import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSummary } from "../src/lib/sources/brainville-summary.ts";
import { parseListing } from "../src/lib/sources/brainville-parse.ts";

const now = new Date("2026-09-25T12:00:00Z");

// Exempelrader tagna från Brainvilles söksida (via /api/debug).
test("ort, omgående start, längd och ålder", () => {
  assert.deepEqual(parseSummary("Finspång Start immediately about 12 months 1 d", now), {
    location: "Finspång",
    startText: "Omgående",
    duration: "12 månader",
    published: "2026-09-24T12:00:00.000Z",
  });
});

test("start om X månader och omfattning i timmar", () => {
  assert.deepEqual(parseSummary("Sweden Start in in 1 month about 24 months 40 hours 5 h", now), {
    location: "Sweden",
    startText: "Om 1 månad",
    duration: "24 månader",
    extent: "40 tim/vecka",
    published: "2026-09-25T07:00:00.000Z",
  });
});

test("utan längd", () => {
  const s = parseSummary("Stockholm Start in in 2 months 2 d", now)!;
  assert.equal(s.location, "Stockholm");
  assert.equal(s.startText, "Om 2 månader");
  assert.equal(s.duration, undefined);
  assert.equal(s.published, "2026-09-23T12:00:00.000Z");
});

test("vanlig text tolkas inte som sammanfattning", () => {
  assert.equal(parseSummary("Vi söker en Java-utvecklare till ett spännande uppdrag."), null);
});

test("parseListing bryter ut sammanfattningsraden", () => {
  const html = `<div><a href="/PublicProfile/Requisition?companyId=55515&id=351652">Technical writer</a>
    <span>Jönköping</span> <span>Start immediately</span> <span>about 5 months</span> <span>1 d</span></div>`;
  const [a] = parseListing(html);
  assert.equal(a.title, "Technical writer");
  assert.equal(a.location, "Jönköping");
  assert.equal(a.startText, "Omgående");
  assert.equal(a.duration, "5 månader");
  assert.equal(a.description, undefined);
});
