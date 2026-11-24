import { collectAssignments, withKeywordResults } from "./aggregate.ts";
import { searchBrainville } from "./sources/brainville.ts";
import { idlePlatsbankenStatus, searchPlatsbanken } from "./sources/platsbanken.ts";
import { matchAssignments, type MatchMode } from "./match.ts";
import type { Assignment, MatchedAssignment, SourceStatus } from "./types.ts";

/**
 * Uppdragslistan som användaren ser: alla källor plus, vid nyckelord, Brainvilles egen sökning
 * och Platsbanken, filtrerad och sorterad mot nyckelorden. Delas av /api/assignments och
 * /api/duplicates så att dubblettanalysen gäller samma annonser som listan.
 */
export async function loadAssignments(
  keywords: string[],
  mode: MatchMode,
  force = false,
): Promise<{ assignments: Assignment[]; sources: SourceStatus[]; results: MatchedAssignment[] }> {
  let data = await collectAssignments(force);
  // Sökningar som bara görs med nyckelord: Brainvilles egen sökning (ger även äldre
  // uppdrag och träffar i text som kräver inloggning) och Arbetsförmedlingens Platsbanken.
  const confirmed = new Map<string, Set<string>>();
  const confirm = (hits: Map<string, Set<string>>) => {
    for (const [id, words] of hits) confirmed.set(id, new Set([...(confirmed.get(id) ?? []), ...words]));
  };
  if (keywords.length) {
    const [bv, pb] = await Promise.allSettled([searchBrainville(keywords), searchPlatsbanken(keywords)]);
    if (bv.status === "fulfilled") {
      data = withKeywordResults(data, "Brainville", bv.value.items, `nyckelordssökning (${bv.value.searched} ord)`);
      confirm(bv.value.hits);
    }
    if (pb.status === "fulfilled") {
      const known = new Set(data.assignments.map((a) => a.id));
      data = {
        assignments: [...data.assignments, ...pb.value.items.filter((a) => !known.has(a.id))],
        sources: [...data.sources, pb.value.status],
      };
      confirm(pb.value.hits);
    }
  } else {
    data = { ...data, sources: [...data.sources, idlePlatsbankenStatus()] };
  }
  return { ...data, results: matchAssignments(data.assignments, keywords, mode, confirmed) };
}
