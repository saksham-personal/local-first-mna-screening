import assert from "node:assert/strict";
import { test } from "node:test";
import { getChatState } from "../src/lib/chat-store";
import { ACTIVE_RESEARCH_POLL_MS, IDLE_RESEARCH_POLL_MS, recordBingOutcome, researchPollDelay, startBingResearch } from "../src/lib/research-client";
import type { BingActivityJob } from "../src/lib/run-activity";
import { sessionStore } from "../src/lib/session-store";

test("Bing approval uses the background start route and returns its Activity job", async () => {
  const originalFetch = globalThis.fetch;
  const job = {
    id: "bing-job-1", kind: "bing", runId: "run-1", sessionId: "session-1", planId: "plan-1",
    title: "Bing company research", state: "queued", steps: [], processedQueries: 0, queryCount: 3,
    failedQueries: 0, startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ job }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await startBingResearch("session-1", "preview-token", { includeInCriteria: true });
    assert.equal(requestUrl, "/api/research/start");
    assert.deepEqual(requestBody, { token: "preview-token", approved: true, sessionId: "session-1" });
    assert.equal(result.id, "bing-job-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

type Reply = { status?: number; body: unknown };
const reply = (body: unknown, status = 200): Reply => ({ status, body });
const rowsReply = (rows: Record<string, unknown>[], extra: Record<string, unknown> = {}) => reply({ rows, total: rows.length, capped: false, discarded: false, ...extra });

/** Answers every fetch with `route` and records the URLs. The real chat and session stores run unchanged. */
async function withFetch(route: (url: string, init?: RequestInit) => Reply, run: (calls: string[]) => Promise<void>) {
  const previous = globalThis.fetch, calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const next = route(url, init);
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try { await run(calls); } finally { globalThis.fetch = previous; }
}

function outcomeJob(sessionId: string, id: string, overrides: Partial<BingActivityJob> = {}): BingActivityJob {
  return {
    id, kind: "bing", runId: "", sessionId, planId: `${id}-plan`, title: "Bing company research", state: "completed",
    steps: [], processedQueries: 3, queryCount: 3, failedQueries: 0,
    startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", ...overrides,
  };
}
const events = (sessionId: string) => sessionStore.getSnapshot().sessions.find(session => session.id === sessionId)!.events;
const outcomeMessages = (sessionId: string, jobId: string) => events(sessionId).filter(event => event.messageId === `bing-research-${jobId}`);
const sourcesTables = (sessionId: string) => getChatState(sessionId).artifacts.flatMap(artifact => artifact.type === "data-table" ? [artifact] : []);

test("completed Bing research saves one sources table and one message, and a repeat call posts nothing", async () => {
  const sessionId = sessionStore.createSession("Bing outcome completed");
  const job = outcomeJob(sessionId, "outcome-completed");
  await withFetch(() => rowsReply([{ Query: "insurance software", URL: "https://example.test/a", Answer: "Lead" }]), async calls => {
    await recordBingOutcome(job);
    await recordBingOutcome(job);
    assert.deepEqual(calls, ["/api/research/runs/rows?id=outcome-completed"]);
  });
  const tables = sourcesTables(sessionId);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rows.length, 1);
  const messages = outcomeMessages(sessionId, job.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].text, "Bing research completed.");
});

test("more than 500 saved observations keep 500 rows and say the rest are saved", async () => {
  const sessionId = sessionStore.createSession("Bing outcome capped");
  const job = outcomeJob(sessionId, "outcome-capped");
  const rows = Array.from({ length: 500 }, (_, index) => ({ Query: `query ${index}`, URL: `https://example.test/${index}` }));
  await withFetch(() => rowsReply(rows, { total: 620, capped: true }), async () => { await recordBingOutcome(job); });
  const tables = sourcesTables(sessionId);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rows.length, 500);
  assert.match(tables[0].note ?? "", /showing first 500; all observations are saved\./);
  assert.equal(outcomeMessages(sessionId, job.id).length, 1);
});

test("discarded Bing research posts one assistant message in chat and no sources table", async () => {
  const sessionId = sessionStore.createSession("Bing outcome discarded");
  const job = outcomeJob(sessionId, "outcome-discarded", { state: "cancelled" });
  await withFetch(() => rowsReply([], { discarded: true }), async calls => {
    await recordBingOutcome(job);
    await recordBingOutcome(job);
    assert.equal(calls.length, 1);
  });
  assert.equal(sourcesTables(sessionId).length, 0);
  const messages = outcomeMessages(sessionId, job.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "message");
  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].status, "success");
  assert.equal(messages[0].text, "Bing research cancelled · results discarded. Nothing from this run appears in companies, context, or exports.");
  assert.ok(getChatState(sessionId).branchMessageIds.includes(`bing-research-${job.id}`));
  assert.equal(events(sessionId).filter(event => event.kind === "system" && event.jobId === job.id).length, 0);
});

test("a failed rows read records nothing, releases the guard, and a retry records once", async () => {
  const sessionId = sessionStore.createSession("Bing outcome retry");
  const job = outcomeJob(sessionId, "outcome-retry");
  let attempts = 0;
  await withFetch(() => (attempts++ === 0 ? reply({ error: "Rows are unavailable." }, 500) : rowsReply([{ Query: "retry", URL: "https://example.test/r" }])), async calls => {
    await assert.rejects(recordBingOutcome(job), /Rows are unavailable/);
    assert.equal(sourcesTables(sessionId).length, 0);
    assert.equal(outcomeMessages(sessionId, job.id).length, 0);
    await recordBingOutcome(job);
    await recordBingOutcome(job);
    assert.equal(calls.length, 2);
  });
  assert.equal(sourcesTables(sessionId).length, 1);
  assert.equal(outcomeMessages(sessionId, job.id).length, 1);
});

test("a cancelled run that kept no rows posts only the message", async () => {
  const sessionId = sessionStore.createSession("Bing outcome empty");
  const job = outcomeJob(sessionId, "outcome-empty", { state: "cancelled" });
  await withFetch(() => rowsReply([]), async () => { await recordBingOutcome(job); });
  assert.equal(sourcesTables(sessionId).length, 0);
  const messages = outcomeMessages(sessionId, job.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "Bing research cancelled · no results were collected");
  assert.deepEqual(messages[0].content, [{ type: "text", text: "Bing research cancelled · no results were collected" }]);
});

test("the include-in-criteria choice survives a failed criteria step and is cleared once that step succeeds", async () => {
  const values = new Map<string, string>();
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  const sessionId = sessionStore.createSession("Bing criteria retry");
  const job = outcomeJob(sessionId, "outcome-criteria");
  // The choice was saved in an earlier page session, so only storage holds it.
  values.set("screening-bing-outcome-options-v1", JSON.stringify({ [job.id]: true }));
  const stored = () => (JSON.parse(values.get("screening-bing-outcome-options-v1") ?? "{}") as Record<string, boolean>)[job.id];
  let generateCalls = 0;
  try {
    await withFetch((url, init) => {
      if (url.startsWith("/api/research/runs/rows")) return rowsReply([{ Query: "insurance software", URL: "https://example.test/a", Answer: "Lead" }]);
      if (url === "/api/conversation/generate") {
        generateCalls += 1;
        return generateCalls === 1 ? reply({ error: "Provider busy." }, 503) : reply({ executed: true, text: "Revised criteria" });
      }
      if (url === "/api/tools") {
        const request = JSON.parse(String(init?.body)) as { tool: string };
        if (request.tool === "create_run") return reply({ ok: true, result: { run_id: "run-criteria-retry" } });
        if (request.tool === "save_criteria_revision") return reply({ ok: true, result: { revision: 1, digest: "digest-1" } });
        return reply({ ok: true, result: {} });
      }
      throw new Error(`Unexpected request: ${url}`);
    }, async () => {
      await assert.rejects(recordBingOutcome(job), /Provider busy/);
      assert.equal(stored(), true);
      await recordBingOutcome(job);
    });
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
  assert.equal(generateCalls, 2);
  assert.equal(stored(), undefined);
  assert.equal(outcomeMessages(sessionId, job.id).length, 1);
  assert.equal(sourcesTables(sessionId).length, 1);
});

test("Bing polling pauses while the document is hidden and otherwise uses the active or idle cadence", () => {
  assert.equal(researchPollDelay([{ state: "running" }], true), undefined);
  assert.equal(researchPollDelay([], true), undefined);
  assert.equal(researchPollDelay([{ state: "running" }], false), ACTIVE_RESEARCH_POLL_MS);
  assert.equal(researchPollDelay([{ state: "completed" }], false), IDLE_RESEARCH_POLL_MS);
});
