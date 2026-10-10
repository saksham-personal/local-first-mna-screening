import test from "node:test";
import assert from "node:assert/strict";
import { controllerAvailable, controllerViews, shortResult, valueLines, sendControllerTurn, type ControllerResponse, type ControllerTurn } from "../src/lib/controller-client";
import { setControllerPreferences, getControllerPreferences } from "../src/lib/controller-client";
import { setLoopToggle } from "../src/lib/loop-client";
import { sessionStore } from "../src/lib/session-store";
import { controllerMessageIds, saveControllerTurns, updateChatState } from "../src/lib/chat-store";
import { createChatAdapter, pendingWorkspaceMessages, transcriptFor } from "../src/lib/chat-driver";
import { fromThreadMessageLike } from "@assistant-ui/react";

const turn: ControllerTurn = { turn_id: "turn-1", conversation_id: "conv-first", parent_turn_id: null, kind: "analyst", created_at: "2026-10-09T10:00:00Z", context: "A search", reasoning: "Use core business", notes: "Review evidence", warnings: ["Unknown heading"], feedback_sent: true, simulated: true, estimated_tokens: 12,
  instructions: [
    { index: 2, action: "approve", title: "Approve", status: "rejected", arguments: {}, result_summary: null, reason: "Analyst-only action" },
    { index: 1, action: "search_mid", title: "Search", status: "executed", arguments: { keywords: ["claims", "software"] }, result_summary: { count: 4, run_id: "run-1" }, reason: null, warnings: ["Duplicate key"] },
    { index: 3, action: "score_mid_semantic", title: null, status: "failed", arguments: {}, result_summary: null, reason: "Vectors unavailable" },
  ] };
const response: ControllerResponse = { conversation_id: "conv-first", rotated: false, rotated_from: null, rotation: null, estimated_tokens: 100, turns: [turn] };

test("controller mapping preserves real statuses, rejection reasons, warnings and simulation truth", () => {
  const view = controllerViews(response)[0];
  assert.deepEqual(view.instructions.map(row => row.status), ["executed", "rejected", "failed"]);
  assert.equal(view.instructions[1].reason, "Analyst-only action");
  assert.equal(view.instructions[2].reason, "Vectors unavailable");
  assert.deepEqual(view.warnings, ["Unknown heading", "Duplicate key"]);
  assert.equal(view.simulated, true);
  assert.equal(view.estimatedTokens, 100);
  assert.equal(shortResult(view.instructions[0].result_summary), "count: 4 · run_id: run-1");
  assert.deepEqual(valueLines(view.instructions[0].arguments), ["keywords: claims; software"]);
});
test("feedback is linked to its actual parent and handoff divider occurs once per conversation", () => {
  const feedback = { ...turn, turn_id: "repair", kind: "feedback" as const, parent_turn_id: "turn-1" };
  assert.equal(controllerViews({ ...response, turns: [turn, feedback] })[1].feedbackParent, "turn-1");
  const handoff = { ...turn, conversation_id: "conv-next", turn_id: "handoff", kind: "handoff" as const };
  const views = controllerViews({ ...response, conversation_id: "conv-next", rotated: true, rotated_from: "conv-first", rotation: "token_budget", turns: [turn, handoff, { ...handoff, turn_id: "next", kind: "analyst" }] });
  assert.match(views[1].divider!, /^Context full — continued in a new conversation/);
  assert.equal(views[1].rotatedFrom, "conv-first");
  assert.equal(views[2].divider, undefined);
});
test("explicit new conversation labels its first turn, while continued turns have no divider", () => {
  assert.match(controllerViews({ ...response, rotated: true, rotated_from: "conv-old", rotation: "new_conversation" })[0].divider!, /^New LLM Suite conversation/);
  assert.equal(controllerViews(response)[0].divider, undefined);
});
test("availability requires a saved run and controller readiness, not screening simulation readiness", () => {
  assert.equal(controllerAvailable("run", { ready: true, controller: { available: true } }), true);
  assert.equal(controllerAvailable(undefined, { ready: true, controller: { available: true } }), false);
  assert.equal(controllerAvailable("run", { ready: false, controller: { available: true } }), false);
  assert.equal(controllerAvailable("run", { ready: true, controller: { available: false } }), false);
  assert.equal(controllerAvailable("run", { ready: true }), false);
});
test("controller client sends fresh-conversation intent and reports rate-limit errors verbatim", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (url, options) => {
      assert.equal(url, "/api/controller/turn");
      assert.deepEqual(JSON.parse(options!.body as string), { sessionId: "session", runId: "run", message: "search", newConversation: true });
      return new Response(JSON.stringify({ error: "LLM Suite rate limit: seven sends per minute" }), { status: 429 });
    }) as typeof fetch;
    await assert.rejects(sendControllerTurn("session", "run", "search", true, new AbortController().signal), /seven sends per minute/);
  } finally { globalThis.fetch = original; }
});
test("controller send yields a pending card, saves separate feedback messages and reloads without duplicates", async () => {
  const sessionId = sessionStore.createSession("Controller contract");
  updateChatState(sessionId, { backendRunId: "run-1" });
  assert.equal(getControllerPreferences(sessionId).mode, false);
  setControllerPreferences(sessionId, { mode: true, newConversation: true });
  const repaired = { ...turn, turn_id: "repair", kind: "feedback" as const, parent_turn_id: turn.turn_id, feedback_sent: false };
  const reply = { ...response, turns: [turn, repaired], rotated: true, rotation: "new_conversation" as const, rotated_from: "conv-old" };
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (url, options) => {
      if (url === "/api/health") return new Response(JSON.stringify({ ready: true, controller: { available: true } }));
      assert.equal(url, "/api/controller/turn");
      assert.equal(JSON.parse(options!.body as string).newConversation, true);
      return new Response(JSON.stringify(reply));
    }) as typeof fetch;
    const adapter = createChatAdapter(sessionId, { openLog: () => {}, title: () => "Controller contract" });
    const analyst = fromThreadMessageLike({ id: "analyst", role: "user", content: [{ type: "text", text: "search for claims software" }] }, "analyst", { type: "complete", reason: "stop" });
    const updates: any[] = [];
    for await (const update of adapter.run({ messages: [analyst], abortSignal: new AbortController().signal, unstable_assistantMessageId: "reply" } as unknown as Parameters<typeof adapter.run>[0]) as AsyncIterable<unknown>) updates.push(update);
    assert.equal(updates[0].content[0].data.pending, true);
    assert.equal(updates.at(-1).content[0].data.turn.turn_id, turn.turn_id);
    assert.equal(pendingWorkspaceMessages(sessionId, ["analyst", "reply"]).length, 1);
    const count = transcriptFor(sessionId).length;
    saveControllerTurns(sessionId, reply);
    assert.equal(transcriptFor(sessionId).length, count);
    assert.equal(controllerMessageIds(sessionId).get("repair"), "controller-repair");
    assert.equal(getControllerPreferences(sessionId).newConversation, false);
    const events = sessionStore.getSnapshot().sessions.find(session => session.id === sessionId)!.events;
    assert.ok(events.filter(event => event.role === "assistant").every(event => event.kind !== "approval"));
  } finally { globalThis.fetch = original; }
});

test("a stored Loop preference uses the regular unavailable-controller path", async () => {
  const sessionId = sessionStore.createSession("Unavailable loop controller");
  updateChatState(sessionId, { backendRunId: "run-unavailable" });
  setControllerPreferences(sessionId, { mode: true });
  setLoopToggle(sessionId, true);
  const original = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = (async url => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ready: true, controller: { available: false } }));
    }) as typeof fetch;
    const adapter = createChatAdapter(sessionId, { openLog: () => {}, title: () => "Unavailable loop controller" });
    const analyst = fromThreadMessageLike({ id: "analyst-unavailable", role: "user", content: [{ type: "text", text: "find claims software" }] }, "analyst-unavailable", { type: "complete", reason: "stop" });
    const updates: any[] = [];
    for await (const update of adapter.run({ messages: [analyst], abortSignal: new AbortController().signal, unstable_assistantMessageId: "reply-unavailable" } as unknown as Parameters<typeof adapter.run>[0]) as AsyncIterable<unknown>) updates.push(update);
    assert.deepEqual(calls, ["/api/health"]);
    const finalParts = updates.at(-1).content;
    assert.equal(finalParts[0].name, "controller-turn");
    assert.match(finalParts[0].data.error, /unavailable or disconnected/);
    assert.equal(finalParts.some((part: any) => part.name === "loop-turn"), false);
  } finally { globalThis.fetch = original; }
});
