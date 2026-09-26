import type { Assignment } from "../types.ts";
import { clean, stripEmpty } from "../parse-utils.ts";
import { swedishPlace } from "./cinode-parse.ts";

// Generell tolkning av uppdragsobjekt från JSON-API:er (Verama, Magnit m.fl.).

export type Obj = Record<string, unknown>;

export function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return clean(v.replace(/<[^>]+>/g, " "));
  if (typeof v === "number") return String(v);
  return undefined;
}

export function first(o: Obj, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
}

export function isoDate(v: unknown): string | undefined {
  const s = typeof v === "number" ? new Date(v > 1e12 ? v : v * 1000).toISOString() : str(v);
  return s?.match(/20\d{2}-\d{2}-\d{2}/)?.[0];
}

export function nameOf(v: unknown): string | undefined {
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
    max = num(first(inner, ["maxRate", "max", "maxAmount", "to", "amount", "value", "price", "hourlyRate"]));
    min = num(first(inner, ["minRate", "min", "minAmount", "from"]));
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

const LEVELS_SV: Record<string, string> = { JUNIOR: "Junior", MEDIOR: "Medior", MID: "Medior", SENIOR: "Senior", EXPERT: "Expert" };

/** Land ur t.ex. locations[0].country, location.countryCode eller country. */
export function countryOf(o: Obj): string | undefined {
  const loc = first(o, ["location", "locations", "workLocation", "address"]);
  const l = (Array.isArray(loc) ? loc[0] : loc) as Obj | undefined;
  const fromLoc = l && typeof l === "object" ? str(first(l, ["countryCode", "country", "countryName"])) ?? nameOf(l.country) : undefined;
  return fromLoc ?? str(first(o, ["countryCode", "country", "countryName"])) ?? nameOf(o.country);
}

export interface JobMapOptions {
  source: string;
  /** Prefix för id, t.ex. "ework" → "ework:123" */
  prefix: string;
  urlFor: (id: string, o: Obj) => string;
  /** Tillåt id:n som inte är rena siffror (t.ex. "REQ-123" eller UUID). */
  stringIds?: boolean;
}

const ID_KEYS = ["id", "jobRequestId", "requestId", "jobId", "reqId", "postingId", "externalId"];
const TITLE_KEYS = ["title", "jobTitle", "positionTitle", "name", "headline", "roleName", "role"];
// Minst ett av dessa fält måste finnas för att objektet ska räknas som ett uppdrag (inte t.ex. en kompetens).
const JOBISH = [
  "startDate", "endDate", "lastDayOfApplications", "applicationDeadline", "location", "locations", "description",
  "remoteness", "firstDayOfApplications", "publishedAt", "created", "postedDate", "datePosted", "jobDescription",
  "city", "country", "workLocation", "closingDate",
];

/**
 * Mappar ett uppdragsobjekt från ett JSON-API till en Assignment. Fältnamnen
 * är sällan dokumenterade, så flera varianter provas. Returnerar null för
 * objekt som inte ser ut som uppdrag.
 */
export function mapJobObject(o: Obj, opts: JobMapOptions): Assignment | null {
  const id = first(o, ID_KEYS);
  const title = str(first(o, TITLE_KEYS));
  const idOk =
    typeof id === "number" ||
    (typeof id === "string" && (/^\d+$/.test(id) || (opts.stringIds === true && /^[\w-]{3,64}$/.test(id))));
  if (!idOk || !title) return null;
  if (!JOBISH.some((k) => k in o)) return null;
  const idStr = String(id);
  const skills = first(o, ["skills", "competences", "requiredSkills", "tags"]);
  const skillText = Array.isArray(skills) ? skills.map((s) => nameOf((s as Obj)?.skill ?? s)).filter(Boolean).join(", ") : undefined;
  const level = str(first(o, ["level", "seniority"]));
  const levelSv = level ? (LEVELS_SV[level.toUpperCase()] ?? level) : undefined;
  const description = [
    str(first(o, ["description", "jobDescription", "summary", "shortDescription", "text"])),
    levelSv ? `Nivå: ${levelSv}.` : undefined,
    skillText ? `Kompetenser: ${skillText}` : undefined,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 2000);
  return stripEmpty({
    id: `${opts.prefix}:${idStr}`,
    source: opts.source,
    title,
    url: opts.urlFor(idStr, o),
    company: firstName(o, ["client", "legalEntityClient", "customer", "customerName", "clientName", "company", "companyName", "organisation", "organization"]),
    location: locationOf(o),
    country: countryOf(o),
    workMode: workModeOf(o),
    rate: rateOf(o),
    extent: extentOf(o),
    published: isoDate(first(o, ["firstDayOfApplications", "publishedAt", "published", "publishDate", "postedDate", "datePosted", "createdAt", "created"])),
    deadline: isoDate(first(o, ["lastDayOfApplications", "applicationDeadline", "deadline", "lastApplicationDate", "applyBefore", "closingDate"])),
    start: isoDate(first(o, ["startDate", "start", "assignmentStart"])),
    end: isoDate(first(o, ["endDate", "end", "assignmentEnd"])),
    description: description || undefined,
  }) as Assignment;
}

