import { NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { fetchText } from "@/lib/http";
import { extractRequisitionId, parseListing } from "@/lib/sources/brainville-parse";
import { extractCinodeId, parseCinodeDetail, parseCinodeListing } from "@/lib/sources/cinode-parse";
import { extractNextCursor } from "@/lib/sources/cinode-parse";
import { probeLoadMore } from "@/lib/sources/cinode-loadmore";
import { findNextPage } from "@/lib/parse-utils";

// Tillåtna sajter och vilken tolkning som används för dem.
const SITES = [
  { host: "brainville.com", parse: parseListing, extractId: extractRequisitionId },
  { host: "cinode.market", parse: parseCinodeListing, extractId: extractCinodeId },
  { host: "cinode.com", parse: parseCinodeListing, extractId: extractCinodeId },
];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Felsökning: /api/debug?url=https://www.brainville.com/PublicPage/RequisitionSearch
 *             /api/debug?url=https://cinode.market/requests
 * Visar vad scrapern ser på en sida. Endast Brainville och Cinode tillåts.
 * Lägg till &full=1 för att få med hela HTML:en.
 * Cinode: &probe=1 provar vilka adresser "Load more" svarar på.
 * JavaScript-filer (t.ex. market.cinode.com/dist/js/requests.js) visas som
 * utdrag runt ord som "cursor", "fetch" och "load-more".
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const target = params.get("url") ?? "https://www.brainville.com/PublicPage/RequisitionSearch?lang=sv";
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return NextResponse.json({ error: "Ogiltig URL" }, { status: 400 });
  }
  const site = SITES.find((s) => u.hostname === s.host || u.hostname.endsWith(`.${s.host}`));
  if (u.protocol !== "https:" || !site) {
    return NextResponse.json({ error: `Endast https-adresser på ${SITES.map((s) => s.host).join(", ")} tillåts` }, { status: 400 });
  }
  try {
    const res = await fetchText(u.toString(), { revalidate: 0 });

    if (/\.m?js(\?|$)/.test(u.pathname + u.search) || /^\s*(?:!function|\(function|"use strict"|var |const |let |import )/.test(res.body)) {
      const hints: string[] = [];
      const re = /cursor|load-?more|fetch\(|ajax|XMLHttpRequest|\/market\/[\w\/-]+|axios/gi;
      let m: RegExpExecArray | null;
      let lastEnd = -1;
      while ((m = re.exec(res.body)) && hints.length < 40) {
        if (m.index < lastEnd) continue;
        const from = Math.max(0, m.index - 200);
        lastEnd = Math.min(res.body.length, m.index + 250);
        hints.push(res.body.slice(from, lastEnd));
      }
      return NextResponse.json({ status: res.status, finalUrl: res.url, bytes: res.body.length, jsHints: hints });
    }
    const items = site.parse(res.body, res.url);
    const $ = cheerio.load(res.body);

    // HTML för första uppdragskortet och dess förälder – visar listans struktur.
    const firstLink = $("a[href]")
      .toArray()
      .find((el) => {
        try {
          return site.extractId(new URL($(el).attr("href") ?? "", res.url).toString());
        } catch {
          return false;
        }
      });
    let listSnippet = "";
    if (firstLink) {
      let node = $(firstLink);
      for (let i = 0; i < 4 && node.parent().length; i++) node = node.parent();
      listSnippet = ($.html(node) ?? "").replace(/\s+/g, " ").slice(0, 6000);
    }

    // Allt som ser ut som paginering eller "visa fler".
    const paginationHints = $("a, button, li, [data-page], [onclick]")
      .toArray()
      .map((el) => {
        const e = $(el);
        const text = e.text().replace(/\s+/g, " ").trim();
        const attrs = Object.entries((el as unknown as { attribs?: Record<string, string> }).attribs ?? {})
          .filter(([k]) => /href|onclick|data-|class|id|rel|aria/.test(k))
          .map(([k, v]) => `${k}="${v.slice(0, 200)}"`)
          .join(" ");
        return { tag: (el as unknown as { name: string }).name, text: text.slice(0, 40), attrs };
      })
      .filter((h) => /pag|page|sida|next|nästa|more|fler|load/i.test(h.attrs) || /^(\d{1,3}|›|»|nästa|next|visa fler|show more|load more)$/i.test(h.text))
      .slice(0, 40);

    const forms = $("form")
      .toArray()
      .map((f) => ({
        action: $(f).attr("action"),
        method: $(f).attr("method"),
        inputs: $(f)
          .find("input, select")
          .toArray()
          .map((i) => `${$(i).attr("name") ?? "?"}=${($(i).attr("value") ?? "").slice(0, 40)}`)
          .slice(0, 40),
      }));

    const urlsInScripts = [
      ...new Set(
        [...res.body.matchAll(/["'`](\/(?:api|Market|PublicPage|PublicProfile|Requisition|requests)[^"'`\s]{2,120})["'`]/gi)].map((m) => m[1]),
      ),
    ].slice(0, 60);

    const cursor = site.host === "brainville.com" ? null : extractNextCursor(res.body);
    const loadMoreProbe =
      cursor && params.get("probe") === "1"
        ? (await probeLoadMore(res.url, cursor, new Set(items.map((a) => a.id)))).results
        : undefined;

    return NextResponse.json({
      status: res.status,
      cursor,
      loadMoreProbe,
      finalUrl: res.url,
      bytes: res.body.length,
      parsedCount: items.length,
      nextPage: findNextPage(res.body, res.url, site.host),
      // På en Cinode-detaljsida: visa vad detaljtolkningen får ut.
      detail: site.host !== "brainville.com" && extractCinodeId(res.url) ? parseCinodeDetail(res.body) : undefined,
      sample: items.slice(0, 5),
      paginationHints,
      forms,
      urlsInScripts,
      scripts: [...res.body.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
      listSnippet,
      ...(params.get("full") === "1" ? { html: res.body } : {}),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
