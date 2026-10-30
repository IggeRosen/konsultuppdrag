import { test } from "node:test";
import assert from "node:assert/strict";
import { isRpgRelevant, parseRpgProject, rpgProjects } from "../src/lib/sources/rightpeople.ts";

// Beskrivningar i samma form som i props.pageProps.projects (2026-10-30), kontaktuppgifter fejkade.
const SV = {
  id: 3501,
  documentId: "abc123svfrontend",
  locale: "en",
  createdAt: "2026-10-22T09:00:00.000Z",
  publishedAt: "2026-10-22T09:05:00.000Z",
  title: "Senior Frontendutvecklare – React & Next.js | If Försäkring (2026.10.22)",
  slug: "senior-frontendutvecklare-react-and-next-js-if-foersaekring-2026-10-22",
  description:
    "<p>Right People Group söker en senior frontendutvecklare till ett konsultuppdrag hos If Försäkring i Stockholm.</p>" +
    "<p><strong>Uppdragsinformation</strong><br><strong>Kund:</strong> If Försäkring<br><strong>Placering:</strong> Bergshamra, Stockholm<br>" +
    "<strong>Hybrid:</strong> Minst 3 dagar per vecka på kontoret<br><strong>Start:</strong> 9 november 2026<br>" +
    "<strong>Längd:</strong> 6 månader med möjlighet till förlängning<br><strong>Omfattning:</strong> Heltid<br>" +
    "<strong>Sista ansökningsdag:</strong> 30 oktober 2026, kl. 12.00 (löpande urval)</p>" +
    "<p><strong>Om uppdraget</strong><br>Du kommer att ingå i ett nordiskt utvecklingsteam.</p>" +
    "<ul><li>Gedigen erfarenhet av React och Next.js.</li></ul>" +
    "<p><strong>Ansökan</strong><br>Är du tillgänglig och har rätt kompetens?<br>Skicka ditt CV till <a href=\"mailto:x@example.com\">x@example.com</a>.</p>",
  location: "Sweden",
  languages: "Swedish",
  competences: "Software development",
  open: true,
};
const NO = {
  id: 3596,
  documentId: "ccxokdg9lhyo9f7dw923qsr6",
  publishedAt: "2026-10-29T15:54:55.342Z",
  title: "Konsulentoppdrag | Funksjonell D365 F&O-arkitekt",
  slug: "konsulentoppdrag-funksjonell-d365-f-and-o-arkitekt",
  description:
    "<p>For en privat kunde søker vi en erfaren funksjonell arkitekt.<br><br><strong>Arbeidssted:</strong> Oslo, mulighet for hjemmekontor 1-2 dager i uken.&nbsp;<br>" +
    "<strong>Allokering:</strong> 100 %<br><strong>Oppstart:</strong> Midten av desember 2026<br><strong>Varighet:</strong> Ut 2027</p>" +
    "<p><strong>Er du interessert?</strong><br>Send CV-en din til <a href=\"mailto:y@example.com\">y@example.com</a></p>",
  location: "Norway",
  languages: "Norwegian",
  competences: "IT and management consulting",
  open: true,
};
const REMOTE = { id: 1, documentId: "remote1", title: "Consultant Request - React Developer", slug: "consultant-request-react-developer", description: "<p>Remote.</p>", location: "Remote projects", open: true };
const CLOSED = { ...SV, documentId: "closed", slug: "closed", open: false };

const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: { projects: [NO, SV, REMOTE, CLOSED] } },
})}</script></body></html>`;

test("rpgProjects läser projects ur __NEXT_DATA__", () => {
  assert.equal(rpgProjects(html).length, 4);
  assert.deepEqual(rpgProjects("<html></html>"), []);
});

test("parseRpgProject läser fälten ur beskrivningen och hoppar över ansökningsdelen", () => {
  const a = parseRpgProject(SV);
  assert.ok(a);
  assert.equal(a.id, "rightpeople:abc123svfrontend");
  assert.equal(a.source, "Right People Group");
  assert.equal(a.url, "https://rightpeoplegroup.com/sv/open-assignments/senior-frontendutvecklare-react-and-next-js-if-foersaekring-2026-10-22");
  assert.equal(a.company, "If Försäkring");
  assert.equal(a.location, "Bergshamra, Stockholm");
  assert.equal(a.country, "Sverige");
  assert.equal(a.published, "2026-10-22");
  assert.equal(a.start, "2026-11-09");
  assert.equal(a.startText, "9 november 2026");
  assert.equal(a.deadline, "2026-10-30");
  assert.equal(a.duration, "6 månader med möjlighet till förlängning");
  assert.equal(a.extent, "Heltid");
  assert.equal(a.workMode, "Hybrid: Minst 3 dagar per vecka på kontoret");
  assert.match(a.description ?? "", /nordiskt utvecklingsteam/);
  assert.match(a.description ?? "", /Område: Software development\./);
  assert.doesNotMatch(a.description ?? "", /@|Skicka ditt CV|Sista ansökningsdag/);
});

test("parseRpgProject: norska fält, remote och stängda", () => {
  const no = parseRpgProject(NO);
  assert.ok(no);
  assert.equal(no.country, "Norge");
  assert.equal(no.location, "Oslo, mulighet for hjemmekontor 1-2 dager i uken.");
  assert.equal(no.extent, "100 %");
  assert.equal(no.duration, "Ut 2027");
  assert.doesNotMatch(no.description ?? "", /@/);
  assert.equal(isRpgRelevant(no), false);

  const r = parseRpgProject(REMOTE);
  assert.ok(r);
  assert.equal(r.country, undefined);
  assert.equal(r.location, "Remote");
  assert.equal(r.workMode, "Distans");
  assert.equal(isRpgRelevant(r), true);

  assert.equal(parseRpgProject(CLOSED), null);
  assert.equal(isRpgRelevant(parseRpgProject(SV)!), true);
});

test("parseRpgProject: engelska etiketter och 'Are you interested?'", () => {
  const a = parseRpgProject({
    documentId: "en1",
    title: "Consultant Task | Data & Analytics Consultant, Stockholm",
    slug: "consultant-task-data",
    description:
      "<p>We are looking for a consultant.</p><p><strong>Location:</strong> Stockholm, onsite<br><strong>Workload:</strong> 100 %<br>" +
      "<strong>Start:</strong> ASAP<br><strong>Duration:</strong> 6 months<br><strong>Arbetssätt:</strong> Distans möjligt</p>" +
      "<p><strong>Are you interested?</strong><br>Send your CV to Jane Doe as soon as possible.</p>",
    location: "Sweden",
    open: true,
  });
  assert.ok(a);
  assert.equal(a.location, "Stockholm, onsite");
  assert.equal(a.extent, "100 %");
  assert.equal(a.startText, "ASAP");
  assert.equal(a.start, undefined);
  assert.equal(a.duration, "6 months");
  assert.equal(a.workMode, "Distans möjligt");
  assert.doesNotMatch(a.description ?? "", /Jane Doe|interested/);
});
