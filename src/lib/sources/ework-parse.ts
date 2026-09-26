import * as cheerio from "cheerio";
import type { Assignment } from "../types.ts";
import { cardFields, clean, extractJobPosting, findCards, findJsonBlobs, spacedText, stripEmpty, walk } from "../parse-utils.ts";
import { mapJobObject, type JobMapOptions, type Obj } from "./job-json.ts";

// Ework publicerar sina uppdrag på plattformen Verama:
//   https://app.verama.com/sv/job-requests          (lista, JavaScript-app)
//   https://app.verama.com/job-requests/33112       (enskilt uppdrag)
export const VERAMA_BASE = "https://app.verama.com";

const JOB_RE = /^(?:https?:\/\/(?:app\.)?verama\.com)?(?:\/(?:sv|en|app))?\/job-requests\/(\d+)(?:[/?#]|$)/i;

export function extractVeramaId(href: string): string | null {
  return href.match(JOB_RE)?.[1] ?? null;
}

export function veramaUrl(id: string): string {
  return `${VERAMA_BASE}/sv/job-requests/${id}`;
}

/** "API Specialist - Ework Verama" / "Backend Developer | Verama" → "API Specialist". */
export function parseVeramaTitle(raw: string): string | undefined {
  const t = clean(raw)
    .replace(/\s*[-–|]\s*(?:Ework\s+)?Verama\s*$/i, "")
    .replace(/\s*[-–|]\s*Ework(?: Group)?\s*$/i, "")
    .trim();
  if (!t || /^(?:Ework\s+)?Verama$/i.test(t) || /discover hundreds|upptäck hundratals/i.test(t)) return undefined;
  return t;
}

const VERAMA_OPTS: JobMapOptions = { source: "Ework", prefix: "ework", urlFor: (id) => veramaUrl(id) };

/** Mappar ett uppdragsobjekt från Veramas JSON (se job-json.ts). */
export function mapVeramaJob(o: Obj): Assignment | null {
  const a = mapJobObject(o, VERAMA_OPTS);
  if (a) delete a.country;
  return a;
}

export { rateOf } from "./job-json.ts";

/** Hittar alla uppdrag i ett godtyckligt JSON-svar (lista, sida, { content: [...] } osv.). */
export function parseVeramaJson(json: unknown): Assignment[] {
  const byId = new Map<string, Assignment>();
  walk(json, (node) => {
    const a = mapVeramaJob(node);
    if (a && !byId.has(a.id)) byId.set(a.id, a);
  });
  return [...byId.values()];
}

/** Läser pagineringsinfo ur ett Spring-liknande svar ({ totalPages, last, number }). */
export function veramaPageInfo(json: unknown): { totalPages?: number; last?: boolean } {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  const o = json as Obj;
  const page = (o.page && typeof o.page === "object" ? o.page : o) as Obj;
  const totalPages = typeof page.totalPages === "number" ? page.totalPages : undefined;
  const last = typeof o.last === "boolean" ? o.last : undefined;
  return stripEmpty({ totalPages, last });
}

/** Tolkar HTML: uppdragslänkar, inbäddad JSON (t.ex. Angulars transfer state) och JSON-LD. */
export function parseVeramaHtml(html: string, pageUrl = VERAMA_BASE): Assignment[] {
  const $ = cheerio.load(html);
  const byId = new Map<string, Assignment>();

  $("script").each((_, el) => {
    const src = $(el).html() ?? "";
    if (!/"(title|name)"\s*:/.test(src)) return;
    const blobs: unknown[] = [];
    try {
      blobs.push(JSON.parse(src));
    } catch {
      blobs.push(...findJsonBlobs(src));
    }
    for (const b of blobs) for (const a of parseVeramaJson(b)) if (!byId.has(a.id)) byId.set(a.id, a);
  });

  for (const { id, card, anchor } of findCards($, (href) => {
    try {
      return extractVeramaId(new URL(href, pageUrl).toString());
    } catch {
      return null;
    }
  })) {
    const key = `ework:${id}`;
    if (byId.has(key)) continue;
    const f = cardFields($, card, anchor);
    byId.set(key, stripEmpty({ id: key, source: "Ework", title: f.title || "", url: veramaUrl(id), company: f.company, location: f.location }) as Assignment);
  }
  return [...byId.values()];
}

/** Tolkar en detaljsida (titel och meta är serverrenderade även om resten är JavaScript). */
export function parseVeramaDetail(html: string): Partial<Assignment> {
  const $ = cheerio.load(html);
  const fromJson = parseVeramaHtml(html)[0];
  const ld = extractJobPosting($) ?? {};
  const title =
    parseVeramaTitle($('meta[property="og:title"]').attr("content") ?? "") ?? parseVeramaTitle($("title").text()) ?? ld.title;
  const desc = clean($('meta[property="og:description"]').attr("content") ?? $('meta[name="description"]').attr("content"));
  $("script, style, noscript").remove();
  const body = spacedText($, $("body"));
  const description = [fromJson?.description, ld.description, desc, body.length > 200 ? body : ""]
    .filter((d): d is string => !!d && !/discover hundreds|upptäck hundratals|javascript/i.test(d))
    .sort((a, b) => b.length - a.length)[0];
  return stripEmpty({
    ...fromJson,
    title: fromJson?.title || title,
    company: fromJson?.company || ld.company,
    location: fromJson?.location || ld.location,
    published: fromJson?.published || ld.published,
    deadline: fromJson?.deadline || ld.deadline,
    description: description?.slice(0, 2500),
  });
}
