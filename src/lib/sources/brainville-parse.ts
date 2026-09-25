import * as cheerio from "cheerio";
import type { Assignment } from "../types.ts";

export const BRAINVILLE_BASE = "https://www.brainville.com";

// Kända URL-mönster för enskilda uppdrag på Brainville:
//   /Market/RequisitionSearchResult/Details/330877
//   /PublicProfile/Requisition?companyId=648&id=330877&returnUrl=...
const DETAILS_RE = /\/RequisitionSearchResult\/Details\/(\d+)/i;
const PUBLIC_REQ_RE = /\/PublicProfile\/Requisition\?(?:[^"'#]*&)?id=(\d+)/i;

const DATE_RE = /\b(20\d{2}-\d{2}-\d{2})\b/g;

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

function clean(text: string | undefined | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Som .text() men med mellanslag mellan element, så att "Stockholm" och "2026-09-20" inte klistras ihop. */
type Node = { type: string; data?: string; name?: string; children?: Node[] };
function spacedText($: cheerio.CheerioAPI, el: unknown): string {
  const parts: string[] = [];
  const visit = (n: Node) => {
    if (n.type === "text") parts.push(n.data ?? "");
    else if (n.name !== "script" && n.name !== "style") n.children?.forEach(visit);
  };
  $(el as never).each((_, n) => visit(n as unknown as Node));
  return clean(parts.join(" "));
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

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const id = extractRequisitionId(href);
    if (!id) return;

    // Gå uppåt tills vi hittar det största elementet som bara innehåller detta uppdrag.
    let card = $(el);
    for (let depth = 0; depth < 8; depth++) {
      const parent = card.parent();
      if (!parent.length || parent.is("body, html, table, tbody, ul, ol")) break;
      const ids = new Set<string>();
      parent.find("a[href]").each((_, a) => {
        const other = extractRequisitionId($(a).attr("href") ?? "");
        if (other) ids.add(other);
      });
      if (ids.size > 1) break;
      card = parent;
    }

    const anchorText = clean($(el).text());
    const heading = clean(card.find("h1,h2,h3,h4,h5,.title,[class*=title],[class*=Title]").first().text());
    const title = heading || anchorText || $(el).attr("title") || "";
    const cardText = spacedText($, card);

    const company =
      clean(card.find("[class*=company],[class*=Company],[class*=customer],[class*=Customer]").first().text()) ||
      pageCompany;
    const location = clean(card.find("[class*=location],[class*=Location],[class*=city],[class*=City]").first().text());
    const dates = [...cardText.matchAll(DATE_RE)].map((m) => m[1]);

    const existing = byId.get(id);
    const candidate: Assignment = {
      id: `brainville:${id}`,
      source: "Brainville",
      title: title || `Uppdrag ${id}`,
      url: canonicalUrl(id, new URL(href, pageUrl).toString()),
      company: company || undefined,
      location: location || undefined,
      published: dates[0],
      deadline: dates.length > 1 ? dates[dates.length - 1] : undefined,
      description: (title && cardText.startsWith(title) ? cardText.slice(title.length).trim() : cardText).slice(0, 600) || undefined,
    };
    // Behåll den rikaste varianten om samma uppdrag länkas flera gånger.
    if (!existing || (candidate.description?.length ?? 0) > (existing.description?.length ?? 0)) {
      byId.set(id, { ...existing, ...stripEmpty(candidate) } as Assignment);
    }
  });

  for (const item of extractJsonAssignments($)) {
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

function stripEmpty<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== "")) as Partial<T>;
}

/**
 * Vissa sidor laddar listan som JSON inbäddad i <script>. Vi letar efter objekt
 * som ser ut som uppdrag (har id + titel) och mappar dem.
 */
export function extractJsonAssignments($: cheerio.CheerioAPI): Assignment[] {
  const out: Assignment[] = [];
  $("script").each((_, el) => {
    const src = $(el).html() ?? "";
    if (!/"(Title|title|Rubrik)"\s*:/.test(src)) return;
    for (const blob of findJsonBlobs(src)) {
      walk(blob, (node) => {
        const id = node.RequisitionId ?? node.requisitionId ?? node.AssignmentId ?? node.assignmentId ?? node.Id ?? node.id;
        const title = node.Title ?? node.title ?? node.Rubrik ?? node.Headline ?? node.headline;
        if ((typeof id === "number" || (typeof id === "string" && /^\d+$/.test(id))) && typeof title === "string") {
          const str = String(id);
          out.push(
            stripEmpty({
              id: `brainville:${str}`,
              source: "Brainville",
              title: clean(title),
              url: canonicalUrl(str),
              company: pickString(node, ["CompanyName", "companyName", "Company", "company", "CustomerName"]),
              location: pickString(node, ["Location", "location", "City", "city", "Municipality", "Country"]),
              published: pickDate(node, ["PublicationStartDate", "PublishedDate", "Published", "publishedAt", "Created"]),
              deadline: pickDate(node, ["PublicationEndDate", "LastApplicationDate", "Deadline", "deadline"]),
              start: pickDate(node, ["AssignmentStartDate", "StartDate", "startDate"]),
              description: pickString(node, ["Description", "description", "Summary", "ShortDescription"])?.slice(0, 1500),
            }) as Assignment,
          );
        }
      });
    }
  });
  return out;
}

function pickString(node: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = node[k];
    if (typeof v === "string" && v.trim()) return clean(v.replace(/<[^>]+>/g, " "));
    if (v && typeof v === "object" && typeof (v as Record<string, unknown>).Name === "string")
      return clean((v as Record<string, string>).Name);
  }
  return undefined;
}

function pickDate(node: Record<string, unknown>, keys: string[]): string | undefined {
  const s = pickString(node, keys);
  const m = s?.match(/20\d{2}-\d{2}-\d{2}/);
  return m?.[0];
}

function walk(node: unknown, visit: (n: Record<string, unknown>) => void, depth = 0) {
  if (depth > 12 || !node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, depth + 1);
    return;
  }
  visit(node as Record<string, unknown>);
  for (const child of Object.values(node)) walk(child, visit, depth + 1);
}

/** Plockar ut balanserade {...}/[...]-block ur ett script och försöker JSON-parsa dem. */
function findJsonBlobs(src: string): unknown[] {
  const blobs: unknown[] = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch !== "{" && ch !== "[") continue;
    const end = matchBracket(src, i);
    if (end < 0) continue;
    const text = src.slice(i, end + 1);
    if (text.length > 40 && /"(Title|title|Rubrik)"\s*:/.test(text)) {
      try {
        blobs.push(JSON.parse(text));
        i = end;
      } catch {
        /* inte giltig JSON – fortsätt leta */
      }
    }
  }
  return blobs;
}

function matchBracket(src: string, start: number): number {
  const open = src[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
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
