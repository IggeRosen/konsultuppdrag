import { test } from "node:test";
import assert from "node:assert/strict";
import { scrapeCinodeListing } from "../src/lib/sources/cinode-loadmore.ts";

const card = (id: number) =>
  `<div class="requests-list__card"><div class="requests-list__title"><a class="list__heading" href="/market/requests/${id}">Uppdrag ${id}</a></div></div>`;
const page = (ids: number[], cursor?: string) =>
  `<div id="requests">${ids.map(card).join("")}</div>${cursor ? `<button id="load-more-button" data-next-cursor="${cursor}">Load more</button>` : ""}`;

function mockFetch(routes: Record<string, string>) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const body = routes[url];
    return new Response(body ?? "not found", { status: body === undefined ? 404 : 200 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

test("bläddrar med ?nextCursor= tills cursorn tar slut", async () => {
  const base = "https://cinode.com/market/requests";
  const m = mockFetch({
    [base]: page([10, 9], "C1"),
    [`${base}?nextCursor=C1`]: page([8, 7], "C2"),
    [`${base}?nextCursor=C2`]: page([6]),
  });
  try {
    const r = await scrapeCinodeListing(10, []);
    assert.deepEqual(r.items.map((a) => a.id), ["cinode:10", "cinode:9", "cinode:8", "cinode:7", "cinode:6"]);
    assert.equal(r.pages, 3);
    assert.match(r.via, /nextCursor= \(ingen ny cursor\)/);
  } finally {
    m.restore();
  }
});

test("respekterar maxPages och stannar om en sida inte ger nya uppdrag", async () => {
  const base = "https://cinode.com/market/requests";
  const m = mockFetch({
    [base]: page([10], "C1"),
    [`${base}?nextCursor=C1`]: page([9], "C2"),
    [`${base}?nextCursor=C2`]: page([9], "C3"),
  });
  try {
    assert.equal((await scrapeCinodeListing(2, [])).pages, 2);
    assert.equal((await scrapeCinodeListing(10, [])).pages, 2);
  } finally {
    m.restore();
  }
});
