import * as cheerio from "cheerio";
import type { Assignment } from "../types.ts";
import { cardFields, clean, extractJobPosting, findCards, findJsonBlobs, spacedText, stripEmpty, walk } from "../parse-utils.ts";
import { isoDate, mapJobObject, str, type Obj } from "./job-json.ts";
import { swedishPlace } from "./cinode-parse.ts";

// Magnit publicerar alla sina uppdrag öppet på marknadsplatsen Magnit Source:
//   https://magnit-source.magnitglobal.com/
// Sajten är global; appen filtrerar fram uppdrag i Sverige.
export const MAGNIT_BASE = "https://magnit-source.magnitglobal.com";
// Sajtens API-server (OPENMARKET_API_BASE_URL i sajtens JavaScript, 2026-09-26).
export const MAGNIT_GATEWAY = process.env.MAGNIT_GATEWAY_URL ?? "https://app-openmarketgateway-prod.azurewebsites.net";

// Tänkbara adressmönster för ett enskilt uppdrag (sajtens struktur är inte känd än).
const JOB_RE =
  /^(?:https?:\/\/[\w.-]*magnitglobal\.com)?(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/(?:jobs?|job-requests?|requests?|opportunit(?:y|ies)|positions?|postings?)\/([\w-]{3,64})\/?(?:[?#].*)?$/i;
const NOT_IDS = new Set(["search", "list", "all", "new", "latest", "filter", "filters", "apply", "saved", "sweden", "sverige"]);

export function extractMagnitId(href: string): string | null {
  const m = href.match(JOB_RE);
  if (!m || NOT_IDS.has(m[1].toLowerCase())) return null;
  return m[1];
}

/** Uppdragets adress: objektets egen länk om den finns, annars en gissning. */
export function magnitUrl(id: string, o?: Obj): string {
  const link = o ? str(o.url ?? o.link ?? o.jobUrl ?? o.publicUrl ?? o.applyUrl ?? o.href) : undefined;
  if (link) {
    try {
      return new URL(link, MAGNIT_BASE).toString();
    } catch {
      /* ogiltig länk */
    }
  }
  return `${MAGNIT_BASE}/jobs/${encodeURIComponent(id)}`;
}

const OPTS = { source: "Magnit", prefix: "magnit", urlFor: magnitUrl, stringIds: true };

// Kundnamn som bara betyder "Magnits kund" och inte säger något.
const PLACEHOLDER_CLIENTS = /^(client of magnit|magnit|confidential|konfidentiell)$/i;

/**
 * Magnit-specifika fält ovanpå den generella mappningen:
 * "Stockholm, SWE" → ort + land, submissionDeadline, kund ur clientInfo när company är "-".
 */
function mapMagnitJob(o: Obj): Assignment | null {
  const a = mapJobObject(o, OPTS);
  if (!a) return null;
  const loc = str(o.location)?.match(/^(.*?),\s*([A-Z]{2,3})$/);
  if (loc) {
    a.location = swedishPlace(loc[1].replace(/^'/, "").trim());
    a.country = loc[2];
  }
  a.deadline = a.deadline ?? isoDate(o.submissionDeadline);
  if (!a.company || PLACEHOLDER_CLIENTS.test(a.company)) {
    const client = o.clientInfo && typeof o.clientInfo === "object" ? str((o.clientInfo as Obj).name) : undefined;
    a.company = client && !PLACEHOLDER_CLIENTS.test(client) ? client : undefined;
    if (!a.company) delete a.company;
  }
  return a;
}

/** Alla uppdrag i ett godtyckligt JSON-svar. */
export function parseMagnitJson(json: unknown): Assignment[] {
  const byId = new Map<string, Assignment>();
  walk(json, (node) => {
    const a = mapMagnitJob(node);
    if (a && !byId.has(a.id)) byId.set(a.id, a);
  });
  return [...byId.values()];
}

// ---- Sverigefilter ----

const SWEDISH_PLACES = [
  "sweden", "sverige", "stockholm", "göteborg", "goteborg", "gothenburg", "malmö", "malmo", "uppsala", "linköping",
  "linkoping", "västerås", "vasteras", "örebro", "orebro", "norrköping", "helsingborg", "jönköping", "umeå", "umea",
  "lund", "luleå", "lulea", "sundsvall", "gävle", "södertälje", "solna", "kista", "karlstad", "växjö", "halmstad",
  "borås", "eskilstuna", "sollentuna", "nacka", "botkyrka", "kalmar", "skövde", "trollhättan", "östersund",
];

/** Sant om uppdraget är i Sverige, eller om platsen är okänd. */
export function isSwedish(a: Pick<Assignment, "country" | "location">): boolean {
  const country = a.country?.trim().toLowerCase();
  if (country) return ["se", "swe", "sweden", "sverige"].includes(country);
  const loc = a.location?.toLowerCase();
  if (!loc) return true;
  return SWEDISH_PLACES.some((p) => loc.includes(p));
}

// ---- HTML ----

/** Tolkar HTML: inbäddad JSON (t.ex. __NEXT_DATA__), JSON-LD och uppdragslänkar. */
export function parseMagnitHtml(html: string, pageUrl = MAGNIT_BASE): Assignment[] {
  const $ = cheerio.load(html);
  const byId = new Map<string, Assignment>();

  $("script").each((_, el) => {
    const src = $(el).html() ?? "";
    if (!/"(title|jobTitle|name)"\s*:/.test(src)) return;
    const blobs: unknown[] = [];
    try {
      blobs.push(JSON.parse(src));
    } catch {
      blobs.push(...findJsonBlobs(src));
    }
    for (const b of blobs) for (const a of parseMagnitJson(b)) if (!byId.has(a.id)) byId.set(a.id, a);
  });

  for (const { id, href, card, anchor } of findCards($, (h) => {
    try {
      return extractMagnitId(new URL(h, pageUrl).toString());
    } catch {
      return null;
    }
  })) {
    const key = `magnit:${id}`;
    if (byId.has(key)) continue;
    const f = cardFields($, card, anchor);
    const rest = (f.title && f.cardText.startsWith(f.title) ? f.cardText.slice(f.title.length) : f.cardText).trim();
    byId.set(
      key,
      stripEmpty({
        id: key,
        source: "Magnit",
        title: f.title,
        url: new URL(href, pageUrl).toString(),
        company: f.company,
        location: f.location,
        published: f.dates[0],
        description: rest.length > 20 ? rest.slice(0, 600) : undefined,
      }) as Assignment,
    );
  }
  return [...byId.values()].filter((a) => a.title);
}

/** Tolkar en uppdragssida. */
export function parseMagnitDetail(html: string): Partial<Assignment> {
  const $ = cheerio.load(html);
  const fromJson = parseMagnitHtml(html)[0];
  const ld = extractJobPosting($) ?? {};
  const rawTitle = clean($('meta[property="og:title"]').attr("content") ?? $("title").text());
  const title = rawTitle.replace(/\s*[-–|]\s*Magnit(?: Source)?.*$/i, "").trim() || undefined;
  const desc = clean($('meta[property="og:description"]').attr("content") ?? $('meta[name="description"]').attr("content"));
  $("script, style, noscript, nav, header, footer").remove();
  const body = spacedText($, $("main").length ? $("main") : $("body"));
  const description = [fromJson?.description, ld.description, desc, body.length > 200 ? body : ""]
    .filter((d): d is string => !!d && !/open job requests from leading companies|enable javascript/i.test(d))
    .sort((a, b) => b.length - a.length)[0];
  return stripEmpty({
    title: fromJson?.title || ld.title || (title && !/^magnit source/i.test(title) ? title : undefined),
    company: fromJson?.company || ld.company,
    location: fromJson?.location || ld.location,
    country: fromJson?.country,
    published: fromJson?.published || ld.published,
    deadline: fromJson?.deadline || ld.deadline,
    start: fromJson?.start,
    end: fromJson?.end,
    description: description?.slice(0, 2500),
  });
}
