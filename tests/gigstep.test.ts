import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractGigstepId, isGigstepRecruitment, parseGigstepJob, parseGigstepSitemap } from "../src/lib/sources/gigstep.ts";
import type { Assignment } from "../src/lib/types.ts";

const URL_JOB = "https://jobs.gigstep.se/jobs/8547932-erfaren-c-net-utvecklare-till-langsiktigt-konsultuppdrag-i-lund";
const html = readFileSync(new URL("./fixtures/gigstep-job.html", import.meta.url), "utf8");

test("extractGigstepId", () => {
  assert.equal(extractGigstepId(URL_JOB), "8547932");
  assert.equal(extractGigstepId("https://jobs.gigstep.se/jobs/4831739-civilingenjorer-se-hit"), "4831739");
  assert.equal(extractGigstepId("https://jobs.gigstep.se/jobs"), null);
  assert.equal(extractGigstepId("https://jobs.gigstep.se/jobs/internal/123"), null);
  assert.equal(extractGigstepId("https://www.gigstep.se/for-giggare"), null);
});

test("parseGigstepSitemap tar bara annonser", () => {
  const xml = `<urlset><url><loc>https://jobs.gigstep.se/</loc></url><url><loc>${URL_JOB}</loc></url>
<url><loc>https://jobs.gigstep.se/people/1041913-x</loc></url><url><loc>https://jobs.gigstep.se/jobs/8545306-qa-testare-till-axis-i-lund</loc></url></urlset>`;
  assert.deepEqual(parseGigstepSitemap(xml), [URL_JOB, "https://jobs.gigstep.se/jobs/8545306-qa-testare-till-axis-i-lund"]);
});

test("parseGigstepJob läser JSON-LD och sidans fält, utan kontaktuppgifter", () => {
  const a = parseGigstepJob(html, URL_JOB);
  assert.ok(a);
  assert.equal(a.id, "gigstep:8547932");
  assert.equal(a.source, "Gigstep");
  assert.equal(a.title, "Erfaren C#/.NET-utvecklare till långsiktigt konsultuppdrag i Lund");
  assert.equal(a.url, URL_JOB);
  assert.equal(a.location, "Lund");
  assert.equal(a.country, "Sverige");
  assert.equal(a.published, "2026-10-14");
  assert.equal(a.deadline, "2026-11-30");
  assert.equal(a.extent, "Heltid");
  assert.match(a.description ?? "", /^Är du en erfaren mjukvaruutvecklare/);
  assert.match(a.description ?? "", /Utveckla mjukvarulösningar i C#\/\.NET\./);
  assert.match(a.description ?? "", /Område: Programmering\./);
  assert.doesNotMatch(a.description ?? "", /@|&lt;|<p>|Moa Hagman/);
  assert.equal(isGigstepRecruitment(a), false);
});

test("isGigstepRecruitment", () => {
  const base: Assignment = { id: "gigstep:1", source: "Gigstep", title: "HR Manager till SES Nordic Group", url: "" };
  assert.equal(isGigstepRecruitment({ ...base, description: "Tjänsten är en tillsvidareanställning hos SES Nordic Group." }), true);
  assert.equal(isGigstepRecruitment({ ...base, description: "Vi rekryterar för kunds räkning." }), true);
  assert.equal(isGigstepRecruitment({ ...base, title: "QA-testare till Axis", description: "Ett gig på sex månader." }), false);
  assert.equal(isGigstepRecruitment({ ...base, title: "IT-tekniker", description: "Ett konsultuppdrag hos kund." }), false);
  assert.equal(isGigstepRecruitment({ ...base, title: "Linuxtekniker", description: "Supportuppdrag i Malmö." }), false);
});
