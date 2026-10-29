import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractWiseId, parseWiseListing, wiseLastPage } from "../src/lib/sources/wise.ts";

const html = readFileSync(new URL("./fixtures/wise-list.html", import.meta.url), "utf8");

test("extractWiseId tar id:t sist i annonsadressen", () => {
  assert.equal(extractWiseId("https://www.wise.se/jobb/cloud-engineer-data-platform-8636680/"), "8636680");
  assert.equal(extractWiseId("https://www.wise.se/jobb/%f0%9f%93%8a-it-business-partner-erp-och-finans-6748217/"), "6748217");
  assert.equal(extractWiseId("https://www.wise.se/lediga-jobb/"), null);
  assert.equal(extractWiseId("https://www.wise.se/medarbetare/jacob-elmeljung/"), null);
});

test("parseWiseListing läser korten och hoppar över talent network", () => {
  const items = parseWiseListing(html);
  assert.equal(items.length, 2);
  const [a, b] = items;
  assert.equal(a.id, "wise:8636680");
  assert.equal(a.title, "Cloud Engineer – Data Platform");
  assert.equal(a.url, "https://www.wise.se/jobb/cloud-engineer-data-platform-8636680/");
  assert.equal(a.location, "Stockholm");
  assert.equal(a.country, "Sverige");
  assert.match(a.description ?? "", /Databricks/);
  assert.match(a.description ?? "", /Område: IT\./);
  assert.equal(b.title, "Senior Commercial Finance Consultant – Pricing & Financial Modelling");
});

test("wiseLastPage hittar sista sidan i pagineringen", () => {
  assert.equal(wiseLastPage(html), 10);
  assert.equal(wiseLastPage("<html></html>"), 1);
});
