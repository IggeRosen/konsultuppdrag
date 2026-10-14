import * as cheerio from "cheerio";
type Cheerio = ReturnType<cheerio.CheerioAPI>;
import type { Assignment } from "../types.ts";
import { parseSummary } from "./brainville-summary.ts";
import { cardFields, clean, DATE_RE, extractJsonAssignments, findCards, findNextPage, spacedText, stripEmpty } from "../parse-utils.ts";

export const BRAINVILLE_BASE = "https://www.brainville.com";

// Kända URL-mönster för enskilda uppdrag på Brainville:
//   /sv/Requisition?id=367981&text=testledare             (söksidan, sedan oktober 2026)
//   /sv/PublicProfile/Requisition/343645?companyId=4686   (sedan oktober 2026)
//   /Market/RequisitionSearchResult/Details/330877
//   /PublicProfile/Requisition?companyId=648&id=330877&returnUrl=...
// "Requisition?" (inte "Requisitions?" eller "RequisitionSearch?") skiljer uppdrag från listor.
const PATH_REQ_RE = /\/PublicProfile\/Requisition\/(\d+)/i;
const DETAILS_RE = /\/RequisitionSearchResult\/Details\/(\d+)/i;
const PUBLIC_REQ_RE = /\/Requisition\?(?:[^"'#]*&)?id=(\d+)/i;

export function extractRequisitionId(href: string): string | null {
  const m = href.match(PATH_REQ_RE) ?? href.match(DETAILS_RE) ?? href.match(PUBLIC_REQ_RE);
  return m ? m[1] : null;
}

/** Uppdragets publika sida; länken från listan används om den finns (den bär companyId). */
export function canonicalUrl(id: string, href?: string): string {
  if (href) {
    try {
      const u = new URL(href, BRAINVILLE_BASE);
      if (u.hostname.endsWith("brainville.com")) {
        const path = u.pathname + u.search;
        if (PATH_REQ_RE.test(path) || PUBLIC_REQ_RE.test(path)) return u.toString();
      }
    } catch {
      /* ignorera */
    }
  }
  return `${BRAINVILLE_BASE}/sv/Requisition?id=${id}`;
}

/** Brainvilles egen länk, utan sökordet (?text=…) som söksidan lägger till. */
function cleanHref(href: string, pageUrl: string): string {
  const u = new URL(href, pageUrl);
  u.searchParams.delete("text");
  u.searchParams.delete("Text");
  return u.toString();
}

/**
 * Söksidans JSON-LD (sedan oktober 2026):
 *   { "@type": "ItemList", "itemListElement": [{ "@type": "ListItem", "url": ".../sv/Requisition?id=367981", "name": "Testledare" }] }
 */
function parseItemList($: cheerio.CheerioAPI): Assignment[] {
  const out: Assignment[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let json: unknown;
    try {
      json = JSON.parse($(el).html() ?? "");
    } catch {
      return;
    }
    for (const list of Array.isArray(json) ? json : [json]) {
      const items = (list as { "@type"?: string; itemListElement?: unknown })?.itemListElement;
      if ((list as { "@type"?: string })?.["@type"] !== "ItemList" || !Array.isArray(items)) continue;
      for (const it of items as { url?: unknown; name?: unknown; item?: { url?: unknown; name?: unknown } }[]) {
        const url = typeof it?.url === "string" ? it.url : typeof it?.item?.url === "string" ? it.item.url : undefined;
        const name = clean(typeof it?.name === "string" ? it.name : typeof it?.item?.name === "string" ? it.item.name : "");
        const id = url ? extractRequisitionId(url) : null;
        if (!id || !url) continue;
        out.push(stripEmpty({ id: `brainville:${id}`, source: "Brainville", title: name || `Uppdrag ${id}`, url: canonicalUrl(id, cleanHref(url, BRAINVILLE_BASE)) }) as Assignment);
      }
    }
  });
  return out;
}

/** Tolkar sidtiteln "DevOps | Hire Quality AB - Assignment | Brainville - ..." */
export function parseDocumentTitle(title: string): { title?: string; company?: string } {
  const parts = title.split("|").map((p) => p.trim());
  if (parts.length < 3) return {};
  const [t, companyPart] = parts;
  const company = companyPart.replace(/\s*-\s*(Assignment|Uppdrag)\s*$/i, "").trim();
  return { title: t || undefined, company: company || undefined };
}

const MONTHS_SV = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

/** "idag 15:57" / "igår 16:23" / "12 okt" → ÅÅÅÅ-MM-DD (svensk tid). */
export function brainvilleAgeDate(text: string, now = new Date()): string | undefined {
  const day = (offset: number) =>
    new Date(now.getTime() - offset * 86400_000).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
  const t = text.trim().toLowerCase();
  if (/^idag\b|^today\b/.test(t)) return day(0);
  if (/^igår\b|^yesterday\b/.test(t)) return day(1);
  if (/^i förrgår\b/.test(t)) return day(2);
  const iso = t.match(/20\d{2}-\d{2}-\d{2}/)?.[0];
  if (iso) return iso;
  const m = t.match(/^(\d{1,2})\s+([a-zåäö]{3})/);
  const mon = m ? MONTHS_SV.indexOf(m[2]) : -1;
  if (!m || mon < 0) return undefined;
  const year = Number(day(0).slice(0, 4));
  const d = `${year}-${String(mon + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return d > day(0) ? `${year - 1}${d.slice(4)}` : d;
}

const WORK_MODE_RE = /^(hybrid|distans|remote|på plats|on-?site)$/i;

/** "Start om om 1 månad" → "Om 1 månad", "Start direkt" → "Omgående", "Längd ca. 12 months" → "ca 12 månader". */
function brainvilleChip(text: string): { startText?: string; duration?: string } {
  const t = clean(text);
  const en: Record<string, string> = { months: "månader", month: "månad", weeks: "veckor", week: "vecka", days: "dagar", day: "dag", years: "år", year: "år" };
  const sv = (s: string) => s.replace(/\b(months?|weeks?|days?|years?)\b/gi, (w) => en[w.toLowerCase()] ?? w);
  if (/^start\s+(direkt|omgående|nu|immediately)/i.test(t)) return { startText: "Omgående" };
  const start = t.match(/^start\s+(?:(?:om|in)\s+)+(.+)$/i);
  if (start) return { startText: `Om ${sv(start[1])}` };
  const date = t.match(/^start\s+(.+)$/i);
  if (date) return { startText: sv(date[1]) };
  const dur = t.match(/^(?:längd|length)\s+(.+)$/i);
  if (dur) return { duration: sv(dur[1]).replace(/^ca\.\s*/i, "ca ") };
  return {};
}

/**
 * Söksidans kort (sedan oktober 2026):
 *   <span>idag <span>15:57</span></span> … <h3><a href="/sv/Requisition?id=…">Titel</a></h3>
 *   <div data-flex><div title="Visby, Gotlands län, Sweden"><span>Visby</span></div><div>Hybrid</div></div>
 *   <span class="c_chip …" title="<div><b>Startdatum</b><div>Nu</div>">Start direkt</span>
 *   <time datetime="2026-10-26">1 vecka kvar</time>   … kompetenstaggar
 * Ger null om kortet inte har den uppbyggnaden.
 */
export function parseBrainvilleCard($: cheerio.CheerioAPI, card: Cheerio, now = new Date()): Partial<Assignment> | null {
  const h3 = card.find("h3").first();
  if (!h3.length || !card.find("time[datetime], .c_chip").length) return null;
  const meta = h3.next();
  const metaDivs = meta.children().toArray().map((el) => $(el));
  const locEl = metaDivs.find((d) => (d.attr("title") ?? "").includes(","));
  const location = clean((locEl ?? metaDivs[0])?.text() ?? "") || undefined;
  const country = locEl?.attr("title")?.split(",").pop()?.trim() || undefined;
  const workMode = metaDivs.map((d) => clean(d.text())).find((t) => WORK_MODE_RE.test(t));

  const header = clean(card.find("h3").first().parent().find("span").first().text());
  const chips: { startText?: string; duration?: string } = {};
  card.find(".c_chip").each((_, el) => {
    Object.assign(chips, { ...brainvilleChip($(el).text()), ...chips });
  });
  const deadline = card.find("time[datetime]").first().attr("datetime")?.match(/20\d{2}-\d{2}-\d{2}/)?.[0];

  // Kompetenstaggar: korta texter i kortet som inte är något av ovanstående.
  const known = new Set([clean(h3.text()), location, workMode, header].filter(Boolean) as string[]);
  const tags = new Set<string>();
  card.find("*").each((_, el) => {
    const node = $(el);
    if (node.children().length || node.closest("h3, time, .c_chip").length) return;
    const t = clean(node.text());
    if (!t || t.length > 40 || known.has(t) || metaDivs.some((d) => d.find(node).length)) return;
    if (/^(idag|igår|i förrgår)\b|^\d{1,2}:\d{2}$|^\d+\s*(v|d|må|h|t|min|vecka|veckor|dag|dagar|månad|månader)$|kvar$|^(start|längd)\b/i.test(t)) return;
    if (/^\d+$/.test(t)) return;
    tags.add(t);
  });

  return stripEmpty({
    location: location ? location.replace(/\s+/g, ", ") : undefined,
    country,
    workMode: workMode ? (/^(remote|distans)$/i.test(workMode) ? "Distans" : /^hybrid$/i.test(workMode) ? "Hybrid" : "På plats") : undefined,
    published: brainvilleAgeDate(header, now),
    deadline,
    startText: chips.startText,
    duration: chips.duration,
    description: tags.size ? `Kompetenser: ${[...tags].join(", ")}` : undefined,
  });
}

/**
 * Hittar alla uppdragslänkar i en listsida (sökresultat eller ett företags
 * "Open assignments"-sida) och plockar ut titel, företag, ort och datum från
 * det omgivande HTML-elementet ("kortet").
 */
export function parseListing(html: string, pageUrl = BRAINVILLE_BASE): Assignment[] {
  const $ = cheerio.load(html);
  const byId = new Map<string, Assignment>();

  const pageCompany = parseListingCompany($);

  for (const { id, href, card, anchor } of findCards($, extractRequisitionId)) {
    const key = `brainville:${id}`;
    const v2 = parseBrainvilleCard($, card);
    if (v2) {
      const title = clean(card.find("h3").first().text()) || clean(anchor.text());
      const candidate = stripEmpty({ id: key, source: "Brainville", title: title || `Uppdrag ${id}`, url: canonicalUrl(id, cleanHref(href, pageUrl)), company: pageCompany, ...v2 }) as Assignment;
      const existing = byId.get(key);
      byId.set(key, existing ? ({ ...candidate, ...existing } as Assignment) : candidate);
      continue;
    }
    const f = cardFields($, card, anchor);
    const { title, cardText, dates } = f;
    const company = f.company || pageCompany;
    const location = f.location;

    const rest = (title && cardText.startsWith(title) ? cardText.slice(title.length).trim() : cardText).slice(0, 600);
    const summary = parseSummary(rest);

    const existing = byId.get(key);
    const candidate: Assignment = {
      id: key,
      source: "Brainville",
      title: title || `Uppdrag ${id}`,
      url: canonicalUrl(id, cleanHref(href, pageUrl)),
      company: company || undefined,
      location: location || summary?.location || undefined,
      published: dates[0] ?? summary?.published,
      deadline: dates.length > 1 ? dates[dates.length - 1] : undefined,
      startText: summary?.startText,
      duration: summary?.duration,
      extent: summary?.extent,
      // Är texten bara sammanfattningsraden har vi redan brutit ut allt ur den.
      description: summary ? undefined : rest || undefined,
    };
    // Länkas samma uppdrag flera gånger fyller senare träffar bara i saknade fält.
    if (!existing) byId.set(key, stripEmpty(candidate) as Assignment);
    else byId.set(key, { ...stripEmpty(candidate), ...stripEmpty(existing) } as Assignment);
  }

  // Söksidans JSON-LD-lista fyller i titlar och uppdrag som korten saknar.
  for (const item of parseItemList($)) {
    const cur = byId.get(item.id);
    if (!cur) byId.set(item.id, item);
    else if (cur.title.startsWith("Uppdrag ") && !item.title.startsWith("Uppdrag ")) byId.set(item.id, { ...cur, title: item.title });
  }

  for (const item of extractJsonAssignments($, { source: "Brainville", prefix: "brainville", urlFor: (id) => canonicalUrl(id) })) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }

  return [...byId.values()];
}

function parseListingCompany($: cheerio.CheerioAPI): string | undefined {
  // "Open assignments | KeyMan AB | Brainville - ..."
  const parts = clean($("title").text()).split("|").map((p) => p.trim());
  if (parts.length >= 3 && /open assignments|öppna uppdrag/i.test(parts[0])) return parts[1] || undefined;
  return undefined;
}

/** Tolkar en detaljsida för ett uppdrag och returnerar berikande fält. */
export function parseDetail(html: string): Partial<Assignment> {
  const $ = cheerio.load(html);
  const fromTitle = parseDocumentTitle(clean($("title").text()));
  const crumb = breadcrumbTitle($);
  const ogDesc = clean($('meta[property="og:description"]').attr("content") ?? $('meta[name="description"]').attr("content"));

  // Sajtens ram (sedan oktober 2026: out_topmenu, out_footer m.fl.) är inte uppdragstext.
  $("script, style, nav, header, footer, noscript, [class^='out_'], [class*=' out_'], .cc-window, #LanguageSelectionForm").remove();
  // Välj det textrikaste blocket i huvudinnehållet som beskrivning.
  let best = "";
  $("main, article, [class*=description], [class*=Description], [class*=requisition], [class*=Requisition], .content, #content, div")
    .slice(0, 400)
    .each((_, el) => {
      const text = spacedText($, el);
      if (text.length > best.length && text.length < 8000) best = text;
    });
  const description = (best.length > ogDesc.length ? best : ogDesc).slice(0, 2500);
  const h1 = clean($("h1").first().text());
  const dates = [...description.matchAll(DATE_RE)].map((m) => m[1]);

  return stripEmpty({
    title: crumb || fromTitle.title || h1 || undefined,
    company: fromTitle.company,
    description: description || undefined,
    start: dates[0],
  });
}

/** Sista ledet i JSON-LD BreadcrumbList, t.ex. { item: { name: "Testledare" } } (uppdragssidan sedan oktober 2026). */
function breadcrumbTitle($: cheerio.CheerioAPI): string | undefined {
  let name: string | undefined;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() ?? "") as { "@type"?: string; itemListElement?: { position?: number; name?: string; item?: { name?: string } }[] };
      if (json["@type"] !== "BreadcrumbList" || !Array.isArray(json.itemListElement)) return;
      const last = [...json.itemListElement].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).pop();
      const n = clean(last?.item?.name ?? last?.name ?? "");
      if (n && !/^konsultuppdrag$/i.test(n)) name = n;
    } catch {
      /* inte JSON */
    }
  });
  return name;
}

export function findNextPageUrl(html: string, pageUrl: string): string | null {
  return findNextPage(html, pageUrl, "brainville.com");
}
