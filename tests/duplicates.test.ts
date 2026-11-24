import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDuplicates, comparePair, normalizeTitle, titleSimilarity } from "../src/lib/duplicates.ts";
import type { Assignment } from "../src/lib/types.ts";

const LOREM =
  "Vi söker en erfaren utvecklare som ska bygga nya tjänster i molnet tillsammans med ett agilt team hos kunden. " +
  "Du arbetar med Java, Spring Boot och Kubernetes och tar ansvar för kodkvalitet, tester och driftsättning. " +
  "Uppdraget passar dig som har flera års erfarenhet av backendutveckling och trivs i en komplex miljö.";
const OTHER =
  "Kunden behöver en projektledare som driver ett större förändringsarbete inom ekonomi och HR med många intressenter. " +
  "Du planerar, följer upp och rapporterar till styrgruppen och leder ett tvärfunktionellt team genom hela införandet.";

const a = (over: Partial<Assignment>): Assignment => ({ id: "x:1", source: "X", title: "", url: "https://x.se/1", ...over });

test("normalizeTitle tar bort datum och prefix", () => {
  assert.equal(normalizeTitle("Konsultuppdrag – Senior Java-utvecklare (2026.10.29)"), "senior java utvecklare");
  assert.equal(normalizeTitle("Consultant Task | Data Engineer | 8.10.2026"), "data engineer");
  assert.equal(titleSimilarity("Senior Javautvecklare, Stockholm", "Senior Javautvecklare – Stockholm"), 1);
});

test("samma länk och samma titel + text är säkra dubbletter", () => {
  const p = comparePair(a({ id: "a:1", url: "https://www.x.se/jobb/1/" }), a({ id: "b:1", url: "https://x.se/jobb/1" }));
  assert.equal(p?.certain, true);
  assert.deepEqual(p?.reasons, ["Samma annonslänk"]);

  const q = comparePair(
    a({ id: "a:2", source: "A", url: "https://a.se/2", title: "Senior Javautvecklare", description: LOREM, location: "Stockholm" }),
    a({ id: "b:2", source: "B", url: "https://b.se/2", title: "Konsultuppdrag - Senior Javautvecklare (2026-11-02)", description: LOREM, location: "Stockholm, hybrid" }),
  );
  assert.equal(q?.certain, true);
  assert.equal(q?.confidence, 100);
  assert.ok(q?.reasons.includes("Samma titel"));
  assert.ok(q?.reasons.some((r) => r.startsWith("Beskrivningen 100 % lik")));
});

test("liknande titel utan beskrivning blir en misstänkt dubblett med procent", () => {
  const p = comparePair(
    a({ id: "a:3", source: "A", url: "https://a.se/3", title: "Senior Java-utvecklare till bank", location: "Göteborg", start: "2027-01-11" }),
    a({ id: "b:3", source: "B", url: "https://b.se/3", title: "Senior Javautvecklare bank", location: "Göteborg", start: "2027-01-11" }),
  );
  assert.ok(p);
  assert.equal(p.certain, false);
  assert.ok(p.confidence >= 70 && p.confidence <= 99, String(p.confidence));
  assert.ok(p.reasons.some((r) => r.startsWith("Samma ort")));
  assert.ok(p.reasons.some((r) => r.startsWith("Samma startdatum")));
});

test("olika ort och olika text sänker eller fäller bedömningen", () => {
  const p = comparePair(
    a({ id: "a:4", source: "A", url: "https://a.se/4", title: "Projektledare", description: LOREM, location: "Malmö" }),
    a({ id: "b:4", source: "B", url: "https://b.se/4", title: "Projektledare", description: OTHER + " " + OTHER, location: "Umeå" }),
  );
  assert.equal(p, null);
});

test("mallartade titlar med helt olika beskrivningar räknas inte som dubbletter", () => {
  const list = Array.from({ length: 6 }, (_, i) =>
    a({ id: `s:${i}`, source: ["A", "B"][i % 2], url: `https://s.se/${i}`, title: `Unikt uppdrag nummer ${i} inom område ${"abcdef"[i]}`, description: `Helt egen text ${i} `.repeat(30), location: "Stockholm" }),
  );
  assert.equal(analyzeDuplicates(list).groups.length, 0);
});

test("analyzeDuplicates grupperar och räknar överflödiga uppdrag", () => {
  const list: Assignment[] = [
    a({ id: "a:1", source: "A", url: "https://a.se/1", title: "Senior Javautvecklare", description: LOREM, location: "Stockholm" }),
    a({ id: "b:1", source: "B", url: "https://b.se/1", title: "Senior Javautvecklare", description: LOREM, location: "Stockholm" }),
    a({ id: "c:1", source: "C", url: "https://c.se/1", title: "Senior Java-utvecklare", location: "Stockholm" }),
    a({ id: "a:2", source: "A", url: "https://a.se/2", title: "Projektledare ekonomi och HR", description: OTHER + " " + OTHER }),
    a({ id: "b:9", source: "B", url: "https://b.se/9", title: "Testledare till myndighet" }),
  ];
  const r = analyzeDuplicates(list);
  assert.equal(r.total, 5);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].items.length, 3);
  assert.equal(r.redundant, 2);
  assert.equal(r.redundantCertain, 1);
  assert.equal(r.redundantSuspected, 1);
  assert.equal(r.unique, 3);
  assert.equal(r.groups[0].certain, false);
  assert.deepEqual(r.overlap.sources, ["A", "B", "C"]);
  assert.equal(r.overlap.matrix[0][1], 1);
  assert.equal(r.buckets.find((b) => b.label === "Säker")?.count, 1);
});

test("vanliga titelord som 'Business Analyst' utesluter inte paret från jämförelse", () => {
  // Fler än 5 % av annonserna innehåller "business" eller "analyst", så orden räknas som vanliga.
  const filler = Array.from({ length: 80 }, (_, i) =>
    a({ id: `f:${i}`, source: "F", url: `https://f.se/${i}`, title: i % 2 ? `Business Controller ${i}` : `Data Analyst nivå ${i}`, description: `Egen text nummer ${i} `.repeat(20) }),
  );
  const list = [
    ...filler,
    a({ id: "a:ba", source: "A", url: "https://a.se/ba", title: "Business Analyst", description: LOREM, location: "Stockholm" }),
    a({ id: "b:ba", source: "B", url: "https://b.se/ba", title: "Business Analyst – Region Stockholm", description: LOREM, location: "Stockholm" }),
  ];
  const r = analyzeDuplicates(list);
  const g = r.groups.find((x) => x.items.some((i) => i.id === "a:ba"));
  assert.ok(g, "Business Analyst-paret ska hittas");
  assert.deepEqual(g.items.map((i) => i.id).sort(), ["a:ba", "b:ba"]);
});

test("korta, allmänna titlar utan beskrivning ger bara måttlig misstanke", () => {
  const same = comparePair(
    a({ id: "a:g", source: "A", url: "https://a.se/g", title: "Business Analyst", location: "Stockholm" }),
    a({ id: "b:g", source: "B", url: "https://b.se/g", title: "Business Analyst", location: "Stockholm" }),
  );
  assert.ok(same && !same.certain && same.confidence < 80, String(same?.confidence));
  const otherCity = comparePair(
    a({ id: "a:h", source: "A", url: "https://a.se/h", title: "Business Analyst", location: "Malmö" }),
    a({ id: "b:h", source: "B", url: "https://b.se/h", title: "Business Analyst", location: "Luleå" }),
  );
  assert.equal(otherCity, null);
});
