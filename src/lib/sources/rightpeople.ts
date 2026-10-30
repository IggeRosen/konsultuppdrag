import * as cheerio from "cheerio";
import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText } from "../http.ts";
import { stripEmpty } from "../parse-utils.ts";
import { isoDate, str, type Obj } from "./job-json.ts";
import { parseSwedishPeriod } from "./wise.ts";

// Right People Group – nordisk konsultmäklare, Next.js. Sajten har ingen robots.txt (404,
// 2026-10-30). Listan https://rightpeoplegroup.com/sv/open-assignments har alla öppna uppdrag
// (alla länder) i __NEXT_DATA__ under props.pageProps.projects, med titel, slug, beskrivning
// (HTML), location ("Sweden", "Norway", "Remote projects" …), languages, competences och open.
// Ett anrop räcker – annonssidorna behövs inte. Bara Sverige och remote tas med om inte
// RIGHTPEOPLE_ALL_COUNTRIES=1. Kontaktpersonens namn och e-post tas inte med.
export const RPG_BASE = "https://rightpeoplegroup.com";
const LIST = `${RPG_BASE}/sv/open-assignments`;
const ALL_COUNTRIES = process.env.RIGHTPEOPLE_ALL_COUNTRIES === "1";

const COUNTRIES: Record<string, string> = {
  sweden: "Sverige",
  norway: "Norge",
  denmark: "Danmark",
  finland: "Finland",
  germany: "Tyskland",
  netherlands: "Nederländerna",
};

/** Projektlistan ur sidans __NEXT_DATA__ (tom om den saknas). */
export function rpgProjects(html: string): Obj[] {
  const $ = cheerio.load(html);
  try {
    const data = JSON.parse($("script#__NEXT_DATA__").html() ?? "") as Obj;
    const projects = ((data.props as Obj)?.pageProps as Obj)?.projects;
    return Array.isArray(projects) ? (projects.filter((p) => p && typeof p === "object") as Obj[]) : [];
  } catch {
    return [];
  }
}

/** Beskrivningens HTML som rader. */
function htmlLines(html: string): string[] {
  return cheerio
    .load(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|h[1-6]|div)>/gi, "\n"))
    .text()
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// Fälten står som "Placering: Bergshamra, Stockholm" (sv) eller "Arbeidssted: Oslo" (no) osv.
const FIELDS: Record<string, string[]> = {
  customer: ["kund", "kunde", "client", "customer"],
  location: ["placering", "plats", "ort", "arbetsplats", "arbeidssted", "arbejdssted", "location", "sijainti"],
  workMode: ["hybrid", "distans", "remote", "på plats", "arbetssätt", "arbetsform", "work mode"],
  start: ["start", "startdatum", "uppstart", "oppstart", "opstart", "start date", "aloitus"],
  duration: ["längd", "uppdragslängd", "varighet", "varighed", "duration", "period", "kesto"],
  extent: ["omfattning", "allokering", "beläggning", "allocation", "workload", "omfang", "laajuus"],
  deadline: ["sista ansökningsdag", "sista ansökningsdatum", "ansökan senast", "søknadsfrist", "ansøgningsfrist", "deadline"],
};

// Ansökningsdelen (kontaktperson, e-post) börjar med någon av dessa rader.
const APPLY = /^(ansökan|är du (tillgänglig|intresserad)|er du interessert|er du interesseret|(are you )?interested\?|application$|kiinnostunut)/i;

/** Datum i klartext ("9 november 2026", "2026-11-09", "9.11.2026") → ISO. */
function dateOf(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const iso = text.match(/\b(20\d{2})[-.](\d{2})[-.](\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const fi = text.match(/\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/);
  if (fi) return `${fi[3]}-${fi[2].padStart(2, "0")}-${fi[1].padStart(2, "0")}`;
  return parseSwedishPeriod(text).start;
}

/** Ett projekt ur listan. */
export function parseRpgProject(p: Obj): Assignment | null {
  const title = str(p.title)?.replace(/\s+/g, " ").trim();
  const slug = str(p.slug);
  if (!title || !slug || p.open === false) return null;
  const lines = htmlLines(typeof p.description === "string" ? p.description : "");
  const cut = lines.findIndex((l) => APPLY.test(l));
  const own = (cut >= 0 ? lines.slice(0, cut) : lines).filter((l) => !/@/.test(l));
  const fields: Record<string, string> = {};
  const body: string[] = [];
  for (const line of own) {
    const m = line.match(/^([^:]{2,30}):\s*(.+)$/);
    const key = m && Object.keys(FIELDS).find((k) => FIELDS[k].includes(m[1].trim().toLowerCase()));
    if (m && key) {
      // "Hybrid: Minst 3 dagar …" behåller etiketten, "Arbetssätt: Distans möjligt" bara värdet.
      fields[key] ??= key === "workMode" && /^(hybrid|distans|remote|på plats)$/i.test(m[1].trim()) ? `${m[1].trim()}: ${m[2].trim()}` : m[2].trim();
      if (key !== "deadline") body.push(line);
    } else body.push(line);
  }
  const place = str(p.location)?.trim();
  const remote = /remote/i.test(place ?? "");
  const country = place && !remote ? (COUNTRIES[place.toLowerCase()] ?? place) : undefined;
  const area = str(p.competences);
  return stripEmpty({
    id: `rightpeople:${str(p.documentId) ?? str(p.id) ?? slug}`,
    source: "Right People Group",
    title,
    url: `${RPG_BASE}/sv/open-assignments/${slug}`,
    company: fields.customer,
    location: fields.location ?? (remote ? "Remote" : country),
    country,
    published: isoDate(p.publishedAt) ?? isoDate(p.createdAt),
    deadline: dateOf(fields.deadline),
    start: dateOf(fields.start),
    startText: fields.start,
    duration: fields.duration,
    extent: fields.extent,
    workMode: fields.workMode ?? (remote ? "Distans" : undefined),
    description: [...body, area && `Område: ${area}.`].filter(Boolean).join("\n").slice(0, 2500) || undefined,
  }) as Assignment;
}

/** Sverige eller remote. */
export const isRpgRelevant = (a: Assignment) => !a.country || a.country === "Sverige";

export const rightpeople: SourceAdapter = {
  name: "Right People Group",
  homepage: LIST,

  async fetchAssignments() {
    const strategies: string[] = [];
    const res = await fetchText(LIST, { timeoutMs: 10000, revalidate: 1800 });
    if (res.status >= 400) throw new Error(`Kunde inte läsa Right People Groups uppdragslista (HTTP ${res.status})`);
    const projects = rpgProjects(res.body);
    if (!projects.length) throw new Error("Inga uppdrag hittades i Right People Groups __NEXT_DATA__ (sidans uppbyggnad kan ha ändrats).");
    let all = projects.map(parseRpgProject).filter((a): a is Assignment => !!a);
    strategies.push(`__NEXT_DATA__: ${projects.length} uppdrag, ${all.length} öppna`);
    const today = new Date().toISOString().slice(0, 10);
    const expired = all.filter((a) => a.deadline && a.deadline < today).length;
    if (expired) strategies.push(`utgångna bortfiltrerade: ${expired}`);
    all = all.filter((a) => !(a.deadline && a.deadline < today));
    if (!ALL_COUNTRIES) {
      const other = all.filter((a) => !isRpgRelevant(a)).length;
      if (other) strategies.push(`andra länder bortfiltrerade: ${other}`);
      all = all.filter(isRpgRelevant);
    }
    return { assignments: all, strategies };
  },
};
