import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_POLL_MS,
  IDLE_POLL_MS,
  backgroundPollDelay,
  isBackgroundActive,
} from "../src/lib/background-client";

test("background runs poll fast only while work is moving", () => {
  assert.equal(ACTIVE_POLL_MS, 2000);
  assert.equal(IDLE_POLL_MS, 15000);
  assert.equal(backgroundPollDelay([], false), IDLE_POLL_MS);
  assert.equal(backgroundPollDelay([{ state: "completed" }, { state: "paused" }, { state: "blocked" }, { state: "error" }], false), IDLE_POLL_MS);
  assert.equal(backgroundPollDelay([{ state: "completed" }, { state: "running" }], false), ACTIVE_POLL_MS);
  assert.equal(backgroundPollDelay([{ state: "queued" }], false), ACTIVE_POLL_MS);
  assert.equal(isBackgroundActive([{ state: "paused" }]), false);
});

test("background polling pauses while the tab is hidden", () => {
  assert.equal(backgroundPollDelay([{ state: "running" }], true), undefined);
  assert.equal(backgroundPollDelay([], true), undefined);
});
