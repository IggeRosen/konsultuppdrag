import * as cheerio from "cheerio";
import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { stripEmpty } from "../parse-utils.ts";
import { isoDate } from "./job-json.ts";

// Wise (Wise IT, Wise Finance m.fl.) – konsultuppdrag och rekryteringar, WordPress.
// robots.txt tillåter allt utom /wp/wp-admin/ (2026-10-29). Sitemapen
// (wp-sitemap-posts-job-1.xml) innehåller även stängda annonser, så vi läser i stället
// listan över öppna annonser filtrerad på typen konsultuppdrag (rekryteringar till
// kundföretag tas inte med): https://www.wise.se/lediga-jobb/?jobTags=konsult&pg=N (15 per sida).
// Varje kort: <div class="archive-item job"> med ort (h6.city), område (h6.department),
// rubrik/länk (a.archive-item-link → /jobb/<slug>-<id>/) och ingress (.archive-item-excerpt).
export const WISE_BASE = "https://www.wise.se";
const LIST = `${WISE_BASE}/lediga-jobb/`;
const CONSULTING = `${LIST}?jobTags=konsult`;
const MAX_PAGES = Number(process.env.WISE_MAX_PAGES ?? 15);
const MAX_DETAILS = Number(process.env.WISE_MAX_DETAILS ?? 100);

const JOB_RE = /^https?:\/\/(?:www\.)?wise\.se\/(?:en\/)?jobb\/([a-z0-9%][a-z0-9%-]{0,300}?)-(\d{4,})\/?(?:[?#].*)?$/i;

/** "8636680" ur https://www.wise.se/jobb/cloud-engineer-data-platform-8636680/. */
export function extractWiseId(url: string): string | null {
  return url.match(JOB_RE)?.[2] ?? null;
}

// Inte uppdrag: intresseanmälningar till Wise nätverk.
const NOT_A_JOB = /talent network|intresseanmälan|registrera ditt cv/i;

/** Annonskorten på en sida av /lediga-jobb/. */
export function parseWiseListing(html: string, pageUrl = LIST): Assignment[] {
  const $ = cheerio.load(html);
  const out = new Map<string, Assignment>();
  $(".archive-item").each((_, el) => {
    const card = $(el);
    const link = card.find("a.archive-item-link, a[href*='/jobb/']").first();
    let url: string;
    try {
      url = new URL(link.attr("href") ?? "", pageUrl).toString();
    } catch {
      return;
    }
    const id = extractWiseId(url);
    const title = link.text().replace(/\s+/g, " ").trim();
    if (!id || !title || out.has(`wise:${id}`) || NOT_A_JOB.test(title)) return;
    const city = card.find(".archive-item-type.city").first().text().trim();
    const area = card.find(".archive-item-type.department").first().text().trim();
    const excerpt = card.find(".archive-item-excerpt").first().text().replace(/\s+/g, " ").trim();
    out.set(
      `wise:${id}`,
      stripEmpty({
        id: `wise:${id}`,
        source: "Wise",
        title,
        url,
        location: city || undefined,
        country: "Sverige",
        description: [excerpt, area && `Område: ${area}.`].filter(Boolean).join("\n") || undefined,
      }) as Assignment,
    );
  });
  return [...out.values()];
}

/** Sista sidnumret i pagineringen (?pg=N), 1 om det saknas. */
export function wiseLastPage(html: string): number {
  const nums = [...html.matchAll(/[?&](?:amp;)?pg=(\d{1,3})/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(1, ...nums) : 1;
}

const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
const DATE_RE = new RegExp(`(\\d{1,2})\\s+(${MONTHS.join("|")})(?:\\s+(20\\d{2}))?`, "gi");
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * "1 januari – 20 juli 2027" → { start: "2027-01-01", end: "2027-07-20" }. Ett datum utan
 * år får nästa datums år (eller året före om månaden ligger senare än nästa datums).
 */
export function parseSwedishPeriod(text: string): { start?: string; end?: string } {
  const found = [...text.matchAll(DATE_RE)].map((m) => ({
    day: Number(m[1]),
    month: MONTHS.indexOf(m[2].toLowerCase()) + 1,
    year: m[3] ? Number(m[3]) : undefined,
  }));
  for (let i = found.length - 2; i >= 0; i--) {
    const next = found[i + 1];
    if (!found[i].year && next.year) found[i].year = found[i].month > next.month ? next.year - 1 : next.year;
  }
  const iso = (d?: { day: number; month: number; year?: number }) =>
    d?.year && d.day >= 1 && d.day <= 31 ? `${d.year}-${pad(d.month)}-${pad(d.day)}` : undefined;
  if (found.length >= 2) return { start: iso(found[0]), end: iso(found[1]) };
  return { start: iso(found[0]) };
}

export interface WiseDetail {
  open: boolean;
  location?: string;
  deadline?: string;
  start?: string;
  end?: string;
  extent?: string;
  workMode?: string;
  description?: string;
}

/**
 * En annonssida (/jobb/<slug>-<id>/). Fälten står i .job-details som .docket med
 * .docket-label/.docket-text (Avdelning, Slutdatum, Status, Plats) och annonstexten i
 * .job-body, ofta inledd med rader som "Omfattning: 100 %", "Period: 1 januari – 20 juli 2027"
 * och "Arbetssätt: På plats" (2026-10-29). Kontaktpersonens namn, e-post och telefon tas inte med.
 */
export function parseWiseJob(html: string): WiseDetail | null {
  const $ = cheerio.load(html);
  const docket: Record<string, string> = {};
  $(".docket").each((_, el) => {
    const label = $(el).find(".docket-label").first().text().replace(/\s+/g, " ").trim().toLowerCase();
    const value = $(el).find(".docket-text").first().text().replace(/\s+/g, " ").trim();
    if (label && value) docket[label] = value;
  });
  const body = $(".job-body").first();
  if (!body.length && !Object.keys(docket).length) return null;
  body.find("script, style, svg, form, iframe, .share, .job-links-wrapper").remove();
  body.find("br").replaceWith("\n");
  body.find("p, li, h1, h2, h3, h4, h5, h6, div").each((_, n) => {
    $(n).append("\n");
  });
  const lines = body
    .text()
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // Wise standardtext om företaget och kontaktuppgifter efter "OM WISE …" tas bort.
  const cut = lines.findIndex((l) => /^OM WISE\b/.test(l));
  const kept = (cut > 0 ? lines.slice(0, cut) : lines).filter(
    (l) => !/@|\+46|\b0\d{1,3}[- ]?\d{2,3}[ ]?\d{2}[ ]?\d{2}\b|^har du frågor/i.test(l),
  );
  const field = (name: string) => kept.find((l) => l.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim();
  const text = kept.join("\n");
  const period = field("period");
  const { start, end } = period ? parseSwedishPeriod(period) : {};
  const slut = docket["slutdatum"];
  const deadline = slut && !/pågående|löpande/i.test(slut) ? isoDate(slut) ?? parseSwedishPeriod(slut).start : undefined;
  return {
    open: !docket["status"] || /öppen|open/i.test(docket["status"]),
    location: field("placering") ?? docket["plats"],
    deadline,
    start,
    end,
    extent: field("omfattning"),
    workMode: field("arbetssätt"),
    description: text ? text.slice(0, 2500) : undefined,
  };
}

export const wise: SourceAdapter = {
  name: "Wise",
  homepage: CONSULTING,

  async fetchAssignments() {
    const strategies: string[] = [];
    const first = await fetchText(CONSULTING, { timeoutMs: 8000, revalidate: 1800 });
    if (first.status >= 400) throw new Error(`Kunde inte läsa Wise lediga jobb (HTTP ${first.status})`);
    const byId = new Map<string, Assignment>();
    // Listan är filtrerad på konsultuppdrag.
    const add = (a: Assignment) => byId.has(a.id) || byId.set(a.id, { ...a, extent: "Konsultuppdrag" });
    parseWiseListing(first.body, first.url).forEach(add);
    const last = Math.min(MAX_PAGES, wiseLastPage(first.body));
    const pages = Array.from({ length: Math.max(0, last - 1) }, (_, i) => i + 2);
    let failed = 0;
    const results = await mapLimit(pages, 4, async (p) => {
      try {
        const res = await fetchText(`${CONSULTING}&pg=${p}`, { timeoutMs: 8000, revalidate: 1800 });
        if (res.status >= 400) {
          failed++;
          return [];
        }
        return parseWiseListing(res.body, res.url);
      } catch {
        failed++;
        return [];
      }
    });
    results.flat().forEach(add);
    if (!byId.size) throw new Error("Inga annonser hittades på wise.se/lediga-jobb (sidans uppbyggnad kan ha ändrats).");
    strategies.push(`lediga-jobb, konsultuppdrag (${last} sid): ${byId.size} annonser`);
    if (failed) strategies.push(`sidor som inte gick att hämta: ${failed}`);

    // Annonssidorna ger hela texten, period, omfattning och arbetssätt.
    const list = [...byId.values()];
    const pick = list.slice(0, MAX_DETAILS);
    let detailFailed = 0;
    let closed = 0;
    const merged = await mapLimit(pick, 6, async (a): Promise<Assignment | null> => {
      try {
        const res = await fetchText(a.url, { timeoutMs: 8000, revalidate: 6 * 3600 });
        const d = res.status < 400 ? parseWiseJob(res.body) : null;
        if (!d) {
          detailFailed++;
          return a;
        }
        if (!d.open) {
          closed++;
          return null;
        }
        const area = a.description?.match(/Område: [^\n]+/)?.[0];
        return stripEmpty({
          ...a,
          location: d.location ?? a.location,
          deadline: d.deadline,
          start: d.start,
          end: d.end,
          extent: ["Konsultuppdrag", d.extent].filter(Boolean).join(", "),
          workMode: d.workMode,
          description: d.description ? [d.description, area].filter(Boolean).join("\n").slice(0, 2500) : a.description,
        }) as Assignment;
      } catch {
        detailFailed++;
        return a;
      }
    });
    strategies.push(`annonssidor hämtade: ${pick.length}`);
    if (detailFailed) strategies.push(`annonssidor som inte gick att tolka: ${detailFailed}`);
    if (closed) strategies.push(`stängda bortfiltrerade: ${closed}`);
    const today = new Date().toISOString().slice(0, 10);
    const assignments = [...merged, ...list.slice(MAX_DETAILS)].filter(
      (a): a is Assignment => !!a && !(a.deadline && a.deadline < today) && !(a.end && a.end < today),
    );
    return { assignments, strategies };
  },
};
