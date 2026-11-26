import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText } from "../http.ts";
import { clean, stripEmpty } from "../parse-utils.ts";
import { isoDate, type Obj } from "./job-json.ts";

// TED (Tenders Electronic Daily) – EU:s officiella databas för offentliga upphandlingar.
// Sök-API:t https://api.ted.europa.eu/v3/notices/search är öppet och gratis (ingen nyckel krävs
// för sökning) och dokumenterat på https://docs.ted.europa.eu/api/. Här hämtas aktiva
// upphandlingar med svensk köpare och CPV-koder för IT- och konsulttjänster. Det är anbud
// (ofta ramavtal) som ett konsultbolag lämnar, inte uppdrag för en enskild konsult, så de
// märks "Offentlig upphandling". Upphandlingar under EU:s tröskelvärden publiceras inte i TED.
// Frågan kan överstyras med TED_QUERY (TED:s expertsyntax) och fälten med TED_FIELDS.
export const TED_API = "https://api.ted.europa.eu/v3/notices/search";
export const TED_NOTICE = (id: string) => `https://ted.europa.eu/sv/notice/-/detail/${encodeURIComponent(id)}`;
const MAX_PAGES = Number(process.env.TED_MAX_PAGES ?? 5);
const PAGE_SIZE = 100;

/** CPV-koder: IT-tjänster (72…) och företags-/ledningskonsulttjänster (794…). */
export const TED_CPV = [
  "72000000", "72100000", "72200000", "72210000", "72220000", "72221000", "72222000", "72222300", "72224000",
  "72224100", "72225000", "72226000", "72227000", "72228000", "72230000", "72240000", "72250000", "72260000",
  "72261000", "72262000", "72263000", "72265000", "72266000", "72267000", "72268000", "72300000", "72310000",
  "72320000", "72400000", "72500000", "72510000", "72590000", "72600000", "72610000", "72700000", "72800000",
  "72810000", "72820000", "72900000", "79400000", "79410000", "79411000", "79411100", "79412000", "79413000",
  "79415000", "79417000", "79418000", "79419000", "79420000", "79421000", "79421100",
];

export const TED_QUERY =
  process.env.TED_QUERY ??
  `buyer-country IN (SWE) AND classification-cpv IN (${TED_CPV.join(" ")}) AND notice-type IN (cn-standard cn-social cn-desg)`;

/** Fälten som begärs. Okända fältnamn ger fel från API:t, så det finns en kortare reservlista. */
export const TED_FIELDS = (process.env.TED_FIELDS?.split(",").map((f) => f.trim()).filter(Boolean)) ?? [
  "publication-number",
  "notice-title",
  "buyer-name",
  "buyer-city",
  "publication-date",
  "deadline-receipt-tender-date-lot",
  "classification-cpv",
  "notice-type",
  "description-proc",
  "description-lot",
  "place-of-performance-city-lot",
  "links",
];
const MIN_FIELDS = ["publication-number", "notice-title", "buyer-name", "publication-date", "deadline-receipt-tender-date-lot", "links"];

const LANGS = ["swe", "sv", "sve", "SWE", "SV", "eng", "en", "ENG", "EN"];

/** Ett TED-värde som text: språkobjekt ({swe, eng, …}) väljer svenska, sedan engelska; listor slås ihop. */
export function tedText(v: unknown, join = ", "): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return clean(v) || undefined;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    const parts = [...new Set(v.map((x) => tedText(x, join)).filter((x): x is string => !!x))];
    return parts.join(join) || undefined;
  }
  if (typeof v === "object") {
    const o = v as Obj;
    for (const l of LANGS) if (o[l] !== undefined) return tedText(o[l], join);
    const first = Object.values(o)[0];
    return tedText(first, join);
  }
  return undefined;
}

/** Alla datum i ett värde (sträng, lista eller språkobjekt), som ÅÅÅÅ-MM-DD. */
function dates(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(dates);
  if (v && typeof v === "object") return Object.values(v as Obj).flatMap(dates);
  const d = isoDate(v);
  return d ? [d] : [];
}

/** Länken till annonsen på ted.europa.eu (svenska i första hand). */
function noticeUrl(links: unknown, id: string): string {
  const html = links && typeof links === "object" ? (links as Obj).html : undefined;
  if (html && typeof html === "object") {
    const h = html as Obj;
    for (const l of ["SWE", "swe", "SV", "ENG", "eng", "EN"]) if (typeof h[l] === "string") return h[l] as string;
  }
  return TED_NOTICE(id);
}

/** En annons från sök-API:t → Assignment. */
export function parseTedNotice(n: Obj, today = new Date().toISOString().slice(0, 10)): Assignment | null {
  const id = tedText(n["publication-number"]);
  const title = tedText(n["notice-title"], " ");
  if (!id || !title) return null;
  // Rubriken är ofta "Sverige – IT-tjänster – <titel>": ta bort land och kategori.
  const shortTitle = title.replace(/^(Sverige|Sweden)\s+[–—-]\s+.+?\s+[–—-]\s+/i, "").trim() || title;
  const deadlines = dates(n["deadline-receipt-tender-date-lot"]).sort();
  const deadline = deadlines.find((d) => d >= today) ?? deadlines[deadlines.length - 1];
  const cpv = tedText(n["classification-cpv"]);
  const desc = [tedText(n["description-proc"], "\n"), tedText(n["description-lot"], "\n")]
    .filter((x): x is string => !!x)
    .filter((x, i, a) => a.indexOf(x) === i)
    .join("\n");
  const buyer = tedText(n["buyer-name"]);
  return stripEmpty({
    id: `ted:${id}`,
    source: "TED",
    title: shortTitle,
    url: noticeUrl(n.links, id),
    company: buyer,
    location: tedText(n["place-of-performance-city-lot"]) ?? tedText(n["buyer-city"]),
    country: "Sverige",
    published: dates(n["publication-date"])[0],
    deadline,
    extent: "Offentlig upphandling",
    description:
      [desc.slice(0, 2400), buyer && `Upphandlande organisation: ${buyer}.`, cpv && `CPV: ${cpv}.`, "Sista dag avser anbud."]
        .filter(Boolean)
        .join("\n") || undefined,
  }) as Assignment;
}

/** Annonserna i ett svar från sök-API:t. */
export function parseTedJson(json: unknown): Assignment[] {
  const notices = json && typeof json === "object" ? (json as Obj).notices : undefined;
  if (!Array.isArray(notices)) return [];
  return notices.map((n) => (n && typeof n === "object" ? parseTedNotice(n as Obj) : null)).filter((a): a is Assignment => !!a);
}

/** En sida ur sök-API:t. */
export async function tedSearch(page: number, { query = TED_QUERY, fields = TED_FIELDS } = {}) {
  const res = await fetchText(TED_API, {
    method: "POST",
    timeoutMs: 15000,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, fields, page, limit: PAGE_SIZE, scope: "ACTIVE", paginationMode: "PAGE_NUMBER" }),
  });
  let json: unknown = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* inte JSON */
  }
  return { status: res.status, json, body: res.body };
}

export const ted: SourceAdapter = {
  name: "TED",
  homepage: "https://ted.europa.eu/sv/",

  async fetchAssignments() {
    const strategies: string[] = [];
    let fields = TED_FIELDS;
    let first = await tedSearch(1, { fields });
    if (first.status === 400 && !process.env.TED_FIELDS) {
      // Något fältnamn kan ha bytt namn: försök med de säkraste fälten.
      strategies.push(`fältlistan avvisades (${first.body.slice(0, 200)}), provar kortare`);
      fields = MIN_FIELDS;
      first = await tedSearch(1, { fields });
    }
    if (first.status >= 400 || !first.json) throw new Error(`TED:s sök-API svarade ${first.status}: ${first.body.slice(0, 300)}`);
    const total = Number((first.json as Obj).totalNoticeCount ?? 0);
    let all = parseTedJson(first.json);
    const pages = Math.min(MAX_PAGES, Math.ceil(total / PAGE_SIZE));
    for (let p = 2; p <= pages; p++) {
      const r = await tedSearch(p, { fields });
      if (r.status >= 400) {
        strategies.push(`sida ${p} svarade ${r.status}`);
        break;
      }
      all.push(...parseTedJson(r.json));
    }
    strategies.push(`sök-API: ${total} aktiva upphandlingar, ${all.length} hämtade`);
    const unique = new Map(all.map((a) => [a.id, a]));
    all = [...unique.values()];
    const today = new Date().toISOString().slice(0, 10);
    const expired = all.filter((a) => a.deadline && a.deadline < today).length;
    if (expired) strategies.push(`utgångna bortfiltrerade: ${expired}`);
    return { assignments: all.filter((a) => !(a.deadline && a.deadline < today)), strategies };
  },
};
