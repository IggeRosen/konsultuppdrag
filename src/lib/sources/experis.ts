import * as cheerio from "cheerio";
import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { stripEmpty, walk } from "../parse-utils.ts";
import { str, type Obj } from "./job-json.ts";
import { descriptionOf } from "./itjobb.ts";

// Experis (ManpowerGroup) – IT-konsulter och rekrytering, Sitecore. robots.txt spärrar bara
// /candidate (2026-10-29). Annonserna står sist i https://www.experis.se/sitemap.xml som
// /sv/jobb/<yrkesområde>/<slug>/<id> och varje annonssida har JSON-LD av typen JobPosting.
// JSON-LD:n är inte alltid giltig JSON (t.ex. "industry": IT, Data,) och lagas innan tolkning.
// employmentType skiljer konsultuppdrag från "Rekrytering till företag" (anställning hos kunden),
// som hoppas över om inte EXPERIS_ALL_TYPES=1.
export const EXPERIS_BASE = "https://www.experis.se";
const SITEMAP = `${EXPERIS_BASE}/sitemap.xml`;
const MAX_DETAILS = Number(process.env.EXPERIS_MAX_DETAILS ?? 80);
const ALL_TYPES = process.env.EXPERIS_ALL_TYPES === "1";

const JOB_RE = /^https?:\/\/(?:www\.)?experis\.se\/(?:sv\/jobb|jobb|en\/job|job)\/[^/?#]+\/[^/?#]+\/(\d{3,})\/?(?:[?#].*)?$/i;

/** "54774" ur https://www.experis.se/sv/jobb/itdata/senior-javautvecklaretech-lead-till-lfv/54774. */
export function extractExperisId(url: string): string | null {
  return url.match(JOB_RE)?.[1] ?? null;
}

/** De svenska annonsadresserna i sitemapen (en per id). */
export function parseExperisSitemap(xml: string): string[] {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const url = m[1].replace(/&amp;/g, "&");
    const id = extractExperisId(url);
    if (!id) continue;
    // Svenska versionen (/sv/jobb/) före den engelska.
    if (!out.has(id) || /\/sv\/jobb\//.test(url)) out.set(id, url);
  }
  return [...out.values()];
}

/**
 * Lagar rader som `"industry": IT, Data,` (värde utan citattecken) i pretty-printad JSON.
 */
export function repairJsonLd(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*"[\w@]+"\s*:\s*)(.*?)(,?)\s*$/);
      if (!m) return line;
      const v = m[2].trim();
      if (!v || /^(["[{]|-?\d+(\.\d+)?$|true$|false$|null$)/.test(v)) return line;
      return `${m[1]}${JSON.stringify(v)}${m[3]}`;
    })
    .join("\n");
}

/** Annonssidans JobPosting (eller null). */
export function experisJobPosting(html: string): Obj | null {
  const $ = cheerio.load(html);
  let job: Obj | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (job) return;
    const raw = $(el).html() ?? "";
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      try {
        data = JSON.parse(repairJsonLd(raw));
      } catch {
        return;
      }
    }
    walk(data, (n) => {
      if (!job && n["@type"] === "JobPosting") job = n;
    });
  });
  return job;
}

/** "20261028T075431" / "20261127T225959Z" / "2026-10-28…" → "2026-10-28". */
export function experisDate(v: unknown): string | undefined {
  const s = str(v);
  const m = s?.match(/^(20\d{2})-?(\d{2})-?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

/** Tolkar en annonssida via JSON-LD JobPosting. */
export function parseExperisJob(html: string, url: string): Assignment | null {
  const id = extractExperisId(url);
  const j = experisJobPosting(html);
  if (!id || !j) return null;
  const title = str(j.title);
  if (!title) return null;
  const locs = Array.isArray(j.jobLocation) ? (j.jobLocation as Obj[]) : j.jobLocation ? [j.jobLocation as Obj] : [];
  const addrs = locs.map((l) => (l?.address && typeof l.address === "object" ? (l.address as Obj) : {}));
  const places = [...new Set(addrs.map((a) => str(a.addressLocality) ?? str(a.addressRegion)).filter((p): p is string => !!p))];
  const country = addrs.map((a) => str(a.addressCountry)).find(Boolean);
  const org = j.hiringOrganization && typeof j.hiringOrganization === "object" ? (j.hiringOrganization as Obj) : {};
  const type = str(j.employmentType);
  const industry = str(j.industry);
  return stripEmpty({
    id: `experis:${id}`,
    source: "Experis",
    title,
    url,
    company: str(org.name),
    location: places.join(", ") || undefined,
    country: !country || /^(SE|SWE|Sverige|Sweden)$/i.test(country) ? "Sverige" : country,
    published: experisDate(j.datePosted),
    deadline: experisDate(j.validThrough),
    extent: type,
    description: [descriptionOf(j.description), industry && `Område: ${industry}.`].filter(Boolean).join("\n").slice(0, 2500) || undefined,
  }) as Assignment;
}

/** Rekrytering till kundföretag (anställning hos kunden), inte ett uppdrag. */
export const isExperisRecruitment = (a: Assignment) => /rekrytering/i.test(a.extent ?? "");

export const experis: SourceAdapter = {
  name: "Experis",
  homepage: `${EXPERIS_BASE}/sv/sok`,

  async fetchAssignments() {
    const strategies: string[] = [];
    const res = await fetchText(SITEMAP, { timeoutMs: 10000, revalidate: 1800 });
    if (res.status >= 400) throw new Error(`Kunde inte läsa Experis sitemap (HTTP ${res.status})`);
    const urls = parseExperisSitemap(res.body);
    if (!urls.length) throw new Error("Experis sitemap innehöll inga annonser.");
    const pick = urls.slice(0, MAX_DETAILS);
    strategies.push(`sitemap: ${urls.length} annonser, ${pick.length} hämtade`);

    let failed = 0;
    const jobs = await mapLimit(pick, 6, async (u) => {
      try {
        const page = await fetchText(u, { timeoutMs: 8000, revalidate: 6 * 3600 });
        if (page.status >= 400) {
          failed++;
          return null;
        }
        return parseExperisJob(page.body, u);
      } catch {
        failed++;
        return null;
      }
    });
    if (failed) strategies.push(`annonssidor som inte gick att hämta: ${failed}`);

    const today = new Date().toISOString().slice(0, 10);
    let all = jobs.filter((a): a is Assignment => !!a);
    const expired = all.filter((a) => a.deadline && a.deadline < today).length;
    if (expired) strategies.push(`utgångna bortfiltrerade: ${expired}`);
    all = all.filter((a) => !(a.deadline && a.deadline < today));
    if (!ALL_TYPES) {
      const recruit = all.filter(isExperisRecruitment).length;
      if (recruit) strategies.push(`rekryteringar till företag bortfiltrerade: ${recruit}`);
      all = all.filter((a) => !isExperisRecruitment(a));
    }
    return { assignments: all, strategies };
  },
};
