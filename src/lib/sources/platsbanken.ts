import type { Assignment, SourceStatus } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { stripEmpty, walk } from "../parse-utils.ts";
import { isoDate, str, type Obj } from "./job-json.ts";

// Arbetsförmedlingens Platsbanken via det öppna JobSearch-API:t (JobTech Dev):
//   GET https://jobsearch.api.jobtechdev.se/search?q=<ord>&limit=100&sort=pubdate-desc
//   → { total: { value }, hits: [{ id, headline, webpage_url, employer, workplace_address,
//       publication_date, application_deadline, description, employment_type, duration, … }] }
// Platsbanken innehåller främst anställningar, så källan används bara när någon söker
// med nyckelord och visas som en egen källa som kan döljas i appen.
export const PLATSBANKEN = "Platsbanken";
export const JOBSEARCH_API = process.env.JOBTECH_API_URL ?? "https://jobsearch.api.jobtechdev.se";
const MAX_KEYWORDS = Number(process.env.PLATSBANKEN_MAX_KEYWORDS ?? 8);
const PER_KEYWORD = Math.min(100, Number(process.env.PLATSBANKEN_PER_KEYWORD ?? 100));

export const platsbankenSearchUrl = (keyword: string, limit = PER_KEYWORD) =>
  `${JOBSEARCH_API}/search?q=${encodeURIComponent(keyword)}&limit=${limit}&sort=pubdate-desc`;

const label = (v: unknown) => (v && typeof v === "object" ? str((v as Obj).label) : undefined);

/** "50"–"100" → "50–100 %", 100–100 → "100 %". */
function scopeOf(v: unknown): string | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { min, max } = v as { min?: unknown; max?: unknown };
  if (typeof min !== "number" && typeof max !== "number") return undefined;
  return min === max || typeof min !== "number" || typeof max !== "number" ? `${max ?? min} %` : `${min}–${max} %`;
}

/** En annons (hit) från JobSearch-API:t. */
export function mapPlatsbankenHit(o: Obj): Assignment | null {
  const id = str(o.id);
  const title = str(o.headline);
  if (!id || !title) return null;
  const employer = (o.employer && typeof o.employer === "object" ? o.employer : {}) as Obj;
  const addr = (o.workplace_address && typeof o.workplace_address === "object" ? o.workplace_address : {}) as Obj;
  const desc = o.description && typeof o.description === "object" ? str((o.description as Obj).text) : undefined;
  const meta = [
    label(o.employment_type) && `Anställningsform: ${label(o.employment_type)}.`,
    label(o.occupation) && `Yrke: ${label(o.occupation)}.`,
  ]
    .filter(Boolean)
    .join(" ");
  const hours = label(o.working_hours_type);
  const scope = scopeOf(o.scope_of_work);
  return stripEmpty({
    id: `platsbanken:${id}`,
    source: PLATSBANKEN,
    title,
    url: str(o.webpage_url) ?? `https://arbetsformedlingen.se/platsbanken/annonser/${encodeURIComponent(id)}`,
    company: str(employer.name) ?? str(employer.workplace),
    location: str(addr.municipality) ?? str(addr.city) ?? str(addr.region),
    country: str(addr.country),
    published: isoDate(o.publication_date),
    deadline: isoDate(o.application_deadline),
    duration: label(o.duration),
    extent: [hours, scope && scope !== "100 %" ? scope : undefined].filter(Boolean).join(", ") || undefined,
    description: [meta, desc].filter(Boolean).join(" ").slice(0, 2000) || undefined,
  }) as Assignment;
}

/** Alla annonser i ett JSON-svar (används även av /api/debug). */
export function parsePlatsbankenJson(json: unknown): Assignment[] {
  const hits = json && typeof json === "object" && Array.isArray((json as Obj).hits) ? ((json as Obj).hits as Obj[]) : [];
  const out: Assignment[] = [];
  if (hits.length) {
    for (const h of hits) {
      const a = mapPlatsbankenHit(h);
      if (a) out.push(a);
    }
    return out;
  }
  walk(json, (n) => {
    if ("headline" in n) {
      const a = mapPlatsbankenHit(n);
      if (a) out.push(a);
    }
  });
  return out;
}

/** Söker i Platsbanken efter varje nyckelord (nyaste först). */
export async function searchPlatsbanken(
  keywords: string[],
): Promise<{ items: Assignment[]; hits: Map<string, Set<string>>; status: SourceStatus }> {
  const words = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].slice(0, MAX_KEYWORDS);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (process.env.JOBTECH_API_KEY) headers["api-key"] = process.env.JOBTECH_API_KEY;
  const errors: string[] = [];
  const totals: number[] = [];
  const results = await mapLimit(words, 4, async (kw) => {
    try {
      const res = await fetchText(platsbankenSearchUrl(kw), { headers, timeoutMs: 8000, revalidate: 900 });
      if (res.status >= 400) {
        errors.push(`"${kw}": HTTP ${res.status}`);
        return [];
      }
      const json = JSON.parse(res.body) as { total?: { value?: number } };
      if (typeof json.total?.value === "number") totals.push(json.total.value);
      return parsePlatsbankenJson(json);
    } catch (err) {
      errors.push(`"${kw}": ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  });
  const byId = new Map<string, Assignment>();
  const hits = new Map<string, Set<string>>();
  results.forEach((items, i) => {
    for (const a of items) {
      if (!byId.has(a.id)) byId.set(a.id, a);
      if (!hits.has(a.id)) hits.set(a.id, new Set());
      hits.get(a.id)!.add(words[i]);
    }
  });
  const items = [...byId.values()];
  const failedAll = words.length > 0 && errors.length === words.length;
  return {
    items,
    hits,
    status: {
      source: PLATSBANKEN,
      ok: !failedAll,
      count: items.length,
      strategies: [
        `JobSearch-API, ${words.length} ord, max ${PER_KEYWORD} per ord`,
        ...(totals.length ? [`träffar i Platsbanken: ${totals.reduce((a, b) => a + b, 0)}`] : []),
        ...errors.map((e) => `fel: ${e}`),
      ],
      error: failedAll ? `Kunde inte söka i Platsbanken (${errors[0]})` : undefined,
      fetchedAt: new Date().toISOString(),
    },
  };
}

/** Status när ingen har sökt: källan finns men används först med nyckelord. */
export function idlePlatsbankenStatus(): SourceStatus {
  return {
    source: PLATSBANKEN,
    ok: true,
    count: 0,
    idle: true,
    strategies: ["Söks med dina nyckelord (Arbetsförmedlingens JobSearch-API)"],
    fetchedAt: new Date().toISOString(),
  };
}
