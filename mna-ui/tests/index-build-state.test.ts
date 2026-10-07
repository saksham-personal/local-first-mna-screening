import assert from "node:assert/strict";
import test from "node:test";
import { buildEtaText, defaultBundleName, elapsedText, etaText, isActiveBuild, overallPercent, stepPercent, stepPresentation } from "../src/index/index-build-state";
import type { BuildStep, IndexBuild } from "../src/index/index-build-client";
const ids = ["read_workbook", "validate_headers", "normalize_identifiers", "store_rows", "keyword_index", "semantic_embeddings", "verify", "activate"];
function step(id: string, status: BuildStep["status"] = "pending", rows_done = 0, rows_total: number | null = null): BuildStep {
  return { id, label: id, status, rows_done, rows_total, started_at: null, finished_at: null, rate_per_sec: null, eta_seconds: null, detail: null };
}
test("weighted build progress includes skipped work and clamps row progress", () => {
  assert.equal(overallPercent(ids.map(id => step(id))), 0);
  assert.equal(overallPercent(ids.map(id => step(id, "done"))), 100);
  assert.equal(overallPercent(ids.map(id => step(id, "skipped"))), 100);
  assert.equal(overallPercent(ids.map(id => step(id, id === "store_rows" ? "running" : "pending", 50, 100))), 25);
  assert.equal(overallPercent(ids.map(id => step(id, ["keyword_index", "semantic_embeddings"].includes(id) ? "skipped" : "pending"))), 40);
  assert.equal(stepPercent(step("store_rows", "running", 200, 100)), 100);
  assert.equal(stepPercent(step("store_rows", "running", -1, 100)), 0);
  assert.equal(stepPercent(step("read_workbook", "running")), 0);
});
test("ETA and elapsed text handle missing, invalid and short estimates", () => {
  assert.equal(etaText(null), "—"); assert.equal(etaText(NaN), "—"); assert.equal(etaText(-1), "—");
  assert.equal(etaText(59), "under a minute left"); assert.equal(etaText(180), "about 3 min left");
  assert.equal(elapsedText(null), "—"); assert.equal(elapsedText("bad"), "—");
  assert.equal(elapsedText("2026-10-07T10:00:00Z", "2026-10-07T10:03:12Z"), "3m 12s");
  assert.equal(elapsedText("2026-10-07T10:00:00Z", null, Date.parse("2026-10-07T10:00:12Z")), "12s");
  assert.equal(elapsedText("2026-10-07T10:00:00Z", "2026-10-07T09:00:00Z"), "0s");
});
test("activity is running only for queued/running and ETA uses the running step", () => {
  for (const status of ["queued", "running", "succeeded", "failed", "cancelled", "interrupted"] as const) assert.equal(isActiveBuild({ status }), status === "running" || status === "queued");
  assert.equal(isActiveBuild(null), false);
  const build = { status: "running", steps: [{ ...step("store_rows", "running"), eta_seconds: 120 }] } as IndexBuild;
  assert.equal(buildEtaText(build), "about 2 min left");
  assert.equal(buildEtaText({ ...build, status: "succeeded" }), "—");
  assert.equal(buildEtaText({ ...build, current_step: "store_rows", steps: [step("normalize_identifiers", "running"), ...build.steps] }), "about 2 min left");
  for (const status of ["pending", "running", "done", "skipped", "failed"] as const) assert.ok(stepPresentation(status).label);
  assert.equal(stepPresentation("skipped").icon, "minus");
});
test("bundle names preserve descriptive names and date generic workbooks", () => {
  const date = new Date(2026, 9, 7);
  assert.equal(defaultBundleName("MID.xlsx", date), "MID 2026-10-07");
  assert.equal(defaultBundleName("export.xlsx", date), "MID 2026-10-07");
  assert.equal(defaultBundleName("Insurance_Companies.XLSX", date), "Insurance Companies");
  assert.equal(defaultBundleName("a".repeat(140) + ".xlsx", date).length, 120);
});
