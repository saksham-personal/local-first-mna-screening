import assert from "node:assert/strict";
import test from "node:test";
import { companyPageSizes, loadingProgress, pageRows } from "../src/workspace/company-pager";
import { appendGridPage, fetchScreeningGridPage, fetchGridDescriptions, type ScreeningGrid } from "../src/lib/grid-client";

test("pagination exposes 100/250/500 sizes and slices just the visible page", () => {
  const rows = Array.from({ length: 5613 }, (_, index) => index);
  assert.deepEqual(companyPageSizes, [100, 250, 500]);
  assert.deepEqual(pageRows(rows, 1, 100), rows.slice(100, 200));
  assert.equal(pageRows(rows, 11, 500).length, 113);
  assert.equal(loadingProgress(3000, 5613, true), "Loading all rows · 3,000 of 5,613");
  assert.equal(loadingProgress(5613, 5613, false), undefined);
});

test("page one resolves without requesting the continuation and projects the view and picker ids", async () => {
  const prior = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)).arguments);
    return Response.json({ ok: true, result: { rows: [], columns: [], total: 0, considered_count: 0, hidden_count: 0, selection_revision: 1, source_hash: "h", next_cursor: null } });
  };
  try {
    await fetchScreeningGridPage("run-insurance", "one", { view: "iscc", columns: ["Company Name", "ISCC Score"] });
    assert.deepEqual(requests, [{ run_id: "one", view: "iscc", include_hidden: true, limit: 100, columns: ["Company Name", "ISCC Score"] }]);
    await fetchScreeningGridPage("run-insurance", "one", { limit: 5000 });
    assert.equal(requests[1].limit, 1000);
  } finally { globalThis.fetch = prior; }
});

test("streamed pages preserve the catalog reference and reject stale revisions or duplicate rows", () => {
  const current = { rows: [{ company_id: "a" }], columns: [], total: 2, consideredCount: 2, hiddenCount: 0, selectionRevision: 1, sourceHash: "h", rounds: [], has_mid_keyword: false, has_semantic: false, has_iscc: false, nextCursor: "a" } as unknown as ScreeningGrid;
  const next = { ...current, columns: [], rows: [{ company_id: "b" }], nextCursor: undefined } as unknown as ScreeningGrid;
  const combined = appendGridPage(current, next);
  assert.equal(combined.columns, current.columns);
  assert.deepEqual(combined.rows.map(row => row.company_id), ["a", "b"]);
  assert.equal(combined.nextCursor, undefined);
  assert.throws(() => appendGridPage(current, { ...next, selectionRevision: 2 }), /changed while/);
  assert.throws(() => appendGridPage(current, current), /paging did not advance/);
});

test("description requests are bounded to a visible page and empty pages make no call", async () => {
  const prior = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.deepEqual(JSON.parse(String(init?.body)), { tool: "get_grid_descriptions", arguments: { run_id: "one", company_ids: ["a", "b"] }, analystApproved: false });
    return Response.json({ ok: true, result: { companies: [{ company_id: "a", sources: [] }] } });
  };
  try {
    assert.deepEqual(await fetchGridDescriptions("run-insurance", "one", []), []);
    assert.equal(calls, 0);
    assert.equal((await fetchGridDescriptions("run-insurance", "one", ["a", "b"])).length, 1);
    await assert.rejects(fetchGridDescriptions("run-insurance", "one", Array(501).fill("a")), /at most 500/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = prior; }
});
