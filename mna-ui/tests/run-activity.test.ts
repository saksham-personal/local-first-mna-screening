import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRunCancelRequest, createOutcomeOnceGuard, mapBingJobToActivity, mapScreeningJobToActivity, processedUnit } from "../src/lib/run-activity";

const screening = {
  id: "plan-1", planId: "plan-1", runId: "run-1", sessionId: "session-1", digest: "digest",
  title: "LLM Suite screening · Insurance software", provider: "llm_suite" as const, state: "running" as const,
  total: 4, completed: 1, failed: 1, running: 1, staged: 0, current: true, observedAt: "2026-01-01T00:00:00.000Z",
  steps: [
    { id: "input", label: "Build input table", state: "completed" },
    { id: "send", label: "Send batches · 2 of 4", state: "running" },
    { id: "parse", label: "Parse results", state: "queued" },
  ],
  errors: [{ batch: 4, message: "Provider interrupted", retryable: true }],
};

const bing = {
  id: "job-1", kind: "bing" as const, runId: "run-1", sessionId: "session-1", planId: "plan-1",
  title: "Bing research · Insurance software", state: "running" as const,
  steps: [
    { id: "approve", label: "Approve plan", state: "completed" },
    { id: "send", label: "Send queries · 1 of 3", state: "running" },
    { id: "save", label: "Save observations", state: "queued" },
  ],
  processedQueries: 1, queryCount: 3, failedQueries: 0,
  startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
};

test("Activity mapper presents screening progress, steps, and controls per state", () => {
  const running = mapScreeningJobToActivity(screening, { now: Date.parse("2026-01-01T00:00:05.000Z") });
  assert.equal(running.processed, 2);
  assert.equal(running.percent, 50);
  assert.deepEqual(running.actions, ["pause", "cancel"]);
  assert.deepEqual(running.steps.map(step => step.state), ["done", "running", "pending"]);
  assert.equal(running.elapsedMs, 5000);

  assert.deepEqual(mapScreeningJobToActivity({ ...screening, state: "paused" }).actions, ["resume", "cancel"]);
  assert.deepEqual(mapScreeningJobToActivity({ ...screening, state: "error", completed: 2 }).actions, ["retry", "stage", "dismiss"]);
  assert.deepEqual(mapScreeningJobToActivity({ ...screening, state: "cancelled", completed: 2, message: "Cancelled; processed results were discarded." }).actions, ["dismiss"]);
  const cancelled = mapScreeningJobToActivity({ ...screening, state: "cancelled", total: 288, completed: 7, failed: 281 });
  assert.equal(cancelled.processed, 7);
  assert.equal(cancelled.percent, 7 / 288 * 100);
});

test("Activity mapper presents Bing progress, steps, and controls per state", () => {
  const running = mapBingJobToActivity(bing, { now: Date.parse("2026-01-01T00:00:05.000Z") });
  assert.ok(Math.abs(running.percent - 100 / 3) < 0.000001);
  assert.deepEqual(running.actions, ["pause", "cancel"]);
  assert.deepEqual(running.steps.map(step => step.state), ["done", "running", "pending"]);
  assert.deepEqual(mapBingJobToActivity({ ...bing, state: "paused" }).actions, ["resume", "cancel"]);
  assert.deepEqual(mapBingJobToActivity({ ...bing, state: "completed" }).actions, ["open", "dismiss"]);
  assert.deepEqual(mapBingJobToActivity({ ...bing, state: "cancelled" }).actions, ["dismiss"]);
});

test("cancel request builder preserves both keep choices", () => {
  assert.deepEqual(buildRunCancelRequest("plan-1", true), { planId: "plan-1", keep: true });
  assert.deepEqual(buildRunCancelRequest("plan-1", false), { planId: "plan-1", keep: false });
});

test("outcome guard claims once and persists completed job IDs", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const guard = createOutcomeOnceGuard(storage);
  assert.equal(guard.claim("job-1"), true);
  assert.equal(guard.claim("job-1"), false);
  guard.release("job-1");
  assert.equal(guard.claim("job-1"), true);
  guard.complete("job-1");
  const reloaded = createOutcomeOnceGuard(storage);
  assert.equal(reloaded.has("job-1"), true);
  assert.equal(reloaded.claim("job-1"), false);
});

test("finished, paused, blocked, and stopped screening runs freeze elapsed time at their last update", () => {
  const later = Date.parse("2026-01-01T01:00:00.000Z");
  const settled = { ...screening, startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:02:30.000Z" };
  for (const state of ["completed", "error", "cancelled", "paused", "blocked"] as const) {
    assert.equal(mapScreeningJobToActivity({ ...settled, state }, { now: later }).elapsedMs, 150_000, state);
  }
  // Without an update time, the current clock is the only reading available.
  assert.equal(mapScreeningJobToActivity({ ...settled, state: "completed", updatedAt: undefined }, { now: later }).elapsedMs, 3_600_000);
});

test("finished, paused, and stopped Bing runs freeze elapsed time at their last update", () => {
  const later = Date.parse("2026-01-01T01:00:00.000Z");
  for (const state of ["completed", "failed", "cancelled", "paused"] as const) {
    assert.equal(mapBingJobToActivity({ ...bing, state, updatedAt: "2026-01-01T00:00:45.000Z" }, { now: later }).elapsedMs, 45_000, state);
  }
});

test("queued and cancelling runs keep ticking against the clock", () => {
  const later = Date.parse("2026-01-01T00:00:09.000Z");
  assert.equal(mapScreeningJobToActivity({ ...screening, state: "cancelling", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z" }, { now: later }).elapsedMs, 9_000);
  assert.equal(mapBingJobToActivity({ ...bing, state: "queued", updatedAt: "2026-01-01T00:00:01.000Z" }, { now: later }).elapsedMs, 9_000);
});

test("progress labels name each source's unit with the right plural", () => {
  assert.equal(processedUnit("bing", 1), "1 query");
  assert.equal(processedUnit("bing", 28712), `${(28712).toLocaleString()} queries`);
  assert.equal(processedUnit("screening", 1), "1 batch");
  assert.equal(processedUnit("screening", 4), "4 batches");
});
