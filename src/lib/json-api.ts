import type { Assignment } from "./types.ts";
import { fetchText } from "./http.ts";

// Generell sondering och paginering av odokumenterade JSON-API:er. Kandidat-
// adresserna är mallar där {page} ersätts med sidnumret (0-baserat).

const JSON_HEADERS = { Accept: "application/json, text/plain, */*" };

export interface ApiPage {
  status: number;
  json: unknown;
  items: Assignment[];
  contentType?: string;
  body: string;
}

export async function fetchJsonPage(url: string, parse: (json: unknown) => Assignment[]): Promise<ApiPage> {
  const res = await fetchText(url, { revalidate: 900, timeoutMs: 7000, headers: JSON_HEADERS });
  let json: unknown = null;
  if (res.status < 400 && /^\s*[[{]/.test(res.body)) {
    try {
      json = JSON.parse(res.body);
    } catch {
      /* inte JSON */
    }
  }
  return { status: res.status, json, items: json ? parse(json) : [], contentType: res.headers["content-type"], body: res.body };
}

/** Sista sidan enligt vanliga pagineringsformat (Spring, { page: { totalPages } }, hasMore/next). */
export function isLastPage(json: unknown, page: number): boolean {
  if (!json || typeof json !== "object" || Array.isArray(json)) return false;
  const o = json as Record<string, unknown>;
  const p = (o.page && typeof o.page === "object" ? o.page : o) as Record<string, unknown>;
  if (o.last === true || o.hasMore === false || o.hasNext === false) return true;
  if (typeof p.totalPages === "number" && page + 1 >= p.totalPages) return true;
  if ("next" in o && (o.next === null || o.next === "")) return true;
  return false;
}

export interface ApiProbe {
  url: string;
  status: number | string;
  contentType?: string;
  bytes: number;
  items: number;
  sample?: string;
  firstKeys?: string[];
  firstItem?: Assignment;
}

function firstObject(json: unknown): object | undefined {
  if (Array.isArray(json)) return json.find((x) => x && typeof x === "object");
  if (!json || typeof json !== "object") return undefined;
  for (const k of ["content", "items", "results", "data", "jobs", "hits", "records", "requests"]) {
    const v = (json as Record<string, unknown>)[k];
    if (Array.isArray(v)) return v.find((x) => x && typeof x === "object");
    if (v && typeof v === "object") {
      const inner = firstObject(v);
      if (inner) return inner;
    }
  }
  return undefined;
}

/** Provar alla kandidater (sida 0) och rapporterar vad varje ger – för /api/debug. */
export async function probeJsonApis(templates: string[], parse: (json: unknown) => Assignment[]): Promise<ApiProbe[]> {
  return Promise.all(
    templates.map(async (tpl): Promise<ApiProbe> => {
      const url = tpl.replace("{page}", "0");
      try {
        const r = await fetchJsonPage(url, parse);
        const obj = firstObject(r.json);
        return {
          url,
          status: r.status,
          contentType: r.contentType,
          bytes: r.body.length,
          items: r.items.length,
          sample: r.body.slice(0, 600),
          firstKeys: obj ? Object.keys(obj) : undefined,
          firstItem: r.items[0],
        };
      } catch (err) {
        return { url, status: err instanceof Error ? err.message : String(err), bytes: 0, items: 0 };
      }
    }),
  );
}

/**
 * Provar den första kandidaten; ger den inget provas resten parallellt. Den
 * som svarar med uppdrag används och bläddras upp till `maxPages` sidor.
 */
export async function scrapeJsonApi(
  templates: string[],
  parse: (json: unknown) => Assignment[],
  { maxPages, errors }: { maxPages: number; errors: string[] },
): Promise<{ items: Assignment[]; pages: number; via: string }> {
  const tryTpl = (tpl: string) =>
    fetchJsonPage(tpl.replace("{page}", "0"), parse)
      .then((r) => ({ tpl, r }))
      .catch(() => null);
  const [primary, ...rest] = templates;
  let tried = [await tryTpl(primary)];
  let hit = tried[0]?.r.items.length ? tried[0] : null;
  if (!hit && rest.length) {
    tried = [...tried, ...(await Promise.all(rest.map(tryTpl)))];
    hit = tried.find((t) => t && t.r.items.length > 0) ?? null;
  }
  if (!hit) {
    errors.push(`API: inget svar med uppdrag (${tried.map((t) => t?.r.status ?? "fel").join(", ")})`);
    return { items: [], pages: 0, via: "" };
  }
  const seen = new Map(hit.r.items.map((a) => [a.id, a]));
  let pages = 1;
  const paged = hit.tpl.includes("{page}");
  let lastJson = hit.r.json;
  for (let page = 1; paged && page < maxPages && !isLastPage(lastJson, page - 1); page++) {
    try {
      const r = await fetchJsonPage(hit.tpl.replace("{page}", String(page)), parse);
      const fresh = r.items.filter((a) => !seen.has(a.id));
      if (!fresh.length) break;
      fresh.forEach((a) => seen.set(a.id, a));
      pages++;
      lastJson = r.json;
    } catch {
      break;
    }
  }
  return { items: [...seen.values()], pages, via: new URL(hit.tpl.replace("{page}", "0")).pathname };
}
