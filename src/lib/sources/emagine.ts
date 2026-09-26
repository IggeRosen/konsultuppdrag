import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { scrapePaged } from "../paging.ts";
import { urlsFromSitemaps } from "../sitemap.ts";
import { isSwedish } from "../sweden.ts";
import { walk } from "../parse-utils.ts";
import { fixSearchBody, hasPaging, languageOrder, languagesFromNgState, seedBodies, serverErrorVariants, withPage, type EmagineLanguage } from "./emagine-search.ts";
import { EMAGINE_PORTAL, emagineUrl, extractEmagineId, parseEmagineApiDetail, parseEmagineDetail, parseEmagineJson, parseEmagineListing } from "./emagine-parse.ts";

// emagine publicerar uppdrag i portalen (portal.emagine.org/jobs/<id>/<slug>), en
// Angular-app som hämtar dem från portal-api.emagine.org. Vi använder samma API:
// sökningen (alla länder, nyaste först) och detaljer för de svenska uppdragen.
// Listsidor och sitemaps används bara som reserv om API:t inte svarar.
const LISTING_PAGES = [
  { url: "https://emagine-consulting.se/consultants/freelance-jobs/", host: "emagine-consulting.se" },
  { url: `${EMAGINE_PORTAL}/jobs`, host: "emagine.org" },
  { url: "https://www.emagine.org/consultants/freelance-jobs/", host: "emagine.org" },
];
const MAX_PAGES = Number(process.env.EMAGINE_MAX_PAGES ?? 15);
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
      Cookie: "CurrentUiLang=EN",
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

async function probeDetail(id: string) {
  try {
    const d = await fetchApiDetail(id);
    return {
      url: `${EMAGINE_API}/api/JobAds/details/${id}/En`,
      status: d.status,
      keys: d.json && typeof d.json === "object" ? Object.keys(d.json) : undefined,
      parsed: d.json ? parseEmagineApiDetail(d.json) : undefined,
      sample: d.body.slice(0, 1500),
    };
  } catch (err) {
    return { status: err instanceof Error ? err.message : String(err) };
  }
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
        firstItem: r?.items.find(isSwedish) ?? r?.items[0],
        swedishOnPage: r?.items.filter(isSwedish).length,
        detail: r?.items[0] ? await probeDetail((r.items.find(isSwedish) ?? r.items[0]).id.replace(/^emagine:/, "")) : undefined,
        sample: r?.body.slice(0, 1500),
      };
    }),
  );
}

/** Söker med den första förfrågan som ger uppdrag och hämtar resten av sidorna parallellt (nyaste först). */
async function scrapeSearch(errors: string[]): Promise<{ items: Assignment[]; pages: number; total?: number; via: string }> {
  const statuses: (number | string | undefined)[] = [];
  for (const seed of startBodies()) {
    const d = await discover(seed);
    statuses.push(d.rounds.at(-1)?.status);
    if (!d.result?.items.length) continue;
    const seen = new Map(d.result.items.map((a) => [a.id, a]));
    const json = d.result.json as { totalCount?: number; items?: unknown[] };
    const perPage = json.items?.length ?? d.result.items.length;
    const total = typeof json.totalCount === "number" ? json.totalCount : undefined;
    const lastPage = hasPaging(d.body) ? Math.min(MAX_PAGES, total ? Math.ceil(total / Math.max(1, perPage)) : MAX_PAGES) : 1;
    let pages = 1;
    const rest = Array.from({ length: Math.max(0, lastPage - 1) }, (_, i) => i + 2);
    await mapLimit(rest, 5, async (page) => {
      try {
        const r = await postSearch(withPage(d.body, page));
        if (!r.items.length) return;
        r.items.forEach((a) => seen.has(a.id) || seen.set(a.id, a));
        pages++;
      } catch {
        /* en sida som fallerar hoppas över */
      }
    });
    return { items: [...seen.values()], pages, total, via: `språk ${JSON.stringify(d.body.supportedLanguageId)}` };
  }
  errors.push(`POST /api/JobAds/Search: inga uppdrag (${statuses.join(", ")})`);
  return { items: [], pages: 0, via: "" };
}

/** Uppdragets detaljer via API:t (GET /api/JobAds/details/{id}/{språk}, getById i portalens JavaScript). */
async function fetchApiDetail(id: string) {
  const res = await fetchText(`${EMAGINE_API}/api/JobAds/details/${encodeURIComponent(id)}/En`, {
    headers: { Accept: "application/json", Origin: EMAGINE_PORTAL, Referer: `${EMAGINE_PORTAL}/jobs` },
    timeoutMs: 6000,
    revalidate: 6 * 3600,
  });
  let json: unknown = null;
  if (res.status < 400) {
    try {
      json = JSON.parse(res.body);
    } catch {
      /* inte JSON */
    }
  }
  return { status: res.status, json, body: res.body };
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

    // 1) Portalens sök-API (alla länder, nyaste först).
    const api = await scrapeSearch(errors);
    if (api.items.length) {
      add(api.items);
      strategies.push(`API JobAds/Search, ${api.via} (${api.pages} sid, ${api.items.length} av ${api.total ?? "?"})`);
    }

    // 2) Reserv om API:t inte svarar: listsidor och sitemaps.
    if (!api.items.length) {
      const listings = await Promise.all(
        LISTING_PAGES.map((p) => scrapePaged(p.url, parseEmagineListing, { hostSuffix: p.host, maxPages: MAX_PAGES, errors })),
      );
      listings.forEach((l, i) => {
        if (!l.items.length) return;
        add(l.items);
        const u = new URL(LISTING_PAGES[i].url);
        strategies.push(`${u.host}${u.pathname} (${l.pages} sid${l.via ? `, ${l.via}` : ""}): ${l.items.length}`);
      });
      const fromSitemap = [
        ...(await urlsFromSitemaps(EMAGINE_PORTAL, extractEmagineId, { errors, prefer: /job/i })),
        ...(await urlsFromSitemaps("https://emagine-consulting.se", extractEmagineId, { errors, prefer: /job|freelance/i })),
      ]
        .filter(([id]) => !byId.has(`emagine:${id}`))
        .sort(([a], [b]) => Number(b) - Number(a))
        .slice(0, MAX_FROM_SITEMAP);
      for (const [id, url] of fromSitemap) byId.set(`emagine:${id}`, { id: `emagine:${id}`, source: "emagine", title: "", url: emagineUrl(id, url) });
      if (fromSitemap.length) strategies.push(`sitemap: ${fromSitemap.length}`);
    }

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
      const id = a.id.replace(/^emagine:/, "");
      let d: Partial<Assignment> & { closed?: boolean } = {};
      try {
        const r = await fetchApiDetail(id);
        if (r.json) d = parseEmagineApiDetail(r.json);
      } catch {
        /* prova sidan i stället */
      }
      if (!d.description) {
        try {
          const res = await fetchText(a.url, { timeoutMs: 6000, revalidate: 6 * 3600 });
          if (res.status < 400) d = { ...parseEmagineDetail(res.body), ...d };
        } catch {
          /* detaljerna är frivilliga */
        }
      }
      if (d.closed) {
        byId.delete(a.id);
        closed++;
        return;
      }
      if (!Object.keys(d).length) return;
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
