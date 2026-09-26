import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { scrapeJsonApi, probeJsonApis } from "../json-api.ts";
import { urlsFromSitemaps } from "../sitemap.ts";
import { extractMagnitId, isSwedish, MAGNIT_BASE, MAGNIT_GATEWAY, parseMagnitDetail, parseMagnitHtml, parseMagnitJson } from "./magnit-parse.ts";

// Magnit Source (magnit-source.magnitglobal.com) är Magnits öppna marknadsplats,
// en Angular-app som hämtar uppdragen från en separat API-server (MAGNIT_GATEWAY).
// Vi provar dess jobsearch-anrop, läser startsidans HTML och sitemapen. En egen
// adress kan sättas med env MAGNIT_API_URL ({page} = sidnummer från 0).
const MAX_PAGES = Number(process.env.MAGNIT_MAX_PAGES ?? 6);
const MAX_FROM_SITEMAP = Number(process.env.MAGNIT_MAX_SITEMAP ?? 60);
const MAX_DETAIL_FETCHES = Number(process.env.MAGNIT_MAX_DETAILS ?? 60);
// Sätt MAGNIT_ALL_COUNTRIES=1 för att visa uppdrag i alla länder.
const ALL_COUNTRIES = process.env.MAGNIT_ALL_COUNTRIES === "1";

export function magnitApiCandidates(): string[] {
  const gw = MAGNIT_GATEWAY;
  return [
    ...new Set(
      [
        process.env.MAGNIT_API_URL,
        // Riktiga anrop ur sajtens JavaScript (2026-09-26). Startsidans uppdrag är troligen öppna.
        `${gw}/api/jobsearch/landing-page-job-requests`,
        `${gw}/api/jobsearch?page={page}&pageSize=50`,
        `${gw}/api/jobsearch?pageNumber={page}&pageSize=50`,
        `${gw}/api/jobsearch`,
      ].filter((u): u is string => !!u),
    ),
  ];
}

export function probeMagnitApi() {
  return probeJsonApis(magnitApiCandidates(), parseMagnitJson);
}

const HTML_PAGES = [`${MAGNIT_BASE}/`, `${MAGNIT_BASE}/jobs`];

export const magnit: SourceAdapter = {
  name: "Magnit",
  homepage: MAGNIT_BASE,

  async fetchAssignments() {
    const strategies: string[] = [];
    const errors: string[] = [];
    const byId = new Map<string, Assignment>();
    const add = (items: Assignment[]) => {
      for (const it of items) byId.set(it.id, { ...it, ...byId.get(it.id) } as Assignment);
    };

    // 1) JSON-API och 2) HTML-sidor parallellt.
    const [api, ...htmlPages] = await Promise.all([
      scrapeJsonApi(magnitApiCandidates(), parseMagnitJson, { maxPages: MAX_PAGES, errors }),
      ...HTML_PAGES.map((url) =>
        fetchText(url)
          .then((r) => (r.status < 400 ? parseMagnitHtml(r.body, r.url) : (errors.push(`HTTP ${r.status} från ${new URL(url).pathname}`), [])))
          .catch((err) => (errors.push(`${new URL(url).pathname}: ${err instanceof Error ? err.message : String(err)}`), [] as Assignment[])),
      ),
    ]);
    if (api.items.length) {
      add(api.items);
      strategies.push(`API ${api.via} (${api.pages} sid): ${api.items.length}`);
    }
    const html = htmlPages.flat();
    if (html.length) {
      add(html);
      strategies.push(`HTML: ${html.length}`);
    }

    // 3) Sitemap, bara om inget annat gav uppdrag.
    if (!byId.size) {
      const fromSitemap = [...(await urlsFromSitemaps(MAGNIT_BASE, extractMagnitId, { errors, prefer: /job|request|posting/i }))].slice(
        0,
        MAX_FROM_SITEMAP,
      );
      for (const [id, url] of fromSitemap) byId.set(`magnit:${id}`, { id: `magnit:${id}`, source: "Magnit", title: "", url });
      if (fromSitemap.length) strategies.push(`sitemap: ${fromSitemap.length}`);
    }

    if (byId.size === 0) {
      throw new Error(errors.length ? `Kunde inte hämta uppdrag från Magnit Source (${errors[0]})` : "Inga uppdrag hittades på Magnit Source.");
    }

    // Filtrera fram Sverige innan detaljsidor hämtas.
    const beforeFilter = byId.size;
    if (!ALL_COUNTRIES) for (const [id, a] of byId) if (!isSwedish(a)) byId.delete(id);
    if (beforeFilter !== byId.size) strategies.push(`utanför Sverige bortfiltrerade: ${beforeFilter - byId.size}`);

    // 4) Detaljsidor för uppdrag utan titel eller beskrivning.
    const toEnrich = [...byId.values()]
      .filter((a) => !a.title || (a.description?.length ?? 0) < 200)
      .sort((a, b) => Number(!b.title) - Number(!a.title))
      .slice(0, MAX_DETAIL_FETCHES);
    let enriched = 0;
    await mapLimit(toEnrich, 8, async (a) => {
      try {
        const res = await fetchText(a.url, { timeoutMs: 6000, revalidate: 6 * 3600 });
        if (res.status >= 400) return;
        const d = parseMagnitDetail(res.body);
        const cur = byId.get(a.id)!;
        byId.set(a.id, {
          ...cur,
          title: cur.title || d.title || "",
          company: cur.company ?? d.company,
          location: cur.location ?? d.location,
          country: cur.country ?? d.country,
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
    const all = [...byId.values()].filter((a) => ALL_COUNTRIES || isSwedish(a));
    const expired = all.filter((a) => a.deadline && a.deadline < today).length;
    if (expired) strategies.push(`utgångna bortfiltrerade: ${expired}`);
    return { assignments: all.filter((a) => a.title && !(a.deadline && a.deadline < today)), strategies };
  },
};
