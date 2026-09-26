// OBS: JSON/HTML nedan är syntetisk. Magnit Sources dataformat är inte känt än;
// uppdatera via /api/debug?url=https://magnit-source.magnitglobal.com/&probe=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMagnitId, isSwedish, magnitUrl, parseMagnitDetail, parseMagnitHtml, parseMagnitJson } from "../src/lib/sources/magnit-parse.ts";
import { isLastPage, scrapeJsonApi } from "../src/lib/json-api.ts";

test("uppdragslänkar", () => {
  assert.equal(extractMagnitId("https://magnit-source.magnitglobal.com/jobs/REQ-12345"), "REQ-12345");
  assert.equal(extractMagnitId("/en/job-requests/8812"), "8812");
  assert.equal(extractMagnitId("https://magnit-source.magnitglobal.com/jobs/search"), null);
  assert.equal(extractMagnitId("https://example.com/jobs/123"), null);
});

test("JSON: strängid, egen länk, land och kund", () => {
  const items = parseMagnitJson({
    results: [
      {
        jobId: "REQ-12345",
        jobTitle: "Senior .NET Developer",
        client: { name: "Volvo Cars" },
        location: { city: "Gothenburg", countryCode: "SE" },
        postedDate: "2026-09-24T10:00:00Z",
        closingDate: "2026-10-10",
        startDate: "2026-11-01",
        url: "/jobs/REQ-12345",
        jobDescription: "<p>C# och Azure</p>",
      },
      { jobId: "REQ-9", jobTitle: "Data Engineer", location: { city: "Austin", country: "United States" }, postedDate: "2026-09-20" },
    ],
  });
  assert.equal(items.length, 2);
  const [dotnet, us] = items;
  assert.deepEqual(dotnet, {
    id: "magnit:REQ-12345",
    source: "Magnit",
    title: "Senior .NET Developer",
    url: "https://magnit-source.magnitglobal.com/jobs/REQ-12345",
    company: "Volvo Cars",
    location: "Göteborg",
    country: "SE",
    published: "2026-09-24",
    deadline: "2026-10-10",
    start: "2026-11-01",
    description: "C# och Azure",
  });
  assert.equal(isSwedish(dotnet), true);
  assert.equal(isSwedish(us), false);
});

test("Sverigefilter", () => {
  assert.equal(isSwedish({ country: "Sweden" }), true);
  assert.equal(isSwedish({ country: "NO" }), false);
  assert.equal(isSwedish({ location: "Stockholm, Sweden" }), true);
  assert.equal(isSwedish({ location: "London" }), false);
  assert.equal(isSwedish({}), true, "okänd plats behålls");
  assert.equal(magnitUrl("A B"), "https://magnit-source.magnitglobal.com/jobs/A%20B");
});

test("HTML: __NEXT_DATA__ och länkar", () => {
  const html = `<html><body>
    <a href="/jobs/777"><h3>Scrum Master</h3></a><span class="location">Malmö</span>
    <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"jobs":[{"id":"778","title":"Testledare","city":"Uppsala","country":"Sweden"}]}}}</script>
  </body></html>`;
  const items = parseMagnitHtml(html);
  assert.deepEqual(items.map((i) => [i.id, i.title]).sort(), [["magnit:777", "Scrum Master"], ["magnit:778", "Testledare"]]);
});

test("detaljsida", () => {
  const html = `<html><head><title>Senior .NET Developer | Magnit Source</title>
    <meta property="og:description" content="Vi söker en senior .NET-utvecklare med erfarenhet av Azure och mikrotjänster till ett långt uppdrag."></head><body></body></html>`;
  const d = parseMagnitDetail(html);
  assert.equal(d.title, "Senior .NET Developer");
  assert.match(d.description!, /mikrotjänster/);
});

test("isLastPage", () => {
  assert.equal(isLastPage({ last: true }, 0), true);
  assert.equal(isLastPage({ totalPages: 3 }, 1), false);
  assert.equal(isLastPage({ totalPages: 3 }, 2), true);
  assert.equal(isLastPage({ page: { totalPages: 1 } }, 0), true);
  assert.equal(isLastPage({ hasMore: false }, 0), true);
  assert.equal(isLastPage({ next: null, results: [] }, 0), true);
  assert.equal(isLastPage([], 0), false);
});

test("scrapeJsonApi: faller tillbaka på andra kandidaten och bläddrar", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.pathname === "/b") {
      const page = Number(u.searchParams.get("page"));
      const jobs = [[{ id: 1, title: "A", city: "Lund" }], [{ id: 2, title: "B", city: "Lund" }], []][page] ?? [];
      return new Response(JSON.stringify({ content: jobs, totalPages: 2 }));
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  try {
    const r = await scrapeJsonApi(["https://x.test/a?page={page}", "https://x.test/b?page={page}"], parseMagnitJson, { maxPages: 5, errors: [] });
    assert.deepEqual(r.items.map((a) => a.id), ["magnit:1", "magnit:2"]);
    assert.equal(r.pages, 2);
    assert.equal(r.via, "/b");
  } finally {
    globalThis.fetch = original;
  }
});
