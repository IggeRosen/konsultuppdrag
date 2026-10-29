import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText } from "../http.ts";
import { stripEmpty } from "../parse-utils.ts";
import { isoDate, str, type Obj } from "./job-json.ts";
import { descriptionOf } from "./itjobb.ts";

// Nexer Group (IT- och teknikkonsulter). Jobbsidan https://nexergroup.com/sv/karriar/lediga-jobb/
// hämtar alla jobb (Teamtailor) från ett öppet WordPress-gränssnitt på Nexers egen sajt:
//   GET https://nexergroup.com/wp-json/nexer-blocks/v1/teamtailor_jobs
//   → [{ id, title, body (HTML), company-name, apply_url, start_date, end_date,
//        cities[], countries[], role, recruiter_email, picture }]
// Ingen nyckel behövs. robots.txt spärrar bara listans filterparametrar (?city=, ?role=, ?country=).
// Listan gäller alla länder; som standard tas bara jobb i Sverige med (NEXER_ALL_COUNTRIES=1 tar alla).
export const NEXER_BASE = "https://nexergroup.com";
export const NEXER_JOBS_API = `${NEXER_BASE}/wp-json/nexer-blocks/v1/teamtailor_jobs`;
const ALL_COUNTRIES = process.env.NEXER_ALL_COUNTRIES === "1";

const strings = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => str(x)).filter((x): x is string => !!x);

/** Ett jobb från gränssnittet. */
export function mapNexerJob(o: Obj): Assignment | null {
  const id = str(o.id);
  const title = str(o.title);
  if (!id || !title) return null;
  const cities = [...new Set(strings(o.cities))];
  const countries = [...new Set(strings(o.countries))];
  const role = str(o.role);
  const body = descriptionOf(o.body);
  const url = str(o.apply_url);
  return stripEmpty({
    id: `nexer:${id}`,
    source: "Nexer",
    title,
    url: url && /^https?:\/\//.test(url) ? url : `${NEXER_BASE}/sv/karriar/lediga-jobb/`,
    company: str(o["company-name"]) ?? "Nexer",
    location: cities.join(", ") || undefined,
    country: countries.join(", ") || undefined,
    published: isoDate(o.start_date),
    deadline: isoDate(o.end_date),
    description: [body, role ? `Roll: ${role}.` : undefined].filter(Boolean).join("\n").slice(0, 2500) || undefined,
  }) as Assignment;
}

const inSweden = (a: Assignment) => !a.country || /sverige|sweden/i.test(a.country);

/** Alla jobb i ett JSON-svar (används även av /api/debug). */
export function parseNexerJson(json: unknown): Assignment[] {
  const list = Array.isArray(json) ? json : [];
  const out = new Map<string, Assignment>();
  for (const x of list) {
    const a = x && typeof x === "object" ? mapNexerJob(x as Obj) : null;
    if (a && !out.has(a.id)) out.set(a.id, a);
  }
  return [...out.values()];
}

export const nexer: SourceAdapter = {
  name: "Nexer",
  homepage: `${NEXER_BASE}/sv/karriar/lediga-jobb/`,

  async fetchAssignments() {
    const strategies: string[] = [];
    const res = await fetchText(NEXER_JOBS_API, { headers: { Accept: "application/json" }, timeoutMs: 10000, revalidate: 1800 });
    if (res.status >= 400) throw new Error(`Kunde inte läsa Nexers jobblista (HTTP ${res.status})`);
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new Error("Nexers jobblista var inte JSON (gränssnittet kan ha ändrats).");
    }
    const all = parseNexerJson(json);
    if (!all.length) throw new Error("Nexers jobblista var tom.");
    const local = ALL_COUNTRIES ? all : all.filter(inSweden);
    strategies.push(`teamtailor_jobs: ${all.length} jobb${ALL_COUNTRIES ? "" : `, ${local.length} i Sverige`}`);

    const today = new Date().toISOString().slice(0, 10);
    const expired = local.filter((a) => a.deadline && a.deadline < today).length;
    if (expired) strategies.push(`utgångna bortfiltrerade: ${expired}`);
    return { assignments: local.filter((a) => !(a.deadline && a.deadline < today)), strategies };
  },
};
