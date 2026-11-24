import { NextResponse } from "next/server";
import { loadAssignments } from "@/lib/load";
import { parseKeywords, type MatchMode } from "@/lib/match";
import { analyzeDuplicates, explainDuplicates } from "@/lib/duplicates";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Dubblettanalys av uppdragslistan. Med ?keywords=…&mode=… analyseras samma annonser som
 * listan visar (inklusive Platsbanken och Brainvilles nyckelordssökning); utan nyckelord hela
 * listan. ?explain=ord visar i stället alla uppdrag med ordet i titel eller ort och bedömningen
 * av varje par (även under gränsen), för felsökning.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const keywords = parseKeywords(params.get("keywords"));
  const mode: MatchMode = params.get("mode") === "all" ? "all" : "any";
  const force = params.get("refresh") === "1";
  const { assignments, results } = await loadAssignments(keywords, mode, force);
  // Dubbletter letas bland de visade annonserna, men hur ovanliga ord och orter är räknas på
  // hela listan (se analyzeDuplicates).
  const explain = params.get("explain");
  if (explain) return NextResponse.json(explainDuplicates(results, explain, assignments));
  return NextResponse.json(analyzeDuplicates(results, assignments), {
    headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900" },
  });
}
