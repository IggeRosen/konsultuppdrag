import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { scrapePaged } from "../paging.ts";
import { urlsFromSitemaps } from "../sitemap.ts";
import { extractKeymanId, KEYMAN_BASE, keymanUrl, parseKeymanDetail, parseKeymanListing } from "./keyman-parse.ts";

// KeyMan publicerar sina uppdrag på keyman.se/sv/uppdrag/. Listan kompletteras
// med sitemapen (nyaste uppdragen) och varje uppdrags egen sida (beskrivning,
// ort, start, sista ansökningsdag).
const LISTING_URL = `${KEYMAN_BASE}/sv/uppdrag/`;
const MAX_PAGES = Number(process.env.KEYMAN_MAX_PAGES ?? 10);
const MAX_FROM_SITEMAP = Number(process.env.KEYMAN_MAX_SITEMAP ?? 60);
const MAX_DETAIL_FETCHES = Number(process.env.KEYMAN_MAX_DETAILS ?? 80);

export const keyman: SourceAdapter = {
  name: "KeyMan",
  homepage: LISTING_URL,

  async fetchAssignments() {
    const strategies: string[] = [];
    const errors: string[] = [];
    const byId = new Map<string, Assignment>();

    // 1) Listsidan, med paginering (nästa-länk, ?page= eller /page/N/).
    const listing = await scrapePaged(LISTING_URL, parseKeymanListing, { hostSuffix: "keyman.se", maxPages: MAX_PAGES, errors });
    for (const a of listing.items) byId.set(a.id, a);
    if (listing.items.length) strategies.push(`listsidan (${listing.pages} sid${listing.via ? `, ${listing.via}` : ""}): ${listing.items.length}`);

    // 2) Sitemap: de nyaste uppdragen (högst id) som listan inte gav.
    const fromSitemap = [...(await urlsFromSitemaps(KEYMAN_BASE, extractKeymanId, { errors, prefer: /uppdrag|job|post/i }))]
      .filter(([id]) => !byId.has(`keyman:${id}`))
      .sort(([a], [b]) => Number(b) - Number(a))
      .slice(0, MAX_FROM_SITEMAP);
    for (const [id, url] of fromSitemap) byId.set(`keyman:${id}`, { id: `keyman:${id}`, source: "KeyMan", title: "", url: keymanUrl(url) });
    if (fromSitemap.length) strategies.push(`sitemap: ${fromSitemap.length}`);

    if (byId.size === 0) {
      throw new Error(errors.length ? `Kunde inte nå KeyMan (${errors[0]})` : "Inga uppdrag hittades på KeyMan.");
    }

    // 3) Detaljsidor för beskrivning och strukturerade fält.
    const toEnrich = [...byId.values()]
      .filter((a) => !a.title || (a.description?.length ?? 0) < 300)
      .sort((a, b) => Number(!b.title) - Number(!a.title))
      .slice(0, MAX_DETAIL_FETCHES);
    let enriched = 0;
    await mapLimit(toEnrich, 8, async (a) => {
      try {
        const res = await fetchText(a.url, { timeoutMs: 6000, revalidate: 6 * 3600 });
        if (res.status >= 400) return;
        const d = parseKeymanDetail(res.body, a.url);
        const cur = byId.get(a.id)!;
        byId.set(a.id, {
          ...cur,
          title: cur.title || d.title || "",
          company: cur.company ?? d.company,
          location: cur.location ?? d.location,
          workMode: cur.workMode ?? d.workMode,
          extent: cur.extent ?? d.extent,
          published: cur.published ?? d.published,
          deadline: cur.deadline ?? d.deadline,
          start: cur.start ?? d.start,
          end: cur.end ?? d.end,
          description: (d.description?.length ?? 0) > (cur.description?.length ?? 0) ? d.description : cur.description,
        });
        enriched++;
      } catch {
        /* detaljsidan är frivillig */
      }
    });
    if (enriched) strategies.push(`detaljsidor: ${enriched}`);

    const today = new Date().toISOString().slice(0, 10);
    const all = [...byId.values()];
    const expired = all.filter((a) => a.deadline && a.deadline < today).length;
    if (expired) strategies.push(`utgångna bortfiltrerade: ${expired}`);
    return { assignments: all.filter((a) => a.title && !(a.deadline && a.deadline < today)), strategies };
  },
};
