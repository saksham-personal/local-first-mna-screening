import { test } from "node:test";
import assert from "node:assert/strict";
import {
  artifactBase,
  getChatState,
  patchArtifact,
  saveArtifact,
  updateChatState,
} from "../src/lib/chat-store";
import { getJob, refreshJobs, syncJob } from "../src/lib/chat-jobs";
import {
  buildSessionArchive,
  declaredSessionFiles,
} from "../src/lib/session-export";
import { recommendedStep } from "../src/lib/chat-policy";
import { sessionStore } from "../src/lib/session-store";
import type { JobSnapshot } from "../src/lib/chat-contract";

const eventsFor = (id: string) =>
  sessionStore.getSnapshot().sessions.find((s) => s.id === id)!.events;
function runningJob(sessionId: string): JobSnapshot {
  const id = crypto.randomUUID();
  const startedAt = "2026-10-04T01:00:00.000Z";
  updateChatState(sessionId, {
    jobId: id,
    jobContext: {
      id,
      revision: 1,
      turnId: id,
      messageId: `${id}-answer`,
      startedAt,
    },
  });
  return {
    id,
    sessionId,
    startedAt,
    state: "running",
    events: [
      {
        id: `${id}-call`,
        type: "tool-start",
        tool: "search_mid",
        args: { query: "claims software" },
        timestamp: startedAt,
      },
    ],
  };
}

test("server disappearance ends recovery without inventing a tool finish or duration", async () => {
  const sessionId = sessionStore.createSession("Restart recovery");
  const job = runningJob(sessionId);
  syncJob(job);
  const prior = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ jobs: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  try {
    await refreshJobs();
  } finally {
    globalThis.fetch = prior;
  }
  const tool = eventsFor(sessionId).find((e) => e.kind === "tool")!;
  assert.equal(tool.status, "cancelled");
  assert.equal(tool.finishedAt, undefined);
  assert.equal(tool.durationMs, undefined);
  assert.match(tool.error!, /finish not recorded/);
  assert.equal(getJob(job.id)?.state, "error");
  assert.equal(getJob(job.id)?.finishedAt, undefined);
  assert.equal(
    eventsFor(sessionId).find((e) => e.kind === "message" && e.jobId === job.id)
      ?.finishedAt,
    undefined,
  );
});

test("an earlier empty poll cannot report a newly created job as lost", async () => {
  const sessionId = sessionStore.createSession("Poll race");
  const prior = globalThis.fetch;
  let release!: (response: Response) => void;
  globalThis.fetch = () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  const request = refreshJobs();
  const job = runningJob(sessionId);
  syncJob(job);
  release(
    new Response(JSON.stringify({ jobs: [] }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
  try {
    await request;
  } finally {
    globalThis.fetch = prior;
  }
  assert.equal(getJob(job.id)?.state, "running");
  assert.equal(
    eventsFor(sessionId).filter((e) => e.kind === "message").length,
    0,
  );
  syncJob({
    ...job,
    state: "cancelled",
    finishedAt: "2026-10-04T01:00:01.000Z",
    events: [
      ...job.events,
      {
        id: `${job.id}-call`,
        type: "tool-error",
        tool: "search_mid",
        result: { error: "Cancelled" },
        timestamp: "2026-10-04T01:00:01.000Z",
      },
    ],
  });
  syncJob(job);
  assert.equal(getJob(job.id)?.state, "cancelled");
});

test("artifact transitions leave the original receipt intact and archive file references stay deduplicated", () => {
  const sessionId = sessionStore.createSession("Artifact history");
  const artifact = saveArtifact(sessionId, {
    ...artifactBase("Upload"),
    type: "file",
    file: { id: "registered-file", name: "input.csv", bytes: 3, kind: "CSV" },
    importStatus: "Uploaded",
  });
  patchArtifact(sessionId, artifact.id, { importStatus: "Imported" });
  patchArtifact(sessionId, artifact.id, { importStatus: "Imported" });
  const receipts = eventsFor(sessionId).filter((e) => e.kind === "artifact");
  assert.equal(receipts.length, 2);
  assert.equal(
    (receipts[0].result as { importStatus: string }).importStatus,
    "Uploaded",
  );
  assert.equal(
    (receipts[1].result as { importStatus: string }).importStatus,
    "Imported",
  );
  assert.equal(
    declaredSessionFiles(
      sessionStore.getSnapshot().sessions.find((s) => s.id === sessionId)!,
    ).length,
    1,
  );
  assert.equal(getChatState(sessionId).artifacts[0].type, "file");
});

test("archive rejects oversized, missing, and changed attachments before producing a partial ZIP", async () => {
  const sessionId = sessionStore.createSession("Archive checks");
  const artifact = saveArtifact(sessionId, {
    ...artifactBase("Upload"),
    type: "file",
    file: {
      id: "safe-file",
      name: "data.csv",
      bytes: 40 * 1024 * 1024 + 1,
      kind: "CSV",
    },
  });
  const snapshot = () =>
    sessionStore.getSnapshot().sessions.find((s) => s.id === sessionId)!;
  let calls = 0;
  await assert.rejects(
    buildSessionArchive(snapshot(), async () => {
      calls++;
      return new Uint8Array();
    }),
    /40 MB/,
  );
  assert.equal(calls, 0);
  patchArtifact(sessionId, artifact.id, {
    file: { id: "safe-file", name: "data.csv", bytes: 3, kind: "CSV" },
  });
  await assert.rejects(
    buildSessionArchive(snapshot(), async () => {
      throw new Error("File unavailable");
    }),
    /File unavailable/,
  );
  await assert.rejects(
    buildSessionArchive(snapshot(), async () => new Uint8Array(2)),
    /size changed/,
  );
});

test("the chat recommendation switches at exactly 2000 companies", () => {
  assert.equal(recommendedStep(1999), "pitchbook");
  assert.equal(recommendedStep(2000), "llm");
  assert.equal(recommendedStep(2001), "llm");
});
