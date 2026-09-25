// OBS: HTML:en nedan är syntetisk och bygger på Brainvilles kända URL-mönster,
// inte på en sparad kopia av sajten. Uppdatera med riktig HTML via /api/debug.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRequisitionId, parseDetail, parseDocumentTitle, parseListing } from "../src/lib/sources/brainville-parse.ts";

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
