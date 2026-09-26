import { test } from "node:test";
import assert from "node:assert/strict";
import { magnit } from "../src/lib/sources/magnit.ts";

// Svarsformatet { jobs, totalCount, continuationToken } och POST-kroppen är tagna ur
// Magnit Sources JavaScript (2026-09-26). Uppdragsobjekten följer landing-page-svaret.
const job = (id: string, location: string, deadline = "2099-01-01T00:00:00+00:00") => ({
  id,
  title: `Uppdrag ${id}`,
  billRate: { amount: 800, currencySymbol: "kr", frequency: "Hourly" },
  location,
  company: "SEB",
  startDate: "2026-11-01T00:00:00+00:00",
  submissionDeadline: deadline,
  status: 4,
});

test("POST-sökning med continuationToken, Sverigefilter, detaljer och utgångna", async () => {
  const bodies: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === "/api/jobsearch" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (!body.continuationToken) {
        return new Response(
          JSON.stringify({ jobs: [job("req-a", "Stockholm, SWE"), job("req-b", "Amsterdam, NLD")], totalCount: 3, continuationToken: "T2" }),
        );
      }
      return new Response(JSON.stringify({ jobs: [job("req-c", "Göteborg, SWE", "2020-01-01T00:00:00+00:00")], totalCount: 3, continuationToken: null }));
    }
    const detail = url.pathname.match(/^\/api\/jobsearch\/([\w-]+)\/details$/);
    if (detail) return new Response(JSON.stringify({ ...job(detail[1], "Stockholm, SWE"), description: "Testledning i agila team med Cypress." }));
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  process.env.MAGNIT_PAGE_SIZE = "2";
  try {
    const { assignments, strategies } = await magnit.fetchAssignments();
    assert.deepEqual(assignments.map((a) => a.id), ["magnit:req-a"]);
    assert.equal(assignments[0].description, "Testledning i agila team med Cypress.");
    assert.equal(assignments[0].rate, "800 kr/tim");
    assert.equal((bodies[0] as { sortOption: unknown }).sortOption && (bodies[1] as { continuationToken: string }).continuationToken, "T2");
    assert.ok(strategies.some((s) => /utanför Sverige bortfiltrerade: 1/.test(s)), strategies.join(" | "));
    assert.ok(strategies.some((s) => /utgångna bortfiltrerade: 1/.test(s)));
  } finally {
    globalThis.fetch = original;
    delete process.env.MAGNIT_PAGE_SIZE;
  }
});
