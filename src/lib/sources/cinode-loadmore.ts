import type { Assignment } from "../types.ts";
import { fetchText, type FetchResult } from "../http.ts";
import { extractNextCursor, parseCinodeListing, parseLoadMoreResponse } from "./cinode-parse.ts";

// Cinode Markets lista visar 20 uppdrag och en "Load more"-knapp med
// data-next-cursor (en DynamoDB-nyckel, base64). Nästa sida hämtas med
// ?nextCursor=<cursor> (verifierat via /api/debug?…&probe=1). Adressen kan
// överstyras med env CINODE_LOAD_MORE_URL, t.ex.
//   https://cinode.com/market/requests?nextCursor={cursor}
export const LISTING_URL = "https://cinode.com/market/requests";
const DEFAULT_TEMPLATE = `${LISTING_URL}?nextCursor={cursor}`;

function template(): string {
  return process.env.CINODE_LOAD_MORE_URL || DEFAULT_TEMPLATE;
}

function fill(tpl: string, cursor: string): string {
  return tpl.replace("{cursor}", encodeURIComponent(cursor));
}

/** Alternativa adresser som provas om standardadressen slutar fungera. */
export function loadMoreCandidates(listingUrl: string, cursor: string): string[] {
  const u = new URL(listingUrl);
  const base = `${u.origin}${u.pathname.replace(/\/$/, "")}`;
  const tpls = [
    template(),
    `${base}?nextCursor={cursor}`,
    `${base}?cursor={cursor}`,
    `${base}?next={cursor}`,
    `${base}?after={cursor}`,
    `${base}/load-more?cursor={cursor}`,
    `${u.origin}/market/api/requests?cursor={cursor}`,
  ];
  return [...new Set(tpls)].map((t) => fill(t, cursor));
}

const XHR_HEADERS = { "X-Requested-With": "XMLHttpRequest", Accept: "text/html,application/json;q=0.9,*/*;q=0.8" };

function fetchPage(url: string): Promise<FetchResult> {
  return fetchText(url, { revalidate: 900, timeoutMs: 6000, headers: XHR_HEADERS });
}

export interface ProbeResult {
  url: string;
  status: number | string;
  bytes: number;
  newIds: number;
  /** Cursorn till sidan efter, om den hittades i svaret */
  nextCursor: string | null;
  /** Bara för adresser som gav nya uppdrag: svarets headers och slut, för felsökning */
  headers?: Record<string, string>;
  tail?: string;
}

/** Provar kandidatadresserna för nästa sida och rapporterar vad varje ger. */
export async function probeLoadMore(listingUrl: string, cursor: string, knownIds: Set<string>): Promise<ProbeResult[]> {
  return Promise.all(
    loadMoreCandidates(listingUrl, cursor).map(async (url): Promise<ProbeResult> => {
      try {
        const res = await fetchPage(url);
        if (res.status >= 400) return { url, status: res.status, bytes: res.body.length, newIds: 0, nextCursor: null };
        const parsed = parseLoadMoreResponse(res.body, res.url, res.headers);
        const newIds = parsed.items.filter((a) => !knownIds.has(a.id)).length;
        return {
          url,
          status: res.status,
          bytes: res.body.length,
          newIds,
          nextCursor: parsed.cursor,
          ...(newIds > 0 ? { headers: res.headers, tail: res.body.slice(-1500) } : {}),
        };
      } catch (err) {
        return { url, status: err instanceof Error ? err.message : String(err), bytes: 0, newIds: 0, nextCursor: null };
      }
    }),
  );
}

/** Hämtar listan och bläddrar med "Load more" så långt det går (max `maxPages` sidor). */
export async function scrapeCinodeListing(
  maxPages: number,
  errors: string[],
): Promise<{ items: Assignment[]; pages: number; via: string }> {
  let first: FetchResult;
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
  let cursor = extractNextCursor(first.body, first.headers);
  let pages = 1;
  if (!cursor || !seen.size) return { items: [...seen.values()], pages, via: "" };

  // Hämta en sida med given mall; returnerar antal nya uppdrag och nästa cursor.
  const step = async (tpl: string, c: string) => {
    const res = await fetchPage(fill(tpl, c));
    if (res.status >= 400) return { added: 0, next: null as string | null };
    const parsed = parseLoadMoreResponse(res.body, res.url, res.headers);
    let added = 0;
    for (const a of parsed.items) if (!seen.has(a.id)) (seen.set(a.id, a), added++);
    return { added, next: parsed.cursor };
  };

  let tpl = template();
  let result = await step(tpl, cursor).catch(() => ({ added: 0, next: null }));
  if (!result.added) {
    // Standardadressen gav inget – prova alternativen och byt mall om någon fungerar.
    const probe = await probeLoadMore(first.url, cursor, new Set(seen.keys()));
    const hit = probe.find((p) => p.newIds > 0);
    if (!hit) return { items: [...seen.values()], pages, via: "load more: ingen adress fungerade" };
    tpl = hit.url.replace(encodeURIComponent(cursor), "{cursor}");
    result = await step(tpl, cursor);
  }
  pages++;
  cursor = result.next;

  while (cursor && pages < maxPages) {
    const r = await step(tpl, cursor).catch(() => ({ added: 0, next: null }));
    if (!r.added) break;
    pages++;
    cursor = r.next;
  }
  const u = new URL(tpl.replace("{cursor}", "x"));
  const via = `load more: ${u.pathname}${u.search.replace(/=.*$/, "=")}${cursor ? "" : " (ingen ny cursor)"}`;
  return { items: [...seen.values()], pages, via };
}
