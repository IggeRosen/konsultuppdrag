import { NextResponse } from "next/server";
import { collectAssignments } from "@/lib/aggregate";
import { analyzeDuplicates, explainDuplicates } from "@/lib/duplicates";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Dubblettanalys av hela uppdragslistan (alla källor, utan nyckelordsfilter).
 * ?explain=ord visar i stället alla uppdrag med ordet i titeln och bedömningen av varje par
 * (även under gränsen), för felsökning.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const force = params.get("refresh") === "1";
  const { assignments } = await collectAssignments(force);
  const explain = params.get("explain");
  if (explain) return NextResponse.json(explainDuplicates(assignments, explain));
  return NextResponse.json(analyzeDuplicates(assignments), {
    headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900" },
  });
}
