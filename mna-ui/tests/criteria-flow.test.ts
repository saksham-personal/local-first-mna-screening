import { test } from "node:test";
import assert from "node:assert/strict";
import { fromThreadMessageLike, type ChatModelAdapter } from "@assistant-ui/react";
import { approveCriteriaWithExamples, createChatAdapter, hiddenActionMetadata, reviseCriteria, transcriptFor } from "../src/lib/chat-driver";
import { artifactBase, emptyChatState, getChatState, updateChatState } from "../src/lib/chat-store";
import { flushCriteriaDraft, readCriteriaHistory } from "../src/lib/review-client";
import { sessionStore } from "../src/lib/session-store";
import { intakeToCriteria, normalizeIntake } from "../src/intake/intake-model";
import { mapCriteriaVersions } from "../src/chat/criteria-versions";

async function withBackend(run: (requests: { tool: string; arguments: Record<string, unknown> }[]) => Promise<void>, initialRevision = 0) {
  const previous = globalThis.fetch;
  const requests: { tool: string; arguments: Record<string, unknown> }[] = [];
  let revision = initialRevision;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request);
    let result: Record<string, unknown> = {};
    if (request.tool === "create_run") result = { run_id: crypto.randomUUID() };
    if (request.tool === "save_criteria_revision") result = { revision: ++revision, digest: `digest-${revision}` };
    if (request.tool === "get_criteria_history") result = { revisions: [], count: 0 };
    return new Response(JSON.stringify({ ok: true, result }));
  };
  try { await run(requests); } finally { globalThis.fetch = previous; }
}
const session = () => sessionStore.createSession("Criteria flow verification");

test("old business-phase chats load as one pending card with the saved Rust revision", () => {
  const id = session(), previous = globalThis.localStorage;
  const state = { ...emptyChatState(id), criteriaText: "Claims software", definition: "Claims software", revision: 8, goodFitExamples: "Good company", durableCriteria: { revision: 7, localRevision: 8, digest: "saved-draft" }, artifacts: [{ ...artifactBase("Business criteria"), type: "criteria", criteriaText: "Claims software", definition: "Claims software", ignored: [], revision: 8, phase: "business", decision: "approved" }] };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => key === `screening-chat-v1:${id}` ? JSON.stringify(state) : null } });
  try {
    const loaded = getChatState(id), card = loaded.artifacts[0];
    assert.equal(loaded.revision, 7);
    assert.equal(loaded.approvedRevision, undefined);
    assert.ok(card.type === "criteria");
    assert.equal(card.revision, 7);
    assert.equal(card.decision, "pending");
    assert.equal(card.phase, undefined);
    assert.equal(card.goodFitExamples, "Good company");
  } finally { Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous }); }
});

test("unchanged examples approve the same saved backend revision with one criteria card", async () => {
  await withBackend(async requests => {
    const id = session();
    const card = reviseCriteria(id, "Claims software", "Claims software");
    await flushCriteriaDraft(id);
    assert.equal(getChatState(id).revision, 7);
    assert.equal(getChatState(id).durableCriteria?.revision, 7);
    await approveCriteriaWithExamples(id, card.id, "", "");
    assert.equal(getChatState(id).approvedRevision, 7);
    assert.equal(requests.filter(request => request.tool === "save_criteria_revision").length, 1);
    assert.deepEqual(requests.at(-1)?.arguments, { run_id: getChatState(id).backendRunId, revision: 7, digest: "digest-7", approved_by: "Analyst approval in Screening" });
    assert.equal(getChatState(id).artifacts.filter(artifact => artifact.type === "criteria").length, 1);
    assert.equal(getChatState(id).artifacts.some(artifact => artifact.type === "fit-examples"), false);
  }, 6);
});

test("queued saves assign Rust revisions to historical cards without replacing the latest draft", async () => {
  const previous = globalThis.fetch;
  let beginFirst!: () => void, finishFirst!: () => void;
  const firstStarted = new Promise<void>(resolve => { beginFirst = resolve; });
  const firstReleased = new Promise<void>(resolve => { finishFirst = resolve; });
  let saves = 0;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.tool === "create_run") return new Response(JSON.stringify({ ok: true, result: { run_id: "queued-run" } }));
    const revision = 6 + ++saves;
    if (saves === 1) { beginFirst(); await firstReleased; }
    return new Response(JSON.stringify({ ok: true, result: { revision, digest: `digest-${revision}` } }));
  };
  try {
    const id = session(), first = reviseCriteria(id, "Claims software", "Claims software");
    await firstStarted;
    const second = reviseCriteria(id, "Payroll software", "Payroll software");
    finishFirst();
    await flushCriteriaDraft(id);
    const state = getChatState(id);
    assert.equal(state.revision, 8);
    assert.equal(state.definition, "Payroll software");
    assert.equal(state.durableCriteria?.revision, 8);
    const revisions = state.artifacts.filter(artifact => artifact.type === "criteria");
    assert.equal(revisions.find(artifact => artifact.id === first.id)?.revision, 7);
    assert.equal(revisions.find(artifact => artifact.id === second.id)?.revision, 8);
    await assert.rejects(approveCriteriaWithExamples(id, first.id), /latest/);
  } finally { finishFirst(); globalThis.fetch = previous; }
});

test("edited inline examples save N+1 before approving its exact revision and digest", async () => {
  await withBackend(async requests => {
    const id = session();
    const original = reviseCriteria(id, "Claims software", "Claims software");
    await flushCriteriaDraft(id);
    const card = await approveCriteriaWithExamples(id, original.id, "Good company\nAnother company", "Bad company");
    assert.equal(card.type, "criteria");
    assert.equal(getChatState(id).approvedRevision, 2);
    assert.equal(getChatState(id).revision, 2);
    const saves = requests.filter(request => request.tool === "save_criteria_revision");
    assert.equal(saves.length, 2);
    assert.deepEqual(saves[1].arguments.good_fit_examples, ["Good company\nAnother company"]);
    assert.deepEqual(saves[1].arguments.bad_fit_examples, ["Bad company"]);
    assert.equal(requests.at(-1)?.tool, "approve_criteria_revision");
    assert.equal(requests.at(-1)?.arguments.revision, 2);
    assert.equal(requests.at(-1)?.arguments.digest, "digest-2");
    const events = sessionStore.getSnapshot().sessions.find(item => item.id === id)!.events;
    assert.equal(events.filter(event => event.kind === "approval").length, 1);
    assert.equal(events.filter(event => event.kind === "system" && event.title === "Criteria examples revised").length, 1);
    assert.equal(getChatState(id).artifacts.find(artifact => artifact.id === original.id)?.type === "criteria" && (getChatState(id).artifacts.find(artifact => artifact.id === original.id) as { decision: string }).decision, "declined");
  });
});

test("stale approval actions cannot save or approve after a different draft is created", async () => {
  await withBackend(async requests => {
    const id = session(), old = reviseCriteria(id, "Claims software", "Claims software");
    await flushCriteriaDraft(id);
    reviseCriteria(id, "Payroll software", "Payroll software");
    await flushCriteriaDraft(id);
    const count = requests.length;
    await assert.rejects(approveCriteriaWithExamples(id, old.id, "Good", "Bad"), /latest/);
    assert.equal(requests.length, count);
    assert.equal(getChatState(id).approvedRevision, undefined);
  });
});

test("criteria edits clear displayed results while retaining the earlier search for cancellation", async () => {
  await withBackend(async () => {
    const id = session();
    reviseCriteria(id, "Claims software", "Claims software");
    await flushCriteriaDraft(id);
    const originalRevision = getChatState(id).revision;
    updateChatState(id, { jobId: "earlier-search", jobContext: { id: "earlier-search", revision: originalRevision, turnId: "turn", messageId: "answer" }, counts: { midOnly: 7, isccOnly: 0, both: 0 } });
    reviseCriteria(id, "Payroll software", "Payroll software");
    await flushCriteriaDraft(id);
    const state = getChatState(id);
    assert.equal(state.jobId, "earlier-search");
    assert.equal(state.jobContext?.revision, originalRevision);
    assert.notEqual(state.revision, originalRevision);
    assert.deepEqual(state.counts, { midOnly: 0, isccOnly: 0, both: 0 });
    assert.deepEqual(state.companies, []);
  });
});

test("an edit during the examples save never authorizes the replacement draft", async () => {
  const previous = globalThis.fetch;
  const requests: { tool: string; arguments: Record<string, unknown> }[] = [];
  let beginExamples!: () => void, finishExamples!: () => void, revision = 0;
  const examplesStarted = new Promise<void>(resolve => { beginExamples = resolve; });
  const examplesReleased = new Promise<void>(resolve => { finishExamples = resolve; });
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request);
    if (request.tool === "create_run") return new Response(JSON.stringify({ ok: true, result: { run_id: "approval-race-run" } }));
    if (request.tool === "save_criteria_revision") {
      const savedRevision = ++revision;
      if (savedRevision === 2) { beginExamples(); await examplesReleased; }
      return new Response(JSON.stringify({ ok: true, result: { revision: savedRevision, digest: `digest-${savedRevision}` } }));
    }
    return new Response(JSON.stringify({ ok: true, result: {} }));
  };
  try {
    const id = session(), card = reviseCriteria(id, "Claims software", "Claims software");
    await flushCriteriaDraft(id);
    const approval = approveCriteriaWithExamples(id, card.id, "Good company", "");
    await examplesStarted;
    reviseCriteria(id, "Payroll software", "Payroll software");
    const rejected = assert.rejects(approval, /changed|latest/);
    finishExamples();
    await rejected;
    await flushCriteriaDraft(id);
    assert.equal(requests.filter(request => request.tool === "approve_criteria_revision").length, 0);
    assert.equal(getChatState(id).definition, "Payroll software");
    assert.equal(getChatState(id).approvedRevision, undefined);
  } finally { finishExamples(); globalThis.fetch = previous; }
});

test("hidden action metadata survives routing and transcript reload without fake message events", async () => {
  await withBackend(async () => {
    const id = session();
    const message = fromThreadMessageLike({ id: "hidden-example", role: "user", content: [{ type: "text", text: "/example" }], metadata: { custom: hiddenActionMetadata("/example") } }, "hidden-example", { type: "complete", reason: "stop" });
    assert.equal(message.metadata.custom.hidden, true);
    const adapter = createChatAdapter(id, { openLog: () => {}, title: () => "Criteria" });
    for await (const _ of adapter.run({ messages: [message], abortSignal: new AbortController().signal, unstable_assistantMessageId: "answer", runConfig: {} } as unknown as Parameters<ChatModelAdapter["run"]>[0]) as AsyncIterable<unknown>) { /* drain */ }
    assert.match(getChatState(id).definition, /insurance/i);
    const restored = transcriptFor(id).find(item => item.id === "hidden-example");
    assert.equal(restored?.metadata?.custom?.hidden, true);
    assert.equal((restored?.metadata?.custom?.artifactAction as { type: string }).type, "command");
    const event = sessionStore.getSnapshot().sessions.find(item => item.id === id)?.events.find(item => item.messageId === "hidden-example");
    assert.equal(event?.kind, "system");
    assert.equal(event?.role, "user");
  });
});

test("approval routing relies on metadata even when the action label is arbitrary", async () => {
  await withBackend(async requests => {
    const id = session(), card = reviseCriteria(id, "Claims software", "Claims software");
    await flushCriteriaDraft(id);
    const message = fromThreadMessageLike({ id: "approval-action", role: "user", content: "Button action", metadata: { custom: hiddenActionMetadata("Button action", { type: "approve-criteria", artifactId: card.id }) } }, "approval-action", { type: "complete", reason: "stop" });
    // A discovery job request is intentionally rejected by this mock after
    // criteria approval, so no fabricated discovery result is created.
    const adapter = createChatAdapter(id, { openLog: () => {}, title: () => "Criteria" });
    for await (const _ of adapter.run({ messages: [message], abortSignal: new AbortController().signal, unstable_assistantMessageId: "answer", runConfig: {} } as unknown as Parameters<ChatModelAdapter["run"]>[0]) as AsyncIterable<unknown>) { /* drain */ }
    assert.equal(getChatState(id).approvedRevision, 1);
    assert.equal(requests.some(request => request.tool === "approve_criteria_revision"), true);
  });
});

test("history versions map start, end, approval metadata and statuses in revision order", () => {
  const rows = mapCriteriaVersions([
    { revision: 3, criteria_text: "Current", business_definition: "Current", created_at: "2026-10-07T12:00:00Z", approved: false },
    { revision: 1, criteria_text: "Original", created_at: "2026-10-07T10:00:00Z", approved: true, approved_by: "Analyst", approved_at: "2026-10-07T10:05:00Z", superseded_at: "2026-10-07T11:00:00Z" },
    { revision: 2, criteria_text: "Second", created_at: "2026-10-07T11:00:00Z", approved: false },
  ]);
  assert.deepEqual(rows.map(row => row.revision), [1, 2, 3]);
  assert.deepEqual(rows.map(row => row.status), ["Superseded", "Superseded", "Draft"]);
  assert.equal(rows[0].createdAt, "2026-10-07T10:00:00Z");
  assert.equal(rows[0].endedAt, "2026-10-07T11:00:00Z");
  assert.equal(rows[1].endedAt, rows[2].createdAt);
  assert.equal(rows[2].endedAt, undefined);
  assert.equal(rows[0].approvedBy, "Analyst");
  assert.equal(rows[0].approvedAt, "2026-10-07T10:05:00Z");
  assert.equal(mapCriteriaVersions([{ revision: 1, approved: true }])[0].status, "Approved");
});

test("intake saves all fields plus only core-business exclusions and preserves them on examples edits", async () => {
  await withBackend(async requests => {
    const id = session();
    const intakeForm = normalizeIntake({ investmentThesis: "Claims software excluding brokers, US companies", submitterName: "Analyst", sizeParameters: ["$0–50MM"], geographyFocus: ["Canada"] });
    const draft = intakeToCriteria(intakeForm);
    const card = reviseCriteria(id, draft.criteriaText, draft.definition, draft.deferred, undefined, { intakeForm });
    await flushCriteriaDraft(id);
    const saved = requests.find(request => request.tool === "save_criteria_revision")!;
    assert.deepEqual(saved.arguments.intake_form, intakeForm);
    assert.deepEqual(saved.arguments.core_business_exclusions, ["brokers"]);
    assert.deepEqual(getChatState(id).ignored, draft.deferred);
    await approveCriteriaWithExamples(id, card.id, "Good company", "");
    const second = requests.filter(request => request.tool === "save_criteria_revision").at(-1)!;
    assert.deepEqual(second.arguments.intake_form, intakeForm);
    assert.deepEqual(second.arguments.core_business_exclusions, ["brokers"]);
  });
});

test("history reads cache per run and saves invalidate the cache", async () => {
  await withBackend(async requests => {
    const id = session(), card = reviseCriteria(id, "Claims software", "Claims software");
    await flushCriteriaDraft(id);
    const runId = getChatState(id).backendRunId!;
    await Promise.all([readCriteriaHistory(id, runId), readCriteriaHistory(id, runId)]);
    assert.equal(requests.filter(request => request.tool === "get_criteria_history").length, 1);
    await approveCriteriaWithExamples(id, card.id, "Good", "");
    await readCriteriaHistory(id, runId);
    assert.equal(requests.filter(request => request.tool === "get_criteria_history").length, 2);
    updateChatState(id, { criteriaSaveError: undefined });
  });
});
