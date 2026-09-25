import { test } from "node:test";
import assert from "node:assert/strict";
import { ework } from "../src/lib/sources/ework.ts";

function mockFetch(routes: (url: string) => { status?: number; body: string } | undefined) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const r = routes(url);
    return new Response(r?.body ?? "not found", { status: r ? (r.status ?? 200) : 404 });
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

test("hittar fungerande API-adress, bläddrar och filtrerar utgångna", async () => {
  const job = (id: number, deadline = "2099-01-01") => ({ id, title: `Uppdrag ${id}`, startDate: "2026-10-01", lastDayOfApplications: deadline });
  const restore = mockFetch((url) => {
    const u = new URL(url);
    if (u.pathname === "/api/public/job-requests/search") {
      const page = Number(u.searchParams.get("page"));
      const pages = [
        { content: [job(3), job(2)], totalPages: 2, last: false },
        { content: [job(1, "2020-01-01")], totalPages: 2, last: true },
      ];
      return { body: JSON.stringify(pages[page] ?? { content: [] }) };
    }
    if (u.pathname.startsWith("/sv/job-requests/") || u.pathname === "/sv/job-requests") return { body: "<html><body><app-root></app-root></body></html>" };
    return undefined;
  });
  try {
    const { assignments, strategies } = await ework.fetchAssignments();
    assert.deepEqual(assignments.map((a) => a.id).sort(), ["ework:2", "ework:3"]);
    assert.ok(strategies.some((s) => /API \/api\/public\/job-requests\/search \(2 sid\): 3/.test(s)), strategies.join(" | "));
    assert.ok(strategies.some((s) => /utgångna bortfiltrerade: 1/.test(s)));
  } finally {
    restore();
  }
});

test("tydligt fel när inget fungerar", async () => {
  const restore = mockFetch(() => ({ status: 403, body: "forbidden" }));
  try {
    await assert.rejects(() => ework.fetchAssignments(), /Kunde inte hämta uppdrag från Ework\/Verama/);
  } finally {
    restore();
  }
});

test("använder standardadressen direkt och hoppar över sondering, sitemap och detaljsidor", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === "/api/public/job-requests" && u.searchParams.get("sort")) {
      const job = { id: 7, title: "Java", startDate: "2026-10-01", description: "x".repeat(50) };
      return new Response(JSON.stringify({ content: [job], totalPages: 1, last: true }));
    }
    return new Response("<html></html>");
  }) as typeof fetch;
  try {
    const { assignments } = await ework.fetchAssignments();
    assert.deepEqual(assignments.map((a) => a.id), ["ework:7"]);
    const paths = calls.map((c) => new URL(c).pathname);
    assert.ok(!paths.includes("/api/public/job-requests/search"), "ska inte sondera alternativ");
    assert.ok(!paths.some((p) => /sitemap|robots/.test(p)), "ska inte läsa sitemap");
    assert.ok(!paths.some((p) => /\/job-requests\/\d+/.test(p)), "ska inte hämta detaljsidor");
  } finally {
    globalThis.fetch = original;
  }
});
