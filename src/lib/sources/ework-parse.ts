import * as cheerio from "cheerio";
import type { Assignment } from "../types.ts";
import { cardFields, clean, extractJobPosting, findCards, findJsonBlobs, spacedText, stripEmpty, walk } from "../parse-utils.ts";
import { swedishPlace } from "./cinode-parse.ts";

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

type Obj = Record<string, unknown>;

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return clean(v.replace(/<[^>]+>/g, " "));
  if (typeof v === "number") return String(v);
  return undefined;
}

function first(o: Obj, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
}

function isoDate(v: unknown): string | undefined {
  const s = typeof v === "number" ? new Date(v > 1e12 ? v : v * 1000).toISOString() : str(v);
  return s?.match(/20\d{2}-\d{2}-\d{2}/)?.[0];
}

function nameOf(v: unknown): string | undefined {
  if (Array.isArray(v)) return v.map(nameOf).filter(Boolean).join(", ") || undefined;
  if (v && typeof v === "object") {
    const o = v as Obj;
    const direct = str(first(o, ["name", "displayName", "legalName", "companyName", "title", "label"]));
    if (direct) return direct;
    // T.ex. { legalEntity: { name } } eller { company: { name } }
    for (const k of ["legalEntity", "company", "organisation", "organization", "client"]) {
      const inner = o[k];
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        const n = str(first(inner as Obj, ["name", "displayName", "legalName"]));
        if (n) return n;
      }
    }
    return undefined;
  }
  return str(v);
}

function locationOf(o: Obj): string | undefined {
  const loc = first(o, ["location", "locations", "city", "workLocation", "place", "address"]);
  if (Array.isArray(loc)) return loc.map((l) => locationOf({ location: l })).filter(Boolean).join(", ") || undefined;
  if (loc && typeof loc === "object") {
    const l = loc as Obj;
    const city = str(first(l, ["city", "locality", "name", "municipality"]));
    const country = str(first(l, ["country", "countryName"]));
    const place = city ?? nameOf(country);
    return place ? swedishPlace(place) : undefined;
  }
  const s = str(loc);
  return s ? swedishPlace(s) : undefined;
}

function workModeOf(o: Obj): string | undefined {
  const pct = first(o, ["remoteness", "remotePercentage", "remote_percentage", "remotePercent"]);
  const n = typeof pct === "number" ? pct : Number(str(pct));
  if (Number.isFinite(n)) {
    if (n <= 0) return "På plats";
    if (n >= 100) return "Distans";
    return `Hybrid · ${Math.round(n)} % distans`;
  }
  const mode = str(first(o, ["remote", "workMode", "workplaceType", "remoteType"]));
  if (!mode) return undefined;
  if (/^(true|remote|fully.?remote|distans)$/i.test(mode)) return "Distans";
  if (/^(false|onsite|on.?site|office)$/i.test(mode)) return "På plats";
  if (/hybrid/i.test(mode)) return "Hybrid";
  return mode;
}

/** Första nyckel som ger ett namn (hoppar över t.ex. objekt utan namnfält eller null). */
function firstName(o: Obj, keys: string[]): string | undefined {
  for (const k of keys) {
    const n = nameOf(o[k]);
    if (n) return n;
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/\s/g, "").replace(",", ".")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Pris ur t.ex. `rate: 850`, `rate: { amount: 850, currency: "SEK" }`,
 * `rate: { min: 700, max: 900 }` eller `rate: { value: { amount } }`.
 */
export function rateOf(o: Obj): string | undefined {
  const raw = first(o, ["rate", "hourlyRate", "price", "maxRate", "rateMax"]);
  let min: number | undefined;
  let max: number | undefined;
  let currency = str(first(o, ["currency", "rateCurrency"]));
  let unit = "tim";
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Obj;
    const inner = (r.value && typeof r.value === "object" ? r.value : r) as Obj;
    max = num(first(inner, ["max", "maxAmount", "to", "amount", "value", "price", "hourlyRate"]));
    min = num(first(inner, ["min", "minAmount", "from"]));
    currency = str(first(inner, ["currency", "currencyCode"])) ?? str(first(r, ["currency", "currencyCode"])) ?? currency;
    const per = str(first(r, ["unit", "type", "period", "rateType"]));
    if (per && /month|månad/i.test(per)) unit = "mån";
  } else {
    max = num(raw);
  }
  if (!max && !min) return undefined;
  const cur = !currency || /^(SEK|kr)$/i.test(currency) ? "kr" : currency.toUpperCase();
  const amount = min && max && min !== max ? `${min}–${max}` : String(max ?? min);
  return `${amount} ${cur}/${unit}`;
}

function extentOf(o: Obj): string | undefined {
  const h = num(first(o, ["hoursPerWeek", "hours", "workload"]));
  if (h) return `${h} tim/vecka`;
  const pct = num(first(o, ["extent", "scope", "workloadPercentage"]));
  return pct && pct <= 100 ? `${pct} %` : undefined;
}

/**
 * Mappar ett uppdragsobjekt från Veramas JSON till en Assignment. Fältnamnen
 * är inte dokumenterade, så flera varianter provas. Returnerar null för
 * objekt som inte ser ut som uppdrag.
 */
export function mapVeramaJob(o: Obj): Assignment | null {
  const id = first(o, ["id", "jobRequestId", "requestId"]);
  const title = str(first(o, ["title", "name", "headline", "roleName", "role"]));
  if (!(typeof id === "number" || (typeof id === "string" && /^\d+$/.test(id))) || !title) return null;
  // Kräv minst ett fält som tyder på att objektet är ett uppdrag (inte t.ex. en kompetens).
  const jobish = ["startDate", "endDate", "lastDayOfApplications", "applicationDeadline", "location", "locations", "description", "remoteness", "firstDayOfApplications", "publishedAt", "created"];
  if (!jobish.some((k) => k in o)) return null;
  const idStr = String(id);
  const skills = first(o, ["skills", "competences", "requiredSkills", "tags"]);
  const skillText = Array.isArray(skills) ? skills.map((s) => nameOf((s as Obj)?.skill ?? s)).filter(Boolean).join(", ") : undefined;
  const description = [str(first(o, ["description", "summary", "shortDescription", "text"])), skillText ? `Kompetenser: ${skillText}` : undefined]
    .filter(Boolean)
    .join(" ")
    .slice(0, 2000);
  return stripEmpty({
    id: `ework:${idStr}`,
    source: "Ework",
    title,
    url: veramaUrl(idStr),
    company: firstName(o, ["client", "legalEntityClient", "customer", "customerName", "clientName", "company", "companyName", "organisation", "organization"]),
    location: locationOf(o),
    workMode: workModeOf(o),
    rate: rateOf(o),
    extent: extentOf(o),
    published: isoDate(first(o, ["firstDayOfApplications", "publishedAt", "published", "publishDate", "createdAt", "created"])),
    deadline: isoDate(first(o, ["lastDayOfApplications", "applicationDeadline", "deadline", "lastApplicationDate", "applyBefore"])),
    start: isoDate(first(o, ["startDate", "start", "assignmentStart"])),
    end: isoDate(first(o, ["endDate", "end", "assignmentEnd"])),
    description: description || undefined,
  }) as Assignment;
}

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
