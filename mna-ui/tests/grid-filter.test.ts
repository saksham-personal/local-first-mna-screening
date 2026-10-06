import assert from "node:assert/strict";
import test from "node:test";
import {
  BLANK_LABEL,
  activeFilterCount,
  bucketLabel,
  bucketOf,
  compareRows,
  defaultFilter,
  describeFilter,
  distinctValues,
  emptyFilterState,
  filterRows,
  isBlank,
  isFilterActive,
  normalizeValue,
  parseScore,
  rowPassesColumn,
  rowPassesQuick,
  scoreBuckets,
  sortRows,
} from "../src/grid/grid-filter";
import type { BucketScheme, ColumnFilter, GridColumnSpec } from "../src/grid/grid-types";

type Row = {
  name: unknown;
  amount: unknown;
  score: unknown;
  day: unknown;
  source: unknown;
  hidden: unknown;
};

const nameColumn: GridColumnSpec<Row> = { id: "name", header: "Name", kind: "text", value: (row) => row.name };
const amountColumn: GridColumnSpec<Row> = { id: "amount", header: "Revenue", kind: "number", value: (row) => row.amount };
const scoreColumn: GridColumnSpec<Row> = { id: "score", header: "Score", kind: "score", value: (row) => row.score };
const dayColumn: GridColumnSpec<Row> = { id: "day", header: "Date", kind: "date", value: (row) => row.day };
const sourceColumn: GridColumnSpec<Row> = { id: "source", header: "Source", kind: "category", value: (row) => row.source };
const hiddenColumn: GridColumnSpec<Row> = { id: "hidden", header: "Internal note", kind: "text", hidden: true, value: (row) => row.hidden };
const columns = [nameColumn, amountColumn, scoreColumn, dayColumn, sourceColumn, hiddenColumn];
const row = (overrides: Partial<Row> = {}): Row => ({ name: "", amount: "", score: "", day: "", source: "", hidden: "", ...overrides });

test("blank detection and checklist normalization handle blank and numeric values", () => {
  assert.equal(isBlank(null), true);
  assert.equal(isBlank(undefined), true);
  assert.equal(isBlank("  \t"), true);
  assert.equal(isBlank(0), false);
  assert.equal(normalizeValue("  Acme  "), "Acme");
  assert.equal(normalizeValue(12), "12");
  assert.equal(normalizeValue("  "), "");
});

test("score parsing recognizes CHECK without case or surrounding-space sensitivity", () => {
  assert.equal(parseScore("check"), "CHECK");
  assert.equal(parseScore(" CHECK "), "CHECK");
  assert.equal(parseScore("7.5"), 7.5);
  assert.equal(parseScore(0), 0);
  assert.equal(parseScore(""), null);
  assert.equal(parseScore("10.1"), null);
  assert.equal(parseScore("4/10"), null);
});

test("number filters implement every operator and parse formatted numeric strings", () => {
  const passes = (value: unknown, filter: ColumnFilter) => rowPassesColumn(row({ amount: value }), amountColumn, filter);
  assert.equal(passes("$1,234.50", { kind: "number", op: "gt", a: 1000 }), true);
  assert.equal(passes(4, { kind: "number", op: "gt", a: 4 }), false);
  assert.equal(passes(4, { kind: "number", op: "gte", a: 4 }), true);
  assert.equal(passes(3, { kind: "number", op: "lt", a: 4 }), true);
  assert.equal(passes(4, { kind: "number", op: "lte", a: 4 }), true);
  assert.equal(passes("4", { kind: "number", op: "eq", a: 4 }), true);
  assert.equal(passes(5, { kind: "number", op: "neq", a: 4 }), true);
  assert.equal(passes(5, { kind: "number", op: "between", a: 8, b: 5 }), true);
  assert.equal(passes(4, { kind: "number", op: "between", a: 5, b: 8 }), false);
  assert.equal(passes("", { kind: "number", op: "blank" }), true);
  assert.equal(passes(0, { kind: "number", op: "blank" }), false);
  assert.equal(passes("3", { kind: "number", op: "notBlank" }), true);
  assert.equal(passes("  ", { kind: "number", op: "notBlank" }), false);
  assert.equal(passes("", { kind: "number", op: "neq", a: 5 }), false);
});

test("number checklists combine with operators and incomplete operators are ignored", () => {
  const passes = (value: unknown, filter: ColumnFilter) => rowPassesColumn(row({ amount: value }), amountColumn, filter);
  assert.equal(passes("10", { kind: "number", values: ["10"] }), true);
  assert.equal(passes(10, { kind: "number", values: ["11"] }), false);
  assert.equal(passes("10", { kind: "number", values: ["10"], op: "gt", a: 10 }), false);
  assert.equal(passes("", { kind: "number", op: "gt" }), true);
  assert.equal(passes(10, { kind: "number", op: "between", a: 5 }), true);
  assert.equal(isFilterActive({ kind: "number", op: "gt" }), false);
});

test("score defaults include CHECK while includeCheck false excludes it", () => {
  const defaultScoreFilter = defaultFilter("score");
  assert.deepEqual(defaultScoreFilter, { kind: "score", includeCheck: true });
  assert.equal(rowPassesColumn(row({ score: "CHECK" }), scoreColumn, defaultScoreFilter), true);
  assert.equal(rowPassesColumn(row({ score: "" }), scoreColumn, defaultScoreFilter), true);
  assert.equal(rowPassesColumn(row({ score: "CHECK" }), scoreColumn, { kind: "score", includeCheck: false }), false);
  assert.equal(rowPassesColumn(row({ score: 7 }), scoreColumn, { kind: "score", includeCheck: false }), true);
  assert.equal(isFilterActive(defaultScoreFilter), false);
  assert.equal(isFilterActive({ kind: "score", includeCheck: false }), true);
});

test("score filters implement numeric operators and keep CHECK separate", () => {
  const passes = (value: unknown, filter: ColumnFilter) => rowPassesColumn(row({ score: value }), scoreColumn, filter);
  assert.equal(passes(8, { kind: "score", op: "gt", a: 7, includeCheck: false }), true);
  assert.equal(passes(7, { kind: "score", op: "gte", a: 7, includeCheck: false }), true);
  assert.equal(passes(6, { kind: "score", op: "lt", a: 7, includeCheck: false }), true);
  assert.equal(passes(7, { kind: "score", op: "lte", a: 7, includeCheck: false }), true);
  assert.equal(passes("7", { kind: "score", op: "eq", a: 7, includeCheck: false }), true);
  assert.equal(passes(8, { kind: "score", op: "neq", a: 7, includeCheck: false }), true);
  assert.equal(passes(7, { kind: "score", op: "between", a: 8, b: 6, includeCheck: false }), true);
  assert.equal(passes(" CHECK ", { kind: "score", op: "gt", a: 7, includeCheck: true }), true);
  assert.equal(passes("check", { kind: "score", op: "gt", a: 7, includeCheck: false }), false);
  assert.equal(passes("", { kind: "score", op: "gt", includeCheck: true }), true);
  assert.equal(passes("", { kind: "score", op: "gt", a: 7, includeCheck: true }), false);
  assert.equal(passes("", { kind: "score", op: "blank", includeCheck: false }), true);
  assert.equal(passes(7, { kind: "score", op: "blank", includeCheck: true }), false);
  assert.equal(passes("malformed", { kind: "score", op: "notBlank", includeCheck: false }), true);
});

test("score bucket checklists match numeric buckets and CHECK independently", () => {
  const filter: ColumnFilter = { kind: "score", buckets: [7, "CHECK"], includeCheck: false };
  assert.equal(rowPassesColumn(row({ score: 7 }), scoreColumn, filter), true);
  assert.equal(rowPassesColumn(row({ score: "CHECK" }), scoreColumn, filter), true);
  assert.equal(rowPassesColumn(row({ score: "check" }), scoreColumn, { kind: "score", buckets: [7], includeCheck: true }), false);
  assert.equal(rowPassesColumn(row({ score: "" }), scoreColumn, { kind: "score", buckets: [7, "CHECK"], includeCheck: true }), false);
  assert.equal(bucketOf(" CHECK ", { type: "integer", min: 0, max: 10 }), "CHECK");
  assert.equal(bucketOf(" ", { type: "integer", min: 0, max: 10 }), null);
});

test("bin buckets include lower and upper edges and clamp out-of-range values", () => {
  const bins: BucketScheme = { type: "bins", min: 0, max: 1, count: 10 };
  assert.equal(bucketOf(0, bins), 0);
  assert.equal(bucketOf(0.3, bins), 3);
  assert.equal(bucketOf(1, bins), 9);
  assert.equal(bucketOf(-0.2, bins), 0);
  assert.equal(bucketOf(2, bins), 9);
});

test("integer buckets round to the nearest integer and clamp", () => {
  const integer: BucketScheme = { type: "integer", min: 0, max: 10 };
  assert.equal(bucketOf(6.5, integer), 7);
  assert.equal(bucketOf(6.4, integer), 6);
  assert.equal(bucketOf(-3, integer), 0);
  assert.equal(bucketOf(14, integer), 10);
});

test("bucket labels use integer keys and readable bin ranges", () => {
  assert.equal(bucketLabel(7, { type: "integer", min: 0, max: 10 }), "7");
  assert.equal(bucketLabel("CHECK", { type: "integer", min: 0, max: 10 }), "CHECK");
  assert.equal(bucketLabel(3, { type: "bins", min: 0, max: 1, count: 10 }), "0.3–0.4");
  assert.equal(bucketLabel(3, { type: "bins", min: 0, max: 10, count: 10 }), "3–4");
});

test("score histograms contain every bucket in order and put CHECK last", () => {
  const histogramColumn: GridColumnSpec<{ score: unknown }> = {
    id: "score", header: "Score", kind: "score", value: (item) => item.score,
  };
  const buckets = scoreBuckets([{ score: 0 }, { score: 6.5 }, { score: "CHECK" }, { score: "check" }, { score: "" }], histogramColumn, { type: "integer", min: 0, max: 10 });
  assert.equal(buckets.length, 12);
  assert.deepEqual(buckets.slice(0, 3).map(({ key, count }) => [key, count]), [[0, 1], [1, 0], [2, 0]]);
  assert.deepEqual(buckets.at(-1), { key: "CHECK", label: "CHECK", count: 2 });
  assert.deepEqual(scoreBuckets([{ score: "CHECK" }], histogramColumn, { type: "bins", min: 0, max: 1, count: 2 }, false), [
    { key: 0, label: "0–0.5", count: 0 },
    { key: 1, label: "0.5–1", count: 0 },
  ]);
});

test("date filters implement on, before, after, between, blank, and notBlank", () => {
  const passes = (value: unknown, filter: ColumnFilter) => rowPassesColumn(row({ day: value }), dayColumn, filter);
  assert.equal(passes("2024-04-04T01:30:00+02:00", { kind: "date", op: "on", a: "2024-04-03" }), true);
  assert.equal(passes("2024-04-04", { kind: "date", op: "on", a: "2024-04-03" }), false);
  assert.equal(passes("2024-04-03T23:59:59Z", { kind: "date", op: "before", a: "2024-04-04" }), true);
  assert.equal(passes("2024-04-04", { kind: "date", op: "before", a: "2024-04-04" }), false);
  assert.equal(passes("2024-04-04T00:00:01Z", { kind: "date", op: "after", a: "2024-04-04" }), true);
  assert.equal(passes("2024-04-04", { kind: "date", op: "after", a: "2024-04-04" }), false);
  assert.equal(passes("2024-04-03", { kind: "date", op: "between", a: "2024-04-05", b: "2024-04-03" }), true);
  assert.equal(passes("2024-04-06", { kind: "date", op: "between", a: "2024-04-03", b: "2024-04-05" }), false);
  assert.equal(passes("", { kind: "date", op: "blank" }), true);
  assert.equal(passes("2024-04-03", { kind: "date", op: "blank" }), false);
  assert.equal(passes("unparseable", { kind: "date", op: "notBlank" }), true);
  assert.equal(passes("", { kind: "date", op: "notBlank" }), false);
});

test("date operators with missing operands are ignored", () => {
  const passes = (value: unknown, filter: ColumnFilter) => rowPassesColumn(row({ day: value }), dayColumn, filter);
  assert.equal(passes("", { kind: "date", op: "before" }), true);
  assert.equal(passes("2024-04-03", { kind: "date", op: "between", a: "2024-04-01" }), true);
  assert.equal(isFilterActive({ kind: "date", op: "after" }), false);
  assert.equal(isFilterActive({ kind: "date", op: "between", a: "2024-04-01" }), false);
});

test("text and category filters apply contains and checklist matching", () => {
  assert.equal(rowPassesColumn(row({ name: "Acme Holdings" }), nameColumn, { kind: "text", contains: "ACME" }), true);
  assert.equal(rowPassesColumn(row({ name: "Acme Holdings" }), nameColumn, { kind: "text", contains: "acme", values: ["Acme Holdings"] }), true);
  assert.equal(rowPassesColumn(row({ name: "Acme Holdings" }), nameColumn, { kind: "text", contains: "acme", values: ["Other"] }), false);
  assert.equal(rowPassesColumn(row({ source: " MID " }), sourceColumn, { kind: "category", values: ["MID"] }), true);
  assert.equal(rowPassesColumn(row({ source: "ISCC" }), sourceColumn, { kind: "category", values: [] }), true);
});

test("distinct values put blanks first, sort numeric-aware, count, and search labels", () => {
  const rows = ["10", "2", "Banana", "apple", undefined, "", "2"].map((name) => row({ name }));
  assert.deepEqual(distinctValues(rows, nameColumn), [
    { value: "", label: BLANK_LABEL, count: 2 },
    { value: "2", label: "2", count: 2 },
    { value: "10", label: "10", count: 1 },
    { value: "apple", label: "apple", count: 1 },
    { value: "Banana", label: "Banana", count: 1 },
  ]);
  assert.deepEqual(distinctValues(rows, nameColumn, "APP"), [{ value: "apple", label: "apple", count: 1 }]);
  assert.deepEqual(distinctValues(rows, nameColumn, "blanks"), [{ value: "", label: BLANK_LABEL, count: 2 }]);
});

test("quick search checks hidden columns and is case-insensitive", () => {
  const item = row({ name: "Visible Company", hidden: "Confidential Tag" });
  assert.equal(rowPassesQuick(item, columns, "confidential"), true);
  assert.equal(rowPassesQuick(item, columns, "VISIBLE"), true);
  assert.equal(rowPassesQuick(item, columns, "missing"), false);
  assert.equal(rowPassesQuick(item, columns, "   "), true);
});

test("filterRows combines quick and column filters and can ignore one facet filter", () => {
  const rows = [
    row({ name: "Acme One", source: "MID" }),
    row({ name: "Acme Two", source: "ISCC" }),
    row({ name: "Other", source: "MID" }),
  ];
  const state = { quick: "acme", columns: { source: { kind: "category", values: ["MID"] } as ColumnFilter } };
  assert.deepEqual(filterRows(rows, columns, state).map((item) => item.name), ["Acme One"]);
  assert.deepEqual(filterRows(rows, columns, state, { ignoreColumnId: "source" }).map((item) => item.name), ["Acme One", "Acme Two"]);
  assert.deepEqual(filterRows(rows, columns, state, { ignoreColumnId: "name" }).map((item) => item.name), ["Acme One"]);
});

test("score sorting keeps CHECK then blanks last in both directions", () => {
  const sortColumn: GridColumnSpec<{ id: string; score: unknown }> = {
    id: "score", header: "Score", kind: "score", value: (item) => item.score,
  };
  const rows = [
    { id: "blank", score: " " },
    { id: "check", score: " CHECK " },
    { id: "two-a", score: 2 },
    { id: "ten", score: "10" },
    { id: "two-b", score: 2 },
  ];
  assert.deepEqual(sortRows(rows, [sortColumn], { columnId: "score", direction: "asc" }).map(({ id }) => id), ["two-a", "two-b", "ten", "check", "blank"]);
  assert.deepEqual(sortRows(rows, [sortColumn], { columnId: "score", direction: "desc" }).map(({ id }) => id), ["ten", "two-a", "two-b", "check", "blank"]);
  assert.ok(compareRows({ id: "check", score: "check" }, { id: "blank", score: null }, sortColumn, "desc") < 0);
});

test("sortRows is stable and always returns a copy", () => {
  const sortColumn: GridColumnSpec<{ id: number; amount: unknown }> = {
    id: "amount", header: "Revenue", kind: "number", value: (item) => item.amount,
  };
  const rows = [{ id: 1, amount: 5 }, { id: 2, amount: 5 }, { id: 3, amount: 2 }];
  const sorted = sortRows(rows, [sortColumn], { columnId: "amount", direction: "asc" });
  assert.deepEqual(sorted.map(({ id }) => id), [3, 1, 2]);
  assert.notEqual(sorted, rows);
  const copied = sortRows(rows, [sortColumn], null);
  assert.deepEqual(copied, rows);
  assert.notEqual(copied, rows);
});

test("filter activity and counts include quick search but ignore default and incomplete filters", () => {
  assert.deepEqual(emptyFilterState(), { quick: "", columns: {} });
  const state = {
    quick: " Acme ",
    columns: {
      score: { kind: "score", includeCheck: true } as ColumnFilter,
      amount: { kind: "number", op: "gt" } as ColumnFilter,
      source: { kind: "category", values: ["MID"] } as ColumnFilter,
      day: { kind: "date", op: "notBlank" } as ColumnFilter,
    },
  };
  assert.equal(activeFilterCount(state), 3);
  assert.equal(activeFilterCount({ quick: "  ", columns: {} }), 0);
  assert.equal(isFilterActive({ kind: "score", includeCheck: true }), false);
  assert.equal(isFilterActive({ kind: "score", includeCheck: false }), true);
});

test("filter descriptions match the shared chip wording", () => {
  assert.equal(describeFilter(scoreColumn, { kind: "score", op: "gte", a: 7, includeCheck: true }), "Score: ≥ 7 + CHECK");
  assert.equal(describeFilter(scoreColumn, { kind: "score", buckets: [8, 7, "CHECK"], includeCheck: false }), "Score: 7, 8, CHECK");
  assert.equal(describeFilter(sourceColumn, { kind: "category", values: ["MID", "ISCC"] }), "Source: MID, ISCC");
  assert.equal(describeFilter(nameColumn, { kind: "text", contains: "acme" }), "Name contains acme");
  assert.equal(describeFilter(amountColumn, { kind: "number", op: "between", a: 20, b: 10 }), "Revenue: 10–20");
  assert.equal(describeFilter(dayColumn, { kind: "date", op: "on", a: "2024-04-03" }), "Date: on 2024-04-03");
});
