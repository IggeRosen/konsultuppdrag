import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractAwId, isAwConsulting, parseAwJob, parseAwSitemap } from "../src/lib/sources/academicwork.ts";

const URL_JOB = "https://www.academicwork.se/lediga-jobb/j/erfaren-netutvecklare-for-kommande-uppdrag/SM4KJR";
const html = readFileSync(new URL("./fixtures/academicwork-job.html", import.meta.url), "utf8");

test("extractAwId", () => {
  assert.equal(extractAwId(URL_JOB), "SM4KJR");
  assert.equal(extractAwId("https://www.academicwork.se/lediga-jobb/j/ap--ar-manager/VYQYHN"), "VYQYHN");
  assert.equal(extractAwId("https://www.academicwork.se/lediga-jobb/stockholm/it"), null);
  assert.equal(extractAwId("https://www.academicwork.se/lediga-jobb/j/x/SM4KJR/apply"), null);
});

test("parseAwSitemap tar bara annonser, nyast först", () => {
  const xml = `<urlset>
<url><loc>https://www.academicwork.se/lediga-jobb/it</loc><lastmod>2025-04-24</lastmod></url>
<url><loc>https://www.academicwork.se/lediga-jobb/j/ap--ar-manager/VYQYHN</loc><lastmod>2026-10-15</lastmod></url>
<url><loc>${URL_JOB}</loc><lastmod>2026-10-01</lastmod></url>
<url><loc>https://www.academicwork.se/lediga-jobb/j/fibertekniker-till-eltel-networks/575URK</loc><lastmod>2026-10-30</lastmod></url>
</urlset>`;
  assert.deepEqual(parseAwSitemap(xml).map((e) => e.id), ["575URK", "VYQYHN", "SM4KJR"]);
});

test("parseAwJob läser fälten ur texten och hoppar över kontaktuppgifter och liknande jobb", () => {
  const a = parseAwJob(html, URL_JOB);
  assert.ok(a);
  assert.equal(a.id, "academicwork:SM4KJR");
  assert.equal(a.title, "Erfaren .NET-utvecklare för kommande uppdrag");
  assert.equal(a.url, URL_JOB);
  assert.equal(a.location, "Umeå");
  assert.equal(a.startText, "Enligt överenskommelse");
  assert.equal(a.extent, "Konsultuppdrag, Heltid");
  assert.equal(isAwConsulting(a), true);
  assert.match(a.description ?? "", /^Vi letar dig som har några års/);
  assert.match(a.description ?? "", /Om tjänsten\nI rollen som \.NET-utvecklare/);
  assert.match(a.description ?? "", /Avancerad kunskap i programmeringsspråket C#/);
  assert.doesNotMatch(a.description ?? "", /@|rekryteringsprocess hanteras|matchande jobb|V1P12X/);
});

test("parseAwJob: rekrytering räknas inte som konsultuppdrag", () => {
  const a = parseAwJob(html.replace("<span>Konsultuppdrag</span>", "<span>Rekrytering</span>"), URL_JOB);
  assert.equal(a?.extent, "Rekrytering, Heltid");
  assert.equal(isAwConsulting(a!), false);
});

test("parseAwJob: etikett och värde på olika rader", () => {
  const a = parseAwJob(html.replace('<div class="flex"><span class="font-medium">Plats:</span><span>Umeå</span></div>', "<div>Plats:</div><div>Umeå</div>"), URL_JOB);
  assert.equal(a?.location, "Umeå");
});
