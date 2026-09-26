// Felsvaret nedan är riktigt (POST https://portal-api.emagine.org/api/JobAds/Search, 2026-09-26).
import { test } from "node:test";
import assert from "node:assert/strict";
import { errorPath, fixSearchBody, hasPaging, withPage } from "../src/lib/sources/emagine-search.ts";

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
  assert.deepEqual(next, { filter: { pageSize: 50 }, sorting: { sortBy: "", direction: 0 } });
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
