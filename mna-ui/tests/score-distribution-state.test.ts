import assert from "node:assert/strict";
import test from "node:test";
import { belongsToTab, defaultMetric, toggleScoreBucket } from "../src/workspace/score-distribution-state";
import { filterRows, scoreBuckets } from "../src/grid/grid-filter";
import type { GridColumnSpec, BucketScheme } from "../src/grid/grid-types";
import type { RoundColumns } from "../src/lib/grid-client";

const scheme: BucketScheme = { type: "integer", min: 0, max: 10 };
const column: GridColumnSpec<unknown> = { id: "score", header: "Score", kind: "score", bucketScheme: scheme, value: (row) => row };
test("source tabs include both-source companies and preserve unknown-source rows in All", () => {
  assert.equal(belongsToTab("both", "MID"), true);
  assert.equal(belongsToTab("both", "ISCC"), true);
  assert.equal(belongsToTab("ISCC", "MID"), false);
  assert.equal(belongsToTab(null, "All"), true);
  assert.equal(belongsToTab(null, "MID"), false);
});
test("default metric follows source tabs and newest round with a fallback", () => {
  const columns = ["mid_semantic_score", "iscc_relevancy", "round:R1:score:fit", "round:R2:score:fit"].map((id) => ({ ...column, id }));
  const rounds = [1, 2].map((n) => ({ key: `R${n}`, round_no: n, provider: "llmsuite", provider_label: "LLM Suite", score_columns: ["fit"], output_columns: ["fit"] })) satisfies RoundColumns[];
  assert.equal(defaultMetric("All", columns, rounds), "round:R2:score:fit");
  assert.equal(defaultMetric("MID", columns, rounds), "mid_semantic_score");
  assert.equal(defaultMetric("ISCC", columns, rounds), "iscc_relevancy");
  assert.equal(defaultMetric("All", columns, []), "mid_semantic_score");
  assert.equal(defaultMetric("All", columns, [], { has_semantic: false, has_iscc: true }), "iscc_relevancy");
  assert.equal(defaultMetric("MID", columns, [], { has_semantic: false, has_iscc: true }), "mid_semantic_score");
  assert.equal(defaultMetric("All", [], []), undefined);
});
test("bar toggles preserve CHECK by default and switch a condition to buckets", () => {
  const filter = toggleScoreBucket(undefined, 7, scheme);
  assert.equal(filter.kind, "score");
  assert.deepEqual(filterRows([0, 7, 8, "CHECK", null], [column], { quick: "", columns: { score: filter } }), [0, 8, "CHECK"]);
  const condition = toggleScoreBucket({ kind: "score", op: "gte", a: 7, includeCheck: true }, 8, scheme);
  assert.deepEqual(filterRows([6, 7, 8, 9, "CHECK"], [column], { quick: "", columns: { score: condition } }), [7, 9, "CHECK"]);
  const withoutCheck = toggleScoreBucket(undefined, "CHECK", scheme);
  assert.deepEqual(filterRows([0, 7, "CHECK"], [column], { quick: "", columns: { score: withoutCheck } }), [0, 7]);
});
test("deselecting the final bucket shows no companies and can be toggled back", () => {
  const empty = toggleScoreBucket({ kind: "score", buckets: ["CHECK"], includeCheck: true }, "CHECK", scheme);
  assert.deepEqual(filterRows([0, 10, "CHECK", null], [column], { quick: "", columns: { score: empty } }), []);
  const again = toggleScoreBucket(empty, 7, scheme);
  assert.deepEqual(filterRows([7, 8, "CHECK"], [column], { quick: "", columns: { score: again } }), [7]);
});
test("chart counts ignore its own filter but follow other filters, include zeros and pin CHECK last", () => {
  const rows = [{ score: 7, source: "MID" }, { score: "CHECK", source: "MID" }, { score: 0, source: "ISCC" }];
  const scores: GridColumnSpec<typeof rows[number]> = { ...column, value: (row) => row.score };
  const source: GridColumnSpec<typeof rows[number]> = { id: "source", header: "Source", kind: "category", value: (row) => row.source };
  const filtered = filterRows(rows, [scores, source], { quick: "", columns: { score: { kind: "score", buckets: [7], includeCheck: true }, source: { kind: "category", values: ["MID"] } } }, { ignoreColumnId: "score" });
  const counts = scoreBuckets(filtered, scores, scheme);
  assert.equal(counts.length, 12);
  assert.equal(counts[0].count, 0);
  assert.equal(counts[7].count, 1);
  assert.deepEqual(counts.at(-1), { key: "CHECK", label: "CHECK", count: 1 });
});
test("semantic and relevancy use ten bins including the upper endpoint", () => {
  for (const max of [1, 10]) {
    const bins: BucketScheme = { type: "bins", min: 0, max, count: 10 };
    const counts = scoreBuckets([0, max, null], column, bins, false);
    assert.equal(counts.length, 10);
    assert.equal(counts[0].count, 1);
    assert.equal(counts[9].count, 1);
    assert.equal(counts.reduce((sum, bucket) => sum + bucket.count, 0), 2);
  }
});
