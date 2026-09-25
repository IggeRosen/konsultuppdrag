import { NextResponse } from "next/server";
import { collectAssignments } from "@/lib/aggregate";
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

  const { assignments, sources } = await collectAssignments(force);
  const results = matchAssignments(assignments, keywords, mode);

  return NextResponse.json(
    { keywords, mode, total: assignments.length, count: results.length, results, sources, plannedSources: PLANNED_SOURCES },
    { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900" } },
  );
}
