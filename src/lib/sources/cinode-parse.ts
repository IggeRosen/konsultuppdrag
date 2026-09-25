import * as cheerio from "cheerio";
import type { Assignment } from "../types.ts";
import {
  cardFields,
  clean,
  DATE_RE,
  extractJobPosting,
  extractJsonAssignments,
  findCards,
  spacedText,
  stripEmpty,
} from "../parse-utils.ts";

export const CINODE_BASE = "https://cinode.market";

// Kända URL-mönster för enskilda uppdrag på Cinode Market:
//   https://cinode.market/requests/19615
//   https://cinode.com/market/requests/19615
const REQUEST_RE = /^(?:https?:\/\/(?:www\.)?(?:cinode\.market|cinode\.com\/market))?\/(?:market\/)?requests\/(\d+)(?:[/?#]|$)/i;

export function extractCinodeId(href: string): string | null {
  return href.match(REQUEST_RE)?.[1] ?? null;
}

export function cinodeUrl(id: string): string {
  return `${CINODE_BASE}/requests/${id}`;
}

// Referensnummer i titeln, t.ex. "LPU-1169", "23-IU-283", "2.8.11-10823/2020".
const REF_RE = /^(?=.*\d)[\p{Lu}\d][\p{Lu}\d.\-/_ ]{1,30}$/u;

/**
 * Tolkar sidtiteln "Cinode Market - Testledare Nivå 4 - Inera - LPU-1169".
 * Sista delen är referensnummer om den ser ut som ett, delen före är kunden.
 */
export function parseCinodeTitle(raw: string): { title?: string; company?: string; reference?: string } {
  const text = clean(raw).replace(/^Cinode Market\s*[-–|]\s*/i, "");
  if (!text || /^Cinode Market$/i.test(text)) return {};
  const parts = text.split(/\s+[-–]\s+/);
  let reference: string | undefined;
  if (parts.length >= 3 && REF_RE.test(parts[parts.length - 1])) reference = parts.pop();
  if (parts.length === 1) return stripEmpty({ title: parts[0], reference });
  const company = parts.pop();
  return stripEmpty({ title: parts.join(" - "), company, reference });
}

/** Hämtar datumet som följer efter någon av etiketterna, t.ex. "Sista svarsdag 2026-01-28". */
function dateAfter(text: string, labels: RegExp): string | undefined {
  const m = text.match(new RegExp(`(?:${labels.source})\\s*:?\\s*(20\\d{2}-\\d{2}-\\d{2})`, "i"));
  return m?.[1];
}

const LAST_REPLY = /sista svarsdag|svara senast|sista ansökningsdag|last reply(?: date)?|reply by|deadline|apply by/;
const START = /startdatum|start date|start|uppdragsstart|period/;
const LOCATION_RE = /(?:^|\s)(?:Ort|Plats|Placering|Location|Placeringsort)\s*:?\s*([\p{Lu}][\p{L}\-]+(?:\s[\p{Lu}][\p{L}\-]+)?)/u;

/** Tolkar en listsida med uppdrag (sökresultat eller nyckelordssida). */
export function parseCinodeListing(html: string, pageUrl = CINODE_BASE): Assignment[] {
  const $ = cheerio.load(html);
  const byId = new Map<string, Assignment>();

  for (const { id, card, anchor } of findCards($, (href) => extractCinodeId(absolutize(href, pageUrl)))) {
    const f = cardFields($, card, anchor);
    const rest = (f.title && f.cardText.startsWith(f.title) ? f.cardText.slice(f.title.length) : f.cardText).trim();
    const candidate = stripEmpty({
      id: `cinode:${id}`,
      source: "Cinode",
      title: f.title || `Uppdrag ${id}`,
      url: cinodeUrl(id),
      company: f.company,
      location: f.location || rest.match(LOCATION_RE)?.[1],
      deadline: dateAfter(rest, LAST_REPLY),
      start: dateAfter(rest, START) ?? f.dates[0],
      description: rest.slice(0, 600),
    }) as Assignment;
    const existing = byId.get(candidate.id);
    byId.set(candidate.id, existing ? ({ ...candidate, ...existing } as Assignment) : candidate);
  }

  for (const item of extractJsonAssignments($, { source: "Cinode", prefix: "cinode", urlFor: cinodeUrl })) {
    const existing = byId.get(item.id);
    byId.set(item.id, existing ? ({ ...item, ...existing } as Assignment) : item);
  }

  return [...byId.values()];
}

function absolutize(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** Tolkar en detaljsida för ett uppdrag. */
export function parseCinodeDetail(html: string): Partial<Assignment> {
  const $ = cheerio.load(html);
  const fromTitle = parseCinodeTitle($("title").text());
  const ld = extractJobPosting($) ?? {};
  const ogTitle = parseCinodeTitle($('meta[property="og:title"]').attr("content") ?? "");
  const ogDesc = clean($('meta[property="og:description"]').attr("content") ?? $('meta[name="description"]').attr("content"));

  $("script, style, nav, header, footer, noscript").remove();
  let best = "";
  $("main, article, [class*=description], [class*=Description], [class*=request], [class*=Request], .content, #content, div")
    .slice(0, 400)
    .each((_, el) => {
      const text = spacedText($, el);
      if (text.length > best.length && text.length < 12000) best = text;
    });
  const body = best.length > ogDesc.length ? best : ogDesc;
  const h1 = clean($("h1").first().text());
  const dates = [...body.matchAll(DATE_RE)].map((m) => m[1]);

  return stripEmpty({
    title: ld.title || fromTitle.title || ogTitle.title || h1 || undefined,
    company: ld.company || fromTitle.company || ogTitle.company,
    location: ld.location || body.match(LOCATION_RE)?.[1],
    published: ld.published,
    deadline: ld.deadline || dateAfter(body, LAST_REPLY),
    start: dateAfter(body, START) ?? dates[0],
    description: (ld.description && ld.description.length > 200 ? ld.description : body).slice(0, 2500) || undefined,
  });
}

/** Plockar ut alla <loc> ur en sitemap (eller sitemap-index). */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const $ = cheerio.load(xml, { xml: true });
  const sitemaps = $("sitemapindex > sitemap > loc")
    .toArray()
    .map((el) => clean($(el).text()));
  const urls = $("urlset > url > loc")
    .toArray()
    .map((el) => clean($(el).text()));
  return { urls, sitemaps };
}

/** Hittar "Sitemap:"-rader i robots.txt. */
export function sitemapsFromRobots(robots: string): string[] {
  return [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
}
