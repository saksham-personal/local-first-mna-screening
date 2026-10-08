import test from "node:test";
import assert from "node:assert/strict";
import { hasPitchBookData } from "../src/lib/screening-client";
import type { ScreeningCatalog } from "../src/lib/screening-contract";

test("LinkedIn is offered after run-wide PitchBook hydration, even outside the sample", () => {
  const source = { source: "PB" as const, label: "PitchBook", hydrated: false, companyCount: 0, fields: [] };
  const catalog: ScreeningCatalog = { total: 5613, sources: [source] };
  assert.equal(hasPitchBookData(catalog), false);
  source.hydrated = true;
  source.companyCount = 1;
  assert.equal(hasPitchBookData(catalog), true);
  source.companyCount = 0;
  assert.equal(hasPitchBookData(catalog), false);
  assert.equal(hasPitchBookData({ total: 5613, sources: [] }), false);
});
