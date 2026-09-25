import type { Assignment, MatchedAssignment } from "./types.ts";

export type MatchMode = "any" | "all";

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Bygger ett regex som matchar nyckelordet som eget ord, så att "Go" inte
 * matchar "Google" och "C#"/".NET" fungerar trots specialtecken.
 */
export function keywordRegex(keyword: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(keyword.trim())}(?![\\p{L}\\p{N}])`, "iu");
}

export function parseKeywords(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of raw.split(",")) {
    const t = k.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out.slice(0, 30);
}

/**
 * Poängsätter uppdrag mot nyckelorden. Träff i titel väger tyngre än i
 * beskrivningen. Utan nyckelord returneras alla uppdrag (poäng 0).
 */
export function matchAssignments(items: Assignment[], keywords: string[], mode: MatchMode = "any"): MatchedAssignment[] {
  const regs = keywords.map((k) => ({ k, re: keywordRegex(k) }));
  const out: MatchedAssignment[] = [];
  for (const a of items) {
    if (!regs.length) {
      out.push({ ...a, score: 0, matched: [] });
      continue;
    }
    let score = 0;
    const matched: string[] = [];
    for (const { k, re } of regs) {
      const inTitle = re.test(a.title);
      const inBody = re.test(`${a.company ?? ""} ${a.location ?? ""} ${a.description ?? ""}`);
      if (inTitle || inBody) {
        matched.push(k);
        score += (inTitle ? 3 : 0) + (inBody ? 1 : 0);
      }
    }
    if (mode === "all" ? matched.length === regs.length : matched.length > 0) {
      out.push({ ...a, score, matched });
    }
  }
  return out.sort((x, y) => y.score - x.score || (y.published ?? "").localeCompare(x.published ?? ""));
}
