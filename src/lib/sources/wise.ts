import * as cheerio from "cheerio";
import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { stripEmpty } from "../parse-utils.ts";

// Wise (Wise IT, Wise Finance m.fl.) – konsultuppdrag och rekryteringar, WordPress.
// robots.txt tillåter allt utom /wp/wp-admin/ (2026-10-29). Sitemapen
// (wp-sitemap-posts-job-1.xml) innehåller även stängda annonser, så vi läser i stället
// listan över öppna annonser: https://www.wise.se/lediga-jobb/?pg=N (15 per sida).
// Varje kort: <div class="archive-item job"> med ort (h6.city), område (h6.department),
// rubrik/länk (a.archive-item-link → /jobb/<slug>-<id>/) och ingress (.archive-item-excerpt).
export const WISE_BASE = "https://www.wise.se";
const LIST = `${WISE_BASE}/lediga-jobb/`;
const MAX_PAGES = Number(process.env.WISE_MAX_PAGES ?? 15);

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

export const wise: SourceAdapter = {
  name: "Wise",
  homepage: LIST,

  async fetchAssignments() {
    const strategies: string[] = [];
    const first = await fetchText(LIST, { timeoutMs: 8000, revalidate: 1800 });
    if (first.status >= 400) throw new Error(`Kunde inte läsa Wise lediga jobb (HTTP ${first.status})`);
    const byId = new Map<string, Assignment>();
    parseWiseListing(first.body, first.url).forEach((a) => byId.set(a.id, a));
    const last = Math.min(MAX_PAGES, wiseLastPage(first.body));
    const pages = Array.from({ length: Math.max(0, last - 1) }, (_, i) => i + 2);
    let failed = 0;
    const results = await mapLimit(pages, 4, async (p) => {
      try {
        const res = await fetchText(`${LIST}?pg=${p}`, { timeoutMs: 8000, revalidate: 1800 });
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
    results.flat().forEach((a) => byId.has(a.id) || byId.set(a.id, a));
    if (!byId.size) throw new Error("Inga annonser hittades på wise.se/lediga-jobb (sidans uppbyggnad kan ha ändrats).");
    strategies.push(`lediga-jobb (${last} sid): ${byId.size} annonser`);
    if (failed) strategies.push(`sidor som inte gick att hämta: ${failed}`);
    return { assignments: [...byId.values()], strategies };
  },
};
