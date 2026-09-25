import type { Assignment } from "../types.ts";
import { fetchText } from "../http.ts";
import { extractNextCursor, parseCinodeListing, parseLoadMoreResponse } from "./cinode-parse.ts";

// Cinode Markets lista visar 20 uppdrag och en "Load more"-knapp med
// data-next-cursor (en DynamoDB-nyckel, base64). Vilken adress knappen anropar
// står i market.cinode.com/dist/js/requests.js. Tills den är känd provar vi de
// vanligaste varianterna och använder den som ger nya uppdrag. Är adressen känd
// kan den sättas med env CINODE_LOAD_MORE_URL, t.ex.
//   https://cinode.com/market/requests?cursor={cursor}
export const LISTING_URL = "https://cinode.com/market/requests";

export function loadMoreCandidates(listingUrl: string, cursor: string): string[] {
  const c = encodeURIComponent(cursor);
  const override = process.env.CINODE_LOAD_MORE_URL;
  if (override) return [override.replace("{cursor}", c)];
  const u = new URL(listingUrl);
  const base = `${u.origin}${u.pathname.replace(/\/$/, "")}`;
  return [
    `${base}?cursor=${c}`,
    `${base}?nextCursor=${c}`,
    `${base}?next=${c}`,
    `${base}?after=${c}`,
    `${base}/load-more?cursor=${c}`,
    `${base}/more?cursor=${c}`,
    `${base}/page?cursor=${c}`,
    `${base}/list?cursor=${c}`,
    `${u.origin}/market/api/requests?cursor=${c}`,
  ];
}

const XHR_HEADERS = { "X-Requested-With": "XMLHttpRequest", Accept: "text/html,application/json;q=0.9,*/*;q=0.8" };

export interface ProbeResult {
  url: string;
  status: number | string;
  bytes: number;
  newIds: number;
  cursor: boolean;
}

/** Provar alla kandidatadresser för nästa sida och rapporterar hur många nya uppdrag varje ger. */
export async function probeLoadMore(
  listingUrl: string,
  cursor: string,
  knownIds: Set<string>,
): Promise<{ results: ProbeResult[]; best: { url: string; items: Assignment[]; cursor: string | null } | null }> {
  let best: { url: string; items: Assignment[]; cursor: string | null } | null = null;
  const candidates = loadMoreCandidates(listingUrl, cursor);
  const results = await Promise.all(
    candidates.map(async (url): Promise<ProbeResult> => {
      try {
        const res = await fetchText(url, { revalidate: 900, timeoutMs: 6000, headers: XHR_HEADERS });
        if (res.status >= 400) return { url, status: res.status, bytes: res.body.length, newIds: 0, cursor: false };
        const parsed = parseLoadMoreResponse(res.body, res.url);
        const fresh = parsed.items.filter((a) => !knownIds.has(a.id));
        return { url, status: res.status, bytes: res.body.length, newIds: fresh.length, cursor: !!parsed.cursor };
      } catch (err) {
        return { url, status: err instanceof Error ? err.message : String(err), bytes: 0, newIds: 0, cursor: false };
      }
    }),
  );
  // Välj i kandidatordning den första som gav nya uppdrag (hämtningen är cachad).
  for (const r of results) {
    if (r.newIds > 0) {
      const res = await fetchText(r.url, { revalidate: 900, timeoutMs: 6000, headers: XHR_HEADERS });
      const parsed = parseLoadMoreResponse(res.body, res.url);
      best = { url: r.url, items: parsed.items, cursor: parsed.cursor };
      break;
    }
  }
  return { results, best };
}

/** Hämtar listan och bläddrar med "Load more" så långt det går (max `maxPages` sidor). */
export async function scrapeCinodeListing(
  maxPages: number,
  errors: string[],
): Promise<{ items: Assignment[]; pages: number; via: string }> {
  let first;
  try {
    first = await fetchText(LISTING_URL);
  } catch (err) {
    errors.push(`/market/requests: ${err instanceof Error ? err.message : String(err)}`);
    return { items: [], pages: 0, via: "" };
  }
  if (first.status >= 400) {
    errors.push(`HTTP ${first.status} från /market/requests`);
    return { items: [], pages: 0, via: "" };
  }
  const seen = new Map(parseCinodeListing(first.body, first.url).map((a) => [a.id, a]));
  let cursor = extractNextCursor(first.body);
  let pages = 1;
  if (!cursor || !seen.size) return { items: [...seen.values()], pages, via: "" };

  // Hitta vilken adress "Load more" använder.
  const probe = await probeLoadMore(first.url, cursor, new Set(seen.keys()));
  if (!probe.best) return { items: [...seen.values()], pages, via: "load more: okänd adress" };
  const template = probe.best.url.replace(encodeURIComponent(cursor), "{cursor}");
  for (const a of probe.best.items) if (!seen.has(a.id)) seen.set(a.id, a);
  pages++;
  cursor = probe.best.cursor;

  while (cursor && pages < maxPages) {
    try {
      const res = await fetchText(template.replace("{cursor}", encodeURIComponent(cursor)), {
        revalidate: 900,
        timeoutMs: 6000,
        headers: XHR_HEADERS,
      });
      if (res.status >= 400) break;
      const parsed = parseLoadMoreResponse(res.body, res.url);
      const fresh = parsed.items.filter((a) => !seen.has(a.id));
      if (!fresh.length) break;
      fresh.forEach((a) => seen.set(a.id, a));
      pages++;
      cursor = parsed.cursor;
    } catch {
      break;
    }
  }
  return { items: [...seen.values()], pages, via: `load more: ${new URL(template).pathname}${new URL(template).search.replace(/=.*$/, "=")}` };
}
