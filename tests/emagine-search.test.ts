// Felsvaret nedan är riktigt (POST https://portal-api.emagine.org/api/JobAds/Search, 2026-09-26).
import { test } from "node:test";
import assert from "node:assert/strict";
import { errorPath, fixSearchBody, hasPaging, languageOrder, languagesFromNgState, seedBodies, serverErrorVariants, withPage } from "../src/lib/sources/emagine-search.ts";

test("felnycklar blir sökvägar", () => {
  assert.deepEqual(errorPath("Filter"), ["filter"]);
  assert.deepEqual(errorPath("$.sorting.Direction"), ["sorting", "direction"]);
  assert.deepEqual(errorPath("Filter.Countries[0]"), ["filter", "countries"]);
});

test("saknade Filter och Sorting läggs till", () => {
  const real = { Filter: ["The Filter field is required."], Sorting: ["The Sorting field is required."] };
  assert.deepEqual(fixSearchBody({ pageNumber: 1, pageSize: 50 }, real), { pageNumber: 1, pageSize: 50, filter: {}, sorting: {} });
});

test("inre fält och typfel", () => {
  const body = { filter: {}, sorting: {} };
  const next = fixSearchBody(body, {
    "Filter.PageSize": ["The PageSize field is required."],
    "Sorting.SortBy": ["The SortBy field is required."],
    "$.sorting.direction": ["The JSON value could not be converted to System.Int32. Path: $.sorting.direction"],
  });
  assert.deepEqual(next, { filter: { pageSize: 100 }, sorting: { sortBy: "", direction: 0 } });
  // Samma fel igen på ett fält som redan har värdet → prova en annan typ.
  const again = fixSearchBody({ sorting: { direction: 0 } }, { "$.sorting.direction": ["The JSON value could not be converted to Emagine.SortDirection."] });
  assert.deepEqual(again, { sorting: { direction: {} } });
  // "request" (hela kroppen) och okända fel ändrar inget.
  assert.equal(fixSearchBody(body, { request: ["The request field is required."] }), null);
});

test("sidbyte", () => {
  assert.deepEqual(withPage({ filter: {}, pageNumber: 1, pageSize: 20 }, 3), { filter: {}, pageNumber: 3, pageSize: 20 });
  assert.deepEqual(withPage({ paging: { skip: 0, take: 25 } }, 3), { paging: { skip: 50, take: 25 } });
  assert.equal(hasPaging({ filter: {}, sorting: {} }), false);
  assert.equal(hasPaging({ filter: { pageIndex: 0 } }), true);
});

test("portalens förfrågan och bläddring med skipCount", () => {
  const [seed] = seedBodies();
  assert.equal(seed.sorting, "CreationTime desc");
  assert.equal(hasPaging(seed), true);
  assert.deepEqual(withPage(seed, 3), { ...seed, skipCount: 200 });
});

test("verkliga fel: listfält och parameterfelet input", () => {
  const round1 = {
    "Filter.TextFilters": ["The TextFilters field is required."],
    "Filter.RecordIdsToExclude": ["The RecordIdsToExclude field is required."],
    "Filter.ConsultantSeniorities": ["The ConsultantSeniorities field is required."],
  };
  assert.deepEqual(fixSearchBody({ filter: {} }, round1), { filter: { textFilters: [], recordIdsToExclude: [], consultantSeniorities: [] } });
  // "input" är åtgärdens parameter, inte ett fält i kroppen.
  assert.equal(fixSearchBody({ filter: {} }, { input: ["The input field is required."] }), null);
});

test("språk ur ng-state och varianter vid serverfel", () => {
  const html = `<script id="ng-state" type="application/json">${JSON.stringify({
    lookups: { supportedLanguages: [{ id: 3, code: "DA" }, { id: 5, code: "EN" }, { id: 7, code: "SV" }], languageProficiencies: [{ id: 99, name: "Native" }] },
  })}</script>`;
  const langs = languagesFromNgState(html);
  assert.deepEqual(langs.map((l) => l.id), [3, 5, 7]);
  assert.deepEqual(languageOrder(langs), [5, 7, 3]);
  const v = serverErrorVariants({ filter: {}, supportedLanguageId: 1 }, [5, 7, 3]);
  assert.deepEqual(v.map((b) => b.supportedLanguageId), [5, 7, 3, 2, 0, 1, undefined]);
  assert.equal(v[5].maxResultCount, 20);
});
