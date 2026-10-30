import * as cheerio from "cheerio";
import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { decodeEntities, stripEmpty, walk } from "../parse-utils.ts";
import { isoDate, str, type Obj } from "./job-json.ts";
import { descriptionOf } from "./itjobb.ts";

// Gigstep – gig- och konsultförmedling (främst IT i Skåne). Uppdragen ligger på Teamtailor-sajten
// https://jobs.gigstep.se, vars robots.txt bara spärrar /app/, /messages/ m.m. och anger
// "Content-Signal: search=yes" (2026-10-30). Annonserna står i https://jobs.gigstep.se/sitemap.xml
// som /jobs/<id>-<slug>, och varje annonssida har JSON-LD JobPosting (beskrivningen HTML-kodad två
// gånger) samt fälten Område/Roll/Plats/Anställningsform som text. Kontaktpersonen står utanför
// beskrivningen och tas inte med. Rena rekryteringar (anställning hos kunden) hoppas över om inte
// GIGSTEP_ALL_TYPES=1.
export const GIGSTEP_BASE = "https://jobs.gigstep.se";
const SITEMAP = `${GIGSTEP_BASE}/sitemap.xml`;
const MAX_DETAILS = Number(process.env.GIGSTEP_MAX_DETAILS ?? 60);
const ALL_TYPES = process.env.GIGSTEP_ALL_TYPES === "1";

const JOB_RE = /^https?:\/\/jobs\.gigstep\.se\/jobs\/(\d{4,})(?:-[^/?#]*)?\/?(?:[?#].*)?$/i;

/** "8547932" ur https://jobs.gigstep.se/jobs/8547932-erfaren-c-net-utvecklare-…. */
export function extractGigstepId(url: string): string | null {
  return url.match(JOB_RE)?.[1] ?? null;
}

/** Annonsadresserna i sitemapen (en per id). */
export function parseGigstepSitemap(xml: string): string[] {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const url = m[1].replace(/&amp;/g, "&");
    const id = extractGigstepId(url);
    if (id && !out.has(id)) out.set(id, url);
  }
  return [...out.values()];
}

const EMPLOYMENT: Record<string, string> = {
  FULL_TIME: "Heltid",
  PART_TIME: "Deltid",
  CONTRACTOR: "Konsultuppdrag",
  TEMPORARY: "Visstid",
  INTERN: "Praktik",
};

/** "Område"/"Anställningsform" m.fl. ur sidans text (etikett på en rad, värdet på nästa). */
function pageFields(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, header, nav, footer, form").remove();
  $("br").replaceWith("\n");
  $("p, li, dt, dd, h1, h2, h3, h4, div, span").each((_, n) => {
    $(n).append("\n");
  });
  const lines = $("body")
    .text()
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out: Record<string, string> = {};
  for (const label of ["Område", "Roll", "Plats", "Anställningsform"]) {
    const i = lines.indexOf(label);
    if (i >= 0 && lines[i + 1]) out[label] = lines[i + 1];
  }
  return out;
}

/** Tolkar en annonssida via JSON-LD JobPosting. */
export function parseGigstepJob(html: string, url: string): Assignment | null {
  const id = extractGigstepId(url);
  if (!id) return null;
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
  const locs = Array.isArray(j.jobLocation) ? (j.jobLocation as Obj[]) : j.jobLocation ? [j.jobLocation as Obj] : [];
  const addrs = locs.map((l) => (l?.address && typeof l.address === "object" ? (l.address as Obj) : {}));
  const places = [...new Set(addrs.map((a) => str(a.addressLocality) ?? str(a.addressRegion)).filter((p): p is string => !!p))];
  const country = addrs.map((a) => str(a.addressCountry)).find(Boolean);
  const fields = pageFields(html);
  const types = (Array.isArray(j.employmentType) ? j.employmentType : [j.employmentType])
    .map((t) => (typeof t === "string" ? (EMPLOYMENT[t.toUpperCase()] ?? t) : undefined))
    .filter((t): t is string => !!t);
  // Beskrivningen är HTML-kodad ("&lt;p&gt;…"): avkoda först, gör sedan om till text.
  const raw = typeof j.description === "string" ? decodeEntities(j.description) : undefined;
  const text = descriptionOf(raw)
    ?.split("\n")
    // Tomrader (från <li><p>…</p></li>) och rader med e-post/telefon tas bort.
    .filter((l) => l.trim() && !/@|\+46|\b0\d{1,3}[- ]?\d{2,3}[ ]?\d{2}[ ]?\d{2}\b/.test(l))
    .join("\n");
  const area = fields["Område"];
  return stripEmpty({
    id: `gigstep:${id}`,
    source: "Gigstep",
    title,
    url: `${GIGSTEP_BASE}${new URL(url).pathname}`,
    location: places.join(", ") || fields["Plats"],
    country: !country || /^(SE|SWE|Sverige|Sweden)$/i.test(country) ? "Sverige" : country,
    published: isoDate(j.datePosted),
    deadline: isoDate(j.validThrough),
    extent: [...new Set([...types, fields["Anställningsform"]].filter(Boolean))].join(", ") || undefined,
    description: [text, area && `Område: ${area}.`].filter(Boolean).join("\n").slice(0, 2500) || undefined,
  }) as Assignment;
}

/** Ren rekrytering (anställning hos kunden) snarare än ett gig/konsultuppdrag. */
export function isGigstepRecruitment(a: Assignment): boolean {
  const text = `${a.title}\n${a.description ?? ""}`;
  if (/konsultuppdrag|konsult\b|\bgig\b|uppdrag via gigstep/i.test(text)) return false;
  return /rekryter|tillsvidareanställ|anställs (direkt )?(av|hos)|anställning hos|direktanställ/i.test(text);
}

export const gigstep: SourceAdapter = {
  name: "Gigstep",
  homepage: `${GIGSTEP_BASE}/jobs`,

  async fetchAssignments() {
    const strategies: string[] = [];
    const res = await fetchText(SITEMAP, { timeoutMs: 10000, revalidate: 1800 });
    if (res.status >= 400) throw new Error(`Kunde inte läsa Gigsteps sitemap (HTTP ${res.status})`);
    const urls = parseGigstepSitemap(res.body);
    if (!urls.length) throw new Error("Gigsteps sitemap innehöll inga annonser.");
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
        return parseGigstepJob(page.body, u);
      } catch {
        failed++;
        return null;
      }
    });
    if (failed) strategies.push(`annonssidor som inte gick att hämta: ${failed}`);

    const today = new Date().toISOString().slice(0, 10);
    let all = jobs.filter((a): a is Assignment => !!a && !(a.deadline && a.deadline < today));
    if (!ALL_TYPES) {
      const recruit = all.filter(isGigstepRecruitment).length;
      if (recruit) strategies.push(`rekryteringar bortfiltrerade: ${recruit}`);
      all = all.filter((a) => !isGigstepRecruitment(a));
    }
    return { assignments: all, strategies };
  },
};
