import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SessionEvent } from "../src/lib/session-contract";
import {
  filterTrajectoryEvents,
  formatDuration,
  groupTrajectoryEvents,
  recordedSpan,
} from "../src/lib/session-trajectory";

function event(
  overrides: Partial<SessionEvent> & Pick<SessionEvent, "id" | "sequence">,
): SessionEvent {
  return {
    sessionId: "session-1",
    kind: "system",
    status: "success",
    origin: "system",
    title: overrides.id,
    startedAt: "2026-10-04T10:00:00.000Z",
    ...overrides,
  };
}

test("trajectory filters match recorded tool data and each event status", () => {
  const events = [
    event({
      id: "lookup",
      sequence: 1,
      kind: "tool",
      status: "success",
      toolName: "Search filings",
      args: { query: "Northstar" },
      turnId: "a",
    }),
    event({
      id: "running",
      sequence: 2,
      kind: "tool",
      status: "running",
      toolName: "Fetch profile",
      turnId: "a",
    }),
    event({
      id: "failed",
      sequence: 3,
      kind: "message",
      status: "error",
      title: "Request failed",
      error: "gateway timeout",
      turnId: "b",
    }),
  ];
  assert.deepEqual(
    filterTrajectoryEvents(events, {
      kind: "tool",
      status: "running",
      query: "",
    }).map((item) => item.id),
    ["running"],
  );
  assert.deepEqual(
    filterTrajectoryEvents(events, {
      kind: "all",
      status: "errors",
      query: "GATEWAY",
    }).map((item) => item.id),
    ["failed"],
  );
  assert.deepEqual(
    filterTrajectoryEvents(events, {
      kind: "all",
      status: "all",
      query: "northstar",
    }).map((item) => item.id),
    ["lookup"],
  );
});

test("turn groups label from the complete event snapshot and split nonconsecutive sections", () => {
  const all = [
    event({ id: "first", sequence: 1, kind: "message", turnId: "turn-a" }),
    event({ id: "workspace", sequence: 2, origin: "workspace" }),
    event({ id: "second", sequence: 3, turnId: "turn-b" }),
  ];
  const projection = groupTrajectoryEvents([all[2], all[1], all[0]], all);
  assert.deepEqual(
    projection.map(({ label, events }) => [
      label,
      events.map((item) => item.id),
    ]),
    [
      ["Turn 2", ["second"]],
      ["Workspace activity", ["workspace"]],
      ["Turn 1", ["first"]],
    ],
  );
});

test("duration comes from recorded timestamps and running records remain start markers", () => {
  const complete = event({
    id: "complete",
    sequence: 1,
    startedAt: "2026-10-04T10:00:00.000Z",
    finishedAt: "2026-10-04T10:00:02.500Z",
    durationMs: 999_999,
  });
  const running = event({
    id: "running",
    sequence: 2,
    status: "running",
    durationMs: 5000,
  });
  assert.equal(recordedSpan(complete)?.durationMs, 2500);
  assert.equal(recordedSpan(running)?.durationMs, undefined);
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(
    recordedSpan(
      event({
        id: "bad",
        sequence: 3,
        startedAt: "2026-10-04T10:00:02.000Z",
        finishedAt: "2026-10-04T10:00:01.000Z",
      }),
    )?.durationMs,
    undefined,
  );
});
