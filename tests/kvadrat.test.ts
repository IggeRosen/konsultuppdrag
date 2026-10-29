// __NUXT_DATA__ är riktig (uppdrag.kvadrat.se via /api/debug, 2026-10-29), oförkortad.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractKvadratSlug, parseKvadratPage, unflattenNuxt } from "../src/lib/sources/kvadrat.ts";

const NUXT = readFileSync(new URL("./fixtures/kvadrat-nuxt-data.json", import.meta.url), "utf8");
const page = (data: string) => `<html><body><div id="__nuxt"></div><script type="application/json" data-nuxt-data="nuxt-app" id="__NUXT_DATA__">${data}</script></body></html>`;

test("unflattenNuxt packar upp devalue med omslag och delade referenser", () => {
  const flat = [["ShallowReactive", 1], { a: 2, b: 2, c: -1 }, ["Reactive", 3], { x: 4 }, "hej"];
  const out = unflattenNuxt(flat) as Record<string, unknown>;
  assert.deepEqual(out.a, { x: "hej" });
  assert.equal(out.a, out.b);
  assert.equal(out.c, undefined);
});

test("parseKvadratPage tolkar alla uppdrag på startsidan", () => {
  const { items, total } = parseKvadratPage(page(NUXT));
  assert.equal(total, 17);
  assert.equal(items.length, 17);
  assert.equal(new Set(items.map((a) => a.id)).size, 17);
  const a = items.find((x) => x.id === "kvadrat:kravanalytiker-sundsvall");
  assert.ok(a);
  assert.equal(a.source, "Kvadrat");
  assert.equal(a.title, "Kravanalytiker");
  assert.equal(a.url, "https://uppdrag.kvadrat.se/hitta-uppdrag/kravanalytiker-sundsvall");
  assert.equal(a.location, "Sundsvall");
  assert.equal(a.country, "Sverige");
  assert.equal(a.start, "2026-10-12");
  assert.equal(a.end, "2027-06-30");
  assert.equal(a.duration, "9 månader");
  assert.equal(a.extent, "100 %");
  assert.match(a.description ?? "", /^Kunden söker en senior kravanalytiker/);
  assert.match(a.description ?? "", /\nKompetenser: .*Jira och Confluence/);
  for (const x of items) assert.match(x.url, /^https:\/\/uppdrag\.kvadrat\.se\/hitta-uppdrag\/[a-z0-9-]+$/);
});

test("parseKvadratPage tål sidor utan eller med trasig data", () => {
  assert.deepEqual(parseKvadratPage("<html></html>").items, []);
  assert.deepEqual(parseKvadratPage(page("[not json")).items, []);
});

test("extractKvadratSlug", () => {
  assert.equal(extractKvadratSlug("https://uppdrag.kvadrat.se/hitta-uppdrag/kravanalytiker-sundsvall"), "kravanalytiker-sundsvall");
  assert.equal(extractKvadratSlug("/hitta-uppdrag/verksamhetsutvecklare-stockholm?x=1"), "verksamhetsutvecklare-stockholm");
  assert.equal(extractKvadratSlug("https://uppdrag.kvadrat.se/"), null);
});
