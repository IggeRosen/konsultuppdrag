// Brainvilles sökresultat visar en sammanfattningsrad per uppdrag, t.ex.
//   "Finspång Start immediately about 12 months 1 d"
//   "Sweden Start in in 1 month about 24 months 40 hours 5 h"
// Den här modulen delar upp raden i ort, start, längd, omfattning och ålder.

const UNITS_SV: Record<string, [string, string]> = {
  day: ["dag", "dagar"],
  week: ["vecka", "veckor"],
  month: ["månad", "månader"],
  year: ["år", "år"],
  dag: ["dag", "dagar"],
  vecka: ["vecka", "veckor"],
  månad: ["månad", "månader"],
};

function svUnit(n: number, unit: string): string {
  const key = unit.toLowerCase().replace(/(s|er|ar|or)$/, "");
  const pair = UNITS_SV[key] ?? UNITS_SV[unit.toLowerCase()];
  return pair ? `${n} ${n === 1 ? pair[0] : pair[1]}` : `${n} ${unit}`;
}

export interface Summary {
  location?: string;
  startText?: string;
  duration?: string;
  extent?: string;
  /** ISO-datum beräknat från åldern ("1 d", "5 h") */
  published?: string;
}

const SUMMARY_RE =
  /^(?<loc>.*?)\s*\bStart(?:ar)?\s+(?:(?<now>immediately|omgående|snarast|asap)|(?:in\s+|om\s+)+(?<inN>\d+)\s+(?<inU>[a-zåäö]+)|(?<date>20\d{2}-\d{2}-\d{2}))\s*(?:(?:about|approx\.?|ca\.?|cirka)\s+(?<durN>\d+)\s+(?<durU>[a-zåäö]+))?\s*(?:(?<hours>\d+)\s+(?:hours|timmar|tim)(?:\/\w+)?)?\s*(?:(?<ageN>\d+)\s*(?<ageU>min|h|d|w|v|mo)\b)?\s*$/i;

export function parseSummary(text: string, now = new Date()): Summary | null {
  const m = text.replace(/\s+/g, " ").trim().match(SUMMARY_RE);
  if (!m?.groups) return null;
  const g = m.groups;
  const out: Summary = {};
  if (g.loc?.trim()) out.location = g.loc.trim();
  if (g.now) out.startText = "Omgående";
  else if (g.inN) out.startText = `Om ${svUnit(Number(g.inN), g.inU)}`;
  else if (g.date) out.startText = g.date;
  if (g.durN) out.duration = svUnit(Number(g.durN), g.durU);
  if (g.hours) out.extent = `${g.hours} tim/vecka`;
  if (g.ageN) {
    const n = Number(g.ageN);
    const hours = { min: n / 60, h: n, d: n * 24, w: n * 24 * 7, v: n * 24 * 7, mo: n * 24 * 30 }[g.ageU.toLowerCase()] ?? 0;
    out.published = new Date(now.getTime() - hours * 3600_000).toISOString();
  }
  return out;
}
