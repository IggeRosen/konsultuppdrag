import * as cheerio from "cheerio";
import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { stripEmpty } from "../parse-utils.ts";

// Academic Work – bemanning och rekrytering, Next.js. robots.txt spärrar bl.a. /api/ (2026-10-29),
// så vi använder inte deras API utan sitemapen https://www.academicwork.se/sitemap.xml, där
// annonserna står som /lediga-jobb/j/<slug>/<KOD>, och annonssidorna. Sidorna saknar JSON-LD;
// fälten står som text: "Plats:Umeå", "Startdatum:…", "Omfattning:Heltid", "Typ av uppdrag:Konsultuppdrag".
// Bara konsultuppdrag tas med om inte ACADEMICWORK_ALL_TYPES=1. Sitemapen har ~400 annonser,
// så bara de senast ändrade hämtas (ACADEMICWORK_MAX_DETAILS).
export const AW_BASE = "https://www.academicwork.se";
const SITEMAP = `${AW_BASE}/sitemap.xml`;
const MAX_DETAILS = Number(process.env.ACADEMICWORK_MAX_DETAILS ?? 150);
const ALL_TYPES = process.env.ACADEMICWORK_ALL_TYPES === "1";

const JOB_RE = /^https?:\/\/(?:www\.)?academicwork\.se\/lediga-jobb\/j\/[^/?#]+\/([A-Z0-9]{5,8})\/?(?:[?#].*)?$/i;

/** "SM4KJR" ur https://www.academicwork.se/lediga-jobb/j/erfaren-netutvecklare-for-kommande-uppdrag/SM4KJR. */
export function extractAwId(url: string): string | null {
  return url.match(JOB_RE)?.[1]?.toUpperCase() ?? null;
}

export interface AwEntry {
  url: string;
  id: string;
  lastmod?: string;
}

/** Annonserna i sitemapen, nyast ändrade först. */
export function parseAwSitemap(xml: string): AwEntry[] {
  const out = new Map<string, AwEntry>();
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const url = m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/)?.[1]?.replace(/&amp;/g, "&");
    const id = url ? extractAwId(url) : null;
    if (!url || !id || out.has(id)) continue;
    out.set(id, { url, id, lastmod: m[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/)?.[1] });
  }
  return [...out.values()].sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""));
}

/** Sidans synliga text rad för rad (utan meny, sidfot och skript). */
function pageLines(html: string): { $: cheerio.CheerioAPI; lines: string[] } {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, header, nav, footer, form, iframe").remove();
  const root = $("main").first().length ? $("main").first() : $("body");
  root.find("br").replaceWith("\n");
  root.find("p, li, h1, h2, h3, h4, h5, h6, div, section").each((_, n) => {
    $(n).append("\n");
  });
  const lines = root
    .text()
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return { $, lines };
}

const LABELS = ["Plats", "Startdatum", "Omfattning", "Typ av uppdrag", "Sista ansökningsdag", "Sista ansökningsdatum"];

/** Tolkar en annonssida. */
export function parseAwJob(html: string, url: string): Assignment | null {
  const id = extractAwId(url);
  if (!id) return null;
  const { $, lines } = pageLines(html);
  // "441 matchande jobb…" inleder listan med liknande jobb längst ned.
  const end = lines.findIndex((l) => /^\d+ matchande jobb/i.test(l));
  const own = end > 0 ? lines.slice(0, end) : lines;
  const title = $("h1").first().text().replace(/\s+/g, " ").trim() || own.find((l) => !/^Sökresultat|^Annons ID/i.test(l));
  if (!title) return null;
  const field = (label: string) => {
    const re = new RegExp(`^${label}:\\s*(.*)$`, "i");
    for (let i = 0; i < own.length; i++) {
      const m = own[i].match(re);
      // "Plats:Umeå" på en rad, eller "Plats:" följt av värdet på nästa rad.
      if (m) return m[1].trim() || own[i + 1]?.trim() || undefined;
    }
    return undefined;
  };
  const type = field("Typ av uppdrag");
  const scope = field("Omfattning");
  const start = field("Startdatum");
  const deadline = (field("Sista ansökningsdag") ?? field("Sista ansökningsdatum"))?.match(/20\d{2}-\d{2}-\d{2}/)?.[0];
  const titleAt = own.indexOf(title);
  const ingress = titleAt >= 0 ? own[titleAt + 1] : undefined;
  // Annonstexten från "Om tjänsten" till "Vår rekryteringsprocess"/"Bli en del av Academic Work".
  const from = own.findIndex((l) => /^Om tjänsten$/i.test(l));
  const to = own.findIndex((l, i) => i > from && /^(Vår rekryteringsprocess|Bli en del av Academic Work|Har du frågor)/i.test(l));
  const body = from >= 0 ? own.slice(from, to > from ? to : undefined).filter((l) => !/@/.test(l)) : [];
  const isLabel = (l: string) => LABELS.some((x) => l.toLowerCase().startsWith(`${x.toLowerCase()}:`));
  const description = [ingress && !isLabel(ingress) && !/^Ansök/i.test(ingress) ? ingress : undefined, ...body].filter(Boolean).join("\n");
  const extent = [type, scope ? [...new Set(scope.split(/\s*,\s*/))].join(", ") : undefined].filter(Boolean).join(", ");
  return stripEmpty({
    id: `academicwork:${id}`,
    source: "Academic Work",
    title,
    url: `${AW_BASE}${new URL(url).pathname}`,
    location: field("Plats"),
    country: "Sverige",
    deadline,
    startText: start,
    extent: extent || undefined,
    description: description ? description.slice(0, 2500) : undefined,
  }) as Assignment;
}

/** Konsultuppdrag (inte rekrytering eller anställning hos kund). */
export const isAwConsulting = (a: Assignment) => /konsultuppdrag/i.test(a.extent ?? "");

export const academicwork: SourceAdapter = {
  name: "Academic Work",
  homepage: `${AW_BASE}/lediga-jobb`,

  async fetchAssignments() {
    const strategies: string[] = [];
    const res = await fetchText(SITEMAP, { timeoutMs: 10000, revalidate: 1800 });
    if (res.status >= 400) throw new Error(`Kunde inte läsa Academic Works sitemap (HTTP ${res.status})`);
    const entries = parseAwSitemap(res.body);
    if (!entries.length) throw new Error("Academic Works sitemap innehöll inga annonser.");
    const pick = entries.slice(0, MAX_DETAILS);
    strategies.push(`sitemap: ${entries.length} annonser, ${pick.length} senast ändrade hämtade`);

    let failed = 0;
    const jobs = await mapLimit(pick, 8, async (e) => {
      try {
        const page = await fetchText(e.url, { timeoutMs: 8000, revalidate: 6 * 3600 });
        if (page.status >= 400) {
          failed++;
          return null;
        }
        return parseAwJob(page.body, e.url);
      } catch {
        failed++;
        return null;
      }
    });
    if (failed) strategies.push(`annonssidor som inte gick att hämta: ${failed}`);

    const today = new Date().toISOString().slice(0, 10);
    let all = jobs.filter((a): a is Assignment => !!a && !(a.deadline && a.deadline < today));
    if (!ALL_TYPES) {
      const other = all.filter((a) => !isAwConsulting(a)).length;
      if (other) strategies.push(`rekryteringar och övrigt bortfiltrerade: ${other}`);
      all = all.filter(isAwConsulting);
    }
    return { assignments: all, strategies };
  },
};
