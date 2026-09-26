import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
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

// Portalens API (env.apiUrl i portalens ng-state) och sökanropet i JobAds-tjänsten
// (chunk-MQK35HBH.js, 2026-09-26): POST /api/JobAds/Search. Förfrågans format är
// inte känt än, så några vanliga varianter provas; EMAGINE_SEARCH_BODY kan sätta den.
export const EMAGINE_API = process.env.EMAGINE_API_URL ?? "https://portal-api.emagine.org";
const SEARCH_URL = () => `${EMAGINE_API}/api/JobAds/Search`;
const PAGE_SIZE = 50;

export function searchBodies(page: number): unknown[] {
  if (process.env.EMAGINE_SEARCH_BODY) {
    return [JSON.parse(process.env.EMAGINE_SEARCH_BODY.replace(/"\{page\}"|\{page\}/g, String(page)))];
  }
  return [
    { pageNumber: page, pageSize: PAGE_SIZE },
    { page, pageSize: PAGE_SIZE },
    { skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE },
    { pageIndex: page - 1, pageSize: PAGE_SIZE },
    { paging: { pageNumber: page, pageSize: PAGE_SIZE } },
    {},
  ];
}

async function postSearch(body: unknown) {
  const res = await fetchText(SEARCH_URL(), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 8000,
  });
  let json: unknown = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* inte JSON */
  }
  return { status: res.status, json, items: json && res.status < 400 ? parseEmagineJson(json) : [], body: res.body };
}

/** För /api/debug: provar sökanropet med olika förfrågningar och visar svaren (även felmeddelanden). */
export async function probeEmagineApi() {
  return Promise.all(
    searchBodies(1).map(async (body) => {
      try {
        const r = await postSearch(body);
        return {
          url: `POST ${SEARCH_URL()} ${JSON.stringify(body)}`,
          status: r.status,
          bytes: r.body.length,
          items: r.items.length,
          topLevelKeys: r.json && typeof r.json === "object" && !Array.isArray(r.json) ? Object.keys(r.json) : undefined,
          firstItem: r.items[0],
          sample: r.body.slice(0, 1200),
        };
      } catch (err) {
        return { url: `POST ${SEARCH_URL()} ${JSON.stringify(body)}`, status: err instanceof Error ? err.message : String(err), bytes: 0, items: 0 };
      }
    }),
  );
}

/** Söker med den första förfrågningsvariant som ger uppdrag, och bläddrar. */
async function scrapeSearch(errors: string[]): Promise<{ items: Assignment[]; pages: number; via: string }> {
  const bodies = searchBodies(1);
  let idx = -1;
  let first: Assignment[] = [];
  const statuses: (number | string)[] = [];
  for (let i = 0; i < bodies.length; i++) {
    try {
      const r = await postSearch(bodies[i]);
      statuses.push(r.status);
      if (r.items.length) {
        idx = i;
        first = r.items;
        break;
      }
    } catch (err) {
      statuses.push(err instanceof Error ? err.message : "fel");
    }
  }
  if (idx < 0) {
    errors.push(`POST /api/JobAds/Search: inga uppdrag (${statuses.join(", ")})`);
    return { items: [], pages: 0, via: "" };
  }
  const seen = new Map(first.map((a) => [a.id, a]));
  let pages = 1;
  for (let page = 2; page <= MAX_PAGES && first.length >= PAGE_SIZE / 2; page++) {
    try {
      const r = await postSearch(searchBodies(page)[idx]);
      const fresh = r.items.filter((a) => !seen.has(a.id));
      if (!fresh.length) break;
      fresh.forEach((a) => seen.set(a.id, a));
      pages++;
    } catch {
      break;
    }
  }
  return { items: [...seen.values()], pages, via: JSON.stringify(bodies[idx]) };
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
      scrapeSearch(errors),
      ...LISTING_PAGES.map((p) => scrapePaged(p.url, parseEmagineListing, { hostSuffix: p.host, maxPages: MAX_PAGES, errors })),
    ]);
    if (api.items.length) {
      add(api.items);
      strategies.push(`API JobAds/Search ${api.via} (${api.pages} sid): ${api.items.length}`);
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
