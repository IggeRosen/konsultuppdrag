import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDuplicates, comparePair, explainDuplicates, normalizeTitle, titleSimilarity } from "../src/lib/duplicates.ts";
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
    a({ id: `s:${i}`, source: ["A", "B"][i % 2], url: `https://s.se/${i}`, title: `Unikt uppdrag nummer ${i} inom område ${"abcdef"[i]}`, description: Array.from({ length: 40 }, (_, k) => `ord${i * 100 + k}`).join(" "), location: "Stockholm" }),
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
  assert.equal(r.overlap.matrix[0][0], 0);
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

test("explainDuplicates visar alla par, även under gränsen", () => {
  const list = [
    a({ id: "a:1", source: "A", url: "https://a.se/1", title: "Business Analyst", location: "Malmö" }),
    a({ id: "b:1", source: "B", url: "https://b.se/1", title: "Business Analyst Finspång", location: "Luleå" }),
    a({ id: "c:1", source: "C", url: "https://c.se/1", title: "Testledare" }),
  ];
  const r = explainDuplicates(list, "business analyst");
  assert.equal(r.items.length, 2);
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].candidate, true);
  assert.ok(r.pairs[0].confidence < 50);
});

test("orter i samma region räknas inte som olika orter", () => {
  const p = comparePair(
    a({ id: "e:1", source: "Ework", url: "https://e.se/1", title: "Senior Program Business Analyst - Custody Knowledge", location: "Solna", start: "2026-12-14" }),
    a({ id: "m:1", source: "emagine", url: "https://m.se/1", title: "Program Business Analyst (Custody Knowledge)", location: "Stockholm Metropolitan Area" }),
  );
  assert.ok(p && p.confidence >= 80, String(p?.confidence));
  assert.ok(p.reasons.some((r) => r.startsWith("Samma region")));
  assert.ok(!p.against.some((r) => r.startsWith("Olika orter")));
  const q = comparePair(
    a({ id: "x:1", source: "A", url: "https://x.se/1", title: "Business Analyst till HellermannTyton", location: "Stockholms län" }),
    a({ id: "y:1", source: "B", url: "https://y.se/1", title: "Business Analyst till HellermannTyton", location: "Stockholm" }),
  );
  assert.ok(q?.reasons.some((r) => r.startsWith("Samma ort")));
});

test("omskrivna annonser om samma uppdrag på en ovanlig ort grupperas", () => {
  // Olika bemanningsföretag skriver egna texter om samma uppdrag (som på Platsbanken).
  const pad = Array.from({ length: 200 }, (_, i) =>
    a({ id: `p:${i}`, source: `P${i % 5}`, url: `https://p.se/${i}`, title: `Utvecklare ${i} inom område ${i}`, location: "Stockholm",
       description: Array.from({ length: 60 }, (_, k) => `ord${(i * 7 + k) % 300}`).join(" ") + " erfarenhet kund team processer behov" }),
  );
  const ba = (id: string, company: string, title: string, intro: string) =>
    a({ id, source: "Platsbanken", company, url: `https://pb.se/${id}`, title, location: "Finspång",
       description: `${intro} Du arbetar med PLM och Teamcenter hos en gasturbintillverkare i Finspång. Produktdata, datakvalitet och processer i PLM-miljön står i fokus, och du samarbetar med verksamheten kring Teamcenter och produktstrukturer.` });
  const list = [
    ...pad,
    ba("pb:1", "UNIK Resurs", "Businees Analyst inom PLM", "Till vår kund inom tillverkande industrin söker vi en Business Analyst för ett uppdrag."),
    ba("pb:2", "TIKK TAKK", "Business Analyst inom PLM-system till energiteknikföretag", "Vi söker en Business Analyst med erfarenhet av Product Lifecycle Management."),
    ba("pb:3", "Skill", "Business Analyst till gasturbintillverkare", "Företaget möter den ökade efterfrågan på energi i över 90 länder."),
    a({ id: "pb:9", source: "Platsbanken", company: "Skill", url: "https://pb.se/9", title: "Dokument- och arkivmedarbetare till gasturbintillverkare", location: "Finspång",
        description: "Företaget möter den ökade efterfrågan på energi. Du skannar, arkiverar och registrerar dokument i arkivet och hjälper kollegor att hitta ritningar och underlag i dokumenthanteringen." }),
  ];
  const r = analyzeDuplicates(list);
  const g = r.groups.find((x) => x.items.some((i) => i.id === "pb:1"));
  assert.ok(g, "Business Analyst-annonserna ska bilda en grupp");
  assert.deepEqual(g.items.map((i) => i.id).sort(), ["pb:1", "pb:2", "pb:3"]);
  assert.ok(g.pairs.some((p) => p.reasons.some((r) => r.includes("ovanlig ort"))));
});

test("kundens egen annons med annan text kopplas till mäklarnas annonser på en ovanlig ort", () => {
  // Som Siemens Energys "Business Analyst PLM" (31692116) mot UNIK:s "Businees Analyst inom PLM"
  // (31740925): bara ~16 % lik text, men samma ovanliga ort.
  const pad = Array.from({ length: 200 }, (_, i) =>
    a({ id: `p:${i}`, source: `P${i % 5}`, url: `https://p.se/${i}`, title: `Utvecklare ${i} inom område ${i}`, location: "Stockholm" }),
  );
  const own = a({ id: "pb:siemens", source: "Platsbanken", company: "Siemens Energy AB", url: "https://pb.se/s", title: "Business Analyst PLM", location: "Finspång" });
  const broker = a({ id: "pb:unik", source: "Platsbanken", company: "UNIK Resurs", url: "https://pb.se/u", title: "Businees Analyst inom PLM", location: "Finspång" });
  const r = analyzeDuplicates([...pad, own, broker]);
  assert.ok(r.groups.some((g) => g.items.some((i) => i.id === "pb:siemens") && g.items.some((i) => i.id === "pb:unik")));
});

test("ovanliga ord och orter räknas mot hela listan, inte den filtrerade", () => {
  // Hela listan: 200 annonser i Stockholm och några i Finspång. Den filtrerade listan (t.ex. på
  // "PLM") innehåller nästan bara Finspång-annonser, där orten annars ser vanlig ut.
  const pad = Array.from({ length: 200 }, (_, i) =>
    a({ id: `p:${i}`, source: `P${i % 5}`, url: `https://p.se/${i}`, title: `Utvecklare ${i} inom område ${i}`, location: "Stockholm" }),
  );
  const own = a({ id: "pb:siemens", source: "Platsbanken", company: "Siemens Energy AB", url: "https://pb.se/s", title: "Business Analyst PLM", location: "Finspång" });
  const broker = a({ id: "pb:unik", source: "Platsbanken", company: "UNIK Resurs", url: "https://pb.se/u", title: "Businees Analyst inom PLM", location: "Finspång" });
  const other = a({ id: "pb:x", source: "Platsbanken", company: "X", url: "https://pb.se/x", title: "Dokumentadministratör", location: "Finspång" });
  const filtered = [own, broker, other];
  const pair = (r: ReturnType<typeof analyzeDuplicates>) => r.groups.flatMap((g) => g.pairs).find((p) => [p.a, p.b].includes("pb:siemens"));
  const alone = pair(analyzeDuplicates(filtered));
  const withCorpus = pair(analyzeDuplicates(filtered, [...pad, ...filtered]));
  assert.ok(alone && withCorpus);
  assert.ok(!alone.reasons.some((r) => r.includes("ovanlig ort")));
  assert.ok(withCorpus.reasons.some((r) => r.includes("ovanlig ort")));
  assert.ok(withCorpus.confidence > alone.confidence);
});

test("källmatrisen räknar annonser, inte par", () => {
  // En annons hos A och tre hos B om samma uppdrag: 1 annons hos A delas med B, 3 hos B delas med A.
  const list: Assignment[] = [
    a({ id: "a:1", source: "A", url: "https://a.se/1", title: "Senior Javautvecklare", description: LOREM, location: "Stockholm" }),
    ...[1, 2, 3].map((n) => a({ id: `b:${n}`, source: "B", url: `https://b.se/${n}`, title: "Senior Javautvecklare", description: LOREM, location: "Stockholm" })),
  ];
  const r = analyzeDuplicates(list);
  assert.equal(r.groups.length, 1);
  assert.deepEqual(r.overlap.sources, ["A", "B"]);
  assert.deepEqual(r.overlap.matrix, [
    [0, 1],
    [3, 3],
  ]);
});
