import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { BRAINVILLE_BASE, parseDetail, parseListing } from "./brainville-parse.ts";

// Publika söksidor för uppdrag.
const SEARCH_PAGES = [
  `${BRAINVILLE_BASE}/PublicPage/RequisitionSearch?lang=sv`,
  `${BRAINVILLE_BASE}/?lang=sv`,
];

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

async function scrapeListing(url: string, errors: string[]): Promise<Assignment[]> {
  try {
    const res = await fetchText(url);
    if (res.status >= 400) {
      errors.push(`HTTP ${res.status} från ${new URL(url).pathname}`);
      return [];
    }
    return parseListing(res.body, res.url);
  } catch (err) {
    errors.push(`${new URL(url).pathname}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
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

    const searchResults = await Promise.all(SEARCH_PAGES.map((u) => scrapeListing(u, errors)));
    searchResults.forEach((items, i) => add(items, `sök ${new URL(SEARCH_PAGES[i]).pathname}`));

    const ids = companyIds();
    const companyResults = await mapLimit(ids, 4, (id) =>
      scrapeListing(`${BRAINVILLE_BASE}/PublicProfile/Requisitions?id=${id}&lang=sv`, errors),
    );
    add(companyResults.flat(), `företagssidor (${ids.length})`);

    const attempts = SEARCH_PAGES.length + ids.length;
    if (byId.size === 0 && errors.length === attempts) {
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
