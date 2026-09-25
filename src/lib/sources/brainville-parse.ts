import * as cheerio from "cheerio";
import type { Assignment } from "../types.ts";
import { parseSummary } from "./brainville-summary.ts";
import { cardFields, clean, DATE_RE, extractJsonAssignments, findCards, findNextPage, spacedText, stripEmpty } from "../parse-utils.ts";

export const BRAINVILLE_BASE = "https://www.brainville.com";

// Kända URL-mönster för enskilda uppdrag på Brainville:
//   /Market/RequisitionSearchResult/Details/330877
//   /PublicProfile/Requisition?companyId=648&id=330877&returnUrl=...
const DETAILS_RE = /\/RequisitionSearchResult\/Details\/(\d+)/i;
const PUBLIC_REQ_RE = /\/PublicProfile\/Requisition\?(?:[^"'#]*&)?id=(\d+)/i;

export function extractRequisitionId(href: string): string | null {
  const m = href.match(DETAILS_RE) ?? href.match(PUBLIC_REQ_RE);
  return m ? m[1] : null;
}

export function canonicalUrl(id: string, href?: string): string {
  if (href) {
    try {
      const u = new URL(href, BRAINVILLE_BASE);
      if (u.hostname.endsWith("brainville.com")) {
        if (PUBLIC_REQ_RE.test(u.pathname + u.search)) return u.toString();
      }
    } catch {
      /* ignorera */
    }
  }
  return `${BRAINVILLE_BASE}/Market/RequisitionSearchResult/Details/${id}`;
}

/** Tolkar sidtiteln "DevOps | Hire Quality AB - Assignment | Brainville - ..." */
export function parseDocumentTitle(title: string): { title?: string; company?: string } {
  const parts = title.split("|").map((p) => p.trim());
  if (parts.length < 3) return {};
  const [t, companyPart] = parts;
  const company = companyPart.replace(/\s*-\s*(Assignment|Uppdrag)\s*$/i, "").trim();
  return { title: t || undefined, company: company || undefined };
}

/**
 * Hittar alla uppdragslänkar i en listsida (sökresultat eller ett företags
 * "Open assignments"-sida) och plockar ut titel, företag, ort och datum från
 * det omgivande HTML-elementet ("kortet").
 */
export function parseListing(html: string, pageUrl = BRAINVILLE_BASE): Assignment[] {
  const $ = cheerio.load(html);
  const byId = new Map<string, Assignment>();

  const pageCompany = parseListingCompany($);

  for (const { id, href, card, anchor } of findCards($, extractRequisitionId)) {
    const f = cardFields($, card, anchor);
    const { title, cardText, dates } = f;
    const company = f.company || pageCompany;
    const location = f.location;

    const rest = (title && cardText.startsWith(title) ? cardText.slice(title.length).trim() : cardText).slice(0, 600);
    const summary = parseSummary(rest);

    const existing = byId.get(id);
    const candidate: Assignment = {
      id: `brainville:${id}`,
      source: "Brainville",
      title: title || `Uppdrag ${id}`,
      url: canonicalUrl(id, new URL(href, pageUrl).toString()),
      company: company || undefined,
      location: location || summary?.location || undefined,
      published: dates[0] ?? summary?.published,
      deadline: dates.length > 1 ? dates[dates.length - 1] : undefined,
      startText: summary?.startText,
      duration: summary?.duration,
      extent: summary?.extent,
      // Är texten bara sammanfattningsraden har vi redan brutit ut allt ur den.
      description: summary ? undefined : rest || undefined,
    };
    // Länkas samma uppdrag flera gånger fyller senare träffar bara i saknade fält.
    if (!existing) byId.set(id, stripEmpty(candidate) as Assignment);
    else byId.set(id, { ...stripEmpty(candidate), ...stripEmpty(existing) } as Assignment);
  }

  for (const item of extractJsonAssignments($, { source: "Brainville", prefix: "brainville", urlFor: (id) => canonicalUrl(id) })) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }

  return [...byId.values()];
}

function parseListingCompany($: cheerio.CheerioAPI): string | undefined {
  // "Open assignments | KeyMan AB | Brainville - ..."
  const parts = clean($("title").text()).split("|").map((p) => p.trim());
  if (parts.length >= 3 && /open assignments|öppna uppdrag/i.test(parts[0])) return parts[1] || undefined;
  return undefined;
}

/** Tolkar en detaljsida för ett uppdrag och returnerar berikande fält. */
export function parseDetail(html: string): Partial<Assignment> {
  const $ = cheerio.load(html);
  const fromTitle = parseDocumentTitle(clean($("title").text()));
  const ogDesc = clean($('meta[property="og:description"]').attr("content") ?? $('meta[name="description"]').attr("content"));

  $("script, style, nav, header, footer, noscript").remove();
  // Välj det textrikaste blocket i huvudinnehållet som beskrivning.
  let best = "";
  $("main, article, [class*=description], [class*=Description], [class*=requisition], [class*=Requisition], .content, #content, div")
    .slice(0, 400)
    .each((_, el) => {
      const text = spacedText($, el);
      if (text.length > best.length && text.length < 8000) best = text;
    });
  const description = (best.length > ogDesc.length ? best : ogDesc).slice(0, 2500);
  const h1 = clean($("h1").first().text());
  const dates = [...description.matchAll(DATE_RE)].map((m) => m[1]);

  return stripEmpty({
    title: fromTitle.title || h1 || undefined,
    company: fromTitle.company,
    description: description || undefined,
    start: dates[0],
  });
}

export function findNextPageUrl(html: string, pageUrl: string): string | null {
  return findNextPage(html, pageUrl, "brainville.com");
}
