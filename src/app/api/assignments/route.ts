import { NextResponse } from "next/server";
import { collectAssignments, withKeywordResults } from "@/lib/aggregate";
import { searchBrainville } from "@/lib/sources/brainville";
import { idlePlatsbankenStatus, searchPlatsbanken } from "@/lib/sources/platsbanken";
import { matchAssignments, parseKeywords, type MatchMode } from "@/lib/match";
import { PLANNED_SOURCES } from "@/lib/sources";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const keywords = parseKeywords(searchParams.get("keywords"));
  const mode: MatchMode = searchParams.get("mode") === "all" ? "all" : "any";
  const force = searchParams.get("refresh") === "1";

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
  const { assignments, sources } = data;
  const results = matchAssignments(assignments, keywords, mode, confirmed);

  return NextResponse.json(
    { keywords, mode, total: assignments.length, count: results.length, results, sources, plannedSources: PLANNED_SOURCES },
    { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900" } },
  );
}
