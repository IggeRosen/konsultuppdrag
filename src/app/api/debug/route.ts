import { NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { fetchText } from "@/lib/http";
import { extractRequisitionId, parseListing } from "@/lib/sources/brainville-parse";
import { extractCinodeId, parseCinodeDetail, parseCinodeListing } from "@/lib/sources/cinode-parse";
import { extractNextCursor } from "@/lib/sources/cinode-parse";
import { probeLoadMore } from "@/lib/sources/cinode-loadmore";
import { findNextPage } from "@/lib/parse-utils";
import { extractVeramaId, parseVeramaDetail, parseVeramaHtml, parseVeramaJson } from "@/lib/sources/ework-parse";
import { probeEworkApi } from "@/lib/sources/ework";
import { extractKeymanId, parseKeymanDetail, parseKeymanListing } from "@/lib/sources/keyman-parse";
import { extractMagnitId, MAGNIT_GATEWAY, parseMagnitDetail, parseMagnitHtml, parseMagnitJson } from "@/lib/sources/magnit-parse";
import { probeMagnitApi } from "@/lib/sources/magnit";
import { extractEmagineId, parseEmagineDetail, parseEmagineJson, parseEmagineListing } from "@/lib/sources/emagine-parse";
import { probeEmagineApi } from "@/lib/sources/emagine";

// Tillåtna sajter och vilken tolkning som används för dem.
const SITES = [
  { host: "brainville.com", parse: parseListing, extractId: extractRequisitionId },
  { host: "cinode.market", parse: parseCinodeListing, extractId: extractCinodeId },
  { host: "cinode.com", parse: parseCinodeListing, extractId: extractCinodeId },
  { host: "verama.com", parse: parseVeramaHtml, extractId: extractVeramaId, json: parseVeramaJson },
  { host: "eworkgroup.com", parse: parseVeramaHtml, extractId: extractVeramaId, json: parseVeramaJson },
  { host: "keyman.se", parse: parseKeymanListing, extractId: extractKeymanId },
  { host: "magnitglobal.com", parse: parseMagnitHtml, extractId: extractMagnitId },
  { host: "emagine.org", parse: parseEmagineListing, extractId: extractEmagineId, json: parseEmagineJson },
  { host: "emagine-consulting.se", parse: parseEmagineListing, extractId: extractEmagineId, json: parseEmagineJson },
  // Magnit Sources API-server (bara exakt denna värd, inte alla azurewebsites.net)
  { host: new URL(MAGNIT_GATEWAY).hostname, parse: parseMagnitHtml, extractId: extractMagnitId, exact: true, json: parseMagnitJson },
];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Felsökning: /api/debug?url=https://www.brainville.com/PublicPage/RequisitionSearch
 *             /api/debug?url=https://cinode.market/requests
 *             /api/debug?url=https://app.verama.com/sv/job-requests&probe=1
 *             /api/debug?url=https://www.keyman.se/sv/uppdrag/
 * Visar vad scrapern ser på en sida. Endast de sajter som finns i SITES tillåts.
 * Lägg till &full=1 för att få med hela HTML:en.
 * Cinode: &probe=1 provar vilka adresser "Load more" svarar på.
 * Verama/Magnit: &probe=1 provar tänkbara JSON-API-adresser för uppdragslistan.
 * JavaScript-filer (t.ex. market.cinode.com/dist/js/requests.js) visas som
 * utdrag runt ord som "cursor", "fetch" och "load-more". &find=ord visar koden runt
 * varje förekomst av ordet (t.ex. &find=jobsearch).
 * JSON-svar visas med antal tolkade uppdrag, fältnamn och första uppdraget.
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
  const site = SITES.find((s) => u.hostname === s.host || (!("exact" in s) && u.hostname.endsWith(`.${s.host}`)));
  if (u.protocol !== "https:" || !site) {
    return NextResponse.json({ error: `Endast https-adresser på ${SITES.map((s) => s.host).join(", ")} tillåts` }, { status: 400 });
  }
  try {
    const res = await fetchText(u.toString(), { revalidate: 0, headers: { Accept: "application/json, text/html;q=0.9, */*;q=0.8" } });

    // JSON-svar (t.ex. ett API): visa hur det tolkas.
    if (/json/i.test(res.headers["content-type"] ?? "") || /^\s*[[{]/.test(res.body)) {
      let json: unknown = null;
      try {
        json = JSON.parse(res.body);
      } catch {
        /* inte JSON trots allt */
      }
      if (json !== null) {
        const parseJson = "json" in site && site.json ? site.json : parseMagnitJson;
        const items = parseJson(json);
        const first = Array.isArray(json)
          ? json[0]
          : Object.values(json as object).find((v) => Array.isArray(v) && v.length)?.[0] ?? json;
        return NextResponse.json({
          status: res.status,
          finalUrl: res.url,
          contentType: res.headers["content-type"],
          bytes: res.body.length,
          topLevelKeys: Array.isArray(json) ? `array[${json.length}]` : Object.keys(json as object),
          firstKeys: first && typeof first === "object" ? Object.keys(first) : undefined,
          parsedCount: items.length,
          firstItem: items[0],
          sample: res.body.slice(0, 1500),
        });
      }
    }

    if (/\.m?js(\?|$)/.test(u.pathname + u.search) || /^\s*(?:!function|\(function|"use strict"|var |const |let |import )/.test(res.body)) {
      const js = res.body;
      const find = params.get("find");
      if (find) {
        const snippets: string[] = [];
        let idx = js.indexOf(find);
        while (idx >= 0 && snippets.length < 25) {
          snippets.push(js.slice(Math.max(0, idx - 400), Math.min(js.length, idx + 400)));
          idx = js.indexOf(find, idx + 400);
        }
        return NextResponse.json({ status: res.status, finalUrl: res.url, bytes: js.length, find, matches: snippets.length, snippets });
      }
      // Alla adresser i filen: fullständiga (utom kända tredjepartsbibliotek) och relativa som ser ut som API-anrop.
      const absoluteUrls = [
        ...new Set([...js.matchAll(/["'`](https?:\/\/[^"'`\s]{4,200})["'`]/g)].map((m) => m[1])),
      ].filter((x) => !/w3\.org|angular\.io|reactjs|mozilla\.org|github\.com\/(?:angular|facebook)|schema\.org|cookiebot|googletagmanager|google-analytics/i.test(x));
      const relativeUrls = [
        ...new Set([
          ...[...js.matchAll(/["'`](\/[\w{}$.:-]+(?:\/[\w{}$.:-]*)+)["'`]/g)].map((m) => m[1]),
          // Template-strängar: `${apiUrl}/job-postings/search`
          ...[...js.matchAll(/`\$\{[\w.]+\}(\/[\w\/{}$.:-]+)`/g)].map((m) => `\${…}${m[1]}`),
        ]),
      ].filter((x) => /api|job|request|search|posting|opportunit|graphql|public/i.test(x));
      // Konfiguration som apiUrl: "…" / baseUrl: "…".
      const config = [...js.matchAll(/(\w*(?:api|base|backend|service|gateway)\w*(?:Url|URL|Uri|Endpoint|Host)\w*)\s*:\s*["'`]([^"'`]{2,200})["'`]/gi)]
        .map((m) => `${m[1]}: ${m[2]}`)
        .slice(0, 40);
      const hints: string[] = [];
      const re = /cursor|load-?more|fetch\(|ajax|XMLHttpRequest|\/market\/[\w\/-]+|\/api\/[\w\/{}$.-]+|job-requests|axios|\.(?:get|post)\(\s*[`"'][^`"']*(?:job|request|search|posting)|graphql/gi;
      let m: RegExpExecArray | null;
      let lastEnd = -1;
      while ((m = re.exec(js)) && hints.length < 40) {
        if (m.index < lastEnd) continue;
        const from = Math.max(0, m.index - 200);
        lastEnd = Math.min(js.length, m.index + 250);
        hints.push(js.slice(from, lastEnd));
      }
      return NextResponse.json({
        status: res.status,
        finalUrl: res.url,
        bytes: js.length,
        absoluteUrls: absoluteUrls.slice(0, 80),
        relativeUrls: relativeUrls.slice(0, 80),
        config,
        jsHints: hints,
      });
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

    const isVerama = site.host === "verama.com" || site.host === "eworkgroup.com";
    const cursor = site.host === "brainville.com" || isVerama || site.host === "magnitglobal.com" || site.host.includes("emagine") ? null : extractNextCursor(res.body, res.headers);
    const isMagnit = site.host === "magnitglobal.com";
    const isEmagine = site.host === "emagine.org" || site.host === "emagine-consulting.se";
    const apiProbe =
      params.get("probe") === "1"
        ? isVerama
          ? await probeEworkApi()
          : isMagnit
            ? await probeMagnitApi()
            : isEmagine
              ? await probeEmagineApi()
              : undefined
        : undefined;
    const loadMoreProbe =
      cursor && params.get("probe") === "1"
        ? await probeLoadMore(res.url, cursor, new Set(items.map((a) => a.id)))
        : undefined;

    return NextResponse.json({
      status: res.status,
      cursor,
      loadMoreProbe,
      apiProbe,
      finalUrl: res.url,
      bytes: res.body.length,
      parsedCount: items.length,
      nextPage: findNextPage(res.body, res.url, site.host),
      // På en Cinode-detaljsida: visa vad detaljtolkningen får ut.
      detail: isEmagine
        ? extractEmagineId(res.url)
          ? parseEmagineDetail(res.body)
          : undefined
        : site.host === "magnitglobal.com"
        ? extractMagnitId(res.url)
          ? parseMagnitDetail(res.body)
          : undefined
        : site.host === "keyman.se"
        ? extractKeymanId(res.url)
          ? parseKeymanDetail(res.body, res.url)
          : undefined
        : isVerama
        ? extractVeramaId(res.url)
          ? parseVeramaDetail(res.body)
          : undefined
        : site.host !== "brainville.com" && extractCinodeId(res.url)
          ? parseCinodeDetail(res.body)
          : undefined,
      sample: items.slice(0, 5),
      paginationHints,
      forms,
      urlsInScripts,
      scripts: [...res.body.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => {
        try {
          return new URL(m[1], res.url).toString();
        } catch {
          return m[1];
        }
      }),
      listSnippet,
      ...(params.get("full") === "1" ? { html: res.body } : {}),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
