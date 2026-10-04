import { strict as assert } from "node:assert";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { createSessionStore } from "../src/lib/session-store";
import { buildSessionExport } from "../src/lib/session-export";
import type { ResearchSession } from "../src/lib/session-contract";

function memoryStorage(initial?: string, failWrite?: boolean) {
  let value = initial ?? null;
  return {
    getItem: (_key: string) => value,
    setItem: (_key: string, next: string) => {
      if (failWrite) throw new Error("quota exceeded");
      value = next;
    },
    peek: () => value,
  };
}

test("session store snapshots are stable and immutable until a mutation", () => {
  const store = createSessionStore(memoryStorage());
  const first = store.getSnapshot();
  assert.equal(first, store.getSnapshot());
  assert.equal(first.sessions.length, 2);
  assert.equal(first.sessions[0].events.length, 1);
  assert.equal(first.sessions[0].events[0].title, "Session initialized");
  assert.ok(Object.isFrozen(first.sessions[0].events[0]));
  const id = store.addEvent({
    kind: "message",
    status: "success",
    origin: "assistant",
    role: "user",
    title: "Question",
    text: "Check this.",
  });
  const after = store.getSnapshot();
  assert.notEqual(after, first);
  assert.equal(first.sessions[0].events.length, 1);
  assert.equal(after.sessions[0].events.at(-1)?.id, id);
  assert.equal(after.sessions[0].events.at(-1)?.sequence, 2);
  assert.equal(after.sessions[0].events.at(-1)?.sessionId, "run-insurance");
  assert.throws(() => store.selectSession("missing"), /Unknown session/);
  assert.throws(
    () =>
      store.addEvent({
        sessionId: "missing",
        kind: "system",
        status: "success",
        origin: "system",
        title: "bad",
      }),
    /Unknown session/,
  );
});

test("tool completion is once-only and scoped to the owning session across switches", () => {
  const store = createSessionStore(memoryStorage());
  const tool = store.startTool("Lookup", { query: "x" });
  store.selectSession("run-claims");
  const claimsTool = store.startTool("Claims search", {});
  store.finishTool(tool, { hits: 2 });
  store.finishTool(tool, { hits: 99 }, "error", "late duplicate");
  store.finishTool(claimsTool, null, "error", "service unavailable");
  const snapshot = store.getSnapshot();
  const insuranceEvents = snapshot.sessions[0].events;
  const original = insuranceEvents.find((event) => event.id === tool)!;
  assert.equal(original.status, "success");
  assert.deepEqual(original.result, { hits: 2 });
  assert.equal(insuranceEvents.filter((event) => event.id === tool).length, 1);
  const claimsEvents = snapshot.sessions[1].events;
  const failed = claimsEvents.find((event) => event.id === claimsTool)!;
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "service unavailable");
  assert.equal(claimsEvents.at(-1)?.sequence, 2);
  assert.throws(() => store.renameSession("missing", "No"), /Unknown session/);
  store.renameSession("run-insurance", "Insurance diligence");
  assert.equal(store.getSnapshot().sessions[0].title, "Insurance diligence");
});

test("hydration preserves session identity and marks unfinished calls interrupted", () => {
  const storage = memoryStorage();
  const first = createSessionStore(storage);
  first.selectSession("run-claims");
  const started = first.startTool("Slow lookup", { query: "claims" });
  const restored = createSessionStore(storage);
  const snapshot = restored.getSnapshot();
  assert.equal(snapshot.activeId, "run-claims");
  assert.equal(snapshot.sessions.length, 2);
  assert.equal(
    snapshot.sessions[1].events.find((event) => event.id === started)?.status,
    "cancelled",
  );
  assert.equal(
    snapshot.sessions[1].events.find((event) => event.id === started)?.error,
    "Interrupted on reload; finish not recorded",
  );
  assert.equal(
    snapshot.sessions[1].events.find((event) => event.id === started)
      ?.finishedAt,
    undefined,
  );
  assert.equal(
    snapshot.sessions[1].events.find((event) => event.id === started)
      ?.durationMs,
    undefined,
  );
  assert.equal(snapshot.sessions[0].id, "run-insurance");
  assert.equal(snapshot.sessions[1].id, "run-claims");
});

test("corrupt storage recovers with a visible error and failed writes retain in-memory state", () => {
  const corrupt = createSessionStore(memoryStorage("{not json"));
  assert.match(corrupt.getSnapshot().storageError ?? "", /could not be read/);
  assert.equal(corrupt.getSnapshot().sessions[0].id, "run-insurance");
  const quota = createSessionStore(memoryStorage(undefined, true));
  const id = quota.addEvent({
    kind: "system",
    status: "success",
    origin: "system",
    title: "Still here",
  });
  assert.ok(
    quota.getSnapshot().sessions[0].events.some((event) => event.id === id),
  );
  assert.match(quota.getSnapshot().storageError ?? "", /quota exceeded/);
});

test("JSONL export is complete, scoped, and ZIP contains the same source log plus useful files", () => {
  const store = createSessionStore(memoryStorage());
  const message = store.addEvent({
    kind: "message",
    status: "success",
    origin: "assistant",
    role: "assistant",
    title: "Answer",
    text: "A useful answer.",
  });
  const tool = store.startTool("Search", { term: "policy" });
  store.finishTool(tool, { records: [1, 2] });
  const session = store.getSnapshot().sessions[0] as ResearchSession;
  const jsonl = buildSessionExport(session, "jsonl");
  const rows = new TextDecoder()
    .decode(jsonl.bytes)
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(rows[0], {
    type: "session",
    schemaVersion: 1,
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
  });
  assert.equal(rows.length, session.events.length + 1);
  assert.ok(
    rows.some(
      (row) =>
        row.type === "event" &&
        row.id === message &&
        row.text === "A useful answer.",
    ),
  );
  assert.ok(
    rows.some(
      (row) =>
        row.type === "event" &&
        row.id === tool &&
        row.args.term === "policy" &&
        row.result.records.length === 2,
    ),
  );
  assert.ok(
    rows.every((row) => row.type !== "event" || row.sessionId === session.id),
  );
  assert.match(jsonl.filename, /insurance-software-run-insurance\.jsonl$/);
  const zip = buildSessionExport(session, "zip");
  const files = unzipSync(zip.bytes);
  assert.equal(
    strFromU8(files["session.jsonl"]),
    new TextDecoder().decode(jsonl.bytes),
  );
  assert.match(strFromU8(files["README.md"]), /Screening session export/);
  assert.match(strFromU8(files["transcript.md"]), /A useful answer\./);
  assert.equal(JSON.parse(strFromU8(files["manifest.json"])).counts.tools, 1);
  assert.equal(
    JSON.parse(strFromU8(files["manifest.json"])).attachments.included,
    false,
  );
  const markdown = new TextDecoder().decode(
    buildSessionExport(session, "markdown").bytes,
  );
  assert.match(markdown, /Arguments:/);
  assert.match(markdown, /Result:/);
});
