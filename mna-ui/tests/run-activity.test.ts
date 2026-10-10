import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRunCancelRequest, createOutcomeOnceGuard, mapBingJobToActivity, mapScreeningJobToActivity } from "../src/lib/run-activity";

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
