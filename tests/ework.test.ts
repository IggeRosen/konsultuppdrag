// OBS: JSON/HTML nedan är syntetisk. Veramas API-format är inte dokumenterat;
// testerna visar att tolkningen klarar de vanligaste varianterna. Uppdatera med
// riktiga svar via /api/debug?url=https://app.verama.com/sv/job-requests&probe=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractVeramaId,
  mapVeramaJob,
  parseVeramaDetail,
  parseVeramaHtml,
  parseVeramaJson,
  parseVeramaTitle,
  veramaPageInfo,
} from "../src/lib/sources/ework-parse.ts";

test("känner igen uppdragslänkar", () => {
  assert.equal(extractVeramaId("https://app.verama.com/job-requests/33112"), "33112");
  assert.equal(extractVeramaId("https://app.verama.com/sv/job-requests/71217?x=1"), "71217");
  assert.equal(extractVeramaId("/app/job-requests/1407"), "1407");
  assert.equal(extractVeramaId("https://app.verama.com/sv/job-requests"), null);
  assert.equal(extractVeramaId("https://example.com/job-requests/1"), null);
});

test("sidtitlar", () => {
  assert.equal(parseVeramaTitle("API Specialist - Ework Verama"), "API Specialist");
  assert.equal(parseVeramaTitle("Backend Developer API"), "Backend Developer API");
  assert.equal(parseVeramaTitle("Verama"), undefined);
  assert.equal(parseVeramaTitle("Discover hundreds of new contract jobs every week | Ework Verama"), undefined);
});

test("mappar ett uppdragsobjekt med nästlade fält", () => {
  const a = mapVeramaJob({
    id: 71217,
    title: "Specialist API Management",
    customer: { name: "Västra Götalandsregionen" },
    location: { city: "Gothenburg", country: "Sweden" },
    remoteness: 50,
    startDate: "2026-11-01",
    endDate: "2027-10-31T00:00:00Z",
    firstDayOfApplications: "2026-09-20T08:00:00Z",
    lastDayOfApplications: "2026-10-05",
    skills: [{ skill: { name: "Azure API Management" } }, { name: "OAuth" }],
    description: "<p>Vi söker en specialist.</p>",
  })!;
  assert.deepEqual(a, {
    id: "ework:71217",
    source: "Ework",
    title: "Specialist API Management",
    url: "https://app.verama.com/sv/job-requests/71217",
    company: "Västra Götalandsregionen",
    location: "Göteborg",
    workMode: "Hybrid · 50 % distans",
    published: "2026-09-20",
    deadline: "2026-10-05",
    start: "2026-11-01",
    end: "2027-10-31",
    description: "Vi söker en specialist. Kompetenser: Azure API Management, OAuth",
  });
});

test("ignorerar objekt som inte är uppdrag", () => {
  assert.equal(mapVeramaJob({ id: 5, name: "Java" }), null);
  assert.equal(mapVeramaJob({ id: "abc", title: "X", startDate: "2026-01-01" }), null);
});

test("hittar uppdrag i Spring-sida och läser paginering", () => {
  const page = {
    content: [
      { id: 1, title: "Java-utvecklare", location: "Stockholm", remoteness: 0, startDate: "2026-10-01" },
      { id: 2, title: "Scrum Master", locations: [{ city: "Malmö" }], remoteness: 100, startDate: "2026-10-01" },
    ],
    totalPages: 3,
    last: false,
    number: 0,
  };
  const items = parseVeramaJson(page);
  assert.deepEqual(items.map((i) => [i.id, i.location, i.workMode]), [
    ["ework:1", "Stockholm", "På plats"],
    ["ework:2", "Malmö", "Distans"],
  ]);
  assert.deepEqual(veramaPageInfo(page), { totalPages: 3, last: false });
  assert.deepEqual(veramaPageInfo({ page: { totalPages: 2 } }), { totalPages: 2 });
});

test("HTML: transfer state och länkar", () => {
  const html = `<html><body>
    <a href="/sv/job-requests/900"><h3>Testledare</h3></a>
    <script id="serverApp-state" type="application/json">{"jobs":{"content":[{"id":901,"title":"DevOps-ingenjör","startDate":"2026-12-01"}]}}</script>
  </body></html>`;
  const items = parseVeramaHtml(html, "https://app.verama.com/sv/job-requests");
  assert.deepEqual(items.map((i) => [i.id, i.title]).sort(), [["ework:900", "Testledare"], ["ework:901", "DevOps-ingenjör"]]);
});

test("detaljsida: titel från meta och beskrivning", () => {
  const html = `<html><head><title>API Specialist - Ework Verama</title>
    <meta property="og:description" content="Vi söker en API-specialist med erfarenhet av Kong och Azure till ett långt uppdrag i Göteborg."></head>
    <body><app-root></app-root><noscript>Please enable JavaScript</noscript></body></html>`;
  const d = parseVeramaDetail(html);
  assert.equal(d.title, "API Specialist");
  assert.match(d.description!, /Kong och Azure/);
});
