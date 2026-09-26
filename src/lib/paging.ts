import type { Assignment } from "./types.ts";
import { fetchText } from "./http.ts";
import { findNextPage } from "./parse-utils.ts";

// Sätt att adressera sida N som vi provar om sidan saknar en vanlig "nästa"-länk:
// query-parametrar samt WordPress-stilen /page/N/.
const PAGE_PARAMS = ["page", "p", "pageNumber", "pageIndex", "currentPage", "/page/"];

export interface ListingPage {
  items: Assignment[];
  html: string;
  url: string;
}

export async function fetchListing(
  url: string,
  parse: (html: string, url: string) => Assignment[],
  errors: string[],
): Promise<ListingPage | null> {
  try {
    const res = await fetchText(url);
    if (res.status >= 400) {
      errors.push(`HTTP ${res.status} från ${new URL(url).pathname}`);
      return null;
    }
    return { items: parse(res.body, res.url), html: res.body, url: res.url };
  } catch (err) {
    errors.push(`${new URL(url).pathname}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function withParam(url: string, key: string, value: number): string {
  const u = new URL(url);
  if (key === "/page/") {
    u.pathname = `${u.pathname.replace(/\/page\/\d+\/?$/, "").replace(/\/$/, "")}/page/${value}/`;
    return u.toString();
  }
  u.searchParams.set(key, String(value));
  return u.toString();
}

/**
 * Hämtar en listsida och bläddrar vidare. Följer en "nästa"-länk om den finns,
 * annars provas vanliga sidparametrar och den som ger nya uppdrag används.
 */
export async function scrapePaged(
  firstUrl: string,
  parse: (html: string, url: string) => Assignment[],
  { hostSuffix, maxPages, errors }: { hostSuffix: string; maxPages: number; errors: string[] },
): Promise<{ items: Assignment[]; pages: number; via: string }> {
  const first = await fetchListing(firstUrl, parse, errors);
  if (!first) return { items: [], pages: 0, via: "" };
  const seen = new Map(first.items.map((a) => [a.id, a]));
  let pages = 1;
  const addNew = (items: Assignment[]) => {
    let added = 0;
    for (const a of items) if (!seen.has(a.id)) (seen.set(a.id, a), added++);
    return added;
  };
  if (!first.items.length) return { items: [], pages, via: "" };

  // 1) Riktiga "nästa"-länkar.
  let next = findNextPage(first.html, first.url, hostSuffix);
  if (next) {
    while (next && pages < maxPages) {
      const page = await fetchListing(next, parse, errors);
      if (!page || addNew(page.items) === 0) break;
      pages++;
      next = findNextPage(page.html, page.url, hostSuffix);
    }
    return { items: [...seen.values()], pages, via: "nästa-länk" };
  }

  // 2) Gissa sidparameter: den första som ger nya uppdrag på sida 2 vinner.
  const probes = await Promise.all(PAGE_PARAMS.map((k) => fetchListing(withParam(firstUrl, k, 2), parse, [])));
  const hit = probes.findIndex((p) => p && p.items.some((a) => !seen.has(a.id)));
  if (hit < 0) return { items: [...seen.values()], pages, via: "" };
  const param = PAGE_PARAMS[hit];
  addNew(probes[hit]!.items);
  pages++;
  for (let n = 3; n <= maxPages; n++) {
    const page = await fetchListing(withParam(firstUrl, param, n), parse, errors);
    if (!page || addNew(page.items) === 0) break;
    pages++;
  }
  return { items: [...seen.values()], pages, via: param === "/page/" ? "/page/N/" : `?${param}=` };
}
