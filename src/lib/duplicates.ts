import type { Assignment } from "./types.ts";

// Dubblettanalys av uppdragslistan. Samma uppdrag publiceras ofta av flera mäklare (en kund
// upphandlar via flera ramavtal) eller två gånger av samma källa (t.ex. svensk och engelsk
// version). Varje par av uppdrag som kan vara samma uppdrag får en bedömning:
//
//   SÄKER dubblett (100 %) när något av följande gäller:
//     • samma annonslänk (efter normalisering), eller
//     • titeln är i praktiken identisk OCH beskrivningen är minst 85 % lik, eller
//     • beskrivningen är minst 92 % lik (kopierad text) OCH titeln minst 60 % lik.
//
//   MISSTÄNKT dubblett (50–99 %) annars, med en sannolikhet som byggs upp av poäng:
//     • titelns likhet (0–55 p, korta allmänna titlar på högst två ord 0–45 p): medel av ord- och
//       teckenlikhet, datum och "Konsultuppdrag –" bortrensade,
//     • beskrivningarnas likhet (0–35 p): det högsta av kopierad text (fyrordsföljder) och
//       omskriven text om samma sak (idf-viktad ordlikhet × 0,85, där ovanliga ord som "PLM" och
//       "Teamcenter" väger tungt); saknas beskrivning väger titeln för båda (högst 65 p för korta
//       titlar, annars 90 p); texter under 20 % lika −15 p,
//     • samma ort (+8 p, +20 p om orten finns i under 3 % av annonserna, t.ex. Finspång) eller
//       olika orter (−20 p); orter i samma region (t.ex. Solna och Stockholm) är neutrala,
//     • samma startdatum (+5 p), samma sista ansökningsdag (+4 p), startdatum mer än två
//       veckor isär (−10 p),
//     • samma källa och samma företag (−5 p): Platsbanken samlar annonser från många företag.
//   Summan begränsas till 0–99 %. Par under MIN_CONFIDENCE (50 %) redovisas inte.
//
// Grupper bildas av alla par över gränsen (ett uppdrag kan finnas hos tre mäklare).
// "Överflödiga" uppdrag = gruppens storlek minus ett, dvs. hur många färre uppdrag listan
// hade haft utan dubbletter.

export const MIN_CONFIDENCE = 50;

export interface DuplicatePair {
  a: string;
  b: string;
  confidence: number;
  certain: boolean;
  /** Det som talar för att det är samma uppdrag. */
  reasons: string[];
  /** Det som talar emot. */
  against: string[];
}

export type DuplicateItem = Pick<Assignment, "id" | "source" | "title" | "url" | "company" | "location" | "published" | "start" | "deadline">;

export interface DuplicateGroup {
  items: DuplicateItem[];
  pairs: DuplicatePair[];
  /** Alla uppdrag i gruppen hänger ihop via säkra par. */
  certain: boolean;
  /** Gruppens svagaste nödvändiga länk (0–100). */
  confidence: number;
}

export interface DuplicateReport {
  total: number;
  /** Antal uppdrag kvar om varje grupp räknas en gång. */
  unique: number;
  /** Uppdrag som är dubbletter av ett annat (gruppstorlek − 1, summerat). */
  redundant: number;
  redundantCertain: number;
  redundantSuspected: number;
  groups: DuplicateGroup[];
  /** Antal par per säkerhetsintervall, för diagram. */
  buckets: { label: string; min: number; max: number; count: number }[];
  /**
   * Annonser per källa som har en dubblett i en annan källa: matrix[rad][kolumn] = antal annonser
   * från radens källa vars grupp även har en annons från kolumnens källa. Diagonalen = annonser
   * vars grupp har ytterligare en annons från samma källa. Inte symmetrisk.
   */
  overlap: { sources: string[]; matrix: number[][] };
}

// ---------- normalisering ----------

const STOP = new Set(
  "och i på till för med av en ett the a an of to for in at on and or som är vi du till hos inom mot konsult konsulter konsultuppdrag uppdrag consultant consultants task request assignment konsulentoppdrag konsulentopgave toimeksianto ny nytt".split(
    " ",
  ),
);

function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae");
}

/** Titeln utan datumstämplar, prefix som "Konsultuppdrag –" och skiljetecken. */
export function normalizeTitle(title: string): string {
  return fold(title)
    .replace(/\(?\b(20\d{2})[.\-/]\d{1,2}[.\-/]\d{1,2}\)?/g, " ")
    .replace(/\(?\b\d{1,2}[.\-/]\d{1,2}[.\-/](20\d{2})\)?/g, " ")
    .replace(/\(?\b\d{1,2} (jan|feb|mar|apr|maj|may|jun|jul|aug|sep|okt|oct|nov|dec)[a-z]* 20\d{2}\)?/g, " ")
    .replace(/^\s*(konsultuppdrag|consultant (task|request)|konsulentoppdrag|konsulentopgave|toimeksianto|uppdrag)\s*[-–|:]\s*/, "")
    .replace(/[^a-z0-9#+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleTokens(title: string): string[] {
  return [...new Set(normalizeTitle(title).split(" ").filter((t) => t.length > 1 && !STOP.has(t)))];
}

function dice<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return (2 * common) / (a.size + b.size);
}

function bigrams(s: string): Set<string> {
  const t = s.replace(/ /g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * Titellikhet 0–1: medel av ordlikhet och teckenlikhet. Teckenlikheten fångar stavfel och
 * sammansättningar ("Java-utvecklare"/"Javautvecklare"), ordlikheten hindrar att ett gemensamt
 * långt ord ("…till gasturbintillverkare") ensamt gör två olika roller lika.
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return (dice(new Set(titleTokens(a)), new Set(titleTokens(b))) + dice(bigrams(na), bigrams(nb))) / 2;
}

/** Fyrordsföljder i beskrivningen (null om texten är för kort för att jämföras). */
export function shingles(text: string | undefined): Set<string> | null {
  if (!text) return null;
  const words = fold(text)
    .replace(/[^a-z0-9#+]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .slice(0, 400);
  if (words.length < 25) return null;
  const out = new Set<string>();
  for (let i = 0; i + 4 <= words.length; i++) out.add(words.slice(i, i + 4).join(" "));
  return out;
}

const TEXT_STOP = new Set(
  ("att det som har vara kan ska eller inom den denna detta dessa fran the and you will with our are your vi du dig din ditt " +
    "oss var vara vart vill nu ocksa samt mycket god goda bra bade inte alla ett en och i pa till for med av om ar ha hos " +
    "this that for from have has who can all their they them its about as be by is it of on or to we an at in not more " +
    "ansokan ansok soka sok soker anstallningsform yrke erfarenhet arbete arbeta arbetar kund kunden kunder uppdrag uppdraget " +
    "roll rollen tjanst tjansten foretag foretaget team teamet work experience role").split(" "),
);

/** Innehållsord i beskrivningen med antal förekomster. */
export function contentWords(text: string | undefined): Map<string, number> | null {
  if (!text) return null;
  const words = fold(text)
    .replace(/[^a-z0-9#+]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 2 && !TEXT_STOP.has(w) && !/^\d+$/.test(w))
    .slice(0, 600);
  if (words.length < 15) return null;
  const tf = new Map<string, number>();
  for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
  return tf;
}

/**
 * Ämneslikhet 0–1 (cosinus med idf-vikter): fångar omskrivna annonser om samma uppdrag, där
 * ovanliga ord som "PLM", "Teamcenter" och "Finspång" återkommer fast meningarna skiljer sig.
 * Returnerar även de tyngsta gemensamma orden som förklaring.
 */
export function topicSimilarity(
  a: Map<string, number> | null,
  b: Map<string, number> | null,
  idf: (w: string) => number = () => 1,
): { sim: number; shared: string[] } | null {
  if (!a || !b) return null;
  const weight = (tf: number, w: string) => (1 + Math.log(tf)) * idf(w);
  let dot = 0;
  let na = 0;
  let nb = 0;
  const shared: [string, number][] = [];
  for (const [w, tf] of a) {
    const x = weight(tf, w);
    na += x * x;
    const tb = b.get(w);
    if (tb) {
      const y = weight(tb, w);
      dot += x * y;
      shared.push([w, x * y]);
    }
  }
  for (const [w, tf] of b) nb += weight(tf, w) ** 2;
  if (!na || !nb) return null;
  shared.sort((p, q) => q[1] - p[1]);
  return { sim: dot / Math.sqrt(na * nb), shared: shared.slice(0, 4).map(([w]) => w) };
}

/** Likhet 0–1 mellan två shingle-mängder (andel av den mindre mängden som återfinns i den större). */
export function textSimilarity(a: Set<string> | null, b: Set<string> | null): number | null {
  if (!a || !b) return null;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let common = 0;
  for (const x of small) if (large.has(x)) common++;
  return common / small.size;
}

function normUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

const PLACE_STOP = new Set([
  "eller", "och", "remote", "distans", "hybrid", "sverige", "sweden", "onsite", "plats", "med", "mojlighet",
  "lan", "kommun", "metropolitan", "area", "region", "omrade", "city", "centrala",
]);

// Kommuner i samma arbetsmarknadsregion: ett uppdrag i "Solna" och ett i "Stockholm" kan vara
// samma uppdrag (mäklare anger ort olika noga), så de räknas varken som samma eller olika ort.
const REGIONS: Record<string, string[]> = {
  stockholm: ["stockholm", "solna", "sundbyberg", "kista", "jarfalla", "nacka", "sollentuna", "lidingo", "danderyd", "taby", "huddinge", "bromma", "haninge", "botkyrka", "sodertalje", "upplands", "vasby", "akersberga", "tyreso", "varmdo", "arlanda", "sigtuna", "marsta"],
  goteborg: ["goteborg", "gothenburg", "molndal", "partille", "kungalv", "lerum", "harryda", "torslanda", "landvetter"],
  malmo: ["malmo", "lund", "burlov", "lomma", "staffanstorp", "svedala", "vellinge"],
};
const REGION_OF = new Map(Object.entries(REGIONS).flatMap(([r, ws]) => ws.map((w) => [w, r] as const)));

/** Ortsord: gemener utan diakritiska tecken, "Stockholms län" → "stockholm". */
function places(loc: string | undefined): Set<string> {
  if (!loc) return new Set();
  return new Set(
    fold(loc)
      .split(/[^a-z]+/)
      .map((w) => (w.length > 4 && w.endsWith("s") && REGION_OF.has(w.slice(0, -1)) ? w.slice(0, -1) : w))
      .filter((w) => w.length > 2 && !PLACE_STOP.has(w)),
  );
}

function regions(ps: Set<string>): Set<string> {
  return new Set([...ps].map((w) => REGION_OF.get(w)).filter((r): r is string => !!r));
}

const pct = (x: number) => `${Math.round(x * 100)} %`;
const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

// ---------- jämförelse av ett par ----------

interface Prepared {
  a: Assignment;
  norm: string;
  tokens: string[];
  tokenSet: Set<string>;
  grams: Set<string>;
  sh: Set<string> | null;
  words: Map<string, number> | null;
  url: string;
  places: Set<string>;
}

/** Statistik över hela listan: hur vanliga ord och orter är. */
interface Context {
  idf: (w: string) => number;
  /** Andel av annonserna med orten (0–1). */
  placeShare: (w: string) => number;
}

const NO_CONTEXT: Context = { idf: () => 1, placeShare: () => 1 };

function buildContext(prep: Prepared[]): Context {
  const df = new Map<string, number>();
  const pf = new Map<string, number>();
  for (const p of prep) {
    for (const w of p.words?.keys() ?? []) df.set(w, (df.get(w) ?? 0) + 1);
    for (const w of p.places) pf.set(w, (pf.get(w) ?? 0) + 1);
  }
  const n = Math.max(1, prep.length);
  return {
    idf: (w) => Math.log((n + 1) / ((df.get(w) ?? 0) + 1)) + 1,
    placeShare: (w) => (pf.get(w) ?? 0) / n,
  };
}

function prepare(a: Assignment): Prepared {
  const norm = normalizeTitle(a.title);
  const tokens = titleTokens(a.title);
  return {
    a,
    norm,
    tokens,
    tokenSet: new Set(tokens),
    grams: bigrams(norm),
    sh: shingles(a.description),
    words: contentWords(a.description),
    url: normUrl(a.url),
    places: places(a.location),
  };
}

/** Samma som titleSimilarity men med förberäknade delar. */
function preparedTitleSimilarity(p: Prepared, q: Prepared): number {
  if (!p.norm || !q.norm) return 0;
  if (p.norm === q.norm) return 1;
  return (dice(p.tokenSet, q.tokenSet) + dice(p.grams, q.grams)) / 2;
}

/** Bedömer om två uppdrag är samma uppdrag. Returnerar null under MIN_CONFIDENCE. */
export function comparePair(x: Assignment, y: Assignment): DuplicatePair | null {
  return compareInner(prepare(x), prepare(y), NO_CONTEXT);
}

function compareInner(p: Prepared, q: Prepared, ctx: Context, keepAll = false): DuplicatePair | null {
  const x = p.a;
  const y = q.a;
  const reasons: string[] = [];
  const against: string[] = [];
  const pair = (confidence: number, certain: boolean): DuplicatePair => ({ a: x.id, b: y.id, confidence, certain, reasons, against });

  if (p.url === q.url) {
    reasons.push("Samma annonslänk");
    return pair(100, true);
  }

  const tSim = preparedTitleSimilarity(p, q);
  // Så olika titlar är olika uppdrag; hoppa över den dyrare textjämförelsen.
  if (tSim < 0.3 && !keepAll) return null;
  const dSim = textSimilarity(p.sh, q.sh);
  const topic = topicSimilarity(p.words, q.words, ctx.idf);
  // Texten räknas som lik om den är kopierad (dSim) eller handlar om samma sak med samma
  // ovanliga ord fast omskriven (topic, något nedviktad).
  const text = dSim === null && !topic ? null : Math.max(dSim ?? 0, (topic?.sim ?? 0) * 0.85);
  if (tSim >= 0.95) reasons.push("Samma titel");
  else if (tSim >= 0.5) reasons.push(`Titeln ${pct(tSim)} lik`);
  else against.push(`Titeln bara ${pct(tSim)} lik`);
  if (text !== null) {
    if (dSim !== null && dSim >= 0.5) reasons.push(`Beskrivningen ${pct(dSim)} lik${dSim >= 0.85 ? " (samma text)" : ""}`);
    else if (text >= 0.3) reasons.push(`Beskrivningarna handlar om samma sak (${pct(text)}${topic?.shared.length ? `: ${topic.shared.join(", ")}` : ""})`);
    else against.push(`Beskrivningarna olika (${pct(text)} lika)`);
  }

  if ((tSim >= 0.95 && dSim !== null && dSim >= 0.85) || (dSim !== null && dSim >= 0.92 && tSim >= 0.6)) {
    addContext(p, q, ctx, reasons, against);
    return pair(100, true);
  }

  // Titel 0–55 p, beskrivning 0–35 p (saknas den räknas titeln för båda).
  // Korta, allmänna titlar ("Business Analyst") säger lite om vilket uppdrag det är och väger
  // mindre än längre titlar.
  const generic = Math.min(p.tokens.length, q.tokens.length) <= 2;
  let score = text === null ? tSim * (generic ? 65 : 90) : tSim * (generic ? 45 : 55) + text * 35;
  // Texter som handlar om helt olika saker talar emot.
  if (text !== null && text < 0.2) score -= 15;
  score += addContext(p, q, ctx, reasons, against);
  // En källa publicerar sällan samma uppdrag två gånger, men Platsbanken m.fl. samlar annonser
  // från många företag: bara samma källa OCH samma företag talar emot.
  if (x.source === y.source && (x.company ?? "") === (y.company ?? "")) {
    score -= 5;
    against.push("Samma källa");
  }
  const confidence = Math.max(0, Math.min(99, Math.round(score)));
  return confidence >= MIN_CONFIDENCE || keepAll ? pair(confidence, false) : null;
}

/** Ort och datum: lägger till skäl och returnerar poäng. */
function addContext(p: Prepared, q: Prepared, ctx: Context, reasons: string[], against: string[]): number {
  const x = p.a;
  const y = q.a;
  let score = 0;
  if (p.places.size && q.places.size) {
    const common = [...p.places].filter((w) => q.places.has(w));
    const sameRegion = [...regions(p.places)].some((r) => regions(q.places).has(r));
    if (common.length) {
      // Samma mindre ort (t.ex. Finspång) säger mer än samma storstad.
      const rare = common.some((w) => ctx.placeShare(w) < 0.03);
      score += rare ? 20 : 8;
      reasons.push(`Samma ort (${x.location}${rare ? ", ovanlig ort" : ""})`);
    } else if (sameRegion) {
      reasons.push(`Samma region (${x.location} / ${y.location})`);
    } else {
      score -= 20;
      against.push(`Olika orter (${x.location} / ${y.location})`);
    }
  }
  if (x.start && y.start) {
    if (x.start === y.start) {
      score += 5;
      reasons.push(`Samma startdatum (${x.start})`);
    } else if (daysApart(x.start, y.start) > 14) {
      score -= 10;
      against.push(`Olika startdatum (${x.start} / ${y.start})`);
    }
  }
  if (x.deadline && y.deadline && x.deadline === y.deadline) {
    score += 4;
    reasons.push(`Samma sista ansökningsdag (${x.deadline})`);
  }
  return score;
}

// ---------- hela listan ----------

/** Par som är värda att jämföra: delar annonslänk eller minst två ovanliga titelord. */
function candidatePairs(prep: Prepared[]): [number, number][] {
  const byToken = new Map<string, number[]>();
  const byUrl = new Map<string, number[]>();
  prep.forEach((p, i) => {
    for (const t of p.tokens) (byToken.get(t) ?? byToken.set(t, []).get(t)!).push(i);
    (byUrl.get(p.url) ?? byUrl.set(p.url, []).get(p.url)!).push(i);
  });
  // Bara extremt vanliga ord hoppas över (de ger för många kandidater). Vanliga ord som
  // "business" och "analyst" måste vara med, annars jämförs aldrig "Business Analyst"-annonser.
  const maxPosting = Math.max(400, Math.round(prep.length * 0.3));
  const n = prep.length;
  const shared = new Map<number, number>();
  for (const ids of byToken.values()) {
    if (ids.length < 2 || ids.length > maxPosting) continue;
    for (let m = 0; m < ids.length; m++) {
      for (let k = m + 1; k < ids.length; k++) {
        const key = ids[m] * n + ids[k];
        shared.set(key, (shared.get(key) ?? 0) + 1);
      }
    }
  }
  const out = new Set<number>();
  for (const [key, count] of shared) {
    const i = Math.floor(key / n);
    const j = key % n;
    const fewTokens = Math.min(prep[i].tokens.length, prep[j].tokens.length) <= 2;
    if (count >= 2 || (fewTokens && count >= 1)) out.add(key);
  }
  for (const ids of byUrl.values()) for (let m = 0; m < ids.length; m++) for (let k = m + 1; k < ids.length; k++) out.add(ids[m] * n + ids[k]);
  return [...out].map((key) => [Math.floor(key / n), key % n] as [number, number]);
}

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) i = this.parent[i] = this.parent[this.parent[i]];
    return i;
  }
  union(i: number, j: number) {
    this.parent[this.find(i)] = this.find(j);
  }
}

const BUCKETS = [
  { label: "50–59 %", min: 50, max: 59 },
  { label: "60–69 %", min: 60, max: 69 },
  { label: "70–79 %", min: 70, max: 79 },
  { label: "80–89 %", min: 80, max: 89 },
  { label: "90–99 %", min: 90, max: 99 },
  { label: "Säker", min: 100, max: 100 },
];

/**
 * Analyserar `assignments` (t.ex. listan filtrerad på nyckelord). Hur vanliga ord och orter är
 * räknas på `corpus`, normalt hela uppdragslistan: i en lista filtrerad på "PLM" är både "PLM"
 * och orten Finspång vanliga, fast de är ovanliga och därför talande bland alla uppdrag.
 */
export function analyzeDuplicates(assignments: Assignment[], corpus: Assignment[] = assignments): DuplicateReport {
  const prep = assignments.map(prepare);
  const ctx = buildContext(corpus === assignments ? prep : corpus.map(prepare));
  const pairs: { i: number; j: number; p: DuplicatePair }[] = [];
  for (const [i, j] of candidatePairs(prep)) {
    const p = compareInner(prep[i], prep[j], ctx);
    if (p) pairs.push({ i, j, p });
  }

  const all = new UnionFind(prep.length);
  const sure = new UnionFind(prep.length);
  for (const { i, j, p } of pairs) {
    all.union(i, j);
    if (p.certain) sure.union(i, j);
  }
  const members = new Map<number, number[]>();
  prep.forEach((_, i) => (members.get(all.find(i)) ?? members.set(all.find(i), []).get(all.find(i))!).push(i));

  const groups: DuplicateGroup[] = [];
  let redundant = 0;
  let redundantCertain = 0;
  for (const ids of members.values()) {
    if (ids.length < 2) continue;
    redundant += ids.length - 1;
    const sureRoots = new Set(ids.map((i) => sure.find(i)));
    redundantCertain += ids.length - sureRoots.size;
    const inGroup = new Set(ids);
    const gp = pairs.filter(({ i }) => inGroup.has(i)).map(({ p }) => p);
    // Svagaste nödvändiga länk: lägsta av varje uppdrags bästa par.
    const best = ids.map((i) => Math.max(...gp.filter((p) => p.a === prep[i].a.id || p.b === prep[i].a.id).map((p) => p.confidence)));
    groups.push({
      items: ids.map((i) => {
        const { id, source, title, url, company, location, published, start, deadline } = prep[i].a;
        return { id, source, title, url, company, location, published, start, deadline };
      }),
      pairs: gp.sort((a, b) => b.confidence - a.confidence),
      certain: sureRoots.size === 1,
      confidence: Math.min(...best),
    });
  }
  groups.sort((a, b) => Number(b.certain) - Number(a.certain) || b.confidence - a.confidence || b.items.length - a.items.length);

  const sources = [...new Set(assignments.map((a) => a.source))].sort((a, b) => a.localeCompare(b, "sv"));
  const idx = new Map(sources.map((s, i) => [s, i]));
  const matrix = sources.map(() => sources.map(() => 0));
  for (const g of groups) {
    const count = new Map<number, number>();
    for (const it of g.items) count.set(idx.get(it.source)!, (count.get(idx.get(it.source)!) ?? 0) + 1);
    for (const [a, n] of count)
      for (const [b, m] of count) {
        if (a !== b) matrix[a][b] += n;
        else if (m > 1) matrix[a][a] += n;
      }
  }

  return {
    total: assignments.length,
    unique: assignments.length - redundant,
    redundant,
    redundantCertain,
    redundantSuspected: redundant - redundantCertain,
    groups,
    buckets: BUCKETS.map((b) => ({ ...b, count: pairs.filter(({ p }) => p.confidence >= b.min && p.confidence <= b.max).length })),
    overlap: { sources, matrix },
  };
}

/**
 * Felsökning: alla uppdrag vars titel innehåller `query` och bedömningen av varje par mellan
 * dem, även under MIN_CONFIDENCE, samt om paret alls valdes ut för jämförelse.
 */
export function explainDuplicates(assignments: Assignment[], query: string, corpus: Assignment[] = assignments) {
  const prep = assignments.map(prepare);
  const ctx = buildContext(corpus === assignments ? prep : corpus.map(prepare));
  const q = fold(query).trim();
  const hit = prep.map((p, i) => ({ p, i })).filter(({ p }) => fold(`${p.a.title} ${p.a.location ?? ""}`).includes(q)).slice(0, 40);
  const n = prep.length;
  const candidates = new Set(candidatePairs(prep).map(([i, j]) => i * n + j));
  const pairs = [];
  for (let m = 0; m < hit.length; m++) {
    for (let k = m + 1; k < hit.length; k++) {
      const [i, j] = [hit[m].i, hit[k].i].sort((a, b) => a - b);
      const r = compareInner(prep[i], prep[j], ctx, true)!;
      pairs.push({ a: prep[i].a.id, b: prep[j].a.id, candidate: candidates.has(i * n + j), confidence: r.confidence, certain: r.certain, reasons: r.reasons, against: r.against });
    }
  }
  return {
    query,
    items: hit.map(({ p }) => ({
      id: p.a.id,
      source: p.a.source,
      title: p.a.title,
      normalized: p.norm,
      tokens: p.tokens,
      location: p.a.location,
      start: p.a.start,
      deadline: p.a.deadline,
      descriptionWords: p.a.description?.split(/\s+/).length ?? 0,
      comparableText: !!p.sh,
    })),
    pairs: pairs.sort((x, y) => y.confidence - x.confidence),
  };
}
