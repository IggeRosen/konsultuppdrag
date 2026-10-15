import { NextResponse } from "next/server";
import { collectAssignments, withKeywordResults } from "@/lib/aggregate";
import { searchBrainville } from "@/lib/sources/brainville";
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
  // Brainvilles egen sökning per nyckelord: ger även äldre uppdrag och träffar i
  // uppdragstext som inte syns utan inloggning.
  let confirmed = new Map<string, Set<string>>();
  if (keywords.length) {
    try {
      const bv = await searchBrainville(keywords);
      data = withKeywordResults(data, "Brainville", bv.items, `nyckelordssökning (${bv.searched} ord)`);
      confirmed = bv.hits;
    } catch {
      /* nyckelordssökningen är ett tillägg; de vanliga uppdragen visas ändå */
    }
  }
  const { assignments, sources } = data;
  const results = matchAssignments(assignments, keywords, mode, confirmed);

  return NextResponse.json(
    { keywords, mode, total: assignments.length, count: results.length, results, sources, plannedSources: PLANNED_SOURCES },
    { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900" } },
  );
}
