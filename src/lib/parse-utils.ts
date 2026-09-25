import * as cheerio from "cheerio";
import type { Assignment } from "./types.ts";

export const DATE_RE = /\b(20\d{2}-\d{2}-\d{2})\b/g;

export function clean(text: string | undefined | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

export type Node = { type: string; data?: string; name?: string; children?: Node[] };

/** Som .text() men med mellanslag mellan element, så att "Stockholm" och "2026-09-20" inte klistras ihop. */
export function spacedText($: cheerio.CheerioAPI, el: unknown): string {
  const parts: string[] = [];
  const visit = (n: Node) => {
    if (n.type === "text") parts.push(n.data ?? "");
    else if (n.name !== "script" && n.name !== "style") n.children?.forEach(visit);
  };
  $(el as never).each((_, n) => visit(n as unknown as Node));
  return clean(parts.join(" "));
}

export function stripEmpty<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== "")) as Partial<T>;
}

export function pickString(node: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = node[k];
    if (typeof v === "string" && v.trim()) return clean(v.replace(/<[^>]+>/g, " "));
    if (v && typeof v === "object") {
      const name = (v as Record<string, unknown>).Name ?? (v as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim()) return clean(name);
    }
  }
  return undefined;
}

export function pickDate(node: Record<string, unknown>, keys: string[]): string | undefined {
  const s = pickString(node, keys);
  const m = s?.match(/20\d{2}-\d{2}-\d{2}/);
  return m?.[0];
}

export function walk(node: unknown, visit: (n: Record<string, unknown>) => void, depth = 0) {
  if (depth > 12 || !node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, depth + 1);
    return;
  }
  visit(node as Record<string, unknown>);
  for (const child of Object.values(node)) walk(child, visit, depth + 1);
}

/** Plockar ut balanserade {...}/[...]-block ur ett script och försöker JSON-parsa dem. */
export function findJsonBlobs(src: string): unknown[] {
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

type Cheerio = ReturnType<cheerio.CheerioAPI>;

/**
 * Hittar alla uppdragslänkar på en listsida och, för varje uppdrag, det största
 * omgivande elementet ("kortet") som bara innehåller just det uppdraget.
 */
export function findCards(
  $: cheerio.CheerioAPI,
  extractId: (href: string) => string | null,
): { id: string; href: string; anchor: Cheerio; card: Cheerio }[] {
  const out: { id: string; href: string; anchor: Cheerio; card: Cheerio }[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const id = extractId(href);
    if (!id) return;
    let card = $(el);
    for (let depth = 0; depth < 8; depth++) {
      const parent = card.parent();
      if (!parent.length || parent.is("body, html, table, tbody, ul, ol")) break;
      const ids = new Set<string>();
      parent.find("a[href]").each((_, a) => {
        const other = extractId($(a).attr("href") ?? "");
        if (other) ids.add(other);
      });
      if (ids.size > 1) break;
      card = parent;
    }
    out.push({ id, href, anchor: $(el), card });
  });
  return out;
}

/** Plockar ut titel, företag, ort och datum ur ett uppdragskort. */
export function cardFields($: cheerio.CheerioAPI, card: Cheerio, anchor: Cheerio) {
  const anchorText = clean(anchor.text());
  const heading = clean(card.find("h1,h2,h3,h4,h5,.title,[class*=title],[class*=Title]").first().text());
  const title = heading || anchorText || anchor.attr("title") || "";
  const cardText = spacedText($, card);
  const company = clean(card.find("[class*=company],[class*=Company],[class*=customer],[class*=Customer]").first().text());
  const location = clean(card.find("[class*=location],[class*=Location],[class*=city],[class*=City]").first().text());
  const dates = [...cardText.matchAll(DATE_RE)].map((m) => m[1]);
  return { title, cardText, company, location, dates };
}

/**
 * Vissa sidor laddar listan som JSON inbäddad i <script>. Vi letar efter objekt
 * som ser ut som uppdrag (har id + titel) och mappar dem.
 */
export function extractJsonAssignments(
  $: cheerio.CheerioAPI,
  opts: { source: string; prefix: string; urlFor: (id: string) => string },
): Assignment[] {
  const out: Assignment[] = [];
  const seen = new Set<string>();
  $("script").each((_, el) => {
    if (/ld\+json/i.test($(el).attr("type") ?? "")) return;
    const src = $(el).html() ?? "";
    if (!/"(Title|title|Rubrik)"\s*:/.test(src)) return;
    for (const blob of findJsonBlobs(src)) {
      walk(blob, (node) => {
        const id =
          node.RequisitionId ?? node.requisitionId ?? node.AssignmentId ?? node.assignmentId ?? node.requestId ?? node.Id ?? node.id;
        const title = node.Title ?? node.title ?? node.Rubrik ?? node.Headline ?? node.headline;
        if (!((typeof id === "number" || (typeof id === "string" && /^\d+$/.test(id))) && typeof title === "string")) return;
        const str = String(id);
        if (seen.has(str)) return;
        seen.add(str);
        out.push(
          stripEmpty({
            id: `${opts.prefix}:${str}`,
            source: opts.source,
            title: clean(title),
            url: opts.urlFor(str),
            company: pickString(node, ["CompanyName", "companyName", "Company", "company", "CustomerName", "customerName", "customer"]),
            location: pickString(node, ["Location", "location", "City", "city", "Municipality", "Country"]),
            published: pickDate(node, ["PublicationStartDate", "PublishedDate", "Published", "publishedAt", "published", "Created", "created", "createdAt"]),
            deadline: pickDate(node, ["PublicationEndDate", "LastApplicationDate", "Deadline", "deadline", "lastReplyDate", "lastReply", "replyBefore"]),
            start: pickDate(node, ["AssignmentStartDate", "StartDate", "startDate"]),
            description: pickString(node, ["Description", "description", "Summary", "summary", "ShortDescription"])?.slice(0, 1500),
          }) as Assignment,
        );
      });
    }
  });
  return out;
}

/** Läser schema.org JobPosting ur <script type="application/ld+json">. */
export function extractJobPosting($: cheerio.CheerioAPI): Partial<Assignment> | null {
  let found: Record<string, unknown> | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (found) return;
    try {
      walk(JSON.parse($(el).html() ?? ""), (node) => {
        if (!found && node["@type"] === "JobPosting") found = node;
      });
    } catch {
      /* trasig JSON-LD */
    }
  });
  if (!found) return null;
  const n = found as Record<string, unknown>;
  const loc = n.jobLocation as Record<string, unknown> | Record<string, unknown>[] | undefined;
  const firstLoc = Array.isArray(loc) ? loc[0] : loc;
  const address = firstLoc?.address as Record<string, unknown> | undefined;
  return stripEmpty({
    title: pickString(n, ["title"]),
    company: pickString(n, ["hiringOrganization"]),
    location: address ? pickString(address, ["addressLocality", "addressRegion", "addressCountry"]) : undefined,
    published: pickDate(n, ["datePosted"]),
    deadline: pickDate(n, ["validThrough"]),
    description: pickString(n, ["description"])?.slice(0, 2500),
  });
}

/** Letar efter en länk till nästa resultatsida (rel=next, "Nästa", "Next", "›", "»") på samma sajt. */
export function findNextPage(html: string, pageUrl: string, hostSuffix: string): string | null {
  const $ = cheerio.load(html);
  const candidates = $('a[rel="next"], link[rel="next"]').toArray().concat(
    $("a[href]")
      .toArray()
      .filter((el) => /^(nästa|next|›|»|>|visa fler|show more|load more)$/i.test(clean($(el).text()) || clean($(el).attr("aria-label")))),
  );
  for (const el of candidates) {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
    try {
      const u = new URL(href, pageUrl);
      if (u.hostname.endsWith(hostSuffix) && u.toString() !== pageUrl) return u.toString();
    } catch {
      /* ignorera */
    }
  }
  return null;
}
