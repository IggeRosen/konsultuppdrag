import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { BRAINVILLE_BASE, findNextPageUrl, parseDetail, parseListing } from "./brainville-parse.ts";

// Publik söksida för uppdrag (paginerad).
const SEARCH_PAGE = `${BRAINVILLE_BASE}/PublicPage/RequisitionSearch?lang=sv`;
const MAX_PAGES = Number(process.env.BRAINVILLE_MAX_PAGES ?? 10);
// Sidparametrar vi provar om sidan saknar en vanlig "nästa"-länk.
const PAGE_PARAMS = ["page", "p", "pageNumber", "pageIndex", "currentPage"];

// Förmedlare/kunder som publicerar många uppdrag på Brainville. Deras publika
// "Öppna uppdrag"-sidor (/PublicProfile/Requisitions?id=...) används som
// komplement/fallback. Kan överstyras med env BRAINVILLE_COMPANY_IDS="648,7820".
const DEFAULT_COMPANY_IDS = [
  648, // Ework Group AB
  7820, // KeyMan AB
  2035, // Randstad Technologies
  10163, // Iceberry
  1679, // Hire Quality AB
  11060, // Consulting Collective
  16215, // Shaya Solutions AB
];

const MAX_DETAIL_FETCHES = Number(process.env.BRAINVILLE_MAX_DETAILS ?? 60);

function companyIds(): number[] {
  const env = process.env.BRAINVILLE_COMPANY_IDS;
  if (!env) return DEFAULT_COMPANY_IDS;
  return env
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function fetchListing(url: string, errors: string[]): Promise<{ items: Assignment[]; html: string; url: string } | null> {
  try {
    const res = await fetchText(url);
    if (res.status >= 400) {
      errors.push(`HTTP ${res.status} från ${new URL(url).pathname}`);
      return null;
    }
    return { items: parseListing(res.body, res.url), html: res.body, url: res.url };
  } catch (err) {
    errors.push(`${new URL(url).pathname}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function scrapeListing(url: string, errors: string[]): Promise<Assignment[]> {
  return (await fetchListing(url, errors))?.items ?? [];
}

function withParam(url: string, key: string, value: number): string {
  const u = new URL(url);
  u.searchParams.set(key, String(value));
  return u.toString();
}

/**
 * Hämtar söksidan och bläddrar vidare. Följer en "nästa"-länk om den finns,
 * annars provas vanliga sidparametrar och den som ger nya uppdrag används.
 */
async function scrapeSearch(errors: string[]): Promise<{ items: Assignment[]; pages: number; via: string }> {
  const first = await fetchListing(SEARCH_PAGE, errors);
  if (!first) return { items: [], pages: 0, via: "" };
  const seen = new Map(first.items.map((a) => [a.id, a]));
  let pages = 1;
  const addNew = (items: Assignment[]) => {
    let added = 0;
    for (const a of items) if (!seen.has(a.id)) (seen.set(a.id, a), added++);
    return added;
  };

  // 1) Riktiga "nästa"-länkar.
  let next = findNextPageUrl(first.html, first.url);
  if (next) {
    while (next && pages < MAX_PAGES) {
      const page = await fetchListing(next, errors);
      if (!page || addNew(page.items) === 0) break;
      pages++;
      next = findNextPageUrl(page.html, page.url);
    }
    return { items: [...seen.values()], pages, via: "nästa-länk" };
  }

  // 2) Gissa sidparameter: den första som ger nya uppdrag på sida 2 vinner.
  const probes = await Promise.all(PAGE_PARAMS.map((k) => fetchListing(withParam(SEARCH_PAGE, k, 2), [])));
  const hit = probes.findIndex((p) => p && p.items.some((a) => !seen.has(a.id)));
  if (hit < 0) return { items: [...seen.values()], pages, via: "" };
  const param = PAGE_PARAMS[hit];
  addNew(probes[hit]!.items);
  pages++;
  for (let n = 3; n <= MAX_PAGES; n++) {
    const page = await fetchListing(withParam(SEARCH_PAGE, param, n), errors);
    if (!page || addNew(page.items) === 0) break;
    pages++;
  }
  return { items: [...seen.values()], pages, via: `?${param}=` };
}

export const brainville: SourceAdapter = {
  name: "Brainville",
  homepage: BRAINVILLE_BASE,

  async fetchAssignments() {
    const strategies: string[] = [];
    const errors: string[] = [];
    const byId = new Map<string, Assignment>();
    const add = (items: Assignment[], label: string) => {
      if (items.length) strategies.push(`${label}: ${items.length}`);
      for (const it of items) byId.set(it.id, { ...byId.get(it.id), ...it });
    };

    const ids = companyIds();
    const [search, companyResults] = await Promise.all([
      scrapeSearch(errors),
      mapLimit(ids, 4, (id) => scrapeListing(`${BRAINVILLE_BASE}/PublicProfile/Requisitions?id=${id}&lang=sv`, errors)),
    ]);
    add(search.items, `söksidan (${search.pages} sid${search.via ? `, ${search.via}` : ""})`);
    add(companyResults.flat(), `företagssidor (${ids.length})`);

    const attempts = 1 + ids.length;
    if (byId.size === 0 && errors.length >= attempts) {
      throw new Error(`Kunde inte nå Brainville (${errors[0]})`);
    }

    // Berika med detaljsidor (beskrivning ger mycket bättre nyckelordsträffar).
    const toEnrich = [...byId.values()]
      .filter((a) => (a.description?.length ?? 0) < 300)
      .slice(0, MAX_DETAIL_FETCHES);
    let enriched = 0;
    await mapLimit(toEnrich, 8, async (a) => {
      try {
        const res = await fetchText(a.url, { timeoutMs: 6000, revalidate: 6 * 3600 });
        if (res.status >= 400) return;
        const detail = parseDetail(res.body);
        const current = byId.get(a.id)!;
        byId.set(a.id, {
          ...current,
          title: current.title.startsWith("Uppdrag ") && detail.title ? detail.title : current.title,
          company: current.company ?? detail.company,
          start: current.start ?? detail.start,
          description:
            (detail.description?.length ?? 0) > (current.description?.length ?? 0) ? detail.description : current.description,
        });
        enriched++;
      } catch {
        /* detaljsidan är frivillig */
      }
    });
    if (enriched) strategies.push(`detaljsidor: ${enriched}`);

    return { assignments: [...byId.values()], strategies };
  },
};
