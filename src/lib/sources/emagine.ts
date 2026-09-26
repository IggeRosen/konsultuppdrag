import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { scrapePaged } from "../paging.ts";
import { urlsFromSitemaps } from "../sitemap.ts";
import { isSwedish } from "../sweden.ts";
import { walk } from "../parse-utils.ts";
import { EMAGINE_PAGE_SIZE, fixSearchBody, hasPaging, languageOrder, languagesFromNgState, seedBodies, serverErrorVariants, withPage, type EmagineLanguage } from "./emagine-search.ts";
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
// (chunk-MQK35HBH.js, 2026-09-26): POST /api/JobAds/Search. Förfrågan kräver minst
// Filter och Sorting; resten lärs in ur API:ts valideringsfel (emagine-search.ts).
// EMAGINE_SEARCH_BODY kan sätta förfrågan direkt (JSON).
export const EMAGINE_API = process.env.EMAGINE_API_URL ?? "https://portal-api.emagine.org";
const SEARCH_URL = () => `${EMAGINE_API}/api/JobAds/Search`;
const MAX_ROUNDS = 8;

type Json = Record<string, unknown>;

function startBodies(): Json[] {
  return process.env.EMAGINE_SEARCH_BODY ? [JSON.parse(process.env.EMAGINE_SEARCH_BODY) as Json] : seedBodies();
}

async function postSearch(body: unknown) {
  const res = await fetchText(SEARCH_URL(), {
    method: "POST",
    // Samma headers som webbläsaren skickar från portalen.
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: EMAGINE_PORTAL,
      Referer: `${EMAGINE_PORTAL}/jobs`,
      "Accept-Language": "en-US,en;q=0.9",
    },
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

type Round = { body: Json; status: number | string; errors?: unknown; items: number; bytes?: number; response?: string };

let languageCache: Promise<{ ids: number[]; langs: EmagineLanguage[] }> | undefined;

/** Språk-id ur portalens ng-state (hämtas en gång). */
function portalLanguages() {
  languageCache ??= fetchText(`${EMAGINE_PORTAL}/jobs`, { timeoutMs: 8000, revalidate: 24 * 3600 })
    .then((r) => {
      const langs = languagesFromNgState(r.body);
      return { ids: languageOrder(langs), langs };
    })
    .catch(() => ({ ids: [], langs: [] }));
  return languageCache;
}

/**
 * Postar, och kompletterar förfrågan utifrån valideringsfelen tills svaret är OK.
 * Klarar förfrågan valideringen men servern svarar 5xx provas varianter (språk m.m.).
 */
async function discover(seed: Json): Promise<{ body: Json; rounds: Round[]; result?: Awaited<ReturnType<typeof postSearch>> }> {
  let body = seed;
  const rounds: Round[] = [];
  const attempt = async (b: Json) => {
    try {
      const r = await postSearch(b);
      const errs = r.json && typeof r.json === "object" ? (r.json as Json).errors : undefined;
      rounds.push({ body: b, status: r.status, errors: errs, items: r.items.length, bytes: r.body.length, response: r.status >= 400 && !errs ? r.body.slice(0, 300) : undefined });
      return { r, errs };
    } catch (err) {
      rounds.push({ body: b, status: err instanceof Error ? err.message : String(err), items: 0 });
      return null;
    }
  };
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const a = await attempt(body);
    if (!a) return { body, rounds };
    if (a.r.status < 400) return { body, rounds, result: a.r };
    if (a.r.status >= 500) {
      const { ids } = await portalLanguages();
      for (const v of serverErrorVariants(body, ids)) {
        const b = await attempt(v);
        if (b && b.r.status < 400) return { body: v, rounds, result: b.r };
      }
      return { body, rounds };
    }
    const next = a.errs && typeof a.errs === "object" ? fixSearchBody(body, a.errs as Json) : null;
    if (!next) return { body, rounds };
    body = next;
  }
  return { body, rounds };
}

function firstObjectKeys(json: unknown): string[] | undefined {
  let keys: string[] | undefined;
  walk(json, (n) => {
    if (!keys && Object.keys(n).length >= 4 && Object.keys(n).some((k) => /title|name/i.test(k))) keys = Object.keys(n);
  });
  return keys;
}

/** För /api/debug: visar varje steg i inlärningen av förfrågan och det slutliga svaret. */
export async function probeEmagineApi() {
  const { langs } = await portalLanguages();
  return Promise.all(
    startBodies().slice(0, 1).map(async (seed) => {
      const d = await discover(seed);
      const r = d.result;
      return {
        url: `POST ${SEARCH_URL()}`,
        portalLanguages: langs,
        finalBody: d.body,
        status: d.rounds.at(-1)?.status,
        items: r?.items.length ?? 0,
        rounds: d.rounds,
        topLevelKeys: r?.json && typeof r.json === "object" && !Array.isArray(r.json) ? Object.keys(r.json) : undefined,
        firstRawKeys: r ? firstObjectKeys(r.json) : undefined,
        firstItem: r?.items[0],
        sample: r?.body.slice(0, 2500),
      };
    }),
  );
}

/** Söker med den första förfrågan som ger uppdrag, och bläddrar. */
async function scrapeSearch(errors: string[]): Promise<{ items: Assignment[]; pages: number; via: string }> {
  const statuses: (number | string | undefined)[] = [];
  for (const seed of startBodies()) {
    const d = await discover(seed);
    statuses.push(d.rounds.at(-1)?.status);
    if (!d.result?.items.length) continue;
    const seen = new Map(d.result.items.map((a) => [a.id, a]));
    let pages = 1;
    for (let page = 2; page <= MAX_PAGES && hasPaging(d.body) && d.result.items.length >= EMAGINE_PAGE_SIZE / 2; page++) {
      try {
        const r = await postSearch(withPage(d.body, page));
        const fresh = r.items.filter((a) => !seen.has(a.id));
        if (!fresh.length) break;
        fresh.forEach((a) => seen.set(a.id, a));
        pages++;
      } catch {
        break;
      }
    }
    return { items: [...seen.values()], pages, via: JSON.stringify(d.body) };
  }
  errors.push(`POST /api/JobAds/Search: inga uppdrag (${statuses.join(", ")})`);
  return { items: [], pages: 0, via: "" };
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
