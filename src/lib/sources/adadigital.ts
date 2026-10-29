import * as cheerio from "cheerio";
import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { stripEmpty, walk } from "../parse-utils.ts";
import { isoDate, str, type Obj } from "./job-json.ts";
import { employmentOf } from "./itjobb.ts";

// ADA Digital (TNG-gruppen) – IT-rekrytering och konsultuthyrning, WordPress.
// robots.txt tillåter allt (2026-10-29). Annonserna (posttypen tng_job) listas i
// https://www.adadigital.se/tng_job-sitemap.xml och varje annonssida
// (/lediga-jobb/<kategori>/<slug>/) har JSON-LD av typen JobPosting.
export const ADA_BASE = "https://www.adadigital.se";
const SITEMAP = `${ADA_BASE}/tng_job-sitemap.xml`;
const MAX_DETAILS = Number(process.env.ADADIGITAL_MAX_DETAILS ?? 60);

const JOB_RE = /^https?:\/\/(?:www\.)?adadigital\.se\/lediga-jobb\/([a-z0-9-]+)\/([a-z0-9][a-z0-9-]{2,200})\/?$/i;

/** "data-och-analytics/konsult-interim-data-engineer-bi-i-stockholm" ur en annonsadress. */
export function extractAdaSlug(url: string): string | null {
  const m = url.match(JOB_RE);
  return m && !/^(ort|yrke)$/i.test(m[1]) ? `${m[1]}/${m[2]}` : null;
}

export interface AdaEntry {
  url: string;
  slug: string;
  lastmod?: string;
}

/** Annonserna i sitemapen, nyast ändrade först. */
export function parseAdaSitemap(xml: string): AdaEntry[] {
  const $ = cheerio.load(xml, { xml: true });
  return $("urlset > url")
    .toArray()
    .map((el): AdaEntry | null => {
      const url = $(el).find("loc").first().text().trim();
      const lastmod = $(el).find("lastmod").first().text().trim() || undefined;
      const slug = extractAdaSlug(url);
      return slug ? { url, slug, lastmod } : null;
    })
    .filter((x): x is AdaEntry => !!x)
    .sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""));
}

/** Annonstexten på sidan (JSON-LD har bara ingressen). Ger undefined om inget längre hittas. */
function bodyText($: cheerio.CheerioAPI, minLength: number): string | undefined {
  $("script, style, noscript, header, nav, footer, form, iframe, .menu, [class*='cookie']").remove();
  const selectors = [".job-content", ".job-description", ".single-job", ".jobpost", ".entry-content", "article", "main"];
  for (const sel of selectors) {
    const el = $(sel).first();
    if (!el.length) continue;
    el.find("br").replaceWith("\n");
    el.find("p, li, h1, h2, h3, h4, h5, h6, div").each((_, n) => {
      $(n).append("\n");
    });
    const text = el
      .text()
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text.length > minLength + 150) return text.slice(0, 2500);
  }
  return undefined;
}

/** Tolkar en annonssida via dess JSON-LD JobPosting (plus annonstexten om den hittas). */
export function parseAdaJob(html: string, url: string): Assignment | null {
  const slug = extractAdaSlug(url);
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
  const loc = (Array.isArray(j.jobLocation) ? j.jobLocation[0] : j.jobLocation) as Obj | undefined;
  const addr = loc?.address && typeof loc.address === "object" ? (loc.address as Obj) : {};
  const country = str(addr.addressCountry);
  const ingress = str(j.description);
  const body = bodyText($, ingress?.length ?? 0);
  const consulting = /\b(konsult|interim|uppdrag)/i.test(title);
  const meta = [
    str(j.industry) && `Område: ${str(j.industry)}.`,
    str(j.jobBenefits) && `Förmåner: ${str(j.jobBenefits)}.`,
  ]
    .filter(Boolean)
    .join(" ");
  return stripEmpty({
    id: `adadigital:${slug}`,
    source: "ADA Digital",
    title,
    url: `${ADA_BASE}/lediga-jobb/${slug}/`,
    company: str((j.hiringOrganization as Obj | undefined)?.name),
    location: str(addr.addressLocality) ?? str(addr.addressRegion),
    country: country === "SE" ? "Sverige" : country,
    published: isoDate(j.datePosted),
    deadline: isoDate(j.validThrough),
    extent: consulting ? "Konsultuppdrag/interim" : employmentOf(j.employmentType),
    description: [body ?? ingress, meta].filter(Boolean).join("\n").slice(0, 2500) || undefined,
  }) as Assignment;
}

export const adadigital: SourceAdapter = {
  name: "ADA Digital",
  homepage: `${ADA_BASE}/lediga-it-jobb/`,

  async fetchAssignments() {
    const strategies: string[] = [];
    const res = await fetchText(SITEMAP, { timeoutMs: 8000, revalidate: 1800 });
    if (res.status >= 400) throw new Error(`Kunde inte läsa ADA Digitals sitemap (HTTP ${res.status})`);
    const entries = parseAdaSitemap(res.body);
    if (!entries.length) throw new Error("ADA Digitals sitemap innehöll inga annonser.");
    const pick = entries.slice(0, MAX_DETAILS);
    strategies.push(`sitemap: ${entries.length} annonser, ${pick.length} hämtade`);

    let failed = 0;
    const jobs = await mapLimit(pick, 6, async (e) => {
      try {
        const page = await fetchText(e.url, { timeoutMs: 8000, revalidate: 6 * 3600 });
        if (page.status >= 400) {
          failed++;
          return null;
        }
        return parseAdaJob(page.body, e.url);
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
