import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText, mapLimit } from "../http.ts";
import type { ApiProbe } from "../json-api.ts";
import { isSwedish, MAGNIT_GATEWAY, parseMagnitJson } from "./magnit-parse.ts";

// Magnit Source (magnit-source.magnitglobal.com) är Magnits öppna marknadsplats,
// en Angular-app som hämtar uppdragen från en separat API-server (MAGNIT_GATEWAY).
// Anropen nedan är tagna ur sajtens JavaScript (2026-09-26) och används även av
// sajtens egna partnersidor utan inloggning:
//   POST /api/jobsearch  { pageSize, sortOption, continuationToken? }
//        → { jobs: [...], totalCount, continuationToken }
//   GET  /api/jobsearch/landing-page-job-requests   (startsidans urval)
//   GET  /api/jobsearch/{id}/details                (ett uppdrag)
const pageSize = () => Number(process.env.MAGNIT_PAGE_SIZE ?? 100);
const MAX_PAGES = Number(process.env.MAGNIT_MAX_PAGES ?? 10);
const MAX_DETAIL_FETCHES = Number(process.env.MAGNIT_MAX_DETAILS ?? 120);
// Sätt MAGNIT_ALL_COUNTRIES=1 för att visa uppdrag i alla länder.
const ALL_COUNTRIES = process.env.MAGNIT_ALL_COUNTRIES === "1";

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };

interface SearchPage {
  jobs?: unknown[];
  totalCount?: number;
  continuationToken?: string | null;
}

async function searchPage(continuationToken: string | null): Promise<{ status: number; page: SearchPage | null; body: string }> {
  const res = await fetchText(`${MAGNIT_GATEWAY}/api/jobsearch`, {
    method: "POST",
    headers: JSON_HEADERS,
    timeoutMs: 10000,
    body: JSON.stringify({
      pageSize: pageSize(),
      sortOption: { orderBy: "PublishedDate", direction: "Desc" },
      ...(continuationToken ? { continuationToken } : {}),
    }),
  });
  let page: SearchPage | null = null;
  if (res.status < 400) {
    try {
      page = JSON.parse(res.body) as SearchPage;
    } catch {
      /* inte JSON */
    }
  }
  return { status: res.status, page, body: res.body };
}

/** Bläddrar i sökningen med continuationToken (nyaste först). */
async function scrapeSearch(errors: string[]): Promise<{ items: Assignment[]; pages: number; total?: number }> {
  const seen = new Map<string, Assignment>();
  let token: string | null = null;
  let pages = 0;
  let total: number | undefined;
  do {
    let r;
    try {
      r = await searchPage(token);
    } catch (err) {
      errors.push(`POST /api/jobsearch: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    if (!r.page) {
      errors.push(`POST /api/jobsearch: HTTP ${r.status}`);
      break;
    }
    pages++;
    total = r.page.totalCount ?? total;
    const items = parseMagnitJson(r.page.jobs ?? []);
    const fresh = items.filter((a) => !seen.has(a.id));
    fresh.forEach((a) => seen.set(a.id, a));
    token = r.page.continuationToken ?? null;
    if (!fresh.length || (r.page.jobs?.length ?? 0) < pageSize()) break;
  } while (token && pages < MAX_PAGES);
  return { items: [...seen.values()], pages, total };
}

async function landingPage(errors: string[]): Promise<Assignment[]> {
  try {
    const res = await fetchText(`${MAGNIT_GATEWAY}/api/jobsearch/landing-page-job-requests`, { headers: { Accept: "application/json" } });
    if (res.status >= 400) {
      errors.push(`landing-page-job-requests: HTTP ${res.status}`);
      return [];
    }
    return parseMagnitJson(JSON.parse(res.body));
  } catch (err) {
    errors.push(`landing-page-job-requests: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function jobId(a: Assignment): string {
  return a.id.replace(/^magnit:/, "");
}

/** För /api/debug: provar sökningen och startsidans urval och visar vad de ger. */
export async function probeMagnitApi(): Promise<ApiProbe[]> {
  const out: ApiProbe[] = [];
  try {
    const r = await searchPage(null);
    const jobs = r.page?.jobs ?? [];
    const items = parseMagnitJson(jobs);
    out.push({
      url: `POST ${MAGNIT_GATEWAY}/api/jobsearch`,
      status: r.status,
      bytes: r.body.length,
      items: items.length,
      sample: `totalCount=${r.page?.totalCount} continuationToken=${r.page?.continuationToken ? "ja" : "nej"} svenska på sidan=${items.filter(isSwedish).length}`,
      firstKeys: jobs[0] && typeof jobs[0] === "object" ? Object.keys(jobs[0] as object) : undefined,
      firstItem: items.find(isSwedish) ?? items[0],
    });
  } catch (err) {
    out.push({ url: `POST ${MAGNIT_GATEWAY}/api/jobsearch`, status: err instanceof Error ? err.message : String(err), bytes: 0, items: 0 });
  }
  const landing = await landingPage([]);
  out.push({ url: `${MAGNIT_GATEWAY}/api/jobsearch/landing-page-job-requests`, status: landing.length ? 200 : "fel", bytes: 0, items: landing.length, firstItem: landing[0] });
  return out;
}

export const magnit: SourceAdapter = {
  name: "Magnit",
  homepage: "https://magnit-source.magnitglobal.com/",

  async fetchAssignments() {
    const strategies: string[] = [];
    const errors: string[] = [];
    const byId = new Map<string, Assignment>();

    // 1) Sökningen (alla länder, nyaste först).
    const search = await scrapeSearch(errors);
    for (const a of search.items) byId.set(a.id, a);
    if (search.items.length) strategies.push(`sökning (${search.pages} sid, ${search.items.length} av ${search.total ?? "?"})`);

    // 2) Startsidans urval som reserv.
    if (!byId.size) {
      const landing = await landingPage(errors);
      for (const a of landing) byId.set(a.id, a);
      if (landing.length) strategies.push(`startsidan: ${landing.length}`);
    }

    if (byId.size === 0) {
      throw new Error(errors.length ? `Kunde inte hämta uppdrag från Magnit Source (${errors[0]})` : "Inga uppdrag hittades på Magnit Source.");
    }

    // Bara Sverige (om inte MAGNIT_ALL_COUNTRIES=1).
    const before = byId.size;
    if (!ALL_COUNTRIES) for (const [id, a] of byId) if (!isSwedish(a)) byId.delete(id);
    if (before !== byId.size) strategies.push(`utanför Sverige bortfiltrerade: ${before - byId.size}`);

    // 3) Detaljer (beskrivning m.m.) via API:t för de uppdrag som återstår.
    const toEnrich = [...byId.values()].filter((a) => (a.description?.length ?? 0) < 200).slice(0, MAX_DETAIL_FETCHES);
    let enriched = 0;
    await mapLimit(toEnrich, 10, async (a) => {
      try {
        const res = await fetchText(`${MAGNIT_GATEWAY}/api/jobsearch/${encodeURIComponent(jobId(a))}/details`, {
          headers: { Accept: "application/json" },
          timeoutMs: 6000,
          revalidate: 6 * 3600,
        });
        if (res.status >= 400) return;
        const d = parseMagnitJson(JSON.parse(res.body))[0];
        if (!d) return;
        const cur = byId.get(a.id)!;
        byId.set(a.id, {
          ...d,
          ...cur,
          description: (d.description?.length ?? 0) > (cur.description?.length ?? 0) ? d.description : cur.description,
        });
        enriched++;
      } catch {
        /* detaljerna är frivilliga */
      }
    });
    if (enriched) strategies.push(`detaljer: ${enriched}`);

    const today = new Date().toISOString().slice(0, 10);
    const all = [...byId.values()];
    const expired = all.filter((a) => a.deadline && a.deadline < today).length;
    if (expired) strategies.push(`utgångna bortfiltrerade: ${expired}`);
    return { assignments: all.filter((a) => a.title && !(a.deadline && a.deadline < today)), strategies };
  },
};
