import assert from "node:assert/strict";
import test from "node:test";
import { accessibleTotal, canLoadMore, firstLoad, mergePage, nextOffset, nextPage, type SpaceLoad, type SpaceResult, type SpaceRow, type SpaceSearch } from "../src/space/space-model";

const lexical: SpaceSearch = { kind: "lexical", keywords: [], expression: "" };
const semantic: SpaceSearch = { kind: "semantic", text: "insurance claims" };
const iscc: SpaceSearch = { kind: "iscc", query: "claims", count: 300 };
const none = new Set<number>();

const row = (id: number): SpaceRow => ({ company_id: `c${id}`, name: `Company ${id}`, values: {} });
// A server page: `count` rows starting at server position `from`, out of `total` matches.
const page = (from: number, count: number, total: number, extra: Partial<SpaceResult> = {}): SpaceResult => ({
  results: Array.from({ length: count }, (_, i) => row(from + i)),
  total,
  ...extra,
});
const ids = (load: SpaceLoad) => load.result.results.map(r => r.company_id);

test("merging a page appends rows in server order without repeating a company", () => {
  const first = firstLoad(page(0, 100, 250));
  // Positions 95-99 repeat rows already loaded; the rest are new.
  const second = mergePage(first, page(95, 100, 250), 100);
  assert.equal(second.result.results.length, 195);
  assert.equal(new Set(ids(second)).size, 195);
  assert.deepEqual(ids(second).slice(0, 3), ["c0", "c1", "c2"]);
  assert.deepEqual(ids(second).slice(-2), ["c193", "c194"]);
});
test("a company repeated inside one page is kept once", () => {
  const load = firstLoad({ results: [row(1), row(2), row(1)], total: 3 });
  assert.deepEqual(ids(load), ["c1", "c2"]);
  assert.equal(nextOffset(load), 3);
});
test("a page of repeats advances the offset without adding rows or ending paging", () => {
  const repeats = mergePage(firstLoad(page(0, 100, 250)), page(0, 100, 250), 100);
  assert.equal(repeats.result.results.length, 100);
  assert.equal(nextOffset(repeats), 200);
  assert.equal(repeats.exhausted, false);
});
test("the next offset is the number of rows loaded when nothing repeats", () => {
  const load = mergePage(firstLoad(page(0, 100, 1000)), page(100, 100, 1000), 100);
  assert.equal(load.result.results.length, 200);
  assert.equal(nextOffset(load), 200);
  assert.deepEqual(nextPage(lexical, load, none), { offset: 200, limit: 100 });
});
test("a page that answers a different offset is ignored", () => {
  const first = firstLoad(page(0, 100, 250));
  assert.equal(mergePage(first, page(100, 100, 250), 0), first);
});
test("the end of results stops paging and the last page asks only for what is left", () => {
  const at200 = mergePage(firstLoad(page(0, 100, 250)), page(100, 100, 250), 100);
  assert.deepEqual(nextPage(lexical, at200, none), { offset: 200, limit: 50 });
  const done = mergePage(at200, page(200, 50, 250), 200);
  assert.equal(done.result.results.length, 250);
  assert.equal(canLoadMore(lexical, done), false);
  assert.equal(nextPage(lexical, done, none), undefined);
});
test("an empty page ends paging even when the total says more rows exist", () => {
  const load = mergePage(firstLoad(page(0, 100, 900)), page(100, 0, 900), 100);
  assert.equal(load.exhausted, true);
  assert.equal(canLoadMore(lexical, load), false);
  assert.equal(nextPage(lexical, load, none), undefined);
});
test("an empty first page is already complete", () => {
  assert.equal(canLoadMore(lexical, firstLoad(page(0, 0, 0))), false);
});
test("semantic search never asks past the 5,000-row backend cap", () => {
  assert.equal(accessibleTotal(semantic, 12000), 5000);
  assert.equal(accessibleTotal(lexical, 12000), 12000);
  let load = firstLoad(page(0, 100, 12000));
  for (let offset = 100; offset < 4900; offset += 100) load = mergePage(load, page(offset, 100, 12000), offset);
  assert.equal(nextOffset(load), 4900);
  assert.deepEqual(nextPage(semantic, load, none), { offset: 4900, limit: 100 });
  load = mergePage(load, page(4900, 100, 12000), 4900);
  assert.equal(load.result.results.length, 5000);
  assert.equal(load.result.total, 12000);
  assert.equal(canLoadMore(semantic, load), false);
  assert.equal(nextPage(semantic, load, none), undefined);
});
test("a semantic total under the cap pages to its own end", () => {
  let load = firstLoad(page(0, 100, 4950));
  for (let offset = 100; offset < 4900; offset += 100) load = mergePage(load, page(offset, 100, 4950), offset);
  assert.deepEqual(nextPage(semantic, load, none), { offset: 4900, limit: 50 });
});
test("ISCC returns its whole result in one call and never pages", () => {
  const load = firstLoad(page(0, 300, 300));
  assert.equal(accessibleTotal(iscc, 300), 300);
  assert.equal(canLoadMore(iscc, load), false);
  assert.equal(nextPage(iscc, load, none), undefined);
});
test("a request for an offset already in flight is not repeated", () => {
  const load = firstLoad(page(0, 100, 250));
  assert.deepEqual(nextPage(lexical, load, none), { offset: 100, limit: 100 });
  assert.equal(nextPage(lexical, load, new Set([100])), undefined);
  // Work pending for an earlier offset does not block the next one.
  assert.deepEqual(nextPage(lexical, load, new Set([0])), { offset: 100, limit: 100 });
});
test("paging through 8,050 rows requests each offset exactly once", () => {
  const requested: number[] = [];
  let load = firstLoad(page(0, 100, 8050));
  for (;;) {
    const request = nextPage(lexical, load, none);
    if (!request) break;
    requested.push(request.offset);
    load = mergePage(load, page(request.offset, request.limit, 8050), request.offset);
  }
  assert.equal(load.result.results.length, 8050);
  assert.equal(requested.length, 80);
  assert.equal(new Set(requested).size, requested.length);
  assert.equal(requested[0], 100);
  assert.equal(requested.at(-1), 8000);
});
test("load all asks for pages of at most the backend maximum of 200", () => {
  const load = firstLoad(page(0, 100, 8050));
  assert.deepEqual(nextPage(lexical, load, none, 500), { offset: 100, limit: 200 });
});
test("the first page's query id and columns survive later pages", () => {
  const first = firstLoad(page(0, 100, 250, { query_id: "q-1", columns: ["Company", "Sector"], bundle_id: "b-1" }));
  // The backend returns query_id only on the first page (offset 0).
  const later = mergePage(first, page(100, 100, 250), 100);
  assert.equal(later.result.query_id, "q-1");
  assert.deepEqual(later.result.columns, ["Company", "Sector"]);
  assert.equal(later.result.bundle_id, "b-1");
});
