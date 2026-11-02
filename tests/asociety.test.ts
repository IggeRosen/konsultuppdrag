import { test } from "node:test";
import assert from "node:assert/strict";
import { asocietySlug, asocietyUrl, parseAsocietyPage, rscPayload, rscTextRows } from "../src/lib/sources/asociety.ts";

// Uppbyggt som sidans RSC-data (2026-11-02): uppdragsobjekt i en push, beskrivningen som
// textrad "34:T<längd i byte>,<text>" i en annan. Kontaktuppgifterna är fejkade.
const DESC =
  "&lt;p&gt;&lt;strong&gt;About the Assignment&lt;/strong&gt;<br> &lt;br&gt;<br> As a Deep Learning Engineer you will develop models för fordon.&lt;/p&gt;<br>" +
  "&lt;p&gt;Contact Kontakt Person, kontakt@example.com, +46 70 000 00 00&lt;/p&gt;";
const JOBS = [
  {
    requisition_enddate: "2027-11-19",
    requisition_shortdescription: "",
    requisition_description: "$34",
    requisition_startdate: "2026-11-23",
    mspperson_cellphone: "+46 700 00 00 00",
    mspperson_email: "kontakt@example.com",
    requisition_locationid: "Göteborg",
    requisition_skillset: [],
    requisition_remotework: "Hybrid",
    requisition_servicecategoryid: "Engineering",
    requisition_worktimepercentage: "100",
    requisition_name: "Senior Deep Learning Engineer – Dynamic Objects",
    abstract_id: "16884",
    requisition_customcode1: "Sweden",
    requisition_offerduedate: "2026-11-04",
    requisition_searchermsppersonid: "Kontakt Person",
    requisition_publisheddate: "2026-11-02",
    requisition_competenceareaid: "Software",
  },
  {
    requisition_description: "Short {text} with \"quotes\"",
    requisition_locationid: "Remote International",
    requisition_remotework: "På plats",
    requisition_name: "Senior Data Analyst- Location: London",
    abstract_id: "17001",
    requisition_customcode1: "International",
  },
];
const payload = `1:"$Sreact.fragment"\n2c:["$","$L2d",null,{"jobs":${JSON.stringify(JOBS)}}]\n34:T${Buffer.byteLength(DESC, "utf8").toString(16)},${DESC}35:T6,åäö\n3a:["$","div",null,{}]\n`;
const half = Math.floor(payload.length / 2);
const html = `<html><body><script>self.__next_f.push([0])</script><script>self.__next_f.push([1,${JSON.stringify(
  payload.slice(0, half),
)}])</script><script>self.__next_f.push([1,${JSON.stringify(payload.slice(half))}])</script></body></html>`;

test("rscPayload och rscTextRows", () => {
  const p = rscPayload(html);
  assert.equal(p, payload);
  assert.equal(rscTextRows(p).get("34"), DESC);
  // Textrad direkt efter en annan, utan radbrytning; längden räknas i byte (å = 2 byte).
  assert.equal(rscTextRows(p).get("35"), "åäö");
});

test("asocietySlug / asocietyUrl", () => {
  assert.equal(asocietySlug("Senior Deep Learning Engineer – Dynamic Objects"), "senior-deep-learning-engineer-dynamic-objects");
  assert.equal(
    asocietyUrl("Senior Deep Learning Engineer – Dynamic Objects", "16884"),
    "https://www.asocietygroup.com/sv/uppdrag/senior-deep-learning-engineer-dynamic-objects-16884",
  );
  assert.equal(asocietySlug("Mjukvaruutvecklare – Inbyggda system (C/C++)"), "mjukvaruutvecklare-inbyggda-system-c-c");
});

test("parseAsocietyPage läser uppdragen utan kontaktuppgifter", () => {
  const [a, b] = parseAsocietyPage(html);
  assert.equal(a.id, "asociety:16884");
  assert.equal(a.source, "A Society");
  assert.equal(a.title, "Senior Deep Learning Engineer – Dynamic Objects");
  assert.equal(a.url, "https://www.asocietygroup.com/sv/uppdrag/senior-deep-learning-engineer-dynamic-objects-16884");
  assert.equal(a.location, "Göteborg");
  assert.equal(a.country, "Sverige");
  assert.equal(a.published, "2026-11-02");
  assert.equal(a.deadline, "2026-11-04");
  assert.equal(a.start, "2026-11-23");
  assert.equal(a.end, "2027-11-19");
  assert.equal(a.extent, "100 %");
  assert.equal(a.workMode, "Hybrid");
  assert.match(a.description ?? "", /^About the Assignment\nAs a Deep Learning Engineer you will develop models för fordon\./);
  assert.match(a.description ?? "", /Område: Engineering, Software\./);
  assert.doesNotMatch(a.description ?? "", /@|\+46|Kontakt Person|&lt;|<p>/);
  assert.equal(b.country, "International");
  assert.equal(b.workMode, "På plats");
  assert.match(b.description ?? "", /Short \{text\} with "quotes"/);
});
