import assert from "node:assert/strict";
import { test } from "node:test";
import { startBingResearch } from "../src/lib/research-client";

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
