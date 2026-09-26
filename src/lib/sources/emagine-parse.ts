import * as cheerio from "cheerio";
import type { Assignment } from "../types.ts";
import { cardFields, clean, DATE_RE, extractJobPosting, findCards, findJsonBlobs, spacedText, stripEmpty, walk } from "../parse-utils.ts";
import { mapJobObject, str, type Obj } from "./job-json.ts";
import { swedishPlace } from "./cinode-parse.ts";

// emagine publicerar uppdrag för frilanskonsulter i sin portal:
//   https://portal.emagine.org/jobs/179236/2-systemutvecklare-med-ai-kompetens-inom-vrden
// och listar dem även på landssajterna, t.ex.
//   https://emagine-consulting.se/consultants/freelance-jobs/
//   https://www.emagine.org/consultants/freelance-jobs/128578/<titel>/?id=163945
// emagine finns i flera länder; appen filtrerar fram Sverige.
export const EMAGINE_PORTAL = "https://portal.emagine.org";

const HOSTS = /(?:portal\.)?emagine(?:-consulting)?\.(?:org|se|com|dk|no|pl|nl|de|co\.uk)/i;
const JOB_RE = new RegExp(
  String.raw`^(?:https?:\/\/(?:www\.)?${HOSTS.source})?(?:\/[a-z]{2})?\/(?:jobs|consultants\/freelance-jobs|freelance-jobs)\/(\d{3,8})(?:\/[\w%.-]*)?\/?(?:[?#].*)?$`,
  "i",
);

export function extractEmagineId(href: string): string | null {
  return href.match(JOB_RE)?.[1] ?? null;
}

/** Portalens egen slug-funktion (chunk-JD6HBCB5.js): "2 Systemutvecklare!" → "2-systemutvecklare". */
export function emagineSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Kanonisk adress: uppdragssidan i portalen (/jobs/<id>/<slug>). */
export function emagineUrl(id: string, href?: string, title?: string): string {
  if (href) {
    try {
      const u = new URL(href, EMAGINE_PORTAL);
      if (u.hostname === "portal.emagine.org") return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
    } catch {
      /* ogiltig länk */
    }
  }
  const slug = title ? emagineSlug(title) : "";
  return `${EMAGINE_PORTAL}/jobs/${id}${slug ? `/${slug}` : ""}`;
}

/** "2 Systemutvecklare … • emagine Portal" → "2 Systemutvecklare …" */
export function parseEmagineTitle(raw: string): string | undefined {
  const t = clean(raw)
    .replace(/^emagine(?: Portal)?\s*[•|–-]\s*/i, "")
    .replace(/\s*[•|–-]\s*emagine(?: Portal)?\s*$/i, "")
    .trim();
  if (!t || /^emagine(?: portal)?$/i.test(t) || /^(freelance jobs|for freelance consultants)/i.test(t)) return undefined;
  return t;
}

const OPTS = {
  source: "emagine",
  prefix: "emagine",
  urlFor: (id: string, o: Obj) =>
    emagineUrl(id, typeof o.url === "string" ? o.url : undefined, [o.title, o.jobTitle, o.name].find((t): t is string => typeof t === "string")),
};

const WORK_MODES: Record<string, string> = { remote: "Distans", onsite: "På plats", hybrid: "Hybrid" };

/** "12.10.2026" → "2026-10-12"; "ASAP"/"N/A" → startText. */
function emagineStart(v: unknown): Pick<Assignment, "start" | "startText"> {
  const s = typeof v === "string" ? v.trim() : "";
  const dmy = s.match(/^(\d{1,2})\.(\d{1,2})\.(20\d{2})$/);
  if (dmy) return { start: `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}` };
  if (/^asap$/i.test(s)) return { startText: "Snarast" };
  if (!s || /^n\/?a$/i.test(s)) return {};
  return { start: s.match(/20\d{2}-\d{2}-\d{2}/)?.[0], startText: s.match(/20\d{2}-\d{2}-\d{2}/) ? undefined : s };
}

/** "1-3 months" → "1–3 månader", "> 12 months" → "> 12 månader". */
function emagineDuration(v: unknown): string | undefined {
  const s = typeof v === "string" ? clean(v) : "";
  if (!s || /^n\/?a$/i.test(s)) return undefined;
  return s
    .replace(/(\d)\s*-\s*(\d)/g, "$1–$2")
    .replace(/\bmonths?\b/i, "månader")
    .replace(/\bweeks?\b/i, "veckor")
    .replace(/\byears?\b/i, "år");
}

const nameIn = (v: unknown) => (v && typeof v === "object" ? str((v as Obj).name) : undefined);

/**
 * Ett uppdrag i sökresultatet från POST /api/JobAds/Search (2026-09-26):
 *   { id, title, startDate: "12.10.2026"|"ASAP"|"N/A", duration: "1-3 months", requestId,
 *     isPartTime, jobAdWorkLocation: { workLocationType: "Remote"|"Onsite"|"Hybrid",
 *     city, region, country: "Norway" }, area: { name }, industry: { name } }
 */
export function mapEmagineJob(o: Obj): Assignment | null {
  const loc = o.jobAdWorkLocation;
  if (!loc || typeof loc !== "object" || (typeof o.id !== "number" && !/^\d+$/.test(String(o.id ?? "")))) return null;
  const title = str(o.title);
  if (!title) return null;
  const id = String(o.id);
  const l = loc as Obj;
  const city = str(l.city) ?? str(l.region);
  const country = str(l.country);
  const mode = typeof l.workLocationType === "string" ? WORK_MODES[l.workLocationType.toLowerCase()] : undefined;
  const area = nameIn(o.area);
  const industry = nameIn(o.industry);
  return stripEmpty({
    id: `emagine:${id}`,
    source: "emagine",
    title,
    url: emagineUrl(id, undefined, title),
    location: city ? swedishPlace(city) : country === "Sweden" ? "Sverige" : country,
    country,
    workMode: mode,
    ...emagineStart(o.startDate),
    duration: emagineDuration(o.duration),
    extent: o.isPartTime === true ? "Deltid" : undefined,
    description: [area && `Område: ${area}.`, industry && `Bransch: ${industry}.`].filter(Boolean).join(" ") || undefined,
  }) as Assignment;
}

/** Uppdrag i godtycklig JSON (API-svar eller inbäddad data). */
export function parseEmagineJson(json: unknown): Assignment[] {
  const byId = new Map<string, Assignment>();
  walk(json, (node) => {
    const a = mapEmagineJob(node) ?? mapJobObject(node, OPTS);
    if (a && !byId.has(a.id)) byId.set(a.id, a);
  });
  return [...byId.values()];
}

/**
 * Detaljer ur GET /api/JobAds/details/{id}/En. Svarets format är inte känt, så
 * texten tas ur alla fält som ser ut som beskrivningar (HTML rensas).
 */
export function parseEmagineApiDetail(json: unknown): Partial<Assignment> {
  if (!json || typeof json !== "object") return {};
  const texts: string[] = [];
  walk(json, (node) => {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v !== "string" || v.length < 40) continue;
      if (!/description|about|task|responsib|requirement|qualif|offer|profile|content|body|text/i.test(k)) continue;
      const t = clean(cheerio.load(v).text().replace(/\s+/g, " "));
      if (t && !texts.includes(t)) texts.push(t);
    }
  });
  const base = mapJobObject(json as Obj, OPTS);
  return stripEmpty({
    company: base?.company,
    deadline: base?.deadline,
    published: base?.published,
    rate: base?.rate,
    end: base?.end,
    description: texts.join("\n\n").slice(0, 3000) || undefined,
  });
}

// Etiketter som förekommer på listkort och uppdragssidor (svenska och engelska).
const LOCATION = /(?:^|\s)(?:Location|Plats|Ort|Placering|Arbetsort)\s*:?\s+([\p{Lu}][\p{L}.' -]{1,40}?)(?=\s+(?:[\p{Lu}][\p{L}]+\s*:|Start|Duration|Varaktighet|Omfattning|Remote|Distans|Deadline|Sista|\d)|[,;|]|$)/u;
const DATE_TEXT = String.raw`(20\d{2}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]20\d{2}|\d{1,2}\s+[A-Za-zåäö]{3,9}\.?,?\s+20\d{2})`;

function normalizeDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const iso = s.match(/20\d{2}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  const dmy = s.match(/^(\d{1,2})[./](\d{1,2})[./](20\d{2})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const months: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, maj: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12 };
  const m = s.match(/(\d{1,2})\s+([A-Za-zåäö]{3})[A-Za-zåäö]*\.?,?\s+(20\d{2})/);
  const mon = m && months[m[2].toLowerCase()];
  return m && mon ? `${m[3]}-${String(mon).padStart(2, "0")}-${m[1].padStart(2, "0")}` : undefined;
}

function dateAfter(text: string, labels: string): string | undefined {
  return normalizeDate(text.match(new RegExp(`(?:${labels})\\s*:?\\s*${DATE_TEXT}`, "i"))?.[1]);
}

/** Strukturerade fält ur fritext på kort och uppdragssidor. */
export function emagineFieldsFromText(text: string): Partial<Assignment> {
  const loc = text.match(LOCATION)?.[1]?.trim();
  const remote = text.match(/\b(\d{1,3})\s*%\s*(?:remote|distans)/i)?.[1] ?? text.match(/(?:remote|distans)\s*:?\s*(\d{1,3})\s*%/i)?.[1];
  const fullyRemote = /\b(fully remote|100\s*% remote|helt på distans)\b/i.test(text);
  const onsite = /\b(on-?site|på plats)\b/i.test(text) && !remote;
  return stripEmpty({
    location: loc ? swedishPlace(loc) : undefined,
    start: dateAfter(text, "Start date|Startdatum|Start|Uppstart"),
    end: dateAfter(text, "End date|Slutdatum|Until|Till och med"),
    deadline: dateAfter(text, "Deadline|Application deadline|Sista ansökningsdag|Sista dag att ansöka|Apply by|Ansök senast"),
    workMode: fullyRemote ? "Distans" : remote ? (Number(remote) >= 100 ? "Distans" : `Hybrid · ${remote} % distans`) : onsite ? "På plats" : undefined,
  });
}

/** Tolkar en listsida: uppdragslänkar/kort och inbäddad JSON. */
export function parseEmagineListing(html: string, pageUrl = `${EMAGINE_PORTAL}/jobs`): Assignment[] {
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
    for (const b of blobs) for (const a of parseEmagineJson(b)) if (!byId.has(a.id)) byId.set(a.id, a);
  });

  for (const { id, href, card, anchor } of findCards($, (h) => {
    try {
      return extractEmagineId(new URL(h, pageUrl).toString());
    } catch {
      return null;
    }
  })) {
    const key = `emagine:${id}`;
    const f = cardFields($, card, anchor);
    const title = parseEmagineTitle(f.title) ?? f.title;
    const rest = (f.cardText.startsWith(f.title) ? f.cardText.slice(f.title.length) : f.cardText).trim();
    const fields = emagineFieldsFromText(rest);
    const candidate = stripEmpty({
      id: key,
      source: "emagine",
      title,
      url: emagineUrl(id, new URL(href, pageUrl).toString()),
      company: f.company,
      location: f.location ? swedishPlace(f.location) : fields.location,
      ...fields,
      published: f.dates.length && !fields.start && !fields.deadline ? f.dates[0] : undefined,
      description: rest.length > 30 && !/^(read more|läs mer|apply|ansök)$/i.test(rest) ? rest.slice(0, 600) : undefined,
    }) as Assignment;
    const existing = byId.get(key);
    byId.set(key, existing ? ({ ...candidate, ...existing } as Assignment) : candidate);
  }
  return [...byId.values()].filter((a) => a.title);
}

/** Sant om uppdragssidan säger att ansökan är stängd. */
export function isClosed(text: string): boolean {
  return /no longer (?:accepting|accepts) applications|applications are closed|ansökan (?:är )?stängd|tar inte längre emot ansökningar/i.test(text);
}

/** Tolkar en uppdragssida i portalen. */
export function parseEmagineDetail(html: string): Partial<Assignment> & { closed?: boolean } {
  const $ = cheerio.load(html);
  const fromJson = parseEmagineListing(html)[0];
  const ld = extractJobPosting($) ?? {};
  const title = parseEmagineTitle($('meta[property="og:title"]').attr("content") ?? "") ?? parseEmagineTitle($("title").text());
  const ogDesc = clean($('meta[property="og:description"]').attr("content") ?? $('meta[name="description"]').attr("content"));
  $("script, style, noscript, nav, header, footer").remove();
  const body = spacedText($, $("main").length ? $("main") : $("body"));
  const fields = emagineFieldsFromText(body);
  const dates = [...body.matchAll(DATE_RE)].map((m) => m[1]);
  const description = [ld.description, fromJson?.description, body.length > 200 ? body : "", ogDesc]
    .filter((d): d is string => !!d)
    .sort((a, b) => b.length - a.length)[0];
  return stripEmpty({
    title: ld.title || title || fromJson?.title || clean($("h1").first().text()) || undefined,
    company: ld.company || fromJson?.company,
    location: ld.location || fromJson?.location || fields.location,
    country: fromJson?.country,
    published: ld.published || fromJson?.published,
    deadline: ld.deadline || fromJson?.deadline || fields.deadline,
    start: fromJson?.start || fields.start || (fields.deadline ? undefined : dates[0]),
    end: fromJson?.end || fields.end,
    workMode: fromJson?.workMode || fields.workMode,
    rate: fromJson?.rate,
    description: description?.slice(0, 2500),
    closed: isClosed(body) || undefined,
  });
}
