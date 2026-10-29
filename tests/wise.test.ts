import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractWiseId, parseSwedishPeriod, parseWiseJob, parseWiseListing, wiseLastPage } from "../src/lib/sources/wise.ts";

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

const job = readFileSync(new URL("./fixtures/wise-job.html", import.meta.url), "utf8");

test("parseWiseJob läser period, omfattning, arbetssätt och annonstext utan kontaktuppgifter", () => {
  const d = parseWiseJob(job);
  assert.ok(d);
  assert.equal(d.open, true);
  assert.equal(d.location, "Stockholm");
  assert.equal(d.deadline, undefined);
  assert.equal(d.start, "2027-01-01");
  assert.equal(d.end, "2027-07-20");
  assert.equal(d.extent, "100 %");
  assert.equal(d.workMode, "På plats");
  assert.match(d.description ?? "", /OM ROLLEN\nVi söker nu en senior redovisningsekonom/);
  assert.match(d.description ?? "", /Upprätta årsredovisningar\./);
  assert.doesNotMatch(d.description ?? "", /OM WISE|@|Anna Exempel|Ansök nu/);
});

test("parseWiseJob markerar stängda annonser", () => {
  const d = parseWiseJob(job.replace("Öppen", "Stängd"));
  assert.equal(d?.open, false);
});

test("parseSwedishPeriod", () => {
  assert.deepEqual(parseSwedishPeriod("1 januari – 20 juli 2027"), { start: "2027-01-01", end: "2027-07-20" });
  assert.deepEqual(parseSwedishPeriod("1 november – 31 mars 2027"), { start: "2026-11-01", end: "2027-03-31" });
  assert.deepEqual(parseSwedishPeriod("15 december 2026 – 30 juni 2027"), { start: "2026-12-15", end: "2027-06-30" });
  assert.deepEqual(parseSwedishPeriod("Snarast, 6 månader"), { start: undefined });
});
