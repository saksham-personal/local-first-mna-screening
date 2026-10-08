import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createGridRuntime } from "../src/grid/grid-runtime";
import { catalogColumnSpecs } from "../src/workspace/company-catalog";

test("typing publishes header state without replacing the catalog or column specs", () => {
  const columns = catalogColumnSpecs([{ id: "Company", label: "Company", group: "identity", source: "merged", type: "text", default_visible: true }]);
  const runtime = createGridRuntime({ columns, filterText: "" });
  const definition = { colId: columns[0].id, headerComponentParams: { gridColumn: columns[0], runtime } };
  let notifications = 0;
  const unsubscribe = runtime.subscribe(() => notifications++);
  for (const filterText of ["c", "cl", "cla", "clai", "claims"]) runtime.publish({ columns, filterText });
  assert.equal(runtime.getSnapshot().filterText, "claims");
  assert.equal(runtime.getSnapshot().columns, columns);
  assert.equal(definition.headerComponentParams.gridColumn, columns[0]);
  assert.equal(definition.headerComponentParams.runtime, runtime);
  assert.equal(notifications, 5);
  runtime.publish(runtime.getSnapshot());
  assert.equal(notifications, 5);
  unsubscribe();
  runtime.publish({ columns, filterText: "claim" });
  assert.equal(notifications, 5);
});

test("AG Grid column-def memo excludes changing filters, sorting, selection and streamed rows", () => {
  const source = readFileSync(new URL("../src/grid/DataGrid.tsx", import.meta.url), "utf8");
  const memo = source.slice(source.indexOf("const columnDefs = useMemo"), source.indexOf("const pageCallbackRef"));
  assert.match(memo, /\}, \[selectable, visibleColumns, groupHeaders, headerRuntime\]\)/);
  assert.doesNotMatch(memo, /filterState[,:]|sortState[,:]|selectedIds[,:]|rows[,:]/);
  assert.match(source, /headerRuntime\.publish\(\{ rows, columns, filterState/);
});
