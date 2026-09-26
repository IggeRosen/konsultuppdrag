// Adresser och sidtitlar nedan är riktiga (sökresultat, 2026-09). HTML/JSON är
// syntetisk; uppdatera via /api/debug?url=https://emagine-consulting.se/consultants/freelance-jobs/&probe=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emagineFieldsFromText,
  emagineSlug,
  emagineUrl,
  extractEmagineId,
  isClosed,
  parseEmagineApiDetail,
  parseEmagineDetail,
  parseEmagineJson,
  parseEmagineListing,
  parseEmagineTitle,
} from "../src/lib/sources/emagine-parse.ts";
import { isSwedish } from "../src/lib/sweden.ts";

test("uppdragsadresser", () => {
  assert.equal(extractEmagineId("https://portal.emagine.org/jobs/179236/2-systemutvecklare-med-ai-kompetens-inom-vrden"), "179236");
  assert.equal(extractEmagineId("https://portal.emagine.org/jobs/159117/freelance-konsulenter"), "159117");
  assert.equal(
    extractEmagineId("https://www.emagine.org/consultants/freelance-jobs/128578/konsulentbistand-for-oppdragskoordinering-nye-tjenester/?id=163945"),
    "128578",
  );
  assert.equal(extractEmagineId("https://emagine-consulting.se/consultants/freelance-jobs/"), null);
  assert.equal(extractEmagineId("https://example.com/jobs/12345/x"), null);
  assert.equal(emagineUrl("179236", "https://portal.emagine.org/jobs/179236/2-systemutvecklare/"), "https://portal.emagine.org/jobs/179236/2-systemutvecklare");
  assert.equal(emagineUrl("128578", "https://www.emagine.org/consultants/freelance-jobs/128578/x/"), "https://portal.emagine.org/jobs/128578");
});

test("sidtitlar", () => {
  assert.equal(parseEmagineTitle("2 Systemutvecklare med AI-kompetens inom vården • emagine Portal"), "2 Systemutvecklare med AI-kompetens inom vården");
  assert.equal(parseEmagineTitle("emagine Portal • For Freelance Consultants - IT Jobs & Remote Contracts"), undefined);
  assert.equal(parseEmagineTitle("emagine Portal"), undefined);
});

test("fält ur text", () => {
  const f = emagineFieldsFromText("Location: Stockholm Start: 2026-11-01 Duration 6 months 50% remote Deadline: 2026-10-10");
  assert.equal(f.location, "Stockholm");
  assert.equal(f.start, "2026-11-01");
  assert.equal(f.deadline, "2026-10-10");
  assert.equal(f.workMode, "Hybrid · 50 % distans");
  assert.equal(emagineFieldsFromText("Plats: Göteborg Startdatum: 01.12.2026").start, "2026-12-01");
  assert.equal(emagineFieldsFromText("Onsite in Malmö").workMode, "På plats");
});

test("listsida: kort och Sverigefilter", () => {
  const html = `<div class="jobs">
    <div class="job"><a href="/jobs/180001/senior-java-developer"><h3>Senior Java Developer</h3></a><p>Location: Stockholm Start: 2026-11-01</p></div>
    <div class="job"><a href="https://portal.emagine.org/jobs/180002/data-engineer"><h3>Data Engineer</h3></a><p>Location: Copenhagen</p></div>
  </div>`;
  const items = parseEmagineListing(html, "https://portal.emagine.org/jobs");
  assert.deepEqual(items.map((i) => [i.id, i.title, i.location]), [
    ["emagine:180001", "Senior Java Developer", "Stockholm"],
    ["emagine:180002", "Data Engineer", "Köpenhamn"],
  ]);
  assert.deepEqual(items.filter(isSwedish).map((i) => i.id), ["emagine:180001"]);
  assert.equal(items[0].url, "https://portal.emagine.org/jobs/180001/senior-java-developer");
});

test("JSON (t.ex. API eller __NEXT_DATA__)", () => {
  const items = parseEmagineJson({ data: [{ id: 181000, title: "Scrum Master", location: { city: "Malmö", country: "SE" }, startDate: "2026-12-01" }] });
  assert.equal(items[0].id, "emagine:181000");
  assert.equal(items[0].url, "https://portal.emagine.org/jobs/181000/scrum-master");
  assert.equal(items[0].country, "SE");
});

test("detaljsida och stängda uppdrag", () => {
  const open = `<html><head><title>2 Systemutvecklare med AI-kompetens inom vården • emagine Portal</title></head>
    <body><main><h1>2 Systemutvecklare</h1><p>Location: Stockholm Start: 2026-11-01 Deadline: 2026-10-15</p>
    <p>Vi söker två systemutvecklare med erfarenhet av Python, LLM och vårdens informationssystem för ett långt uppdrag.</p></main></body></html>`;
  const d = parseEmagineDetail(open);
  assert.equal(d.title, "2 Systemutvecklare med AI-kompetens inom vården");
  assert.equal(d.location, "Stockholm");
  assert.equal(d.deadline, "2026-10-15");
  assert.equal(d.closed, undefined);
  assert.equal(isClosed("This job is no longer accepting applications"), true);
  assert.equal(parseEmagineDetail(open.replace("<main>", "<main><p>No longer accepting applications</p>")).closed, true);
});

test("slug och adress som portalen", () => {
  assert.equal(emagineSlug("2 Systemutvecklare med AI-kompetens inom vården"), "2-systemutvecklare-med-ai-kompetens-inom-vrden");
  assert.equal(emagineUrl("179236", undefined, "2 Systemutvecklare med AI-kompetens inom vården"), "https://portal.emagine.org/jobs/179236/2-systemutvecklare-med-ai-kompetens-inom-vrden");
  const [a] = parseEmagineJson({ totalCount: 1, items: [{ id: 179236, title: "Senior Java-utvecklare", location: "Stockholm", description: "Vi söker en utvecklare." }] });
  assert.equal(a.url, "https://portal.emagine.org/jobs/179236/senior-java-utvecklare");
});

// Riktigt svar från POST https://portal-api.emagine.org/api/JobAds/Search (2026-09-26, förkortat).
const SEARCH_RESPONSE = {
  items: [
    { id: 180597, title: "Samfunnsøkonomisk analyse av innføring av Single Digital Gateway ", startDate: "12.10.2026", duration: "1-3 months", requestId: 319887, isPartTime: false, jobAdWorkLocation: { workLocationType: "Remote", city: null, region: null, country: "Norway" }, area: { id: 2135, name: "Strategy & Transformation" }, industry: { id: 7428, name: "Government" }, isJobSaved: false, applicationDate: null },
    { id: 180595, title: "Expert Informatica (h/f)", startDate: "ASAP", duration: "> 12 months", requestId: 319885, isPartTime: false, jobAdWorkLocation: { workLocationType: "Hybrid", city: "Paris", region: null, country: "France" }, area: { id: 2140, name: "Data & Analytics" }, industry: { id: 7431, name: "Insurance / Pension" }, isJobSaved: false, applicationDate: null },
    { id: 180591, title: "Engenheiro Expert MERN Full-Stack", startDate: "N/A", duration: "4-6 months", requestId: 319870, isPartTime: true, jobAdWorkLocation: { workLocationType: "Onsite", city: "Lisbon", region: null, country: "Portugal" }, area: { id: 2137, name: "Software Development" }, industry: null, isJobSaved: false, applicationDate: null },
    { id: 180500, title: "Senior Java-utvecklare", startDate: "ASAP", duration: "7-9 months", requestId: 319800, isPartTime: false, jobAdWorkLocation: { workLocationType: "Hybrid", city: "Stockholm", region: null, country: "Sweden" }, area: { id: 2137, name: "Software Development" }, industry: null, isJobSaved: false, applicationDate: null },
  ],
  totalCount: 1234,
};

test("sök-API:ts uppdrag", () => {
  const items = parseEmagineJson(SEARCH_RESPONSE);
  assert.equal(items.length, 4);
  const [no, fr, pt, se] = items;
  assert.deepEqual(no, {
    id: "emagine:180597",
    source: "emagine",
    title: "Samfunnsøkonomisk analyse av innføring av Single Digital Gateway",
    url: "https://portal.emagine.org/jobs/180597/samfunnskonomisk-analyse-av-innfring-av-single-digital-gateway",
    location: "Norway",
    country: "Norway",
    workMode: "Distans",
    start: "2026-10-12",
    duration: "1–3 månader",
    description: "Område: Strategy & Transformation. Bransch: Government.",
  });
  assert.equal(fr.startText, "Snarast");
  assert.equal(fr.duration, "> 12 månader");
  assert.equal(fr.workMode, "Hybrid");
  assert.equal(pt.start, undefined);
  assert.equal(pt.startText, undefined);
  assert.equal(pt.extent, "Deltid");
  assert.equal(pt.workMode, "På plats");
  assert.equal(se.location, "Stockholm");
  assert.deepEqual(items.filter(isSwedish).map((a) => a.id), ["emagine:180500"]);
});

test("detaljer ur API:t", () => {
  const d = parseEmagineApiDetail({
    id: 180500,
    title: "Senior Java-utvecklare",
    description: "<p>Vi söker en <b>senior</b> Java-utvecklare till ett stort bolag i Stockholm.</p>",
    requirements: "<ul><li>10 års erfarenhet av Java och Spring Boot</li></ul>",
  });
  assert.equal(d.description, "Vi söker en senior Java-utvecklare till ett stort bolag i Stockholm.\n\n10 års erfarenhet av Java och Spring Boot");
});
