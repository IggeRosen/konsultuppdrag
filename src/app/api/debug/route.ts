import { NextResponse } from "next/server";
import { fetchText } from "@/lib/http";
import { parseListing } from "@/lib/sources/brainville-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Felsökning: /api/debug?url=https://www.brainville.com/PublicPage/RequisitionSearch
 * Visar vad scrapern ser på en sida. Endast brainville.com tillåts.
 */
export async function GET(req: Request) {
  const target = new URL(req.url).searchParams.get("url") ?? "https://www.brainville.com/PublicPage/RequisitionSearch?lang=sv";
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return NextResponse.json({ error: "Ogiltig URL" }, { status: 400 });
  }
  if (u.protocol !== "https:" || !(u.hostname === "brainville.com" || u.hostname.endsWith(".brainville.com"))) {
    return NextResponse.json({ error: "Endast https://*.brainville.com tillåts" }, { status: 400 });
  }
  try {
    const res = await fetchText(u.toString(), { revalidate: 0 });
    const items = parseListing(res.body, res.url);
    const scripts = [...res.body.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    const xhrHints = [...new Set([...res.body.matchAll(/["'](\/[A-Za-z]+\/[A-Za-z/]*(?:Search|Requisition|Assignment)[A-Za-z/]*)["']/g)].map((m) => m[1]))];
    return NextResponse.json({
      status: res.status,
      finalUrl: res.url,
      bytes: res.body.length,
      parsedCount: items.length,
      sample: items.slice(0, 5),
      scripts,
      xhrHints,
      htmlHead: res.body.slice(0, 3000),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
