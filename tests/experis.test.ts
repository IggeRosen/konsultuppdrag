import { test } from "node:test";
import assert from "node:assert/strict";
import { experisDate, extractExperisId, isExperisRecruitment, parseExperisJob, parseExperisSitemap, repairJsonLd } from "../src/lib/sources/experis.ts";

const URL_SV = "https://www.experis.se/sv/jobb/itdata/senior-javautvecklaretech-lead-till-lfv/54774";

test("extractExperisId", () => {
  assert.equal(extractExperisId(URL_SV), "54774");
  assert.equal(extractExperisId("https://www.experis.se/en/job/itdata/senior-javautvecklaretech-lead-till-lfv/54774"), "54774");
  assert.equal(extractExperisId("https://www.experis.se/sv/karriar/konsult-hos-oss"), null);
  assert.equal(extractExperisId("https://www.experis.se/om-oss/kontor/gavle/events/2020/08/13/event-1"), null);
});

test("parseExperisSitemap tar den svenska adressen per annons", () => {
  const xml = `<urlset>
  <url><loc>https://www.experis.se/sv/karriar</loc></url>
  <url><loc>https://www.experis.se/en/job/itdata/bi-utvecklare-till-region-uppsala/54780</loc></url>
  <url><loc>https://www.experis.se/sv/jobb/itdata/bi-utvecklare-till-region-uppsala/54780</loc></url>
  <url><loc>${URL_SV}</loc></url>
</urlset>`;
  assert.deepEqual(parseExperisSitemap(xml), [
    "https://www.experis.se/sv/jobb/itdata/bi-utvecklare-till-region-uppsala/54780",
    URL_SV,
  ]);
});

test("repairJsonLd citerar värden utan citattecken", () => {
  const raw = '{\n\t"title": "X",\n\t"industry": IT, Data,\n\t"n": 3,\n\t"ok": true\n}';
  assert.deepEqual(JSON.parse(repairJsonLd(raw)), { title: "X", industry: "IT, Data", n: 3, ok: true });
});

test("experisDate", () => {
  assert.equal(experisDate("20261028T075431"), "2026-10-28");
  assert.equal(experisDate("20261127T225959Z"), "2026-11-27");
  assert.equal(experisDate("2026-11-27"), "2026-11-27");
  assert.equal(experisDate(""), undefined);
});

const page = (type: string) => `<html><head><script type="application/ld+json">[
\t{
\t\t"@context": "https://schema.org",
\t\t"@type": "WebPage",
\t\t"name": "Sök jobbet"
\t},
\t{
\t\t"@context": "https://schema.org",
\t\t"@type": "JobPosting",
\t\t"title": "Senior Javautvecklare/Tech Lead till LFV",
\t\t"description": "Vill du ta nästa steg i din karriär som Javautvecklare?",
\t\t"datePosted": "20261028T075431",
\t\t"validThrough": "20261127T225959Z",
\t\t"employmentType": "${type}",
\t\t"industry": IT, Data,
\t\t"jobLocation": {
\t\t\t"@type": "Place",
\t\t\t"address": {
\t\t\t\t"@type": "PostalAddress",
\t\t\t\t"addressLocality": "Norrköping",
\t\t\t\t"addressCountry": "SE"
\t\t\t}
\t\t},
\t\t"hiringOrganization": {
\t\t\t"@type": "Organization",
\t\t\t"name": "Experis"
\t\t}
\t}
]</script></head><body></body></html>`;

test("parseExperisJob tolkar trasig JSON-LD", () => {
  const a = parseExperisJob(page("Rekrytering till företag"), URL_SV);
  assert.ok(a);
  assert.equal(a.id, "experis:54774");
  assert.equal(a.title, "Senior Javautvecklare/Tech Lead till LFV");
  assert.equal(a.location, "Norrköping");
  assert.equal(a.country, "Sverige");
  assert.equal(a.published, "2026-10-28");
  assert.equal(a.deadline, "2026-11-27");
  assert.equal(a.company, "Experis");
  assert.match(a.description ?? "", /Område: IT, Data\./);
  assert.equal(isExperisRecruitment(a), true);
  assert.equal(isExperisRecruitment(parseExperisJob(page("Konsultuppdrag"), URL_SV)!), false);
});
