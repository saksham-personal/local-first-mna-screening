import test from "node:test";
import assert from "node:assert/strict";
import { buildCatalog, defaultScreeningConfig, validateConfig } from "../shared/screening.mjs";
import type { DataSource, ScreeningConfig, ScreeningSourceRow } from "../src/lib/screening-contract";
import {
  availableSources,
  columnSource,
  withAvailableSources,
  type SourceSignals,
} from "../src/screening/source-availability";

type Entry = SourceSignals["sources"][number];
const only = (...sources: Entry[]): SourceSignals => ({ sources });
const shown = (catalog: SourceSignals, source: DataSource) => availableSources(catalog).includes(source);

// A real catalog: MID has one company, every other source has no values.
const midRow: ScreeningSourceRow = {
  pk: "C-1",
  PBId: null,
  provenance: {},
  sources: { MID: { "Company Name": "Acme", Sector: "Software" }, ISCC: {}, PB: {}, ROGO: {} },
};
const midCatalog = buildCatalog([midRow]);

test("PitchBook stays hidden until the run has PitchBook data", () => {
  assert.equal(shown(only({ source: "PB", hydrated: false, companyCount: 0, fields: [{ count: 0 }] }), "PB"), false);
  assert.equal(shown(only({ source: "PB", hydrated: false, companyCount: 3 }), "PB"), true);
  assert.equal(shown(only({ source: "PB", hydrated: true, companyCount: 12, fields: [{ count: 12 }] }), "PB"), true);
});

test("MID and ISCC follow the run's counts when the catalog has them", () => {
  const catalog = only(
    { source: "MID", hydrated: false, companyCount: 0, fields: [{ count: 0 }] },
    { source: "ISCC", hydrated: true, companyCount: 4, fields: [{ count: 4 }] },
  );
  assert.equal(shown(catalog, "MID"), false);
  assert.equal(shown(catalog, "ISCC"), true);
});

test("without run counts, MID and ISCC show only when one of their fields has a value", () => {
  assert.equal(shown(only({ source: "MID", fields: [{ count: 0 }, { count: 2 }] }), "MID"), true);
  assert.equal(shown(only({ source: "ISCC", fields: [{ count: 0 }] }), "ISCC"), false);
});

test("a source with no signal stays visible, and so does a source missing from the catalog", () => {
  assert.equal(shown(only({ source: "BING" }), "BING"), true);
  assert.equal(shown(only({ source: "RESULTS", fields: [] }), "RESULTS"), true);
  assert.deepEqual(availableSources({ sources: [] }), ["MID", "ISCC", "PB", "ROGO", "RESULTS", "BING"]);
});

test("a real catalog offers only the sources with data, in picker order", () => {
  assert.deepEqual(availableSources(midCatalog), ["MID"]);
  const pbAndBing = buildCatalog([{
    pk: "C-2",
    PBId: "PB-9",
    provenance: {},
    sources: { MID: {}, ISCC: {}, PB: { PB_Name: "Beta" }, ROGO: {}, BING: { Answer: "Yes" } },
  }]);
  assert.deepEqual(availableSources(pbAndBing), ["PB", "BING"]);
});

test("identity defaults keep PB, MID, ISCC order and drop sources with no data", () => {
  const defaults = defaultScreeningConfig("copilot", "screening", "criteria");
  assert.deepEqual(withAvailableSources(defaults, ["ISCC", "PB"]).identitySources, {
    name: ["PB", "ISCC"],
    website: ["PB", "ISCC"],
    description: ["PB", "ISCC"],
  });
  assert.deepEqual(withAvailableSources(defaults, []).identitySources, { name: [], website: [], description: [] });
});

test("a saved setup drops references to sources with no data silently and passes server validation", () => {
  const saved: ScreeningConfig = {
    ...defaultScreeningConfig("llm_suite", "screening", "criteria"),
    model: "deployment",
    identitySources: { name: ["PB", "MID"], website: ["ISCC", "PB"], description: ["PB", "MID", "ISCC"] },
    inputColumns: ["index", "PB:Revenue", "MID:Sector", "PBId"],
  };
  // Without the drop, the server rejects the stale PitchBook column.
  assert.throws(() => validateConfig(saved, midCatalog), /no longer available/);

  const limited = withAvailableSources(saved, availableSources(midCatalog));
  assert.deepEqual(limited.identitySources, { name: ["MID"], website: [], description: ["MID"] });
  assert.deepEqual(limited.inputColumns, ["index", "MID:Sector", "PBId"]);
  assert.deepEqual(saved.identitySources.name, ["PB", "MID"], "the saved setup itself is not changed");

  const accepted = validateConfig(limited, midCatalog);
  assert.deepEqual(accepted.identitySources, { name: ["MID"], website: [], description: ["MID"] });
  assert.deepEqual(accepted.inputColumns, ["index", "MID:Sector", "PBId"]);
});

test("the default setup for a visible source passes server validation", () => {
  const defaults = defaultScreeningConfig("copilot", "screening", "criteria");
  const config = withAvailableSources({ ...defaults, model: "deployment" }, availableSources(midCatalog));
  assert.deepEqual(validateConfig(config, midCatalog).identitySources, { name: ["MID"], website: ["MID"], description: ["MID"] });
});

test("columns name their source by prefix; index and identifier columns have none", () => {
  assert.equal(columnSource("PB:Revenue"), "PB");
  assert.equal(columnSource("RESULTS:Fit Score"), "RESULTS");
  assert.equal(columnSource("index"), undefined);
  assert.equal(columnSource("PBId"), undefined);
  assert.equal(columnSource("Foo:Bar"), undefined);
});
