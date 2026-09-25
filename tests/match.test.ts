import { test } from "node:test";
import assert from "node:assert/strict";
import { matchAssignments, parseKeywords } from "../src/lib/match.ts";
import type { Assignment } from "../src/lib/types.ts";

const a = (id: string, title: string, description = ""): Assignment => ({ id, source: "T", title, url: "#", description });
const items = [
  a("1", "Go-utvecklare", "Backend i Go och Kubernetes"),
  a("2", "Google Analytics-specialist", "Marknadsföring"),
  a("3", "C# .NET-utvecklare", "Azure"),
  a("4", "Frontend", "React och TypeScript"),
];

test("matchar hela ord, även med specialtecken", () => {
  assert.deepEqual(matchAssignments(items, ["Go"]).map((r) => r.id), ["1"]);
  assert.deepEqual(matchAssignments(items, ["C#"]).map((r) => r.id), ["3"]);
  assert.deepEqual(matchAssignments(items, [".NET"]).map((r) => r.id), ["3"]);
});

test("any/all och titel väger tyngre", () => {
  assert.deepEqual(matchAssignments(items, ["react", "azure"]).map((r) => r.id).sort(), ["3", "4"]);
  assert.deepEqual(matchAssignments(items, ["react", "typescript"], "all").map((r) => r.id), ["4"]);
  const r = matchAssignments([a("x", "Kubernetes", ""), a("y", "Drift", "Kubernetes")], ["kubernetes"]);
  assert.equal(r[0].id, "x");
});

test("parseKeywords trimmar och tar bort dubbletter", () => {
  assert.deepEqual(parseKeywords(" Java, java ,React,, "), ["Java", "React"]);
});
