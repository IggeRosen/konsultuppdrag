import * as cheerio from "cheerio";
import type { Assignment } from "../types.ts";
import { cardFields, clean, DATE_RE, extractJobPosting, findCards, spacedText, stripEmpty } from "../parse-utils.ts";
import { parseCinodeDate, swedishPlace } from "./cinode-parse.ts";

// KeyMan (konsultmäklare) publicerar uppdrag på keyman.se:
//   https://www.keyman.se/sv/uppdrag/                                            (lista)
//   https://www.keyman.se/sv/data-it/servicedeskagent-till-region-sormland-16277 (uppdrag)
// Adressen är /<språk>/<kategori>/<titel>-<id>.
export const KEYMAN_BASE = "https://www.keyman.se";

const JOB_RE = /^(?:https?:\/\/(?:www\.)?keyman\.se)?\/(?:sv|en)\/([a-z0-9-]+)\/[a-z0-9-]+-(\d{3,7})\/?(?:[?#].*)?$/i;

// Sidor under /sv/ som inte är uppdrag även om de skulle sluta med siffror.
const NOT_JOB_CATEGORIES = new Set(["uppdrag", "nyheter", "news", "blogg", "blog", "om-keyman", "jobba-hos-oss", "kund", "konsult", "tag", "kategori", "category", "page"]);

export function extractKeymanId(href: string): string | null {
  const m = href.match(JOB_RE);
  if (!m || NOT_JOB_CATEGORIES.has(m[1].toLowerCase())) return null;
  return m[2];
}

/** Kategorin ur adressen, t.ex. "data-it" → "Data/IT". */
export function keymanCategory(href: string): string | undefined {
  const slug = href.match(JOB_RE)?.[1];
  if (!slug) return undefined;
  const special: Record<string, string> = {
    "data-it": "Data/IT",
    "administration-ekonomi-juridik": "Administration, ekonomi & juridik",
    "hr-kompetensforsorjning": "HR & kompetensförsörjning",
    "chefs-och-ledarskapsstod": "Chefs- och ledarskapsstöd",
    "inkop-upphandling": "Inköp & upphandling",
    "teknik-engineering": "Teknik & engineering",
    "interimschefer": "Interimschefer",
  };
  if (special[slug]) return special[slug];
  // Okänd kategori: "projekt-och-forandringsledning" → "Projekt och forandringsledning" (versal bara först).
  const words = slug.split("-").filter(Boolean);
  return words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

/** Kanonisk adress: svenska versionen utan avslutande snedstreck. */
export function keymanUrl(href: string): string {
  try {
    const u = new URL(href, KEYMAN_BASE);
    u.hostname = "www.keyman.se";
    u.protocol = "https:";
    u.pathname = u.pathname.replace(/^\/en\//, "/sv/").replace(/\/$/, "");
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return href;
  }
}

/**
 * "Financial Controller - POSTNORD GROUP - KeyMan" → titel + kund.
 * "Servicedeskagent till Region Sörmland - KeyMan" → kunden är det som står efter sista "till".
 */
export function parseKeymanTitle(raw: string): { title?: string; company?: string } {
  const text = clean(raw).replace(/\s*[-–|]\s*Key\s?Man\s*$/i, "").trim();
  if (!text || /^key\s?man$/i.test(text) || /^uppdrag$/i.test(text)) return {};
  const parts = text.split(/\s+[-–]\s+/);
  if (parts.length >= 2) {
    const company = parts.pop()!;
    return stripEmpty({ title: parts.join(" - "), company: titleCaseIfShouting(company) });
  }
  // "… till Region Sörmland" / "… till Sveriges riksbank": ett ord med versal följt av högst tre ord, sist i titeln.
  const till = text.match(/\btill\s+([A-ZÅÄÖ][\p{L}.&-]*(?:\s+[\p{L}.&()-]+){0,3})\s*$/u);
  return stripEmpty({ title: text, company: till?.[1] });
}

function titleCaseIfShouting(s: string): string {
  if (s !== s.toUpperCase() || s.length <= 4) return s;
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (["ab", "hb", "kb"].includes(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

const DATE_TEXT = String.raw`(20\d{2}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-zåäö]{3}[a-zåäö]*\.?,?\s+20\d{2})`;

function labeled(text: string, labels: string): string | undefined {
  const m = text.match(new RegExp(`(?:${labels})\\s*:?\\s*${DATE_TEXT}`, "i"));
  return parseCinodeDate(m?.[1]);
}

function labeledText(text: string, labels: string, max = 60): string | undefined {
  const m = text.match(new RegExp(`(?:^|\\s)(?:${labels})\\s*:\\s*([^:]{2,${max}}?)(?=\\s+[A-ZÅÄÖ][\\p{L} ]{2,30}:|$)`, "iu"));
  return m ? clean(m[1]) : undefined;
}

const DEADLINE = "sista ansökningsdag|sista dag att ansöka|ansök senast|sista svarsdag|deadline|last application date|apply by";
const START = "startdatum|start|uppdragsstart|start date|tillträde";
const END = "slutdatum|end date|uppdraget pågår till|till och med";
const LOCATION = "ort|placering|placeringsort|plats|location|stad";
const EXTENT = "omfattning|extent|scope|sysselsättningsgrad";
const REMOTE = "distans|remote|på distans";

/** Plockar ut strukturerade fält ur fritext med etiketter ("Ort: Stockholm", "Start: 2026-11-01" …). */
export function keymanFieldsFromText(text: string): Partial<Assignment> {
  const location = labeledText(text, LOCATION, 40);
  const extent = labeledText(text, EXTENT, 30);
  const remote = labeledText(text, REMOTE, 30);
  const period = text.match(new RegExp(`(?:period|uppdragsperiod)\\s*:?\\s*${DATE_TEXT}\\s*(?:-|–|till|to)\\s*${DATE_TEXT}`, "i"));
  return stripEmpty({
    location: location ? swedishPlace(location.replace(/[.,;]$/, "")) : undefined,
    extent: extent?.replace(/[.,;]$/, ""),
    workMode: remote ? `Distans: ${remote.replace(/[.,;]$/, "")}` : undefined,
    deadline: labeled(text, DEADLINE),
    start: period ? parseCinodeDate(period[1]) : labeled(text, START),
    end: period ? parseCinodeDate(period[2]) : labeled(text, END),
  });
}

/** Tolkar listsidan /sv/uppdrag/ (och kategorisidor): uppdragslänkar och kortens text. */
export function parseKeymanListing(html: string, pageUrl = `${KEYMAN_BASE}/sv/uppdrag/`): Assignment[] {
  const $ = cheerio.load(html);
  const byId = new Map<string, Assignment>();
  const cards = findCards($, (href) => {
    try {
      return extractKeymanId(new URL(href, pageUrl).toString());
    } catch {
      return null;
    }
  });
  for (const { id, href, card, anchor } of cards) {
    const key = `keyman:${id}`;
    const abs = new URL(href, pageUrl).toString();
    const f = cardFields($, card, anchor);
    const fromTitle = parseKeymanTitle(f.title);
    const rest = (f.title && f.cardText.startsWith(f.title) ? f.cardText.slice(f.title.length) : f.cardText).trim();
    const fields = keymanFieldsFromText(rest);
    const category = keymanCategory(abs);
    const candidate = stripEmpty({
      id: key,
      source: "KeyMan",
      title: fromTitle.title || f.title,
      url: keymanUrl(abs),
      company: f.company || fromTitle.company,
      location: f.location || fields.location,
      published: f.dates.length && !fields.deadline ? f.dates[0] : undefined,
      ...fields,
      description: [category ? `Kategori: ${category}.` : "", rest.length > 20 && !/^(läs mer|read more)$/i.test(rest) ? rest.slice(0, 600) : ""]
        .filter(Boolean)
        .join(" "),
    }) as Assignment;
    const existing = byId.get(key);
    byId.set(key, existing ? ({ ...candidate, ...existing } as Assignment) : candidate);
  }
  return [...byId.values()].filter((a) => a.title);
}

/** Tolkar en uppdragssida. */
export function parseKeymanDetail(html: string, pageUrl?: string): Partial<Assignment> {
  const $ = cheerio.load(html);
  const ld = extractJobPosting($) ?? {};
  const fromTitle = parseKeymanTitle($('meta[property="og:title"]').attr("content") ?? $("title").text());
  const h1 = clean($("h1").first().text());
  const ogDesc = clean($('meta[property="og:description"]').attr("content") ?? $('meta[name="description"]').attr("content"));
  const published = ($('meta[property="article:published_time"]').attr("content") ?? "").match(/20\d{2}-\d{2}-\d{2}/)?.[0];

  $("script, style, nav, header, footer, noscript, form, aside").remove();
  let best = "";
  $("main, article, .entry-content, [class*=content], [class*=job], [class*=uppdrag], div")
    .slice(0, 400)
    .each((_, el) => {
      const text = spacedText($, el);
      if (text.length > best.length && text.length < 15000) best = text;
    });
  const body = best.length > ogDesc.length ? best : ogDesc;
  const fields = keymanFieldsFromText(body);
  const category = pageUrl ? keymanCategory(pageUrl) : undefined;
  const dates = [...body.matchAll(DATE_RE)].map((m) => m[1]);

  return stripEmpty({
    title: ld.title || fromTitle.title || h1 || undefined,
    company: ld.company || fromTitle.company,
    location: ld.location || fields.location,
    published: ld.published || published,
    deadline: ld.deadline || fields.deadline,
    start: fields.start ?? (fields.deadline ? undefined : dates[0]),
    end: fields.end,
    extent: fields.extent,
    workMode: fields.workMode,
    description: [category ? `Kategori: ${category}.` : "", (ld.description && ld.description.length > 200 ? ld.description : body).slice(0, 2500)]
      .filter(Boolean)
      .join(" ") || undefined,
  });
}
