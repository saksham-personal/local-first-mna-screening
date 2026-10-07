import assert from "node:assert/strict";
import test from "node:test";
import {
  areFilteredRowsSelected,
  buildFilterChips,
  defaultVisibleColumnIds,
  readGridPreferences,
  serializeGridPreferences,
  setFilteredSelection,
} from "../src/grid/grid-state";
import { emptyFilterState } from "../src/grid/grid-filter";
import type { GridColumnSpec } from "../src/grid/grid-types";

type Row = { id: string; name: string; source: string };
const columns: GridColumnSpec<Row>[] = [
  { id: "name", header: "Company", kind: "text", value: (row) => row.name },
  { id: "source", header: "Source", kind: "category", value: (row) => row.source },
  {
    id: "internal",
    header: "Internal",
    kind: "category",
    value: (row) => row.id,
    hidden: true,
  },
];

test("default visible columns omit hidden columns", () => {
  assert.deepEqual(defaultVisibleColumnIds(columns), ["name", "source"]);
});

test("grid preferences sanitize stored columns and preserve an empty selection", () => {
  assert.deepEqual(
    readGridPreferences(columns, '{"visibleColumnIds":["source","unknown","source"],"sidePanelOpen":true}'),
    { visibleColumnIds: ["source"], sidePanelOpen: true },
  );
  assert.deepEqual(
    readGridPreferences(columns, '{"visibleColumnIds":[],"sidePanelOpen":false}', true),
    { visibleColumnIds: [], sidePanelOpen: false },
  );
  assert.deepEqual(
    readGridPreferences(columns, "{broken", true),
    { visibleColumnIds: ["name", "source"], sidePanelOpen: true },
  );
  assert.deepEqual(
    readGridPreferences(columns, '{"visibleColumnIds":["internal"],"sidePanelOpen":false}'),
    { visibleColumnIds: ["internal"], sidePanelOpen: false },
  );
});

test("grid preferences serialize the visible columns and side panel state", () => {
  const raw = serializeGridPreferences(["source"], true);
  assert.deepEqual(readGridPreferences(columns, raw), {
    visibleColumnIds: ["source"],
    sidePanelOpen: true,
  });
});

test("filter chips include active column filters but not quick search", () => {
  const state = emptyFilterState();
  state.quick = "search";
  state.columns.source = { kind: "category", values: ["MID"] };
  assert.deepEqual(buildFilterChips(columns, state), [
    { columnId: "source", label: "Source: MID" },
  ]);
});

test("filtered selection adds or removes visible rows and preserves other selections", () => {
  const visibleRows: Row[] = [
    { id: "a", name: "A", source: "MID" },
    { id: "b", name: "B", source: "ISCC" },
  ];
  const current = ["b", "hidden"];
  assert.deepEqual(
    setFilteredSelection(current, visibleRows, (row) => row.id, false),
    ["hidden"],
  );
  assert.deepEqual(
    setFilteredSelection(["hidden"], visibleRows, (row) => row.id, true),
    ["hidden", "a", "b"],
  );
  assert.equal(areFilteredRowsSelected(["hidden", "a", "b"], visibleRows, (row) => row.id), true);
  assert.equal(areFilteredRowsSelected(["hidden", "a"], visibleRows, (row) => row.id), false);
  assert.equal(areFilteredRowsSelected<Row>(["hidden"], [], (row) => row.id), false);
});
