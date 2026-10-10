import test from "node:test";
import assert from "node:assert/strict";
import { buildCollapsedTurnLine, buildLoopCancelRequest, buildLoopStartRequest, buildLoopSummaryViewModel, LOOP_OUTCOMES_KEY, readLoopToggle, writeLoopToggle } from "../src/lib/loop-client";
import { createOutcomeOnceGuard, mapLoopJobToActivity, type LoopActivityJob } from "../src/lib/run-activity";

const loop = (overrides: Partial<LoopActivityJob> = {}): LoopActivityJob => ({
  id: "loop-1", kind: "loop", runId: "run-1", sessionId: "session-1", title: "Loop · Insurance",
  state: "running", turn: 3, maxTurns: 10,
  queries: [{ id: "Q1", source: "MID_KEYWORD", label: "claims software", turn: 1, total: 8, histogram: [0, 0, 0, 1, 2, 2, 1, 1, 0, 1], min_score: 0.8, kept_count: 3, keep_turn: 2 }],
  consolidatedCount: 4,
  steps: [{ id: "refine", label: "Refine · turn 3 of 10", state: "running" }],
  message: "Stable shortlist", startedAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:05.000Z",
  simulated: true, appliedReviewId: null, finalCount: null, undoneReviewId: null,
  ...overrides,
});

test("loop activity mapping includes state actions, turn percent, and kept counts", () => {
  const running = mapLoopJobToActivity(loop(), { now: Date.parse("2026-10-10T00:00:10.000Z") });
  assert.deepEqual(running.actions, ["pause", "cancel"]);
  assert.equal(running.percent, 30);
  assert.equal(running.secondaryText, "1 query · 4 companies kept");
  assert.equal(running.elapsedMs, 10_000);
  assert.deepEqual(mapLoopJobToActivity(loop({ state: "paused" })).actions, ["resume", "cancel"]);
  assert.deepEqual(mapLoopJobToActivity(loop({ state: "completed" })).actions, ["summary", "undo"]);
  assert.deepEqual(mapLoopJobToActivity(loop({ state: "cancelled" })).actions, ["dismiss"]);
  assert.deepEqual(mapLoopJobToActivity(loop({ state: "failed" })).actions, ["dismiss"]);
});

test("loop start and cancel request builders use bridge field names", () => {
  assert.deepEqual(buildLoopStartRequest("run-a", "find claims software", "session-b", "Northstar", 12), {
    runId: "run-a", message: "find claims software", sessionId: "session-b", title: "Loop · Northstar", maxTurns: 12,
  });
  assert.deepEqual(buildLoopCancelRequest("loop-a", true), { id: "loop-a", keep: true });
  assert.deepEqual(buildLoopCancelRequest("loop-a", false), { id: "loop-a", keep: false });
});

test("loop outcome once guard persists completed summary IDs across instances", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const first = createOutcomeOnceGuard(storage, LOOP_OUTCOMES_KEY);
  assert.equal(first.claim("loop-1"), true);
  first.complete("loop-1");
  assert.equal(values.get(LOOP_OUTCOMES_KEY), '["loop-1"]');
  const afterReload = createOutcomeOnceGuard(storage, LOOP_OUTCOMES_KEY);
  assert.equal(afterReload.has("loop-1"), true);
  assert.equal(afterReload.claim("loop-1"), false);
});

test("collapsed loop turn line shows action count and the threshold set on that turn", () => {
  const instructions = Array.from({ length: 3 }, (_, index) => ({ index, action: "search_mid", title: null, status: "executed" as const, arguments: null, result_summary: null, reason: null }));
  assert.equal(buildCollapsedTurnLine({ turn: 2, instructions }, loop().queries), "Turn 2 · 3 actions · kept Q1 ≥ 0.80");
  assert.equal(buildCollapsedTurnLine({ turn: 1, instructions: [] }, loop().queries), "Turn 1 · 0 actions");
});

test("summary query model includes a threshold bin and no-keeps heading", () => {
  const kept = buildLoopSummaryViewModel(loop({ state: "completed", finalCount: 4 }), { considered: 4, total: 9 });
  assert.equal(kept.heading, "Loop finished · 4 companies considered");
  assert.equal(kept.appliedText, "Applied to shortlist: 4 considered · 5 hidden");
  assert.equal(kept.queries[0].thresholdBinIndex, 8);
  assert.equal(kept.queries[0].histogram.length, 10);
  assert.equal(kept.queries[0].labelTitle, "claims software");
  const noKeeps = buildLoopSummaryViewModel(loop({ state: "completed", queries: [{ ...loop().queries[0], min_score: null, kept_count: null }] }), { considered: 9, total: 9 });
  assert.equal(noKeeps.noKeeps, true);
  assert.equal(noKeeps.heading, "No keep decisions — shortlist unchanged");
});

test("Loop toggle storage is per session and defaults off", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(readLoopToggle("session-a", storage), false);
  writeLoopToggle("session-a", true, storage);
  assert.equal(readLoopToggle("session-a", storage), true);
  assert.equal(readLoopToggle("session-b", storage), false);
});
