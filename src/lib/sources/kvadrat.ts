import * as cheerio from "cheerio";
import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText } from "../http.ts";
import { stripEmpty } from "../parse-utils.ts";
import { isoDate, str, type Obj } from "./job-json.ts";

// Kvadrats öppna uppdrag: https://uppdrag.kvadrat.se/ (Nuxt). robots.txt tillåter allt
// (2026-10-29). Startsidan bäddar in alla uppdrag i <script id="__NUXT_DATA__">, i Nuxts
// "devalue"-format: en platt array där objekt och listor pekar på andra platser med index.
// Varje uppdrag: { slug, title, excerpt, locations[], requirements[{name,category,level}],
//                  start, end, durationMonths, extent{value,type}, updatedAt }.
export const KVADRAT_BASE = "https://uppdrag.kvadrat.se";
const MAX_PAGES = Number(process.env.KVADRAT_MAX_PAGES ?? 5);

/**
 * Packar upp Nuxts devalue-format (en delmängd som räcker här). -1 betyder undefined;
 * ["ShallowReactive", i], ["Reactive", i], ["Ref", i] m.fl. är omslag kring värdet på i.
 */
export function unflattenNuxt(flat: unknown): unknown {
  if (!Array.isArray(flat)) return undefined;
  const memo = new Map<number, unknown>();
  const WRAPPERS = new Set(["ShallowReactive", "Reactive", "Ref", "ShallowRef", "EmptyRef", "EmptyShallowRef"]);
  const at = (i: number, depth: number): unknown => {
    if (i === -1 || depth > 60 || i < 0 || i >= flat.length) return undefined;
    if (memo.has(i)) return memo.get(i);
    const v = flat[i];
    let out: unknown = v;
    if (Array.isArray(v)) {
      if (typeof v[0] === "string" && WRAPPERS.has(v[0])) out = v.length > 1 ? at(v[1] as number, depth + 1) : undefined;
      else if (v[0] === "Set" || v[0] === "Map") out = undefined;
      else if (v[0] === "Date" && typeof v[1] === "string") out = v[1];
      else {
        const arr: unknown[] = [];
        memo.set(i, arr);
        for (const x of v) arr.push(typeof x === "number" ? at(x, depth + 1) : x);
        return arr;
      }
    } else if (v && typeof v === "object") {
      const o: Obj = {};
      memo.set(i, o);
      for (const [k, x] of Object.entries(v as Obj)) o[k] = typeof x === "number" ? at(x, depth + 1) : x;
      return o;
    }
    memo.set(i, out);
    return out;
  };
  return at(0, 0);
}

/** "kravanalytiker-sundsvall" ur /hitta-uppdrag/kravanalytiker-sundsvall. */
export function extractKvadratSlug(url: string): string | null {
  return url.match(/^(?:https?:\/\/uppdrag\.kvadrat\.se)?\/hitta-uppdrag\/([a-z0-9][a-z0-9-]{1,200})\/?(?:[?#].*)?$/i)?.[1] ?? null;
}

function mapKvadratItem(o: Obj): Assignment | null {
  const slug = str(o.slug);
  const title = str(o.title);
  if (!slug || !title || !/^[a-z0-9-]+$/i.test(slug)) return null;
  const locations = Array.isArray(o.locations) ? o.locations.map((l) => str(l)).filter((l): l is string => !!l) : [];
  const skills = Array.isArray(o.requirements)
    ? o.requirements.map((r) => (r && typeof r === "object" ? str((r as Obj).name) : undefined)).filter((s): s is string => !!s)
    : [];
  const months = typeof o.durationMonths === "number" && o.durationMonths > 0 ? o.durationMonths : undefined;
  const ext = o.extent && typeof o.extent === "object" ? (o.extent as Obj) : undefined;
  const extent = ext && typeof ext.value === "number" ? (str(ext.type) === "percent" ? `${ext.value} %` : `${ext.value} ${str(ext.type) ?? ""}`.trim()) : undefined;
  const excerpt = str(o.excerpt);
  return stripEmpty({
    id: `kvadrat:${slug}`,
    source: "Kvadrat",
    title,
    url: `${KVADRAT_BASE}/hitta-uppdrag/${slug}`,
    location: [...new Set(locations)].join(", ") || undefined,
    country: "Sverige",
    published: isoDate(o.updatedAt),
    start: isoDate(o.start),
    end: isoDate(o.end),
    duration: months ? `${months} ${months === 1 ? "månad" : "månader"}` : undefined,
    extent,
    description: [excerpt, skills.length ? `Kompetenser: ${[...new Set(skills)].join(", ")}` : undefined].filter(Boolean).join("\n") || undefined,
  }) as Assignment;
}

/** Uppdragen på en sida från uppdrag.kvadrat.se, samt totalt antal enligt sidan. */
export function parseKvadratPage(html: string): { items: Assignment[]; total?: number } {
  const $ = cheerio.load(html);
  const raw = $("script#__NUXT_DATA__").html();
  if (!raw) return { items: [] };
  let root: unknown;
  try {
    root = unflattenNuxt(JSON.parse(raw));
  } catch {
    return { items: [] };
  }
  // Leta upp { items: [...], total } bland Nuxts data.
  const out = new Map<string, Assignment>();
  let total: number | undefined;
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 12 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const x of node) visit(x, depth + 1);
      return;
    }
    const o = node as Obj;
    if (Array.isArray(o.items) && o.items.some((i) => i && typeof i === "object" && "slug" in (i as Obj))) {
      if (typeof o.total === "number") total = o.total;
      for (const i of o.items) {
        const a = i && typeof i === "object" ? mapKvadratItem(i as Obj) : null;
        if (a && !out.has(a.id)) out.set(a.id, a);
      }
      return;
    }
    for (const v of Object.values(o)) visit(v, depth + 1);
  };
  visit(root, 0);
  return { items: [...out.values()], total };
}

/** För /api/debug: samma tolkning som listsidan. */
export function parseKvadratHtml(html: string): Assignment[] {
  return parseKvadratPage(html).items;
}

export const kvadrat: SourceAdapter = {
  name: "Kvadrat",
  homepage: `${KVADRAT_BASE}/`,

  async fetchAssignments() {
    const strategies: string[] = [];
    const byId = new Map<string, Assignment>();
    const first = await fetchText(`${KVADRAT_BASE}/`, { timeoutMs: 8000, revalidate: 1800 });
    if (first.status >= 400) throw new Error(`Kunde inte läsa uppdrag.kvadrat.se (HTTP ${first.status})`);
    const page1 = parseKvadratPage(first.body);
    page1.items.forEach((a) => byId.set(a.id, a));
    let pages = 1;
    // Fler sidor om sajten skulle börja dela upp listan (?page=N).
    for (let p = 2; p <= MAX_PAGES && page1.total && byId.size < page1.total; p++) {
      try {
        const res = await fetchText(`${KVADRAT_BASE}/?page=${p}`, { timeoutMs: 8000, revalidate: 1800 });
        const fresh = parseKvadratPage(res.body).items.filter((a) => !byId.has(a.id));
        if (!fresh.length) break;
        fresh.forEach((a) => byId.set(a.id, a));
        pages++;
      } catch {
        break;
      }
    }
    if (!byId.size) throw new Error("Inga uppdrag hittades på uppdrag.kvadrat.se (sidans data kan ha ändrats).");
    strategies.push(`uppdrag.kvadrat.se (${pages} sid): ${byId.size}${page1.total ? ` av ${page1.total}` : ""}`);

    const today = new Date().toISOString().slice(0, 10);
    const all = [...byId.values()];
    const ended = all.filter((a) => a.end && a.end < today).length;
    if (ended) strategies.push(`avslutade bortfiltrerade: ${ended}`);
    return { assignments: all.filter((a) => !(a.end && a.end < today)), strategies };
  },
};
