// Annonsen följer JobSearch-API:ts dokumenterade format (jobsearch.api.jobtechdev.se, /search).
import { test } from "node:test";
import assert from "node:assert/strict";
import { idlePlatsbankenStatus, mapPlatsbankenHit, parsePlatsbankenJson, platsbankenSearchUrl } from "../src/lib/sources/platsbanken.ts";
import { matchAssignments } from "../src/lib/match.ts";

const RESPONSE = {
  total: { value: 2 },
  hits: [
    {
      id: "29871234",
      headline: "PLM-specialist till Saab",
      webpage_url: "https://arbetsformedlingen.se/platsbanken/annonser/29871234",
      employer: { name: "Saab AB", workplace: "Saab Aeronautics" },
      workplace_address: { municipality: "Linköping", region: "Östergötlands län", country: "Sverige", city: null },
      publication_date: "2026-10-20T10:12:00",
      application_deadline: "2026-11-15T23:59:59",
      description: { text: "Vi söker en PLM-specialist med erfarenhet av Teamcenter. Du arbetar med konfigurationsstyrning &amp; ändringshantering." },
      employment_type: { label: "Vanlig anställning" },
      duration: { label: "6 månader eller längre" },
      working_hours_type: { label: "Heltid" },
      scope_of_work: { min: 100, max: 100 },
      occupation: { label: "Systemförvaltare" },
    },
    {
      id: "29870001",
      headline: "Konsult inom produktdata",
      employer: { name: null, workplace: "Konsultbolaget AB" },
      workplace_address: { municipality: null, city: "Göteborg", country: "Sverige" },
      publication_date: "2026-10-19T08:00:00",
      working_hours_type: { label: "Deltid" },
      scope_of_work: { min: 50, max: 80 },
    },
    { id: "x", headline: null },
  ],
};

test("Platsbankens sökadress", () => {
  assert.equal(platsbankenSearchUrl("PLM"), "https://jobsearch.api.jobtechdev.se/search?q=PLM&limit=100&sort=pubdate-desc");
  assert.equal(platsbankenSearchUrl("C# .NET", 10), "https://jobsearch.api.jobtechdev.se/search?q=C%23%20.NET&limit=10&sort=pubdate-desc");
});

test("annonser från JobSearch-API:t", () => {
  const [a, b, ...rest] = parsePlatsbankenJson(RESPONSE);
  assert.equal(rest.length, 0);
  assert.deepEqual(a, {
    id: "platsbanken:29871234",
    source: "Platsbanken",
    title: "PLM-specialist till Saab",
    url: "https://arbetsformedlingen.se/platsbanken/annonser/29871234",
    company: "Saab AB",
    location: "Linköping",
    country: "Sverige",
    published: "2026-10-20",
    deadline: "2026-11-15",
    duration: "6 månader eller längre",
    extent: "Heltid",
    description:
      "Anställningsform: Vanlig anställning. Yrke: Systemförvaltare. Vi söker en PLM-specialist med erfarenhet av Teamcenter. Du arbetar med konfigurationsstyrning & ändringshantering.",
  });
  assert.equal(b.company, "Konsultbolaget AB");
  assert.equal(b.location, "Göteborg");
  assert.equal(b.extent, "Deltid, 50–80 %");
  assert.equal(b.url, "https://arbetsformedlingen.se/platsbanken/annonser/29870001");
  assert.equal(mapPlatsbankenHit({ id: "1" }), null);
});

test("Platsbankens träffar räknas som bekräftade för sitt nyckelord", () => {
  const items = parsePlatsbankenJson(RESPONSE);
  const confirmed = new Map([["platsbanken:29870001", new Set(["plm"])]]);
  assert.deepEqual(
    matchAssignments(items, ["plm"], "any", confirmed).map((r) => r.id).sort(),
    ["platsbanken:29870001", "platsbanken:29871234"],
  );
});

test("utan nyckelord visas källan som vilande, inte trasig", () => {
  const s = idlePlatsbankenStatus();
  assert.equal(s.ok, true);
  assert.equal(s.count, 0);
  assert.equal(s.idle, true);
});
