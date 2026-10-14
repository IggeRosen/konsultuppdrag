// OBS: HTML:en nedan är syntetisk och bygger på Brainvilles kända URL-mönster,
// inte på en sparad kopia av sajten. Uppdatera med riktig HTML via /api/debug.
import { test } from "node:test";
import assert from "node:assert/strict";
import { brainvilleAgeDate, extractRequisitionId, parseDetail, parseDocumentTitle, parseListing } from "../src/lib/sources/brainville-parse.ts";

test("känner igen båda länkformaten", () => {
  assert.equal(extractRequisitionId("/Market/RequisitionSearchResult/Details/330877"), "330877");
  assert.equal(
    extractRequisitionId("/PublicProfile/Requisition?companyId=648&id=168877&returnUrl=/Market/RequisitionSearchResult/Details/168877"),
    "168877",
  );
  assert.equal(extractRequisitionId("/PublicProfile/Requisitions?id=648"), null);
});

test("tolkar sidtitel", () => {
  assert.deepEqual(parseDocumentTitle("DevOps | Hire Quality AB - Assignment | Brainville - The Marketplace"), {
    title: "DevOps",
    company: "Hire Quality AB",
  });
});

test("parseListing hittar kort och deduplicerar", () => {
  const html = `<html><head><title>Open assignments | KeyMan AB | Brainville</title></head><body>
    <ul>
      <li><div class="item"><h3><a href="/PublicProfile/Requisition?companyId=7820&id=1001">Senior Java-utvecklare</a></h3>
        <span class="location">Stockholm</span><span>2026-09-20</span> – <span>2026-10-05</span>
        <p>Vi söker en Java-utvecklare med Spring Boot och Azure.</p>
        <a href="/Market/RequisitionSearchResult/Details/1001">Läs mer</a></div></li>
      <li><div class="item"><h3><a href="/Market/RequisitionSearchResult/Details/1002">Projektledare IT</a></h3>
        <span class="location">Göteborg</span></div></li>
    </ul></body></html>`;
  const items = parseListing(html);
  assert.equal(items.length, 2);
  const java = items.find((i) => i.id === "brainville:1001")!;
  assert.equal(java.title, "Senior Java-utvecklare");
  assert.equal(java.company, "KeyMan AB");
  assert.equal(java.location, "Stockholm");
  assert.equal(java.published, "2026-09-20");
  assert.equal(java.deadline, "2026-10-05");
  assert.match(java.description!, /Spring Boot/);
});

test("parseListing läser inbäddad JSON", () => {
  const html = `<html><body><script>window.data = {"items":[{"Id":42,"Title":"React-konsult","CompanyName":"Ework Group AB","PublicationStartDate":"2026-09-01T00:00:00"}]};</script></body></html>`;
  const items = parseListing(html);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "React-konsult");
  assert.equal(items[0].company, "Ework Group AB");
  assert.equal(items[0].published, "2026-09-01");
});

test("parseDetail hämtar titel, företag och beskrivning", () => {
  const html = `<html><head><title>DevOps | Hire Quality AB - Assignment | Brainville</title></head>
    <body><nav>meny</nav><main><h1>DevOps</h1><div class="description">Kubernetes, Terraform och AWS. Start 2026-11-01.</div></main></body></html>`;
  const d = parseDetail(html);
  assert.equal(d.title, "DevOps");
  assert.equal(d.company, "Hire Quality AB");
  assert.match(d.description!, /Kubernetes/);
  assert.equal(d.start, "2026-11-01");
});

test("findNextPageUrl hittar nästa sida men inte ankarlänkar", async () => {
  const { findNextPageUrl } = await import("../src/lib/sources/brainville-parse.ts");
  const base = "https://www.brainville.com/PublicPage/RequisitionSearch";
  assert.equal(
    findNextPageUrl(`<ul class="pagination"><li><a href="#">1</a></li><li><a href="?page=2">Nästa</a></li></ul>`, base),
    "https://www.brainville.com/PublicPage/RequisitionSearch?page=2",
  );
  assert.equal(findNextPageUrl(`<a href="#">Next</a><a href="javascript:void(0)">›</a>`, base), null);
});

// Länkformatet sedan oktober 2026 (linkPatterns från /api/debug på söksidan, 2026-10-14).
test("nytt länkformat med språkprefix och id i sökvägen", () => {
  assert.equal(extractRequisitionId("/sv/PublicProfile/Requisition/343645?companyId=4686"), "343645");
  assert.equal(extractRequisitionId("https://www.brainville.com/en/PublicProfile/Requisition/343645"), "343645");
  assert.equal(extractRequisitionId("/sv/PublicProfile/Requisitions?id=648"), null);
  assert.equal(extractRequisitionId("/sv/RequisitionSearch?Text=Projektledare"), null);
  const items = parseListing(
    `<ul>
      <li><div class="item"><h3><a href="/sv/PublicProfile/Requisition/343645?companyId=4686">Systemutvecklare .NET</a></h3>
        <p>Stockholm</p></div></li>
      <li><div class="item"><h3><a href="/sv/PublicProfile/Requisition/343646?companyId=648">Testledare</a></h3></div></li>
      <li><a href="/sv/RequisitionSearch?Text=Projektledare">Projektledare</a></li>
    </ul>`,
    "https://www.brainville.com/sv/RequisitionSearch?lang=sv",
  );
  assert.deepEqual(
    items.map((a) => [a.id, a.title, a.url]),
    [
      ["brainville:343645", "Systemutvecklare .NET", "https://www.brainville.com/sv/PublicProfile/Requisition/343645?companyId=4686"],
      ["brainville:343646", "Testledare", "https://www.brainville.com/sv/PublicProfile/Requisition/343646?companyId=648"],
    ],
  );
});

test("företagssidans nya adress räknas inte som ett uppdrag", () => {
  assert.equal(extractRequisitionId("/sv/PublicProfile/Requisitions/648"), null);
});

// Söksidan för "testledare" (2026-10-14): länkar /sv/Requisition?id=…&text=… och JSON-LD ItemList.
test("söksidans nya träfflänkar och JSON-LD-lista", () => {
  assert.equal(extractRequisitionId("/sv/Requisition?id=367981&text=testledare"), "367981");
  assert.equal(extractRequisitionId("/sv/RequisitionSearch?Text=Projektledare"), null);
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    numberOfItems: 4,
    itemListElement: [
      { "@type": "ListItem", position: 1, url: "https://www.brainville.com/sv/Requisition?id=367981", name: "Testledare" },
      { "@type": "ListItem", position: 2, url: "https://www.brainville.com/sv/Requisition?id=367966", name: "Testare / Testledare / Testautomatiserare" },
      { "@type": "ListItem", position: 3, url: "https://www.brainville.com/sv/Requisition?id=367824", name: "Testledare" },
      { "@type": "ListItem", position: 4, url: "https://www.brainville.com/sv/Requisition?id=367732", name: "Testledare" },
    ],
  };
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(itemList)}</script></head><body>
    <a href="/sv/RequisitionSearch?Text=Projektledare">Projektledare</a>
    <div class="req"><a href="/sv/Requisition?id=367981&text=testledare"><h3>Testledare</h3></a><p>Stockholm</p></div>
  </body></html>`;
  const items = parseListing(html, "https://www.brainville.com/sv/RequisitionSearch?Text=testledare&lang=sv");
  assert.deepEqual(
    items.map((a) => [a.id, a.title, a.url]),
    [
      ["brainville:367981", "Testledare", "https://www.brainville.com/sv/Requisition?id=367981"],
      ["brainville:367966", "Testare / Testledare / Testautomatiserare", "https://www.brainville.com/sv/Requisition?id=367966"],
      ["brainville:367824", "Testledare", "https://www.brainville.com/sv/Requisition?id=367824"],
      ["brainville:367732", "Testledare", "https://www.brainville.com/sv/Requisition?id=367732"],
    ],
  );
});

// Riktigt kort från söksidan för "testledare" (listSnippet i /api/debug, 2026-10-14) + ett kort med
// hybrid och kompetenstaggar (som Brainville visar under kortet).
const CARD_VISBY = `<div class="l_gap_row_md l_flex l_flex_column l_flex_grow"> <div class="l_flex l_flex_justifycontent_spacebetween l_flex_align_start l_width_full"> <div class="l_width_full"> <div class="l_flex l_flex_justifycontent_spacebetween l_width_full l_flex_align_center l_gap_md l_height_min_28"> <div class="app_tags_wrapper app_tags_wrapper_small" data-font-size="small" data-font-variant="secondary"> <span class="app_margin_right_5"> <span>idag <span class="l_opacity_medium">15:57</span></span> </span> <span class="app_margin_right_5" title="Du är sen på bollen! Med Premium hade du sett detta uppdrag direkt. 68% av alla konsultuppdrag är brådskande enligt köparen. " data-tooltip=""> <span class="fas fa-exclamation-triangle app_color_brainville_yellow"></span> </span> </div> <div class="app_display_flex app_alignitems_flexend app_justifycontent_spacebetween app_height_100procent app_flex_direction_column"> <div class="app_display_flex app_gap_col_large app_gap_row_medium"> <span title="Logga in eller skapa ett konto för att kunna favoritmarkera uppdrag." data-tooltip="" class="fal fa-heart l_icon_size_md"></span> </div> </div> </div> <h3 data-font-type="title" data-font-size="medium" data-font-fluid="parent full_width"> <a href="/sv/Requisition?id=367981&amp;text=testledare" class="app_link_visited app_overflow_wrap_everywhere h_truncate_3">Testledare</a> </h3> <div data-flex="flex align_center gap_xs"> <div class="app_display_flex app_alignitems_center l_margin_top_6" data-font-size="small" data-font-variant="secondary" title="Visby, Gotlands län, Sweden" data-tooltip="" data-tooltip-position="left"> <span class="app_margin_right_2">Visby</span> </div> <div class="app_display_flex app_alignitems_center l_margin_top_6" data-font-size="small" data-font-variant="secondary"> </div> </div> </div> </div> <div class="l_flex l_flex_justifycontent_spacebetween l_flex_align_end l_width_full mo_hide"> <div> <div class="l_flex l_flex_justifycontent_spacebetween l_width_full l_margin_top_3"> <div class="c_chip__container"> <span class="c_chip c_chip_primary c_chip_md l_gap_0" title="<div><b>Startdatum</b><div>Nu</div>" data-tooltip=""> Start direkt </span> </div> </div> </div> <div> <div class="app_whitespace_nowrap " data-font-size="small" data-font-variant="secondary"> <div> <time datetime="2026-10-26"><span class="l_nowrap"><span>1</span>&nbsp;<span>vecka</span>&nbsp;<span>kvar</span></span></time> </div> </div> </div> </div> <div class="tags"><span>Ekonomi</span></div></div>`;
const CARD_STHLM = `<div class="card"> <span><span>igår <span>16:23</span></span></span> <h3><a href="/sv/Requisition?id=367966&amp;text=testledare">Testare / Testledare / Testautomatiserare</a></h3> <div data-flex="flex"> <div title="Stockholm, Stockholms län, Sweden"><span>Stockholm</span></div> <div>Hybrid</div> </div> <div class="mo_hide"><span class="c_chip c_chip_primary">Start om om 1 månad</span><span class="c_chip">Längd ca. 12 months</span> <time datetime="2026-10-21"><span>1</span> <span>vecka</span> <span>kvar</span></time></div> <div class="mo_show"><span class="c_chip">Start om om 1 månad</span><span class="c_chip">Längd ca. 12 months</span><span>1 v</span></div> <div class="tags"><span>Systemutveckling</span><span>Testning</span><span>Automation</span></div> </div>`;

test("söksidans nya kort: plats, datum, start, längd och kompetenser", () => {
  const now = new Date("2026-10-14T16:00:00Z");
  assert.equal(brainvilleAgeDate("idag 15:57", now), "2026-10-14");
  assert.equal(brainvilleAgeDate("igår 16:23", now), "2026-10-13");
  assert.equal(brainvilleAgeDate("3 okt", now), "2026-10-03");
  const items = parseListing(`<div class="list"><div>${CARD_VISBY}</div><div>${CARD_STHLM}</div></div>`, "https://www.brainville.com/sv/RequisitionSearch?Text=testledare");
  const [visby, sthlm] = items;
  assert.equal(visby.title, "Testledare");
  assert.equal(visby.location, "Visby");
  assert.equal(visby.country, "Sweden");
  assert.equal(visby.startText, "Omgående");
  assert.equal(visby.deadline, "2026-10-26");
  assert.equal(visby.description, "Kompetenser: Ekonomi");
  assert.equal(visby.url, "https://www.brainville.com/sv/Requisition?id=367981");
  assert.match(visby.published ?? "", /^20\d{2}-\d{2}-\d{2}$/);
  assert.equal(sthlm.location, "Stockholm");
  assert.equal(sthlm.workMode, "Hybrid");
  assert.equal(sthlm.startText, "Om 1 månad");
  assert.equal(sthlm.duration, "ca 12 månader");
  assert.equal(sthlm.deadline, "2026-10-21");
  assert.equal(sthlm.description, "Kompetenser: Systemutveckling, Testning, Automation");
});

// Uppdragssidan sedan oktober 2026: titel i BreadcrumbList, sajtens meny/sidfot i out_*-element.
test("uppdragssidan: titel ur BreadcrumbList, menyn räknas inte som beskrivning", () => {
  const crumbs = {
    "@context": "http://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, item: { "@id": "https://www.brainville.com/konsultuppdrag", name: "Konsultuppdrag" } },
      { "@type": "ListItem", position: 2, item: { "@id": "https://www.brainville.com/PublicPage/Requisition?id=367981", name: "Testledare" } },
    ],
  };
  const menu = "Din roll Frilansare Hitta uppdrag och bli hittad av uppdragsgivare. Konsultbolag Sälj era konsulter och hitta bolagets nästa uppdrag. ".repeat(4);
  const d = parseDetail(`<html><head><title>Marknadsplats</title><script type="application/ld+json">${JSON.stringify(crumbs)}</script></head><body>
    <div class="out_topmenu"><div class="out_topmenu_panel">${menu}</div></div>
    <div class="requisition"><h1>Testledare</h1><p>Vi söker en erfaren testledare till ett uppdrag hos en myndighet i Visby. Du leder testarbetet och samordnar testare.</p></div>
    <footer class="out_footer">${menu}</footer></body></html>`);
  assert.equal(d.title, "Testledare");
  assert.match(d.description ?? "", /erfaren testledare/);
  assert.doesNotMatch(d.description ?? "", /Din roll/);
});
