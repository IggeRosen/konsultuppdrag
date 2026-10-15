import { test } from "node:test";
import assert from "node:assert/strict";
import { matchAssignments } from "../src/lib/match.ts";
import { withKeywordResults } from "../src/lib/aggregate.ts";
import { keywordSearchUrl } from "../src/lib/sources/brainville.ts";
import type { Assignment, SourceStatus } from "../src/lib/types.ts";

const a = (id: string, title: string, description?: string): Assignment => ({ id, source: "Brainville", title, url: `https://x/${id}`, description });

test("Brainvilles sökadress", () => {
  assert.equal(keywordSearchUrl("testledare"), "https://www.brainville.com/sv/RequisitionSearch?Text=testledare&lang=sv");
  assert.equal(keywordSearchUrl("C# .NET"), "https://www.brainville.com/sv/RequisitionSearch?Text=C%23%20.NET&lang=sv");
});

test("träffar som portalen bekräftat räknas även om ordet inte syns", () => {
  const items = [a("brainville:1", "Systemutvecklare", "Kompetenser: Backend"), a("brainville:2", "Projektledare")];
  assert.equal(matchAssignments(items, ["java"]).length, 0);
  const confirmed = new Map([["brainville:1", new Set(["java"])]]);
  const res = matchAssignments(items, ["java"], "any", confirmed);
  assert.deepEqual(res.map((r) => [r.id, r.matched, r.score]), [["brainville:1", ["java"], 1]]);
  // "alla ord": bekräftelsen gäller bara ordet den gavs för.
  assert.equal(matchAssignments(items, ["java", "kubernetes"], "all", confirmed).length, 0);
});

test("nyckelordsträffar läggs till utan dubbletter och syns i källans status", () => {
  const sources: SourceStatus[] = [
    { source: "Brainville", ok: true, count: 1, strategies: ["söksidan: 1"], fetchedAt: "t" },
    { source: "Cinode", ok: true, count: 0, strategies: [], fetchedAt: "t" },
  ];
  const data = { assignments: [a("brainville:1", "Testledare")], sources };
  const out = withKeywordResults(data, "Brainville", [a("brainville:1", "Testledare"), a("brainville:2", "Testare")], "nyckelordssökning (1 ord)");
  assert.deepEqual(out.assignments.map((x) => x.id), ["brainville:1", "brainville:2"]);
  assert.equal(out.added, 1);
  assert.equal(out.sources[0].count, 2);
  assert.deepEqual(out.sources[0].strategies, ["söksidan: 1", "nyckelordssökning (1 ord): 2 träffar, 1 nya"]);
  assert.equal(data.assignments.length, 1, "cachen ändras inte");
  assert.equal(out.sources[1], sources[1]);
});
