import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fromThreadMessageLike,
  type ChatModelAdapter,
} from "@assistant-ui/react";
import { appendWorkspaceMessages } from "../src/lib/workspace-message-sync";
import {
  approveCriteria,
  createChatAdapter,
  pendingWorkspaceMessages,
  reviseCriteria,
  transcriptFor,
} from "../src/lib/chat-driver";
import {
  approved,
  artifactBase,
  emptyChatState,
  getChatState,
  mirrorWorkspace,
  saveArtifact,
  syncWorkspaceIntoChat,
  updateChatState,
} from "../src/lib/chat-store";
import { startDiscovery, syncJob } from "../src/lib/chat-jobs";
import type { ArtifactAction, JobSnapshot } from "../src/lib/chat-contract";
import { sessionStore } from "../src/lib/session-store";
import { buildSessionArchive } from "../src/lib/session-export";
import { strFromU8, unzipSync } from "fflate";
import { flushCriteriaDraft } from "../src/lib/review-client";
import { companies as exampleCompanies } from "../src/lib/fixtures";
// @ts-expect-error The production scheduler is plain server-only Node ESM.
import { createJobRegistry } from "../server/jobs.mjs";

const session = () => sessionStore.createSession("Chat contract review");
test("a workspace result attaches to the runtime branch selected by the analyst rather than a newer sibling", () => {
  const entry = (id: string, parentId: string | null) => ({
    parentId,
    message: fromThreadMessageLike(
      { id, role: "assistant", content: [{ type: "text", text: id }] },
      id,
      { type: "complete", reason: "stop" },
    ),
  });
  const repository = {
    headId: "older-answer",
    messages: [
      entry("root", null),
      entry("older-answer", "root"),
      entry("newer-answer", "root"),
    ],
  };
  const next = appendWorkspaceMessages(repository, [
    {
      id: "setup",
      role: "assistant",
      content: [{ type: "text", text: "Saved setup" }],
    },
  ]);
  assert.equal(
    next.messages.find((item) => item.message.id === "setup")?.parentId,
    "older-answer",
  );
  assert.equal(next.headId, "setup");
  assert.equal(
    next.messages.find((item) => item.message.id === "newer-answer")?.parentId,
    "root",
  );
  assert.equal(repository.headId, "older-answer");
  assert.equal(
    appendWorkspaceMessages(next, [
      { id: "setup", role: "assistant", content: "Duplicate" },
    ]).messages.length,
    next.messages.length,
  );
});
test("workspace setup and upload messages reach the live branch once, without restoring abandoned branches", () => {
  const id = session();
  updateChatState(id, { branchMessageIds: ["existing", "upload", "saved"] });
  for (const messageId of ["existing", "abandoned", "upload", "saved"]) {
    sessionStore.addEvent({
      sessionId: id,
      kind: "message",
      role: "assistant",
      origin: "workspace",
      status: "success",
      title: "Workspace result",
      messageId,
      text: messageId,
      content: [{ type: "text", text: messageId }],
    });
  }
  assert.deepEqual(
    pendingWorkspaceMessages(id, ["existing"]).map((message) => message.id),
    ["upload", "saved"],
  );
  assert.deepEqual(
    pendingWorkspaceMessages(id, ["existing", "upload", "saved"]),
    [],
  );
  updateChatState(id, { branchMessageIds: ["existing", "upload"] });
  assert.deepEqual(pendingWorkspaceMessages(id, ["existing", "upload"]), []);
});
test("direct provider questions use chat without a setup and preserve the criteria", async () => {
  const id = session(), prior = globalThis.fetch;
  reviseCriteria(id, "Claims software", "Claims software"); approveCriteria(id);
  const revision = getChatState(id).revision, sent: any[] = [];
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(String(init?.body));
    if (String(url) === '/api/conversation/ask') { sent.push(payload); return new Response(JSON.stringify({ executed: false, message: 'Not connected', calls: [] })); }
    return new Response(JSON.stringify({ ok: true, result: { run_id: 'run-direct', revision: 1, digest: 'draft' } }));
  };
  try {
    await flushCriteriaDraft(id);
    await reply(id, [user("provider-request", "Ask LLM Suite and M365 Copilot which business questions matter?")]);
    assert.deepEqual(sent.map(request => request.provider), ['llm_suite', 'copilot']);
    assert.ok(sent.every(request => /^[A-Za-z0-9._-]+$/.test(request.requestId)));
    assert.ok(!getChatState(id).artifacts.some(artifact => artifact.type === 'screening-request' || artifact.type === 'screening-setup'));
    assert.equal(getChatState(id).revision, revision);
    assert.equal(approved(getChatState(id)), true);
    assert.ok(!events(id).some(event => event.toolName === 'dispatch_provider_text'));
  } finally { globalThis.fetch = prior; }
});

test('selected providers preserve workflow commands and answer questions about screening directly', async () => {
  const id = session(), prior = globalThis.fetch, asks: any[] = [];
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (url === '/api/conversation/ask') { asks.push(request); return new Response(JSON.stringify({ executed: false, message: 'Not connected', calls: [] })); }
    return new Response(JSON.stringify({ ok: true, result: request.tool === 'create_run' ? { run_id: 'routing-run' } : { revision: 1, digest: 'draft' } }));
  };
  try {
    reviseCriteria(id, 'Claims software', 'Claims software'); await flushCriteriaDraft(id);
    updateChatState(id, { model: 'llm_suite', companies: exampleCompanies.slice(0, 1) });
    await reply(id, [user('search-request', 'find companies')]);
    assert.equal(asks.length, 0);
    assert.ok(!getChatState(id).artifacts.some(artifact => artifact.type === 'screening-request'));
    await reply(id, [user('steps-request', 'next steps')]);
    assert.equal(asks.length, 0);
    assert.ok(getChatState(id).artifacts.some(artifact => artifact.type === 'options'));
    await reply(id, [user('criteria-question', '/llm What screening criteria do we use?')]);
    await reply(id, [user('result-question', 'Explain the screening results')]);
    assert.equal(asks.length, 2);
    assert.ok(!getChatState(id).artifacts.some(artifact => artifact.type === 'screening-request'));
    await reply(id, [user('batch-request', '/screen Score these companies')]);
    assert.ok(getChatState(id).artifacts.some(artifact => artifact.type === 'screening-request'));
  } finally { globalThis.fetch = prior; }
});

test("a provider screening step does not swallow earlier PitchBook and ROGO instructions", async () => {
  const id = session();
  await reply(id, [
    user(
      "mixed-plan",
      "Populate PitchBook data and ROGO data then run LLMSuite screening",
    ),
  ]);
  const artifacts = getChatState(id).artifacts;
  assert.deepEqual(
    artifacts
      .filter((a) => a.type === "enrichment-upload")
      .map((a) => a.type === "enrichment-upload" && a.source),
    ["pitchbook", "rogo"],
  );
  assert.ok(
    artifacts.some(
      (a) =>
        a.type === "screening-request" &&
        a.provider === "llm_suite" &&
        a.mode === "screening",
    ),
  );
  assert.ok(!events(id).some((e) => e.kind === "tool"));
});
const events = (id: string) =>
  sessionStore.getSnapshot().sessions.find((s) => s.id === id)!.events;
const user = (id: string, text: string, action?: ArtifactAction) => ({
  id,
  role: "user",
  content: [{ type: "text", text }],
  attachments: [],
  metadata: { custom: action ? { artifactAction: action } : {} },
});
async function reply(
  id: string,
  messages: unknown[],
  assistantId: string = crypto.randomUUID(),
) {
  const adapter = createChatAdapter(id, {
    openLog() {},
    title: () => "Review",
  });
  const run = adapter.run({
    messages,
    abortSignal: new AbortController().signal,
    unstable_assistantMessageId: assistantId,
  } as unknown as Parameters<ChatModelAdapter["run"]>[0]);
  const output = [];
  for await (const update of run as AsyncIterable<unknown>) output.push(update);
  return output;
}
test("/data reads current source context without revising criteria or starting another search", async () => {
  const id = session();
  reviseCriteria(id, "Insurance software", "Insurance software", []);
  updateChatState(id, { companies: [{ ...exampleCompanies[0], pk: "A-1" }], backendRunId: "run-data", approvedRevision: getChatState(id).revision });
  const revision = getChatState(id).revision, prior = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls.push(request.tool);
    if (request.tool === 'save_criteria_revision') return new Response(JSON.stringify({ ok: true, result: { revision: 1, digest: 'draft' } }));
    if (request.tool === 'get_shortlist_context') return new Response(JSON.stringify({ ok: true, result: { total: 1, considered_count: 1, candidates: [{ company_id: 'A-1', considered: true }], selection_revision: 0, source_hash: 'stable', has_more: false, review_columns: {}, coverage: { PB: 1, ROGO: 1, BING: 0 } } }));
    return new Response(JSON.stringify({ ok: true, result: { total: 1, next_cursor: null, rows: [{ pk: "A-1", PBId: "PB-1", sources: { MID: { "Company Name": "MID name", Website: "mid.example", Description: "MID business" }, ISCC: {}, PB: { PB_Name: "PB name", PB_Website: "", PB_Description: "PB business" }, ROGO: { Notes: "Extra context" } }, provenance: {} }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await flushCriteriaDraft(id); calls.length = 0;
    await reply(id, [user("current-data", "/data")]);
    const table = getChatState(id).artifacts.find(a => a.type === "data-table");
    assert.ok(table?.type === "data-table");
    assert.equal(table.rows[0]["Company Name"], "PB name");
    assert.equal(table.rows[0].Website, "mid.example");
    assert.equal(table.rows[0]["ROGO: Notes"], "Extra context");
    assert.equal(getChatState(id).revision, revision);
    assert.equal(approved(getChatState(id)), true);
    assert.deepEqual(calls, ["get_shortlist_context", "get_candidate_source_data"]);
  } finally { globalThis.fetch = prior; }
});
function completed(
  id: string,
  revision: number,
  jobId = crypto.randomUUID(),
): JobSnapshot {
  updateChatState(id, {
    jobId,
    jobContext: {
      id: jobId,
      revision,
      turnId: "job-turn",
      messageId: "job-answer",
    },
  });
  return {
    id: jobId,
    sessionId: id,
    state: "completed",
    startedAt: "2026-10-04T00:00:00.000Z",
    finishedAt: "2026-10-04T00:00:01.000Z",
    events: [
      {
        id: "rust-call",
        type: "tool-start",
        tool: "search_mid",
        args: { query: "claims software" },
        timestamp: "2026-10-04T00:00:00.000Z",
      },
      {
        id: "rust-call",
        type: "tool-result",
        tool: "search_mid",
        result: { found: 1 },
        timestamp: "2026-10-04T00:00:01.000Z",
      },
    ],
    result: {
      backendRunId: "rust-review",
      counts: { midOnly: 1, isccOnly: 0, both: 0 },
      companies: [
        {
          row: { company: { company_id: "MID-NATIVE" }, score: 1.372 },
          detail: {
            company_id: "MID-NATIVE",
            name: "Native scores",
            website: "example.test",
          },
          sourceRows: [
            {
              source: "MID",
              row: { Description: "Original MID description", ECID: "ec-1" },
            },
          ],
        },
      ],
    },
  };
}

test("unapproved search is rejected before a request and stale criteria approval cannot authorize a revision", async () => {
  const id = session();
  const old = reviseCriteria(id, "Claims software", "Claims software");
  await assert.rejects(
    startDiscovery(id, "Review", "turn", "answer"),
    /approve/i,
  );
  reviseCriteria(id, "Payroll software", "Payroll software");
  assert.throws(() => approveCriteria(id, old.id), /out of date/);
  assert.equal(approved(getChatState(id)), false);
  assert.equal(events(id).filter((e) => e.kind === "approval").length, 0);
});

test("criteria changes revoke approval while preserving the saved run and other screenings", () => {
  const a = session(),
    b = session();
  reviseCriteria(a, "Claims software", "Claims software");
  approveCriteria(a);
  reviseCriteria(b, "Payroll software", "Payroll software");
  approveCriteria(b);
  updateChatState(a, { backendRunId: "old-rust" });
  reviseCriteria(a, "Policy software", "Policy software");
  assert.equal(approved(getChatState(a)), false);
  assert.equal(getChatState(a).backendRunId, "old-rust");
  assert.equal(approved(getChatState(b)), true);
  assert.equal(getChatState(b).definition, "Payroll software");
});

test("repeated job snapshots produce one receipt, response and result artifact with native provenance", () => {
  const id = session();
  reviseCriteria(id, "Claims software", "Claims software");
  approveCriteria(id);
  const job = completed(id, getChatState(id).revision);
  syncJob(job);
  syncJob(job);
  assert.equal(events(id).filter((e) => e.kind === "tool").length, 1);
  assert.equal(
    events(id).filter((e) => e.kind === "message" && e.jobId === job.id).length,
    1,
  );
  assert.equal(
    getChatState(id).artifacts.filter((a) => a.type === "companies").length,
    1,
  );
  assert.equal(getChatState(id).companies[0].pk, "MID-NATIVE");
  assert.equal(getChatState(id).companies[0].midScore, 1.372);
  assert.equal(getChatState(id).companies[0].isccScore, undefined);
  assert.equal(
    getChatState(id).companies[0].rawMid?.Description,
    "Original MID description",
  );
});

test("a completed job from old criteria remains an artifact but cannot replace current results", () => {
  const id = session();
  reviseCriteria(id, "Claims software", "Claims software");
  approveCriteria(id);
  const job = completed(id, getChatState(id).revision);
  reviseCriteria(id, "Payroll software", "Payroll software");
  approveCriteria(id);
  syncJob(job);
  assert.equal(getChatState(id).companies.length, 0);
  assert.equal(getChatState(id).backendRunId, undefined);
  const artifact = getChatState(id).artifacts.find(
    (a) => a.type === "companies",
  );
  assert.ok(artifact?.type === "companies");
  assert.match(artifact.note ?? "", /earlier criteria/);
});

test("editing a criteria user message into a command invalidates the original criteria approval", async () => {
  const id = session(), prior = globalThis.fetch;
  const saved: any[] = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    saved.push(request);
    return new Response(JSON.stringify({ ok: true, result: request.tool === 'create_run' ? { run_id: 'edited-run' } : { revision: saved.length, digest: 'current-draft' } }));
  };
  try {
  await reply(
    id,
    [user("original-criteria-message", "Claims software")],
    "criteria-answer",
  );
  approveCriteria(id);
  const revision = getChatState(id).revision;
  await reply(
    id,
    [user("replacement-message", "/criteria")],
    "replacement-answer",
  );
  assert.equal(approved(getChatState(id)), false);
  assert.ok(getChatState(id).revision > revision);
  assert.ok(saved.filter(request => request.tool === 'save_criteria_revision').length >= 2);
  assert.equal(saved.at(-1).arguments.business_definition, getChatState(id).definition);
  } finally { globalThis.fetch = prior; }
});

test("a new review command appended to the existing branch preserves valid approval", async () => {
  const id = session();
  const criteria = user("criteria-message", "Claims software");
  await reply(id, [criteria], "criteria-answer");
  approveCriteria(id);
  await reply(
    id,
    [
      criteria,
      ...transcriptFor(id).filter((m) => m.role === "assistant"),
      user("review-command", "/criteria"),
    ],
    "review-answer",
  );
  assert.equal(approved(getChatState(id)), true);
});

test("retrying the unchanged criteria response preserves the approved revision", async () => {
  const id = session();
  const criteria = user("original-criteria", "Claims software");
  await reply(id, [criteria], "first-answer");
  approveCriteria(id);
  const revision = getChatState(id).revision;
  await reply(id, [criteria], "retried-answer");
  assert.equal(approved(getChatState(id)), true);
  assert.equal(getChatState(id).revision, revision);
});

test("an earlier company artifact cannot silently read a different current company", async () => {
  const id = session();
  reviseCriteria(id, "Claims software", "Claims software");
  approveCriteria(id);
  const job = completed(id, getChatState(id).revision);
  syncJob(job);
  const oldArtifact = getChatState(id).artifacts.find(
    (a) => a.type === "companies",
  )!;
  const other = {
    ...getChatState(id).companies[0],
    pk: "DIFFERENT-COMPANY",
    name: "Different current company",
  };
  updateChatState(id, { companies: [other], backendRunId: "current-run" });
  const requests: Record<string, unknown>[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true, result: { core: {} } }), {
      status: 200,
    });
  };
  try {
    await reply(id, [
      user("inspect-old-company", "@MID-NATIVE Show company context", {
        type: "inspect-company",
        artifactId: oldArtifact.id,
        companyId: "MID-NATIVE",
      }),
    ]);
    assert.ok(
      requests.every(
        (request) =>
          (request.arguments as Record<string, unknown>).company_id !==
          "DIFFERENT-COMPANY",
      ),
    );
  } finally {
    globalThis.fetch = prior;
  }
});

test("an earlier checkpoint artifact cannot silently inspect the current run checkpoint", async () => {
  const id = session();
  const artifact = saveArtifact(id, {
    ...artifactBase("Earlier checkpoint"),
    type: "checkpoint",
    key: "screening-ui",
    backendRunId: "earlier-run",
    summary: "Earlier criteria",
  });
  updateChatState(id, { backendRunId: "current-run" });
  const requests: Record<string, unknown>[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({ ok: true, result: { checkpoint: {} } }),
      { status: 200 },
    );
  };
  try {
    await reply(id, [
      user("inspect-old-checkpoint", "/checkpoint", {
        type: "inspect-checkpoint",
        artifactId: artifact.id,
      }),
    ]);
    assert.ok(
      requests.every(
        (request) =>
          (request.arguments as Record<string, unknown>).run_id !==
          "current-run",
      ),
    );
  } finally {
    globalThis.fetch = prior;
  }
});

test("background completion remains in the transcript after another message is sent while detached", async () => {
  const id = session();
  reviseCriteria(id, "Claims software", "Claims software");
  approveCriteria(id);
  const job = completed(id, getChatState(id).revision);
  await reply(id, [user("while-background", "/flow")], "flow-answer");
  syncJob(job);
  assert.ok(transcriptFor(id).some((m) => m.id === "job-answer"));
});

test("corrupt nested chat state is reset before malformed artifacts reach the renderer", () => {
  const id = session();
  const prior = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () =>
        JSON.stringify({ ...emptyChatState(id), artifacts: [null] }),
      setItem() {},
    },
  });
  try {
    assert.deepEqual(getChatState(id).artifacts, []);
    assert.equal(approved(getChatState(id)), false);
    assert.ok(
      events(id).some((e) => e.title === "Saved chat could not be restored"),
    );
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: prior,
    });
  }
});

test("corrupt optional artifact fields are rejected before React render", () => {
  const corrupt = [
    {
      ...artifactBase("Options"),
      type: "options",
      recommended: "pitchbook",
      options: [],
      selected: {},
    },
    {
      ...artifactBase("Job"),
      type: "job",
      jobId: "corrupt-job",
      state: "running",
      detail: {},
    },
    {
      ...artifactBase("Plan"),
      type: "plan",
      diagram: "",
      steps: [{ id: "draft", label: "Draft", status: "pending", detail: {} }],
    },
    {
      ...artifactBase("Saved setup"),
      type: "screening-setup",
      prepared: {
        id: "SETUP-test",
        title: "LLMSuite screening",
        fingerprint: "a".repeat(64),
        savedAt: new Date().toISOString(),
        executed: false,
        status: "prepared",
        provider: "llm_suite",
        mode: "screening",
        model: "test-deployment",
        companyCount: 7,
        batches: 1,
        config: {
          provider: "llm_suite",
          mode: "screening",
          model: "test-deployment",
          batchSize: 25,
          prompt: "Assess business fit",
          inputColumns: ["index", "pk"],
          outputColumns: ["index", "Fit Score"],
          identitySources: null,
        },
        checkpoint: {
          runId: "R1",
          namespace: "screening-setup:test",
          sequence: 1,
        },
      },
    },
  ];
  for (const artifact of corrupt) {
    const id = session();
    const prior = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () =>
          JSON.stringify({ ...emptyChatState(id), artifacts: [artifact] }),
        setItem() {},
      },
    });
    try {
      assert.deepEqual(getChatState(id).artifacts, []);
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: prior,
      });
    }
  }
});

test("file artifacts create a ZIP with original declared bytes and scoped source events", async () => {
  const id = session(),
    bytes = new Uint8Array([0, 255, 20, 42]);
  sessionStore.addEvent({
    sessionId: id,
    kind: "artifact",
    status: "success",
    origin: "assistant",
    title: "Upload",
    result: {
      type: "file",
      file: { id: "original.pdf", name: "Original.pdf", bytes: bytes.length },
    },
  });
  const current = sessionStore.getSnapshot().sessions.find((s) => s.id === id)!;
  const zip = unzipSync(
    (
      await buildSessionArchive(current, async (fileId) => {
        assert.equal(fileId, "original.pdf");
        return bytes;
      })
    ).bytes,
  );
  const manifest = JSON.parse(strFromU8(zip["manifest.json"]));
  assert.deepEqual(zip[manifest.attachments.files[0].path], bytes);
  assert.ok(manifest.attachments.files[0].path.endsWith(".pdf"));
  assert.equal(manifest.session.id, id);
  await assert.rejects(
    buildSessionArchive(current, async () => new Uint8Array(2)),
    /size changed/,
  );
});

test("archived uploads retain long filename extensions without unsafe path segments", async () => {
  const id = session();
  const bytes = new Uint8Array([80, 75, 3, 4]);
  sessionStore.addEvent({
    sessionId: id,
    kind: "artifact",
    status: "success",
    origin: "assistant",
    title: "Upload",
    result: {
      type: "file",
      file: {
        id: "long-upload.xlsx",
        name: `../../${"company-data-".repeat(12)}.XLSX`,
        bytes: bytes.length,
      },
    },
  });
  const current = sessionStore.getSnapshot().sessions.find((s) => s.id === id)!;
  const zip = unzipSync(
    (await buildSessionArchive(current, async () => bytes)).bytes,
  );
  const manifest = JSON.parse(strFromU8(zip["manifest.json"]));
  const path: string = manifest.attachments.files[0].path;
  assert.ok(path.endsWith(".xlsx"));
  assert.deepEqual(path.split("/").length, 2);
  assert.ok(!path.includes("\\"));
  assert.ok(!path.split("/").includes(".."));
  assert.deepEqual(zip[path], bytes);
});

test("mirroring unchanged chat criteria preserves workspace notes, LinkedIn edits and selected plan", () => {
  const id = session();
  reviseCriteria(id, "Claims software", "Claims software");
  approveCriteria(id);
  const saved = new Map<string, string>();
  const prior = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    },
  });
  try {
    mirrorWorkspace(getChatState(id));
    const key = `screening-workspace-v3:${id}`;
    const workspace = JSON.parse(saved.get(key)!);
    workspace.notes = { "MID-NATIVE": "Analyst note" };
    workspace.linkedinOverrides = {
      "MID-NATIVE": "https://www.linkedin.com/company/native",
    };
    workspace.plan = ["pitchbook", "rogo"];
    saved.set(key, JSON.stringify(workspace));
    mirrorWorkspace(getChatState(id));
    const after = JSON.parse(saved.get(key)!);
    assert.deepEqual(after.notes, workspace.notes);
    assert.deepEqual(after.linkedinOverrides, workspace.linkedinOverrides);
    assert.deepEqual(after.plan, workspace.plan);
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: prior,
    });
  }
});

test("workspace approval revoked by an examples edit is revoked in chat even with unchanged business text", () => {
  const id = session();
  reviseCriteria(id, "Claims software", "Claims software");
  approveCriteria(id);
  const saved = new Map<string, string>();
  const prior = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    },
  });
  try {
    mirrorWorkspace(getChatState(id));
    const key = `screening-workspace-v3:${id}`;
    const workspace = JSON.parse(saved.get(key)!);
    workspace.example = "Changed examples require fresh approval";
    workspace.criteriaApproved = false;
    saved.set(key, JSON.stringify(workspace));
    syncWorkspaceIntoChat(id);
    assert.equal(approved(getChatState(id)), false);
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: prior,
    });
  }
});

test("reload or repeated requests cannot create duplicate active jobs for one screening", async () => {
  const registry = createJobRegistry({ call: async () => ({}) });
  const input = {
    sessionId: "duplicate-job-review",
    title: "Claims software",
    criteriaText: "Claims software",
    definition: "Claims software",
    criteriaApproved: true,
  };
  const first = registry.create(input);
  try {
    try {
      registry.create(input);
    } catch (error) {
      assert.match(String(error), /already|running|progress/i);
    }
    assert.equal(
      registry
        .list()
        .filter(
          (job: JobSnapshot) =>
            job.sessionId === input.sessionId && job.state === "running",
        ).length,
      1,
    );
  } finally {
    for (const job of registry.list()) registry.cancel(job.id);
    await registry.wait(first.id);
  }
});

test("sending a supporting PDF note preserves approved criteria and current company results", async () => {
  const id = session();
  const criteria = user("business-criteria", "Claims software");
  await reply(id, [criteria], "criteria-reply");
  approveCriteria(id);
  updateChatState(id, { backendRunId: "existing-run" });
  const revision = getChatState(id).revision;
  const file = saveArtifact(id, {
    ...artifactBase("Supporting PDF"),
    type: "file",
    file: {
      id: "supporting-file.pdf",
      name: "brief.pdf",
      bytes: 30,
      kind: "pdf",
      importable: false,
    },
  });
  const upload = {
    ...user("supporting-note", "Keep this brief as a supporting file."),
    attachments: [
      {
        id: "supporting-file.pdf",
        name: "brief.pdf",
        type: "document",
        contentType: "application/pdf",
        status: { type: "complete" },
        content: [
          {
            type: "data",
            name: "screening-artifact",
            data: { artifactId: file.id },
          },
        ],
      },
    ],
  };
  await reply(
    id,
    [
      criteria,
      ...transcriptFor(id).filter((message) => message.role === "assistant"),
      upload,
    ],
    "supporting-reply",
  );
  const state = getChatState(id);
  assert.equal(state.criteriaText, "Claims software");
  assert.equal(state.revision, revision);
  assert.equal(approved(state), true);
  assert.equal(state.backendRunId, "existing-run");
  assert.match(events(id).at(-1)?.text ?? "", /supporting file/);
});

test("an explicit new business description accompanying a PDF still creates a fresh criteria draft", async () => {
  const id = session();
  const criteria = user("business-criteria", "Claims software");
  await reply(id, [criteria], "criteria-reply");
  approveCriteria(id);
  const file = saveArtifact(id, {
    ...artifactBase("New PDF"),
    type: "file",
    file: {
      id: "new-file.pdf",
      name: "new.pdf",
      bytes: 30,
      kind: "pdf",
      importable: false,
    },
  });
  const upload = {
    ...user("new-criteria", "Find payroll software companies."),
    attachments: [
      {
        id: "new-file.pdf",
        name: "new.pdf",
        type: "document",
        contentType: "application/pdf",
        status: { type: "complete" },
        content: [
          {
            type: "data",
            name: "screening-artifact",
            data: { artifactId: file.id },
          },
        ],
      },
    ],
  };
  await reply(
    id,
    [
      criteria,
      ...transcriptFor(id).filter((message) => message.role === "assistant"),
      upload,
    ],
    "new-criteria-reply",
  );
  assert.equal(
    getChatState(id).criteriaText,
    "Find payroll software companies.",
  );
  assert.equal(approved(getChatState(id)), false);
});
