// Fältnamnen är riktiga (nexergroup.com/wp-json/nexer-blocks/v1/teamtailor_jobs via /api/debug,
// 2026-10-29); värdena är förkortade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapNexerJob, parseNexerJson } from "../src/lib/sources/nexer.ts";

const JOB = {
  id: "5454169",
  title: "Senior Data Scientist",
  body: "<p><span><strong>Omvandla organisationers AI-ambitioner till mätbart affärsvärde.</strong></span></p><div><p><span>Som Data Scientist på Nexer Insight hjälper du kunder att ta AI från idé till produktion.</span></p></div><ul><li>Python</li><li>MLOps</li></ul>",
  "company-name": "Nexer Insight",
  picture: "https://example.invalid/bild.jpg",
  apply_url: "https://nexergroup.teamtailor.com/jobs/5454169-senior-data-scientist/applications/new",
  start_date: "2026-10-20",
  end_date: "2026-11-30",
  cities: ["Göteborg", "Stockholm"],
  countries: ["Sweden"],
  role: "Data & Analytics",
  recruiter_email: "rekryterare@example.invalid",
};

test("mapNexerJob", () => {
  const a = mapNexerJob(JOB);
  assert.ok(a);
  assert.equal(a.id, "nexer:5454169");
  assert.equal(a.source, "Nexer");
  assert.equal(a.title, "Senior Data Scientist");
  assert.equal(a.url, "https://nexergroup.teamtailor.com/jobs/5454169-senior-data-scientist");
  assert.equal(a.company, "Nexer Insight");
  assert.equal(a.location, "Göteborg, Stockholm");
  assert.equal(a.country, "Sweden");
  assert.equal(a.published, "2026-10-20");
  assert.equal(a.deadline, "2026-11-30");
  const d = a.description ?? "";
  assert.match(d, /^Omvandla organisationers AI-ambitioner/);
  assert.match(d, /\nPython\nMLOps\n/);
  assert.match(d, /Roll: Data & Analytics\.$/);
  assert.doesNotMatch(JSON.stringify(a), /rekryterare@/);
});

test("parseNexerJson tål trasiga poster och dubbletter", () => {
  const items = parseNexerJson([JOB, { ...JOB }, { id: "1" }, null, "x", { ...JOB, id: "2", apply_url: "", cities: [], countries: [] }]);
  assert.deepEqual(items.map((a) => a.id), ["nexer:5454169", "nexer:2"]);
  assert.equal(items[1].url, "https://nexergroup.com/sv/karriar/lediga-jobb/");
  assert.equal(items[1].location, undefined);
  assert.deepEqual(parseNexerJson({ not: "array" }), []);
});

test("rollen kommer med även i långa annonser", () => {
  const a = mapNexerJob({ ...JOB, body: `<p>${"Lång text. ".repeat(400)}</p>` });
  assert.match(a?.description ?? "", /\nRoll: Data & Analytics\.$/);
});
