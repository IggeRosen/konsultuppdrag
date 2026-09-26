const USER_AGENT =
  "Mozilla/5.0 (compatible; KonsultuppdragBot/1.0; +https://github.com/iggerosen/konsultuppdrag)";

export interface FetchResult {
  status: number;
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** Hämtar en sida som text med timeout. Next.js cachar svaret i `revalidate` sekunder. */
export async function fetchText(
  url: string,
  {
    timeoutMs = 8000,
    revalidate = 1800,
    headers = {},
    method = "GET",
    body,
  }: { timeoutMs?: number; revalidate?: number; headers?: Record<string, string>; method?: "GET" | "POST"; body?: string } = {},
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      body,
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.8",
        ...headers,
      },
      ...(method === "GET" ? { next: { revalidate } } : { cache: "no-store" }),
    } as RequestInit);
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k !== "set-cookie") resHeaders[k] = v;
    });
    return { status: res.status, url: res.url || url, body: await res.text(), headers: resHeaders };
  } finally {
    clearTimeout(timer);
  }
}

/** Kör `fn` över `items` med begränsad parallellitet. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
