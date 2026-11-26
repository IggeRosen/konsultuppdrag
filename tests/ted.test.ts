import { test } from "node:test";
import assert from "node:assert/strict";
import { isTedProduct, parseTedJson, parseTedNotice, tedQuery, tedText, TED_QUERY } from "../src/lib/sources/ted.ts";

// Uppbyggt som svaret från https://api.ted.europa.eu/v3/notices/search (fält per språk).
const NOTICE = {
  "publication-number": "712345-2026",
  "notice-title": { swe: "Sverige – IT-tjänster: konsultverksamhet, programvaruutveckling, Internet och support – Ramavtal IT-konsulttjänster 2027" },
  "buyer-name": { swe: ["Region Exempel"] },
  "buyer-city": { swe: ["Linköping"] },
  "publication-date": "2026-11-20+01:00",
  "deadline-receipt-tender-date-lot": ["2026-12-15+01:00", "2026-12-18+01:00"],
  "classification-cpv": ["72000000", "72224000"],
  "description-proc": { swe: "Upphandlingen avser ramavtal för IT-konsulter inom projektledning och systemutveckling.", eng: "IT consultants." },
  links: { html: { SWE: "https://ted.europa.eu/sv/notice/-/detail/712345-2026", ENG: "https://ted.europa.eu/en/notice/-/detail/712345-2026" } },
};

test("tedText väljer svenska och slår ihop listor", () => {
  assert.equal(tedText({ eng: "Hello", swe: "Hej" }), "Hej");
  assert.equal(tedText({ eng: ["A", "B"] }), "A, B");
  assert.equal(tedText({ fra: "Bonjour" }), "Bonjour");
  assert.equal(tedText(undefined), undefined);
});

test("parseTedNotice tolkar en upphandling", () => {
  const a = parseTedNotice(NOTICE, "2026-11-26")!;
  assert.equal(a.id, "ted:712345-2026");
  assert.equal(a.source, "TED");
  assert.equal(a.title, "Ramavtal IT-konsulttjänster 2027");
  assert.equal(a.url, "https://ted.europa.eu/sv/notice/-/detail/712345-2026");
  assert.equal(a.company, "Region Exempel");
  assert.equal(a.location, "Linköping");
  assert.equal(a.country, "Sverige");
  assert.equal(a.published, "2026-11-20");
  assert.equal(a.deadline, "2026-12-15");
  assert.equal(a.extent, "Offentlig upphandling");
  assert.match(a.description!, /ramavtal för IT-konsulter/);
  assert.match(a.description!, /CPV: 72000000, 72224000/);
});

test("parseTedNotice väljer första framtida sista dag och bygger länk om den saknas", () => {
  const a = parseTedNotice({ ...NOTICE, links: undefined }, "2026-12-16")!;
  assert.equal(a.deadline, "2026-12-18");
  assert.equal(a.url, "https://ted.europa.eu/sv/notice/-/detail/712345-2026");
});

test("parseTedJson läser notices och hoppar över annonser utan titel", () => {
  const list = parseTedJson({ notices: [NOTICE, { "publication-number": "1-2026" }], totalNoticeCount: 2 });
  assert.equal(list.length, 1);
  assert.deepEqual(parseTedJson({}), []);
});

test("standardfrågan gäller svenska köpare och konsult-CPV", () => {
  assert.match(TED_QUERY, /buyer-country IN \(SWE\)/);
  assert.match(TED_QUERY, /72000000/);
  assert.match(TED_QUERY, /79400000/);
});

test("frågan begränsar till nya annonser med öppen anbudstid", () => {
  const q = tedQuery(new Date("2026-11-26T12:00:00Z"));
  assert.match(q, /publication-date>=20260530/);
  assert.match(q, /deadline-receipt-tender-date-lot>=20261126/);
  assert.doesNotMatch(tedQuery(new Date("2026-11-26T12:00:00Z"), false), /deadline/);
});

test("upphandlingens egen rubrik går före annonsens kategorirubrik", () => {
  const a = parseTedNotice({ ...NOTICE, "title-proc": { swe: "Konsulttjänster inom informationssäkerhet" } }, "2026-11-26")!;
  assert.equal(a.title, "Konsulttjänster inom informationssäkerhet");
  const old = parseTedNotice({ ...NOTICE, "notice-title": { swe: "Sverige-Kalmar: Konstnärligt skapande" } }, "2026-11-26")!;
  assert.equal(old.title, "Konstnärligt skapande");
});

test("köp av system och hårdvara markeras, konsulttjänster och PLM behålls", () => {
  const cases: [string, string[], boolean][] = [
    ["Upphandling av upphandlingsverktyg", ["48490000", "72000000"], true],
    ["Serverhårdvara", ["72000000"], true],
    ["Verksamhet- och ärendehanteringssystem", ["72000000"], true],
    ["Rättsdatabaser", ["72000000"], true],
    ["Ramavtal Licenspartner", ["72000000"], true],
    ["IT-konsulttjänster", ["72000000"], false],
    ["IT-konsulttjänster utveckling och förvaltning", ["72000000", "48000000"], false],
    ["Omvärldsanalys IT", ["72000000"], false],
    ["Ramavtal bakgrundskontroller och säkerhetsprövningar", ["79400000"], false],
    ["Förvaltning av ekonomisystem", ["72000000"], false],
    ["PLM-system för produktdata", ["48000000"], false],
    ["Licenser Teamcenter", ["48000000"], false],
  ];
  for (const [title, cpv, product] of cases) {
    const a = parseTedNotice({ ...NOTICE, "title-proc": { swe: title }, "classification-cpv": cpv, "description-proc": undefined }, "2026-11-26")!;
    assert.equal(isTedProduct(a), product, title);
  }
  // Aras i beskrivningen räcker för att behålla ett systemköp.
  const aras = parseTedNotice({ ...NOTICE, "title-proc": { swe: "Nytt produktdatasystem" }, "description-proc": { swe: "Systemet ska bygga på Aras Innovator." } }, "2026-11-26")!;
  assert.equal(isTedProduct(aras), false);
});
