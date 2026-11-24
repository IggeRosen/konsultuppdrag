import { NextResponse } from "next/server";
import { collectAssignments } from "@/lib/aggregate";
import { analyzeDuplicates } from "@/lib/duplicates";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Dubblettanalys av hela uppdragslistan (alla källor, utan nyckelordsfilter). */
export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get("refresh") === "1";
  const { assignments } = await collectAssignments(force);
  return NextResponse.json(analyzeDuplicates(assignments), {
    headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900" },
  });
}
