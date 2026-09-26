// Adresser och sidtitlar nedan är riktiga (från sökresultat, 2026-09). HTML:en
// är syntetisk; uppdatera via /api/debug?url=https://www.keyman.se/sv/uppdrag/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractKeymanId,
  keymanCategory,
  keymanFieldsFromText,
  keymanUrl,
  parseKeymanDetail,
  parseKeymanListing,
  parseKeymanTitle,
} from "../src/lib/sources/keyman-parse.ts";

test("känner igen uppdragsadresser", () => {
  assert.equal(extractKeymanId("https://www.keyman.se/sv/data-it/servicedeskagent-till-region-sormland-16277"), "16277");
  assert.equal(extractKeymanId("https://www.keyman.se/en/data-it/provningsingenjor-16068/"), "16068");
  assert.equal(extractKeymanId("/sv/hr-kompetensforsorjning/total-rewards-specialist-postnord-group-16387"), "16387");
  assert.equal(extractKeymanId("https://www.keyman.se/sv/uppdrag/"), null);
  assert.equal(extractKeymanId("https://www.keyman.se/sv/om-keyman/"), null);
  assert.equal(extractKeymanId("https://www.keyman.se/sv/nyheter/keyman-vaxer-2024"), null);
  assert.equal(extractKeymanId("https://example.com/sv/data-it/x-12345"), null);
});

test("kategori och kanonisk adress", () => {
  assert.equal(keymanCategory("https://www.keyman.se/en/data-it/provningsingenjor-16068/"), "Data/IT");
  assert.equal(keymanCategory("/sv/administration-ekonomi-juridik/financial-controller-postnord-group-16276"), "Administration, ekonomi & juridik");
  assert.equal(keymanUrl("https://keyman.se/en/data-it/provningsingenjor-16068/"), "https://www.keyman.se/sv/data-it/provningsingenjor-16068");
});

test("sidtitlar: kund efter bindestreck eller efter sista 'till'", () => {
  assert.deepEqual(parseKeymanTitle("Financial Controller - POSTNORD GROUP - KeyMan"), { title: "Financial Controller", company: "Postnord Group" });
  assert.deepEqual(parseKeymanTitle("Servicedeskagent till Region Sörmland - KeyMan"), { title: "Servicedeskagent till Region Sörmland", company: "Region Sörmland" });
  assert.deepEqual(parseKeymanTitle("Lösningsspecialist för AV-teknik och digitala möten till Sveriges riksbank - KeyMan"), {
    title: "Lösningsspecialist för AV-teknik och digitala möten till Sveriges riksbank",
    company: "Sveriges riksbank",
  });
  assert.deepEqual(parseKeymanTitle("Provningsingenjör - KeyMan"), { title: "Provningsingenjör" });
  assert.deepEqual(parseKeymanTitle("Uppdrag - KeyMan"), {});
});

test("fält ur etiketterad text", () => {
  const f = keymanFieldsFromText(
    "Ort: Nyköping Omfattning: 100% Distans: Delvis Start: 2026-11-01 Sista ansökningsdag: 2026-10-08 Beskrivning: Region Sörmland söker…",
  );
  assert.equal(f.location, "Nyköping");
  assert.equal(f.extent, "100%");
  assert.equal(f.workMode, "Distans: Delvis");
  assert.equal(f.start, "2026-11-01");
  assert.equal(f.deadline, "2026-10-08");
  assert.deepEqual(keymanFieldsFromText("Uppdragsperiod: 2026-11-01 – 2027-06-30").end, "2027-06-30");
});

test("listsida: kort med titel, text och kategori", () => {
  const html = `<html><body><ul>
    <li class="job"><a href="https://www.keyman.se/sv/data-it/servicedeskagent-till-region-sormland-16277"><h3>Servicedeskagent till Region Sörmland</h3></a>
      <p>Ort: Nyköping Sista ansökningsdag: 2026-10-08</p></li>
    <li class="job"><a href="/sv/data-it/provningsingenjor-16068/"><h3>Provningsingenjör</h3></a><a href="/sv/data-it/provningsingenjor-16068/">Läs mer</a></li>
    <li><a href="/sv/om-keyman/">Om oss</a></li>
  </ul></body></html>`;
  const items = parseKeymanListing(html);
  assert.deepEqual(items.map((i) => i.id), ["keyman:16277", "keyman:16068"]);
  const sd = items[0];
  assert.equal(sd.company, "Region Sörmland");
  assert.equal(sd.location, "Nyköping");
  assert.equal(sd.deadline, "2026-10-08");
  assert.equal(sd.url, "https://www.keyman.se/sv/data-it/servicedeskagent-till-region-sormland-16277");
  assert.match(sd.description!, /^Kategori: Data\/IT\./);
});

test("detaljsida", () => {
  const html = `<html><head><title>Financial Controller - POSTNORD GROUP - KeyMan</title>
    <meta property="article:published_time" content="2026-09-22T08:00:00+00:00"></head>
    <body><header>meny</header><main><h1>Financial Controller</h1><div class="entry-content">
    Ort: Solna Omfattning: 100% Start: 2026-11-01 Sista ansökningsdag: 2026-10-06
    Huvudsakliga arbetsuppgifter är operativt ekonomiarbete inom kundfakturering, leverantörsfakturor och bokslut.</div></main></body></html>`;
  const d = parseKeymanDetail(html, "https://www.keyman.se/sv/administration-ekonomi-juridik/financial-controller-postnord-group-16276");
  assert.equal(d.title, "Financial Controller");
  assert.equal(d.company, "Postnord Group");
  assert.equal(d.location, "Solna");
  assert.equal(d.published, "2026-09-22");
  assert.equal(d.start, "2026-11-01");
  assert.equal(d.deadline, "2026-10-06");
  assert.match(d.description!, /^Kategori: Administration, ekonomi & juridik\. .*bokslut/);
});

test("titel med flera 'till' ger kunden efter det sista", () => {
  assert.equal(
    parseKeymanTitle("Leverans av Uppdrag Mätning och uppföljning till Sussa samverkan till Region Sörmland - KeyMan").company,
    "Region Sörmland",
  );
});

import { scrapePaged } from "../src/lib/paging.ts";

test("paginering med WordPress-stilen /page/N/", async () => {
  const base = "https://www.keyman.se/sv/uppdrag/";
  const page = (ids: number[]) => ids.map((id) => `<div><a href="/sv/data-it/uppdrag-${id}"><h3>Uppdrag ${id}</h3></a></div>`).join("");
  const routes: Record<string, string> = {
    [base]: page([16400, 16399]),
    [`${base}page/2/`]: page([16398]),
    [`${base}page/3/`]: page([16398]),
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    return new Response(routes[url] ?? "<html></html>", { status: routes[url] ? 200 : 404 });
  }) as typeof fetch;
  try {
    const r = await scrapePaged(base, parseKeymanListing, { hostSuffix: "keyman.se", maxPages: 10, errors: [] });
    assert.deepEqual(r.items.map((a) => a.id), ["keyman:16400", "keyman:16399", "keyman:16398"]);
    assert.equal(r.pages, 2);
    assert.equal(r.via, "/page/N/");
  } finally {
    globalThis.fetch = original;
  }
});

test("kategorinamn från riktiga adresser", () => {
  assert.equal(keymanCategory("/sv/chefs-och-ledarskapsstod/chefshandledning-samt-stod-till-ledningsgrupp-16394"), "Chefs- och ledarskapsstöd");
  assert.equal(keymanCategory("/sv/management/kvalificerat-stod-till-rektor-vux-yrkesvux-till-nynashamns-kommun-16399"), "Management");
  assert.equal(keymanCategory("/sv/projekt-och-forandringsledning/x-16500"), "Projekt och forandringsledning");
});

test("riktigt listkort (2026-09-26): rubrik med tankstreck och kund", () => {
  const html = `<div class="elementor-element e-con-boxed"><div class="e-con-inner"><div class="elementor-widget-heading">
    <p class="elementor-heading-title elementor-size-default"><a href="https://www.keyman.se/sv/data-it/inkops-och-upphandlingsansvarig-tornberget-fastighetsforvaltnings-ab-16401/">Inköps- och upphandlingsansvarig – Tornberget Fastighetsförvaltnings AB</a></p>
  </div></div></div>`;
  const [a] = parseKeymanListing(html);
  assert.equal(a.id, "keyman:16401");
  assert.equal(a.title, "Inköps- och upphandlingsansvarig");
  assert.equal(a.company, "Tornberget Fastighetsförvaltnings AB");
  assert.equal(a.url, "https://www.keyman.se/sv/data-it/inkops-och-upphandlingsansvarig-tornberget-fastighetsforvaltnings-ab-16401");
});
