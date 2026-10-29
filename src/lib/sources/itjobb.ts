import * as cheerio from "cheerio";
import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { stripEmpty, walk } from "../parse-utils.ts";
import { isoDate, str, type Obj } from "./job-json.ts";

// ITJobb.se – svensk jobbsajt för IT (Next.js). robots.txt tillåter allt (2026-10-29).
// Annonserna listas i sitemapen https://itjobb.se/sv/jobb/sitemap.xml och varje
// annonssida (https://itjobb.se/sv/jobb/<slug>) har JSON-LD av typen JobPosting.
export const ITJOBB_BASE = "https://itjobb.se";
const SITEMAP = `${ITJOBB_BASE}/sv/jobb/sitemap.xml`;
const MAX_DETAILS = Number(process.env.ITJOBB_MAX_DETAILS ?? 80);

const JOB_RE = /^https?:\/\/(?:www\.)?itjobb\.se\/(?:[a-z]{2}\/)?jobb\/([a-z0-9][a-z0-9-]{2,200})\/?$/i;

export function extractItjobbSlug(url: string): string | null {
  return url.match(JOB_RE)?.[1] ?? null;
}

export interface ItjobbEntry {
  url: string;
  slug: string;
  lastmod?: string;
}

/** Annonserna i sitemapen, nyast ändrade först. */
export function parseItjobbSitemap(xml: string): ItjobbEntry[] {
  const $ = cheerio.load(xml, { xml: true });
  return $("urlset > url")
    .toArray()
    .map((el): ItjobbEntry | null => {
      const url = $(el).find("loc").first().text().trim();
      const lastmod = $(el).find("lastmod").first().text().trim() || undefined;
      const slug = extractItjobbSlug(url);
      return slug ? { url, slug, lastmod } : null;
    })
    .filter((x): x is ItjobbEntry => !!x)
    .sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""));
}

const EMPLOYMENT_SV: Record<string, string> = {
  FULL_TIME: "Heltid",
  PART_TIME: "Deltid",
  CONTRACTOR: "Konsultuppdrag",
  TEMPORARY: "Visstid",
  INTERN: "Praktik",
  VOLUNTEER: "Ideellt",
  PER_DIEM: "Timanställning",
  OTHER: "Annan anställningsform",
};

function employmentOf(v: unknown): string | undefined {
  const list = (Array.isArray(v) ? v : [v]).map((x) => str(x)).filter((x): x is string => !!x);
  const sv = [...new Set(list.map((x) => EMPLOYMENT_SV[x.toUpperCase()] ?? x))];
  return sv.length ? sv.join(", ") : undefined;
}

/** Rensar annonstexten men behåller styckebrytningar. */
function descriptionOf(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const text = cheerio
    .load(v.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|h[1-6])>/gi, "\n"))
    .text()
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text ? text.slice(0, 2500) : undefined;
}

/** Tolkar en annonssida via dess JSON-LD JobPosting. */
export function parseItjobbJob(html: string, url: string): Assignment | null {
  const slug = extractItjobbSlug(url);
  if (!slug) return null;
  const $ = cheerio.load(html);
  let job: Obj | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (job) return;
    try {
      walk(JSON.parse($(el).html() ?? ""), (n) => {
        if (!job && n["@type"] === "JobPosting") job = n;
      });
    } catch {
      /* trasig JSON-LD */
    }
  });
  if (!job) return null;
  const j = job as Obj;
  const title = str(j.title);
  if (!title) return null;
  const org = j.hiringOrganization && typeof j.hiringOrganization === "object" ? (j.hiringOrganization as Obj) : {};
  const locs = Array.isArray(j.jobLocation) ? (j.jobLocation as Obj[]) : j.jobLocation ? [j.jobLocation as Obj] : [];
  const addrs = locs.map((l) => (l?.address && typeof l.address === "object" ? (l.address as Obj) : {}));
  const places = [...new Set(addrs.map((a) => str(a.addressLocality) ?? str(a.addressRegion)).filter((p): p is string => !!p))];
  const country = addrs.map((a) => str(a.addressCountry) ?? (a.addressCountry && typeof a.addressCountry === "object" ? str((a.addressCountry as Obj).name) : undefined)).find(Boolean);
  return stripEmpty({
    id: `itjobb:${slug}`,
    source: "ITJobb",
    title,
    url: `${ITJOBB_BASE}/sv/jobb/${slug}`,
    company: str(org.name) ?? str(j.hiringOrganization),
    location: places.join(", ") || undefined,
    country,
    published: isoDate(j.datePosted),
    deadline: isoDate(j.validThrough),
    extent: employmentOf(j.employmentType),
    workMode: /TELECOMMUTE/i.test(str(j.jobLocationType) ?? "") ? "Distans" : undefined,
    description: descriptionOf(j.description),
  }) as Assignment;
}

export const itjobb: SourceAdapter = {
  name: "ITJobb",
  homepage: `${ITJOBB_BASE}/sv/jobb`,

  async fetchAssignments() {
    const strategies: string[] = [];
    const res = await fetchText(SITEMAP, { timeoutMs: 8000, revalidate: 1800 });
    if (res.status >= 400) throw new Error(`Kunde inte läsa ITJobbs sitemap (HTTP ${res.status})`);
    const entries = parseItjobbSitemap(res.body);
    if (!entries.length) throw new Error("ITJobbs sitemap innehöll inga annonser.");
    const pick = entries.slice(0, MAX_DETAILS);
    strategies.push(`sitemap: ${entries.length} annonser, ${pick.length} nyaste hämtade`);

    let failed = 0;
    const jobs = await mapLimit(pick, 8, async (e) => {
      try {
        const page = await fetchText(e.url, { timeoutMs: 8000, revalidate: 6 * 3600 });
        if (page.status >= 400) {
          failed++;
          return null;
        }
        return parseItjobbJob(page.body, e.url);
      } catch {
        failed++;
        return null;
      }
    });
    if (failed) strategies.push(`annonssidor som inte gick att hämta: ${failed}`);

    const today = new Date().toISOString().slice(0, 10);
    const all = jobs.filter((a): a is Assignment => !!a);
    const expired = all.filter((a) => a.deadline && a.deadline < today).length;
    if (expired) strategies.push(`utgångna bortfiltrerade: ${expired}`);
    return { assignments: all.filter((a) => !(a.deadline && a.deadline < today)), strategies };
  },
};
