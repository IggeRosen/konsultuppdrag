import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { scrapeCinodeListing } from "./cinode-loadmore.ts";
import {
  CINODE_BASE,
  cinodeUrl,
  extractCinodeId,
  parseCinodeDetail,
  parseCinodeListing,
  parseSitemap,
  sitemapsFromRobots,
} from "./cinode-parse.ts";

// Cinode Market är öppen för alla utan inloggning (cinode.market → cinode.com/market).
const MAX_PAGES = Number(process.env.CINODE_MAX_PAGES ?? 10);
// Hur många av de senaste uppdragen från sitemapen vi läser in.
const MAX_FROM_SITEMAP = Number(process.env.CINODE_MAX_SITEMAP ?? 80);
const MAX_DETAIL_FETCHES = Number(process.env.CINODE_MAX_DETAILS ?? 80);

/** Samlar uppdrags-id:n från sitemap(s). Följer sitemap-index ett steg. */
async function idsFromSitemaps(errors: string[]): Promise<string[]> {
  const roots = new Set([`${CINODE_BASE}/sitemap.xml`]);
  try {
    const robots = await fetchText(`${CINODE_BASE}/robots.txt`, { revalidate: 24 * 3600 });
    if (robots.status < 400) sitemapsFromRobots(robots.body).forEach((s) => roots.add(s));
  } catch {
    /* robots.txt är frivillig */
  }

  const ids = new Set<string>();
  const visit = async (url: string, depth: number) => {
    try {
      const res = await fetchText(url, { revalidate: 3600 });
      if (res.status >= 400) return;
      const { urls, sitemaps } = parseSitemap(res.body);
      for (const u of urls) {
        const id = extractCinodeId(u);
        if (id) ids.add(id);
      }
      if (depth < 1) {
        // Prioritera under-sitemaps som ser ut att handla om uppdrag.
        const children = sitemaps.sort((a, b) => Number(/request/i.test(b)) - Number(/request/i.test(a))).slice(0, 10);
        await Promise.all(children.map((c) => visit(c, depth + 1)));
      }
    } catch (err) {
      errors.push(`sitemap ${new URL(url).pathname}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  await Promise.all([...roots].map((r) => visit(r, 0)));
  return [...ids];
}

export const cinode: SourceAdapter = {
  name: "Cinode",
  homepage: CINODE_BASE,

  async fetchAssignments() {
    const strategies: string[] = [];
    const errors: string[] = [];
    const byId = new Map<string, Assignment>();
    const add = (items: Assignment[]) => {
      for (const it of items) byId.set(it.id, { ...byId.get(it.id), ...it });
    };

    // 1) Listsidan, med "Load more"-paginering.
    const listing = await scrapeCinodeListing(MAX_PAGES, errors);
    if (listing.items.length) {
      add(listing.items);
      strategies.push(`listsidan (${listing.pages} sid${listing.via ? `, ${listing.via}` : ""}): ${listing.items.length}`);
    }

    // 2) Sitemap: de nyaste uppdragen (högst id) som listan inte redan gav.
    const sitemapIds = (await idsFromSitemaps(errors))
      .filter((id) => !byId.has(`cinode:${id}`))
      .sort((a, b) => Number(b) - Number(a))
      .slice(0, MAX_FROM_SITEMAP);
    for (const id of sitemapIds) byId.set(`cinode:${id}`, { id: `cinode:${id}`, source: "Cinode", title: "", url: cinodeUrl(id) });
    if (sitemapIds.length) strategies.push(`sitemap: ${sitemapIds.length}`);

    if (byId.size === 0) {
      throw new Error(errors.length ? `Kunde inte nå Cinode Market (${errors[0]})` : "Inga uppdrag hittades på Cinode Market.");
    }

    // 3) Detaljsidor: ger titel för sitemap-uppdrag och beskrivning för alla.
    const toEnrich = [...byId.values()]
      .filter((a) => !a.title || (a.description?.length ?? 0) < 300)
      .sort((a, b) => Number(!b.title) - Number(!a.title))
      .slice(0, MAX_DETAIL_FETCHES);
    let enriched = 0;
    await mapLimit(toEnrich, 8, async (a) => {
      try {
        const res = await fetchText(a.url, { timeoutMs: 6000, revalidate: 6 * 3600 });
        if (res.status >= 400) return;
        const d = parseCinodeDetail(res.body);
        const cur = byId.get(a.id)!;
        byId.set(a.id, {
          ...cur,
          title: !cur.title || cur.title.startsWith("Uppdrag ") ? (d.title ?? cur.title) : cur.title,
          company: cur.company ?? d.company,
          location: cur.location ?? d.location,
          published: cur.published ?? d.published,
          deadline: cur.deadline ?? d.deadline,
          start: cur.start ?? d.start,
          description: (d.description?.length ?? 0) > (cur.description?.length ?? 0) ? d.description : cur.description,
        });
        enriched++;
      } catch {
        /* detaljsidan är frivillig */
      }
    });
    if (enriched) strategies.push(`detaljsidor: ${enriched}`);

    // Släng uppdrag utan titel (detaljsidan gick inte att läsa) och de vars svarsdag har passerat.
    const today = new Date().toISOString().slice(0, 10);
    const assignments = [...byId.values()].filter((a) => a.title && !(a.deadline && a.deadline < today));
    const expired = [...byId.values()].filter((a) => a.deadline && a.deadline < today).length;
    if (expired) strategies.push(`utgångna bortfiltrerade: ${expired}`);

    return { assignments, strategies };
  },
};
