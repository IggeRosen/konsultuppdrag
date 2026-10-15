import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { BRAINVILLE_BASE, parseDetail, parseListing } from "./brainville-parse.ts";
import { fetchListing, scrapePaged } from "../paging.ts";

// Publik söksida för uppdrag (paginerad). Sedan oktober 2026 under /sv/
// (den gamla adressen /PublicPage/RequisitionSearch skickar vidare hit).
const SEARCH_PAGE = `${BRAINVILLE_BASE}/sv/RequisitionSearch?lang=sv`;
const MAX_PAGES = Number(process.env.BRAINVILLE_MAX_PAGES ?? 10);

// Förmedlare/kunder som publicerar många uppdrag på Brainville. Deras publika
// "Tillgängliga uppdrag"-sidor (/sv/PublicProfile/Requisitions/<id>) används som
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

// Nyckelordssökning: Brainvilles egen sökning (/sv/RequisitionSearch?Text=…, öppen
// utan inloggning) körs för varje nyckelord när någon söker i appen.
const MAX_KEYWORDS = Number(process.env.BRAINVILLE_MAX_KEYWORDS ?? 8);
const KEYWORD_PAGES = Number(process.env.BRAINVILLE_KEYWORD_PAGES ?? 3);

export const keywordSearchUrl = (keyword: string) =>
  `${BRAINVILLE_BASE}/sv/RequisitionSearch?Text=${encodeURIComponent(keyword)}&lang=sv`;

/**
 * Söker på Brainville efter varje nyckelord. Ger uppdragen och, per uppdrag,
 * vilka nyckelord Brainville returnerade det för.
 */
export async function searchBrainville(
  keywords: string[],
): Promise<{ items: Assignment[]; hits: Map<string, Set<string>>; errors: string[]; searched: number }> {
  const errors: string[] = [];
  const words = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].slice(0, MAX_KEYWORDS);
  const byId = new Map<string, Assignment>();
  const hits = new Map<string, Set<string>>();
  const results = await mapLimit(words, 4, (kw) =>
    scrapePaged(keywordSearchUrl(kw), parseListing, { hostSuffix: "brainville.com", maxPages: KEYWORD_PAGES, errors }),
  );
  results.forEach((r, i) => {
    for (const a of r.items) {
      byId.set(a.id, { ...a, ...byId.get(a.id) });
      if (!hits.has(a.id)) hits.set(a.id, new Set());
      hits.get(a.id)!.add(words[i]);
    }
  });
  return { items: [...byId.values()], hits, errors, searched: words.length };
}

const MAX_DETAIL_FETCHES = Number(process.env.BRAINVILLE_MAX_DETAILS ?? 60);

function companyIds(): number[] {
  const env = process.env.BRAINVILLE_COMPANY_IDS;
  if (!env) return DEFAULT_COMPANY_IDS;
  return env
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** Sedan oktober 2026; den gamla adressen (?id=648) visar inte listan. */
export const companyPage = (id: number) => `${BRAINVILLE_BASE}/sv/PublicProfile/Requisitions/${id}`;

async function scrapeListing(url: string, errors: string[]): Promise<Assignment[]> {
  return (await fetchListing(url, parseListing, errors))?.items ?? [];
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
      scrapePaged(SEARCH_PAGE, parseListing, { hostSuffix: "brainville.com", maxPages: MAX_PAGES, errors }),
      mapLimit(ids, 4, (id) => scrapeListing(companyPage(id), errors)),
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
