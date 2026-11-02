import type { Assignment, SourceAdapter } from "../types.ts";
import { fetchText } from "../http.ts";
import { decodeEntities, stripEmpty } from "../parse-utils.ts";
import { isoDate, str, type Obj } from "./job-json.ts";
import { descriptionOf } from "./itjobb.ts";
import { isSwedish } from "../sweden.ts";

// A Society – konsultmäklare. robots.txt på asocietygroup.com tillåter allt utom /hidden/
// (2026-11-02; asociety.se spärrar allt och används inte). Uppdragslistan
// https://www.asocietygroup.com/sv/uppdrag är en Next.js-sida (app router) där alla öppna
// uppdrag ligger i RSC-datat (self.__next_f.push(...)) som objekt med fälten requisition_name,
// requisition_locationid, requisition_remotework, requisition_startdate/enddate,
// requisition_offerduedate, abstract_id m.fl. Beskrivningen är en referens ("$34") till en
// textrad i samma data. Kontaktpersonens namn, e-post och telefon (mspperson_*,
// requisition_searchermsppersonid) tas inte med. Annonssidan är /sv/uppdrag/<slug>-<abstract_id>. Bara Sverige om inte ASOCIETY_ALL_COUNTRIES=1.
export const ASOCIETY_BASE = "https://www.asocietygroup.com";
const LIST = `${ASOCIETY_BASE}/sv/uppdrag`;
const ALL_COUNTRIES = process.env.ASOCIETY_ALL_COUNTRIES === "1";

/** RSC-datat: alla strängar i self.__next_f.push([1,"…"]) efter varandra. */
export function rscPayload(html: string): string {
  let out = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      out += JSON.parse(m[1]) as string;
    } catch {
      /* trasig bit */
    }
  }
  return out;
}

/** Ett JSON-objekt som börjar vid `start` (måste vara "{"), eller null. Hoppar över strängar. */
function objectAt(text: string, start: number): Obj | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as Obj;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Uppdragsobjekten (de med requisition_name) i RSC-datat, ett per abstract_id. */
export function asocietyRequisitions(payload: string): Obj[] {
  const out = new Map<string, Obj>();
  for (const m of payload.matchAll(/\{"(?:requisition_|abstract_id|mspperson_|location_)/g)) {
    const o = objectAt(payload, m.index!);
    const id = o && str(o.abstract_id);
    if (o && id && str(o.requisition_name) && !out.has(id)) out.set(id, o);
  }
  return [...out.values()];
}

/** Textrader i RSC-datat ("34:T1a2b,<text>", längden i UTF-8-byte) → id → text. */
export function rscTextRows(payload: string): Map<string, string> {
  const rows = new Map<string, string>();
  const buf = Buffer.from(payload, "utf8");
  const head = /([0-9a-f]+):T([0-9a-f]+),/y;
  // En textrad följs direkt (utan radbrytning) av nästa rad, så läs vidare efter varje text.
  const readAt = (byte: number) => {
    while (byte < buf.length) {
      head.lastIndex = 0;
      const m = head.exec(buf.subarray(byte, byte + 40).toString("latin1"));
      if (!m) return;
      const start = byte + m[0].length;
      const len = parseInt(m[2], 16);
      rows.set(m[1], buf.subarray(start, start + len).toString("utf8"));
      byte = start + len;
    }
  };
  for (const m of payload.matchAll(/(?:^|\n)(?=[0-9a-f]+:T[0-9a-f]+,)/g)) {
    const at = Buffer.byteLength(payload.slice(0, m.index! + m[0].length), "utf8");
    readAt(at);
  }
  return rows;
}

/** Beskrivningen (HTML-kodad, med <br>) som text utan kontaktuppgifter. */
function descriptionText(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const html = decodeEntities(raw.replace(/<br\s*\/?>/gi, "\n"));
  return descriptionOf(html)
    ?.split("\n")
    .filter((l) => l.trim() && !/@|\+46|\b0\d{1,3}[- ]?\d{2,3}[ ]?\d{2}[ ]?\d{2}\b/.test(l))
    .join("\n");
}

/** "Senior Deep Learning Engineer – Dynamic Objects" → "senior-deep-learning-engineer-dynamic-objects". */
export function asocietySlug(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Annonssidan, t.ex. /sv/uppdrag/senior-deep-learning-engineer-dynamic-objects-16884. */
export const asocietyUrl = (title: string, id: string) => `${LIST}/${asocietySlug(title)}-${id}`;

const WORK_MODE: Record<string, string> = { hybrid: "Hybrid", "på plats": "På plats", onsite: "På plats", distans: "Distans", remote: "Distans" };

/** Ett uppdragsobjekt → Assignment. `texts` löser upp beskrivningsreferenser ("$34"). */
export function parseAsocietyRequisition(o: Obj, texts: Map<string, string> = new Map()): Assignment | null {
  const id = str(o.abstract_id);
  const title = str(o.requisition_name);
  if (!id || !title) return null;
  const rawDesc = typeof o.requisition_description === "string" ? o.requisition_description : undefined;
  const ref = rawDesc?.match(/^\$([0-9a-f]+)$/)?.[1];
  const description = descriptionText(ref ? texts.get(ref) : rawDesc) ?? descriptionText(str(o.requisition_shortdescription));
  const country = str(o.requisition_customcode1);
  const mode = str(o.requisition_remotework);
  const pct = str(o.requisition_worktimepercentage);
  const area = [str(o.requisition_servicecategoryid), str(o.requisition_competenceareaid)].filter(Boolean).join(", ");
  return stripEmpty({
    id: `asociety:${id}`,
    source: "A Society",
    title,
    url: asocietyUrl(title, id),
    location: str(o.requisition_locationid),
    country: !country || /^(sweden|sverige|se)$/i.test(country) ? (country ? "Sverige" : undefined) : country,
    published: isoDate(o.requisition_publisheddate),
    deadline: isoDate(o.requisition_offerduedate),
    start: isoDate(o.requisition_startdate),
    end: isoDate(o.requisition_enddate),
    extent: pct ? `${pct} %` : undefined,
    workMode: mode ? (WORK_MODE[mode.toLowerCase()] ?? mode) : undefined,
    // Beskrivningen kortas först så att området alltid kommer med.
    description: [description?.slice(0, 2400), area && `Område: ${area}.`].filter(Boolean).join("\n") || undefined,
  }) as Assignment;
}

/** Alla uppdrag på listsidan. */
export function parseAsocietyPage(html: string): Assignment[] {
  const payload = rscPayload(html);
  const texts = rscTextRows(payload);
  return asocietyRequisitions(payload)
    .map((o) => parseAsocietyRequisition(o, texts))
    .filter((a): a is Assignment => !!a);
}

export const asociety: SourceAdapter = {
  name: "A Society",
  homepage: LIST,

  async fetchAssignments() {
    const strategies: string[] = [];
    const res = await fetchText(LIST, { timeoutMs: 12000, revalidate: 1800 });
    if (res.status >= 400) throw new Error(`Kunde inte läsa A Societys uppdragslista (HTTP ${res.status})`);
    let all = parseAsocietyPage(res.body);
    if (!all.length) throw new Error("Inga uppdrag hittades i A Societys sida (RSC-datat kan ha ändrats).");
    strategies.push(`uppdragslistan: ${all.length} uppdrag`);
    const today = new Date().toISOString().slice(0, 10);
    const expired = all.filter((a) => a.deadline && a.deadline < today).length;
    if (expired) strategies.push(`utgångna bortfiltrerade: ${expired}`);
    all = all.filter((a) => !(a.deadline && a.deadline < today));
    if (!ALL_COUNTRIES) {
      const other = all.filter((a) => !isSwedish(a)).length;
      if (other) strategies.push(`andra länder bortfiltrerade: ${other}`);
      all = all.filter(isSwedish);
    }
    return { assignments: all, strategies };
  },
};
