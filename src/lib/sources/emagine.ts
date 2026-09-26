import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { probeJsonApis, scrapeJsonApi } from "../json-api.ts";
import { scrapePaged } from "../paging.ts";
import { urlsFromSitemaps } from "../sitemap.ts";
import { isSwedish } from "../sweden.ts";
import { EMAGINE_PORTAL, emagineUrl, extractEmagineId, parseEmagineDetail, parseEmagineJson, parseEmagineListing } from "./emagine-parse.ts";

// emagine publicerar uppdrag i portalen (portal.emagine.org/jobs/<id>/<titel>)
// och listar dem på landssajterna. Vi läser listsidorna (med paginering),
// provar tänkbara JSON-API:er, läser sitemapen och hämtar detaljsidor.
// Sajternas struktur är inte känd än; se /api/debug.
const LISTING_PAGES = [
  { url: "https://emagine-consulting.se/consultants/freelance-jobs/", host: "emagine-consulting.se" },
  { url: `${EMAGINE_PORTAL}/jobs`, host: "emagine.org" },
  { url: "https://www.emagine.org/consultants/freelance-jobs/", host: "emagine.org" },
];
const MAX_PAGES = Number(process.env.EMAGINE_MAX_PAGES ?? 10);
const MAX_FROM_SITEMAP = Number(process.env.EMAGINE_MAX_SITEMAP ?? 60);
const MAX_DETAIL_FETCHES = Number(process.env.EMAGINE_MAX_DETAILS ?? 80);
// Sätt EMAGINE_ALL_COUNTRIES=1 för att visa uppdrag i alla länder.
const ALL_COUNTRIES = process.env.EMAGINE_ALL_COUNTRIES === "1";

export function emagineApiCandidates(): string[] {
  const q = "page={page}&pageSize=50";
  return [
    ...new Set(
      [
        process.env.EMAGINE_API_URL,
        `${EMAGINE_PORTAL}/api/jobs?${q}`,
        `${EMAGINE_PORTAL}/api/public/jobs?${q}`,
        `${EMAGINE_PORTAL}/api/jobs/search?${q}`,
        `${EMAGINE_PORTAL}/api/v1/jobs?${q}`,
        `${EMAGINE_PORTAL}/api/projects?${q}`,
      ].filter((u): u is string => !!u),
    ),
  ];
}

export function probeEmagineApi() {
  return probeJsonApis(emagineApiCandidates(), parseEmagineJson);
}

export const emagine: SourceAdapter = {
  name: "emagine",
  homepage: "https://emagine-consulting.se/consultants/freelance-jobs/",

  async fetchAssignments() {
    const strategies: string[] = [];
    const errors: string[] = [];
    const byId = new Map<string, Assignment>();
    const add = (items: Assignment[]) => {
      for (const it of items) byId.set(it.id, { ...it, ...byId.get(it.id) } as Assignment);
    };

    // 1) Listsidor och 2) JSON-API parallellt.
    const [api, ...listings] = await Promise.all([
      scrapeJsonApi(emagineApiCandidates(), parseEmagineJson, { maxPages: MAX_PAGES, errors }),
      ...LISTING_PAGES.map((p) => scrapePaged(p.url, parseEmagineListing, { hostSuffix: p.host, maxPages: MAX_PAGES, errors })),
    ]);
    if (api.items.length) {
      add(api.items);
      strategies.push(`API ${api.via} (${api.pages} sid): ${api.items.length}`);
    }
    listings.forEach((l, i) => {
      if (!l.items.length) return;
      add(l.items);
      const u = new URL(LISTING_PAGES[i].url);
      strategies.push(`${u.host}${u.pathname} (${l.pages} sid${l.via ? `, ${l.via}` : ""}): ${l.items.length}`);
    });

    // 3) Sitemap: nyaste uppdragen (högst id) som inte redan hittats.
    const fromSitemap = [
      ...(await urlsFromSitemaps(EMAGINE_PORTAL, extractEmagineId, { errors, prefer: /job/i })),
      ...(await urlsFromSitemaps("https://emagine-consulting.se", extractEmagineId, { errors, prefer: /job|freelance/i })),
    ]
      .filter(([id]) => !byId.has(`emagine:${id}`))
      .sort(([a], [b]) => Number(b) - Number(a))
      .slice(0, MAX_FROM_SITEMAP);
    for (const [id, url] of fromSitemap) byId.set(`emagine:${id}`, { id: `emagine:${id}`, source: "emagine", title: "", url: emagineUrl(id, url) });
    if (fromSitemap.length) strategies.push(`sitemap: ${fromSitemap.length}`);

    if (byId.size === 0) {
      throw new Error(errors.length ? `Kunde inte hämta uppdrag från emagine (${errors[0]})` : "Inga uppdrag hittades hos emagine.");
    }

    // Filtrera fram Sverige innan detaljsidor hämtas (okänd plats behålls).
    const before = byId.size;
    if (!ALL_COUNTRIES) for (const [id, a] of byId) if (!isSwedish(a)) byId.delete(id);
    if (before !== byId.size) strategies.push(`utanför Sverige bortfiltrerade: ${before - byId.size}`);

    // 4) Detaljsidor för uppdrag utan titel eller beskrivning.
    const toEnrich = [...byId.values()]
      .filter((a) => !a.title || (a.description?.length ?? 0) < 300)
      .sort((a, b) => Number(!b.title) - Number(!a.title))
      .slice(0, MAX_DETAIL_FETCHES);
    let enriched = 0;
    let closed = 0;
    await mapLimit(toEnrich, 8, async (a) => {
      try {
        const res = await fetchText(a.url, { timeoutMs: 6000, revalidate: 6 * 3600 });
        if (res.status >= 400) return;
        const d = parseEmagineDetail(res.body);
        if (d.closed) {
          byId.delete(a.id);
          closed++;
          return;
        }
        const cur = byId.get(a.id)!;
        byId.set(a.id, {
          ...cur,
          title: cur.title || d.title || "",
          company: cur.company ?? d.company,
          location: cur.location ?? d.location,
          country: cur.country ?? d.country,
          workMode: cur.workMode ?? d.workMode,
          rate: cur.rate ?? d.rate,
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
    if (closed) strategies.push(`stängda bortfiltrerade: ${closed}`);

    const today = new Date().toISOString().slice(0, 10);
    const all = [...byId.values()].filter((a) => ALL_COUNTRIES || isSwedish(a));
    const expired = all.filter((a) => a.deadline && a.deadline < today).length;
    if (expired) strategies.push(`utgångna bortfiltrerade: ${expired}`);
    return { assignments: all.filter((a) => a.title && !(a.deadline && a.deadline < today)), strategies };
  },
};
