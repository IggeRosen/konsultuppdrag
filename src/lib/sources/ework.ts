import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import { idsFromSitemaps } from "../sitemap.ts";
import {
  extractVeramaId,
  parseVeramaDetail,
  parseVeramaHtml,
  parseVeramaJson,
  VERAMA_BASE,
  veramaPageInfo,
  veramaUrl,
} from "./ework-parse.ts";

// Ework publicerar sina uppdrag på Verama (app.verama.com), en JavaScript-app
// som hämtar listan från ett publikt JSON-API:
//   https://app.verama.com/api/public/job-requests?page=0&size=50
// (Spring-sida: { content: [...], totalPages, last }, verifierat via /api/debug).
// Svarar den inte provas några alternativ. Adressen kan överstyras med env
// EWORK_API_URL, där {page} ersätts med sidnumret.
const MAX_PAGES = Number(process.env.EWORK_MAX_PAGES ?? 6);
const MAX_FROM_SITEMAP = Number(process.env.EWORK_MAX_SITEMAP ?? 60);
const MAX_DETAIL_FETCHES = Number(process.env.EWORK_MAX_DETAILS ?? 60);

const JSON_HEADERS = { Accept: "application/json, text/plain, */*", "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.8" };

export const DEFAULT_API = `${VERAMA_BASE}/api/public/job-requests?page={page}&size=50&sort=firstDayOfApplications,DESC`;

export function apiCandidates(): string[] {
  const q = "page={page}&size=50";
  return [
    ...new Set([
      process.env.EWORK_API_URL || DEFAULT_API,
      `${VERAMA_BASE}/api/public/job-requests?${q}`,
      `${VERAMA_BASE}/api/public/job-requests/search?${q}`,
      `${VERAMA_BASE}/api/job-requests/public?${q}`,
    ]),
  ];
}

export interface ApiProbe {
  url: string;
  status: number | string;
  contentType?: string;
  bytes: number;
  items: number;
  sample?: string;
  /** Fältnamnen i första uppdragsobjektet och hur det tolkades – för att verifiera mappningen */
  firstKeys?: string[];
  firstItem?: Assignment;
}

async function fetchApiPage(url: string): Promise<{ status: number; items: Assignment[]; json: unknown; contentType?: string; bytes: number; body: string }> {
  const res = await fetchText(url, { revalidate: 900, timeoutMs: 7000, headers: JSON_HEADERS });
  let json: unknown = null;
  if (res.status < 400 && /^\s*[[{]/.test(res.body)) {
    try {
      json = JSON.parse(res.body);
    } catch {
      /* inte JSON */
    }
  }
  return {
    status: res.status,
    items: json ? parseVeramaJson(json) : [],
    json,
    contentType: res.headers["content-type"],
    bytes: res.body.length,
    body: res.body,
  };
}

/** Provar alla API-kandidater (sida 0) och rapporterar vad varje ger. */
export async function probeEworkApi(): Promise<ApiProbe[]> {
  return Promise.all(
    apiCandidates().map(async (tpl): Promise<ApiProbe> => {
      const url = tpl.replace("{page}", "0");
      try {
        const r = await fetchApiPage(url);
        const content = (r.json as { content?: unknown[] } | null)?.content;
        const firstObj = Array.isArray(content) && content[0] && typeof content[0] === "object" ? (content[0] as object) : undefined;
        return {
          url,
          status: r.status,
          contentType: r.contentType,
          bytes: r.bytes,
          items: r.items.length,
          sample: r.body.slice(0, 600),
          firstKeys: firstObj ? Object.keys(firstObj) : undefined,
          firstItem: r.items[0],
        };
      } catch (err) {
        return { url, status: err instanceof Error ? err.message : String(err), bytes: 0, items: 0 };
      }
    }),
  );
}

/** Hämtar uppdrag via JSON-API:t, med paginering. */
async function scrapeApi(errors: string[]): Promise<{ items: Assignment[]; pages: number; via: string }> {
  const [primary, ...fallbacks] = apiCandidates();
  const tryTpl = (tpl: string) =>
    fetchApiPage(tpl.replace("{page}", "0"))
      .then((r) => ({ tpl, r }))
      .catch(() => null);
  let hit = await tryTpl(primary);
  let tried = [hit];
  if (!hit || !hit.r.items.length) {
    tried = [hit, ...(await Promise.all(fallbacks.map(tryTpl)))];
    hit = tried.find((p) => p && p.r.items.length > 0) ?? null;
  }
  if (!hit) {
    const statuses = tried.map((p) => p?.r.status ?? "fel").join(", ");
    errors.push(`API: inget svar med uppdrag (${statuses})`);
    return { items: [], pages: 0, via: "" };
  }
  const seen = new Map(hit.r.items.map((a) => [a.id, a]));
  let pages = 1;
  const info = veramaPageInfo(hit.r.json);
  for (let page = 1; page < MAX_PAGES; page++) {
    if (info.last === true || (info.totalPages !== undefined && page >= info.totalPages)) break;
    try {
      const r = await fetchApiPage(hit.tpl.replace("{page}", String(page)));
      const fresh = r.items.filter((a) => !seen.has(a.id));
      if (!fresh.length) break;
      fresh.forEach((a) => seen.set(a.id, a));
      pages++;
      const pi = veramaPageInfo(r.json);
      if (pi.last === true) break;
    } catch {
      break;
    }
  }
  return { items: [...seen.values()], pages, via: new URL(hit.tpl.replace("{page}", "0")).pathname };
}

export const ework: SourceAdapter = {
  name: "Ework",
  homepage: `${VERAMA_BASE}/sv/job-requests`,

  async fetchAssignments() {
    const strategies: string[] = [];
    const errors: string[] = [];
    const byId = new Map<string, Assignment>();
    const add = (items: Assignment[]) => {
      for (const it of items) byId.set(it.id, { ...it, ...byId.get(it.id) } as Assignment);
    };

    // 1) JSON-API:t och 2) listsidans HTML (om den är serverrenderad) parallellt.
    const [api, html] = await Promise.all([
      scrapeApi(errors),
      fetchText(`${VERAMA_BASE}/sv/job-requests`)
        .then((r) => (r.status < 400 ? parseVeramaHtml(r.body, r.url) : (errors.push(`HTTP ${r.status} från /sv/job-requests`), [])))
        .catch((err) => (errors.push(`/sv/job-requests: ${err instanceof Error ? err.message : String(err)}`), [] as Assignment[])),
    ]);
    if (api.items.length) {
      add(api.items);
      strategies.push(`API ${api.via} (${api.pages} sid): ${api.items.length}`);
    }
    if (html.length) {
      add(html);
      strategies.push(`listsidan: ${html.length}`);
    }

    // 3) Sitemap (bara om API:t inte gav något): de nyaste uppdragen (högst id).
    const sitemapIds = (api.items.length ? [] : await idsFromSitemaps(VERAMA_BASE, extractVeramaId, { errors, prefer: /job/i }))
      .filter((id) => !byId.has(`ework:${id}`))
      .sort((a, b) => Number(b) - Number(a))
      .slice(0, MAX_FROM_SITEMAP);
    for (const id of sitemapIds) byId.set(`ework:${id}`, { id: `ework:${id}`, source: "Ework", title: "", url: veramaUrl(id) });
    if (sitemapIds.length) strategies.push(`sitemap: ${sitemapIds.length}`);

    if (byId.size === 0) {
      throw new Error(errors.length ? `Kunde inte hämta uppdrag från Ework/Verama (${errors[0]})` : "Inga uppdrag hittades på Ework/Verama.");
    }

    // 4) Detaljsidor för uppdrag som saknar titel eller beskrivning.
    const toEnrich = [...byId.values()]
      .filter((a) => !a.title || (!api.items.length && (a.description?.length ?? 0) < 200))
      .sort((a, b) => Number(!b.title) - Number(!a.title))
      .slice(0, MAX_DETAIL_FETCHES);
    let enriched = 0;
    await mapLimit(toEnrich, 8, async (a) => {
      try {
        const res = await fetchText(a.url, { timeoutMs: 6000, revalidate: 6 * 3600 });
        if (res.status >= 400) return;
        const d = parseVeramaDetail(res.body);
        const cur = byId.get(a.id)!;
        byId.set(a.id, {
          ...cur,
          title: cur.title || d.title || "",
          company: cur.company ?? d.company,
          location: cur.location ?? d.location,
          workMode: cur.workMode ?? d.workMode,
          rate: cur.rate ?? d.rate,
          published: cur.published ?? d.published,
          deadline: cur.deadline ?? d.deadline,
          start: cur.start ?? d.start,
          end: cur.end ?? d.end,
          description: (d.description?.length ?? 0) > (cur.description?.length ?? 0) ? d.description : cur.description,
        });
        enriched++;
      } catch {
        /* detaljsidan är frivillig */
      }
    });
    if (enriched) strategies.push(`detaljsidor: ${enriched}`);

    const today = new Date().toISOString().slice(0, 10);
    const all = [...byId.values()];
    const expired = all.filter((a) => a.deadline && a.deadline < today).length;
    if (expired) strategies.push(`utgångna bortfiltrerade: ${expired}`);
    const untitled = all.filter((a) => !a.title).length;
    if (untitled) strategies.push(`utan titel (JavaScript-sida): ${untitled}`);
    return { assignments: all.filter((a) => a.title && !(a.deadline && a.deadline < today)), strategies };
  },
};
