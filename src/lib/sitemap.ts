import * as cheerio from "cheerio";
import { fetchText } from "./http.ts";
import { clean } from "./parse-utils.ts";

/** Plockar ut alla <loc> ur en sitemap (eller sitemap-index). */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const $ = cheerio.load(xml, { xml: true });
  const sitemaps = $("sitemapindex > sitemap > loc")
    .toArray()
    .map((el) => clean($(el).text()));
  const urls = $("urlset > url > loc")
    .toArray()
    .map((el) => clean($(el).text()));
  return { urls, sitemaps };
}

/** Hittar "Sitemap:"-rader i robots.txt. */
export function sitemapsFromRobots(robots: string): string[] {
  return [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
}

/**
 * Samlar uppdrags-id:n från en sajts sitemap(s): robots.txt → Sitemap-rader
 * plus /sitemap.xml. Följer sitemap-index ett steg och prioriterar
 * under-sitemaps vars namn matchar `prefer`.
 */
export async function idsFromSitemaps(
  base: string,
  extractId: (url: string) => string | null,
  { errors, prefer = /request|job|assignment|uppdrag/i }: { errors: string[]; prefer?: RegExp },
): Promise<string[]> {
  const roots = new Set([`${base}/sitemap.xml`]);
  try {
    const robots = await fetchText(`${base}/robots.txt`, { revalidate: 24 * 3600 });
    if (robots.status < 400) sitemapsFromRobots(robots.body).forEach((s) => roots.add(s));
  } catch {
    /* robots.txt är frivillig */
  }

  const ids = new Set<string>();
  const visit = async (url: string, depth: number) => {
    try {
      const res = await fetchText(url, { revalidate: 3600 });
      if (res.status >= 400) return;
      const { urls, sitemaps } = parseSitemap(res.body);
      for (const u of urls) {
        const id = extractId(u);
        if (id) ids.add(id);
      }
      if (depth < 1) {
        const children = sitemaps.sort((a, b) => Number(prefer.test(b)) - Number(prefer.test(a))).slice(0, 10);
        await Promise.all(children.map((c) => visit(c, depth + 1)));
      }
    } catch (err) {
      errors.push(`sitemap ${new URL(url).pathname}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  await Promise.all([...roots].map((r) => visit(r, 0)));
  return [...ids];
}
