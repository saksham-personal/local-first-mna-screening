import assert from "node:assert/strict";
import test from "node:test";
import { catalogColumnSpecs, hydrationFlag, readColumnChoice, requestedCatalogIds, visibleCatalogIds } from "../src/workspace/company-catalog";
import type { GridCatalogColumn, GridCompany } from "../src/lib/grid-client";

const catalog: GridCatalogColumn[] = [
  { id: "pb_description", label: "pb_description", group: "hydration", source: "derived", type: "text", default_visible: false },
  { id: "MID_Company Description", label: "MID_Company Description", group: "mid", source: "mid", type: "text", default_visible: true },
  { id: "Banker Name", label: "Banker Name", group: "coverage", source: "mid", type: "text", default_visible: true },
  { id: "MID_Keyword Score", label: "MID_Keyword Score", group: "scores", source: "derived", type: "score", default_visible: true },
  { id: "MID_Semantic Score", label: "MID_Semantic Score", group: "scores", source: "derived", type: "score", default_visible: true },
  { id: "ISCC_Score", label: "ISCC_Score", group: "scores", source: "derived", type: "score", default_visible: true },
  { id: "Company", label: "Company", group: "identity", source: "merged", type: "text", default_visible: true },
];

test("catalog mapping preserves analyst labels, group order, defaults and separate score scales", () => {
  const specs = catalogColumnSpecs(catalog);
  assert.deepEqual(specs.map(column => column.group), ["Identity", "Scores", "Scores", "Scores", "Coverage", "Hydration", "MID"]);
  assert.equal(specs.find(column => column.id === "MID_Company Description")?.header, "MID_Company Description");
  assert.equal(specs.find(column => column.id === "pb_description")?.hidden, true);
  assert.equal(specs.find(column => column.id === "Banker Name")?.group, "Coverage");
  assert.equal(specs.find(column => column.id === "Company")?.pinned, "left");
  assert.equal(specs.find(column => column.id === "MID_Keyword Score")?.bucketScheme?.max, 1);
  assert.equal(specs.find(column => column.id === "MID_Semantic Score")?.bucketScheme?.max, 10);
  assert.equal(specs.find(column => column.id === "ISCC_Score")?.bucketScheme?.max, 1);
  assert.ok(!specs.some(column => column.header === "MID keyword match %"));
  const row = { values: { "MID_Keyword Score": 0, "ISCC_Score": null } } as unknown as GridCompany;
  assert.equal(specs.find(column => column.id === "MID_Keyword Score")!.value(row), 0);
  assert.equal(specs.find(column => column.id === "ISCC_Score")!.value(row), null);
});

test("MID and ISCC views use the backend's unprefixed column labels", () => {
  for (const id of ["MID Score", "MID Semantic Score", "ISCC Score"]) {
    const [spec] = catalogColumnSpecs([{ id, label: id, group: "scores", source: "derived", type: "score", default_visible: true }]);
    assert.equal(spec.id, id);
    assert.equal(spec.header, id);
  }
});

test("picker state survives serialization, ignores retired ids and defaults newly introduced columns", () => {
  const saved = readColumnChoice(JSON.stringify({ visible: ["Company", "retired"], known: ["Company", "MID_Keyword Score", "pb_description"] }));
  assert.deepEqual(visibleCatalogIds(catalog, saved), ["MID_Company Description", "Banker Name", "MID_Semantic Score", "ISCC_Score", "Company"]);
  assert.equal(readColumnChoice("invalid"), undefined);
  assert.equal(readColumnChoice('{"visible":[1],"known":[]}'), undefined);
  assert.deepEqual(visibleCatalogIds(catalog, { visible: [], known: catalog.map(column => column.id) }), []);
  assert.deepEqual(visibleCatalogIds(catalog), catalog.filter(column => column.default_visible).map(column => column.id));
});

test("projection excludes hidden heavy fields and page descriptions but includes selected hydration text", () => {
  assert.deepEqual(requestedCatalogIds(catalog), ["Banker Name", "MID_Keyword Score", "MID_Semantic Score", "ISCC_Score", "Company"]);
  const choice = { visible: ["Company", "pb_description", "MID_Company Description"], known: catalog.map(column => column.id) };
  assert.deepEqual(requestedCatalogIds(catalog, choice), ["pb_description", "Company"]);
});

test("hydration chips read boolean category strings and keep missing flags null", () => {
  for (const value of [true, "true"]) assert.equal(hydrationFlag(value), true);
  for (const value of [false, "false"]) assert.equal(hydrationFlag(value), false);
  for (const value of [null, undefined, "", "-", "unknown"]) assert.equal(hydrationFlag(value), null);
});

test("hidden source scores remain available for the metric picker without requesting heavy fields", () => {
  const specs = catalogColumnSpecs(catalog);
  const row = { values: {}, mid_score: 0, mid_semantic_score: null, iscc_relevancy: 0.75 } as unknown as GridCompany;
  assert.equal(specs.find(column => column.id === "MID_Keyword Score")!.value(row), 0);
  assert.equal(specs.find(column => column.id === "MID_Semantic Score")!.value(row), null);
  assert.equal(specs.find(column => column.id === "ISCC_Score")!.value(row), 0.75);
});
