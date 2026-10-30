import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractGigstepId, isGigstepRecruitment, isRecruitmentText, parseGigstepJob, parseGigstepSitemap } from "../src/lib/sources/gigstep.ts";

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
  assert.doesNotMatch(a.description ?? "", /@|&lt;|<p>|Moa Hagman|\n\n/);
  assert.equal(isGigstepRecruitment(a), false);
});

test("isRecruitmentText", () => {
  assert.equal(isRecruitmentText("HR Manager\nTjänsten är en tillsvidareanställning hos SES Nordic Group."), true);
  assert.equal(isRecruitmentText("HR Manager\nVi rekryterar för kunds räkning."), true);
  assert.equal(isRecruitmentText("QA-testare till Axis\nEtt gig på sex månader."), false);
  assert.equal(isRecruitmentText("IT-tekniker\nEtt konsultuppdrag hos kund."), false);
  assert.equal(isRecruitmentText("Linuxtekniker\nSupportuppdrag i Malmö."), false);
});

test("parseGigstepJob klassar på hela texten, även efter 2 500 tecken", () => {
  const long = "Lång text om rollen. ".repeat(200);
  const page = html
    .replace("Erfaren C#/.NET-utvecklare till långsiktigt konsultuppdrag i Lund", "HR Manager till SES Nordic Group")
    .replace(/Nu söker vi en konsult för ett längre uppdrag\./g, long)
    .replace(/Detta är ett konsultuppdrag via Gigstep hos en av våra kunder i Lund\./g, "Tjänsten är en tillsvidareanställning hos kunden.")
    .replace(/Om konsultuppdraget/g, "Om tjänsten")
    .replace(/C#\/\.NET/g, "HR");
  const a = parseGigstepJob(page, "https://jobs.gigstep.se/jobs/8333104-hr-manager-till-ses-nordic-group");
  assert.ok(a);
  assert.doesNotMatch(a.description ?? "", /tillsvidare/);
  assert.equal(a.extent, "Rekrytering, Heltid");
  assert.equal(isGigstepRecruitment(a), true);
});
