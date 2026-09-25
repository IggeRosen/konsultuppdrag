// OBS: HTML/XML nedan är syntetisk och bygger på Cinode Markets kända URL- och
// titelmönster (cinode.market/requests/<id>, "Cinode Market - Titel - Kund - Ref").
// Uppdatera med riktig HTML via /api/debug?url=https://cinode.market/requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractCinodeId,
  parseCinodeDetail,
  parseCinodeListing,
  parseCinodeTitle,
  parseSitemap,
  sitemapsFromRobots,
} from "../src/lib/sources/cinode-parse.ts";

test("känner igen uppdragslänkar", () => {
  assert.equal(extractCinodeId("https://cinode.market/requests/19615"), "19615");
  assert.equal(extractCinodeId("/requests/7668?ref=x"), "7668");
  assert.equal(extractCinodeId("https://cinode.com/market/requests/9549"), "9549");
  assert.equal(extractCinodeId("/requests/keyword/api-integrations"), null);
  assert.equal(extractCinodeId("https://example.com/requests/1"), null);
});

test("tolkar sidtitlar med och utan kund/referens", () => {
  assert.deepEqual(parseCinodeTitle("Cinode Market - Testledare Nivå 4 till applikationsförvaltning - Inera Test och Utveckling - LPU-1169"), {
    title: "Testledare Nivå 4 till applikationsförvaltning",
    company: "Inera Test och Utveckling",
    reference: "LPU-1169",
  });
  assert.deepEqual(parseCinodeTitle("Cinode Market - IT-Konsult V.S - Botkyrka kommun (ADDA)"), {
    title: "IT-Konsult V.S",
    company: "Botkyrka kommun (ADDA)",
  });
  assert.deepEqual(parseCinodeTitle("Cinode Market - IT - Förvaltning och utveckling av befintliga Vårdsystem - Region Västernorrland - 23-IU-283"), {
    title: "IT - Förvaltning och utveckling av befintliga Vårdsystem",
    company: "Region Västernorrland",
    reference: "23-IU-283",
  });
  assert.deepEqual(parseCinodeTitle("Cinode Market - Head of CIO Office"), { title: "Head of CIO Office" });
  assert.deepEqual(parseCinodeTitle("Cinode Market"), {});
});

test("listsida: kort och inbäddad JSON", () => {
  const html = `<html><body><div class="list">
    <div class="card"><a href="/requests/19055"><h3>Systemarkitekt inom HPC-miljöer</h3></a>
      <span class="company">Karolinska</span><span class="location">Stockholm</span>
      <p>Sista svarsdag 2026-10-28 · Start 2026-11-16</p></div>
    <div class="card"><a href="/requests/19056"><h3>Java-utvecklare</h3></a></div>
    <a href="/requests/keyword/java">Java</a>
  </div>
  <script id="__NEXT_DATA__" type="application/json">{"props":{"items":[{"id":20001,"title":"React-konsult","companyName":"Acme AB","lastReplyDate":"2026-10-10T00:00:00"}]}}</script>
  </body></html>`;
  const items = parseCinodeListing(html, "https://cinode.market/requests");
  assert.deepEqual(items.map((i) => i.id).sort(), ["cinode:19055", "cinode:19056", "cinode:20001"]);
  const hpc = items.find((i) => i.id === "cinode:19055")!;
  assert.equal(hpc.title, "Systemarkitekt inom HPC-miljöer");
  assert.equal(hpc.company, "Karolinska");
  assert.equal(hpc.location, "Stockholm");
  assert.equal(hpc.deadline, "2026-10-28");
  assert.equal(hpc.start, "2026-11-16");
  assert.equal(hpc.url, "https://cinode.market/requests/19055");
  const react = items.find((i) => i.id === "cinode:20001")!;
  assert.equal(react.company, "Acme AB");
  assert.equal(react.deadline, "2026-10-10");
});

test("detaljsida: titel, kund, JSON-LD och etiketter", () => {
  const html = `<html><head><title>Cinode Market - Systemarkitekt inom HPC-miljöer - Region Stockholm</title>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Systemarkitekt inom HPC-miljöer",
      "hiringOrganization":{"@type":"Organization","name":"Region Stockholm"},"datePosted":"2026-09-20",
      "jobLocation":{"@type":"Place","address":{"addressLocality":"Stockholm"}}}</script></head>
    <body><main><h1>Systemarkitekt inom HPC-miljöer</h1>
    <div class="description">Ort: Stockholm. Sista svarsdag: 2026-10-28. Period 2026-11-16 - 2027-11-16 med option.
    Arkitektur och optimering av HPC-miljöer baserade på Slurm.</div></main></body></html>`;
  const d = parseCinodeDetail(html);
  assert.equal(d.title, "Systemarkitekt inom HPC-miljöer");
  assert.equal(d.company, "Region Stockholm");
  assert.equal(d.location, "Stockholm");
  assert.equal(d.published, "2026-09-20");
  assert.equal(d.deadline, "2026-10-28");
  assert.equal(d.start, "2026-11-16");
  assert.match(d.description!, /Slurm/);
});

test("sitemap och robots.txt", () => {
  const index = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap><loc>https://cinode.market/sitemap-requests.xml</loc></sitemap></sitemapindex>`;
  assert.deepEqual(parseSitemap(index), { urls: [], sitemaps: ["https://cinode.market/sitemap-requests.xml"] });
  const set = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://cinode.market/requests/19615</loc></url><url><loc>https://cinode.market/about</loc></url></urlset>`;
  assert.deepEqual(parseSitemap(set).urls, ["https://cinode.market/requests/19615", "https://cinode.market/about"]);
  assert.deepEqual(sitemapsFromRobots("User-agent: *\nSitemap: https://cinode.market/sitemap.xml\n"), ["https://cinode.market/sitemap.xml"]);
});
