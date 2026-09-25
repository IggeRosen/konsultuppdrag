import type { Assignment, SourceStatus } from "./types.ts";
import { SOURCES } from "./sources/index.ts";

const TTL_MS = 15 * 60 * 1000;
let cache: { at: number; data: { assignments: Assignment[]; sources: SourceStatus[] } } | null = null;
let inflight: Promise<{ assignments: Assignment[]; sources: SourceStatus[] }> | null = null;

/** Hämtar uppdrag från alla källor parallellt. En trasig källa stoppar inte de andra. */
export async function collectAssignments(force = false) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;

  inflight = (async () => {
    const results = await Promise.all(
      SOURCES.map(async (src): Promise<{ items: Assignment[]; status: SourceStatus }> => {
        try {
          const { assignments, strategies } = await src.fetchAssignments();
          return {
            items: assignments,
            status: {
              source: src.name,
              ok: assignments.length > 0,
              count: assignments.length,
              strategies,
              error: assignments.length ? undefined : "Inga uppdrag kunde hämtas (sidstrukturen kan ha ändrats).",
              fetchedAt: new Date().toISOString(),
            },
          };
        } catch (err) {
          return {
            items: [],
            status: {
              source: src.name,
              ok: false,
              count: 0,
              strategies: [],
              error: err instanceof Error ? err.message : String(err),
              fetchedAt: new Date().toISOString(),
            },
          };
        }
      }),
    );
    const data = { assignments: results.flatMap((r) => r.items), sources: results.map((r) => r.status) };
    if (data.assignments.length) cache = { at: Date.now(), data };
    return data;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
