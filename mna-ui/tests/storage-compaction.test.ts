import assert from "node:assert/strict";
import { test } from "node:test";
import { compactPayload, createSessionStore, serializeSessionSnapshot, sessionStore } from "../src/lib/session-store";
import { compactChatState, emptyChatState, getChatState, mirrorWorkspace, restoreChatCompanies, updateChatState } from "../src/lib/chat-store";
import { companyFromEntry, companyFromGridRow } from "../src/lib/company-mapper";
// @ts-expect-error The production bridge mapper is plain Node ESM, without declarations.
import { companyEntryFromGridRow } from "../server/jobs.mjs";
import { getEnrichmentReport } from "../src/lib/enrichment-client";
import type { SessionEvent } from "../src/lib/session-contract";

class MemoryStorage {
  values = new Map<string, string>();
  attempts = 0;
  constructor(public limit = Infinity) {}
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    this.attempts++;
    if (value.length * 2 > this.limit) throw new DOMException("quota exceeded", "QuotaExceededError");
    this.values.set(key, value);
  }
  removeItem(key: string) { this.values.delete(key); }
}
const receipt = (sequence: number, result?: unknown): SessionEvent => ({
  id: `event-${sequence}`, sessionId: "run-insurance", sequence, kind: "tool", origin: "workspace", status: "success",
  title: "Read companies", startedAt: new Date(1700000000000 + sequence).toISOString(), result,
});
const gridRow = (index: number) => ({
  company_id: `company-${String(index).padStart(5, "0")}`, considered: index % 7 !== 0, mid_score: 0.75,
  name: `Insurance ${index}`, hq_city: "London", hq_state: "",
  pb: {}, company_payload: { name: `Insurance ${index}`, website: `https://insurance${index}.example`, description: "Insurance claims policy software ".repeat(30),
    identifiers: [{ kind: "ECID", value: String(index) }], keywords: ["insurance"], has_enrichment: false,
    mid_source_row: { "Company Name": `Insurance ${index}`, Website: `https://insurance${index}.example`, Description: "Insurance claims policy software ".repeat(30), ECID: String(index), "Annual Revenue": index * 1000 },
  },
});

test("large results and embedded tool parts compact only on disk; approval and report references survive", async () => {
  const storage = new MemoryStorage(), store = createSessionStore(storage);
  const rows = Array.from({ length: 5000 }, (_, index) => gridRow(index));
  const result = { rows };
  const small = { revision: 4, mandate: "insurance", definition: "claims", sourceArtifactId: "criteria" };
  store.addEvent({ kind: "approval", status: "success", origin: "workspace", title: "Discovery criteria approved", result: small });
  store.addEvent({ kind: "artifact", status: "success", origin: "workspace", title: "Company context updated", result: { report: { report_id: "report-1", run_id: "run-1", purpose: "pitchbook", summary: { matched_count: 5000 }, matched: rows } } });
  const id = store.addEvent({ kind: "message", role: "assistant", origin: "assistant", status: "success", title: "Companies ready", result, content: [{ type: "text", text: "Found 5,000 companies" }, { type: "tool-call", toolCallId: "call", toolName: "get_screening_grid", args: {}, argsText: "{}", result }, { type: "data", name: "screening-artifact", data: { artifactId: "list" } }, { type: "text", text: JSON.stringify(result) }, { type: "tool-call", toolCallId: "large-args", toolName: "read", args: result, argsText: JSON.stringify(result), result }] });
  assert.deepEqual(store.getSnapshot().sessions[0].events.at(-1)?.result, result);
  const restored = createSessionStore(storage).getSnapshot().sessions[0];
  assert.deepEqual(restored.events.find(event => event.kind === "approval")?.result, small);
  const omitted = restored.events.find(event => event.id === id)?.result as Record<string, unknown>;
  assert.equal(omitted._omitted, true); assert.ok(Number(omitted.bytes) > 16000); assert.ok(String(omitted.summary).length <= 500);
  const parts = restored.events.at(-1)?.content as Record<string, unknown>[];
  assert.equal((parts[1].result as Record<string, unknown>)._omitted, true);
  assert.deepEqual(parts[2].data, { artifactId: "list" });
  assert.equal(typeof parts[3].text, "string"); assert.match(String(parts[3].text), /Result not saved/);
  assert.equal(typeof parts[4].argsText, "string"); assert.equal(JSON.parse(String(parts[4].argsText))._omitted, true);
  const report = (restored.events.find(event => event.title === "Company context updated")?.result as { report: Record<string, unknown> }).report;
  assert.equal(report.report_id, "report-1"); assert.deepEqual(report.summary, { matched_count: 5000 });
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { const args = JSON.parse(String(init?.body)).arguments; assert.equal(args.report_id, report.report_id); return Response.json({ ok: true, result: { ...report, matched: rows } }); };
  try { assert.equal((await getEnrichmentReport(String(report.run_id), String(report.report_id))).matched.length, 5000); }
  finally { globalThis.fetch = previous; }
});

test("persisted events cap at 400 plus a marker, and the total snapshot fits 1.5 MB", () => {
  const base = createSessionStore(new MemoryStorage()).getSnapshot();
  const events = Array.from({ length: 700 }, (_, index) => receipt(index + 1, { rows: "x".repeat(18000) }));
  const snapshot = { ...base, sessions: [{ ...base.sessions[0], events }] };
  const saved = JSON.parse(serializeSessionSnapshot(snapshot));
  assert.equal(saved.sessions[0].events.length, 401);
  assert.equal(saved.sessions[0].events.at(-1).title, "300 older events not saved");
  assert.equal(saved.sessions[0].events[0].sequence, 301);
  const large = { ...snapshot, sessions: [{ ...snapshot.sessions[0], events: events.map(event => ({ ...event, result: { text: "x".repeat(7900) } })) }] };
  const raw = serializeSessionSnapshot(large);
  assert.ok(raw.length * 2 <= 1.5 * 1024 * 1024);
  const storage = new MemoryStorage(); storage.setItem("mna-research-session-log-v1", raw);
  assert.equal(createSessionStore(storage).getSnapshot().storageError, undefined);
  assert.deepEqual(compactPayload({ revision: 1 }), { revision: 1 });
  const approval = { ...receipt(1), kind: "approval" as const, title: "Discovery criteria approved", result: { revision: 3 } };
  const protectedSnapshot = { ...snapshot, sessions: [{ ...snapshot.sessions[0], events: [approval, ...events.slice(1)] }] };
  const protectedStorage = new MemoryStorage();
  protectedStorage.setItem("mna-research-session-log-v1", serializeSessionSnapshot(protectedSnapshot));
  const reloaded = createSessionStore(protectedStorage);
  assert.deepEqual(reloaded.getSnapshot().sessions[0].events.find(event => event.kind === "approval")?.result, { revision: 3 });
  reloaded.renameSession("run-insurance", "Renamed");
  const markers = JSON.parse(protectedStorage.getItem("mna-research-session-log-v1")!).sessions[0].events.filter((event: SessionEvent) => event.id === "omitted-run-insurance");
  assert.equal(markers.length, 1); assert.equal(markers[0].title, "300 older events not saved");
});

test("5,000-company state uses under 300 KB and all keys under 2 MB; reload pages Rust with identical MID objects", async (t) => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), previousFetch = globalThis.fetch;
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  const id = sessionStore.createSession("Large run");
  sessionStore.addEvent({ sessionId: id, kind: "approval", status: "success", origin: "workspace", title: "Discovery criteria approved", result: { revision: 1, mandate: "Insurance", definition: "Claims software", sourceArtifactId: "criteria" } });
  const rows = Array.from({ length: 5000 }, (_, index) => gridRow(index));
  const companies = rows.map(row => companyFromEntry(companyEntryFromGridRow(row)));
  assert.deepEqual(rows.map(companyFromGridRow), companies);
  const state = { ...emptyChatState(id), criteriaText: "Insurance", definition: "Claims software", revision: 1, approvedRevision: 1, backendRunId: "rust-run", companies, counts: { midOnly: companies.filter(c => c.considered).length, isccOnly: 0, both: 0 }, artifacts: [{ id: "criteria", title: "Criteria", createdAt: new Date().toISOString(), type: "criteria" as const, revision: 1, decision: "approved" as const, criteriaText: "Insurance", definition: "Claims software", ignored: [] }, { id: "list", title: "Found companies", createdAt: new Date().toISOString(), type: "companies" as const, companies, counts: { midOnly: 4285, isccOnly: 0, both: 0 }, backendRunId: "rust-run" }, { id: "table", title: "Data", createdAt: new Date().toISOString(), type: "data-table" as const, rows, columns: ["name"] }] };
  const compact = compactChatState(state);
  assert.equal(compact.companies.length, 0); assert.equal(compact.companiesTrimmed, true);
  storage.setItem(`screening-chat-v1:${id}`, JSON.stringify(compact));
  mirrorWorkspace(state);
  storage.setItem("mna-research-session-log-v1", serializeSessionSnapshot(sessionStore.getSnapshot()));
  const ledger = createSessionStore(storage); ledger.selectSession(id);
  ledger.addEvent({ kind: "tool", origin: "workspace", status: "success", title: "Grid", result: { rows } });
  assert.ok(storage.getItem(`screening-chat-v1:${id}`)!.length * 2 < 300 * 1024);
  assert.equal(JSON.parse(storage.getItem(`screening-executed-v1:${id}`)!).companies, undefined);
  assert.ok([...storage.values.values()].reduce((sum, value) => sum + value.length * 2, 0) < 2 * 1024 * 1024);
  let pages = 0;
  globalThis.fetch = async (_url, init) => {
    const { tool, arguments: args } = JSON.parse(String(init?.body));
    let result;
    if (tool === "get_screening_grid") {
      pages++; assert.equal(args.include_company_payload, true); assert.equal(args.include_hidden, true);
      const start = args.after_company_id ? rows.findIndex(row => row.company_id === args.after_company_id) + 1 : 0;
      const pageRows = rows.slice(start, start + args.limit);
      result = { rows: pageRows, total: rows.length, considered_count: state.counts.midOnly, source_hash: "hash", selection_revision: 0, next_cursor: start + args.limit < rows.length ? pageRows.at(-1)!.company_id : null };
    } else if (tool === "get_shortlist_context") {
      const start = args.after_company_id ? rows.findIndex(row => row.company_id === args.after_company_id) + 1 : 0;
      const candidates = rows.slice(start, start + args.limit).map(row => ({ company_id: row.company_id, considered: row.considered }));
      result = { candidates, total: rows.length, considered_count: state.counts.midOnly, source_hash: "hash", selection_revision: 0, review_columns: {}, coverage: { PB: 0, ROGO: 0, BING: 0 }, has_more: start + args.limit < rows.length, next_after_company_id: candidates.at(-1)?.company_id };
    } else if (tool === "get_candidate_source_data") result = { rows: [], total: 0 };
    else throw new Error(`Unexpected tool ${tool}`);
    return Response.json({ ok: true, result });
  };
  try {
    assert.equal(getChatState(id).companiesLoading, true);
    await restoreChatCompanies(id);
    assert.equal(pages, 3); assert.equal(getChatState(id).companiesLoadError, undefined);
    assert.deepEqual(getChatState(id).companies, companies);
    assert.equal(getChatState(id).companiesLoading, false);
    assert.equal(getChatState(id).approvedRevision, 1);
    assert.equal(getChatState(id).criteriaText, "Insurance");
    assert.equal(getChatState(id).artifacts.length, 3);
    const restoredList = getChatState(id).artifacts.find(artifact => artifact.type === "companies");
    assert.ok(restoredList?.type === "companies");
    assert.deepEqual(restoredList.companies, companies);
    assert.ok([...storage.values.values()].reduce((sum, value) => sum + value.length * 2, 0) < 2 * 1024 * 1024);
    t.diagnostic(`Stored chat: ${storage.getItem(`screening-chat-v1:${id}`)!.length * 2} bytes; all keys: ${[...storage.values.values()].reduce((sum, value) => sum + value.length * 2, 0)} bytes (UTF-16 estimate).`);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("quota failures retry compact storage and never throw or append failure events", () => {
  const storage = new MemoryStorage(4000), store = createSessionStore(storage);
  assert.doesNotThrow(() => store.addEvent({ kind: "tool", origin: "workspace", status: "success", title: "Grid", result: { rows: "x".repeat(100000) } }));
  assert.equal(store.getSnapshot().sessions[0].events.length, 2);
  const retryStorage = new MemoryStorage(10000), retryStore = createSessionStore(retryStorage);
  retryStore.addEvent({ kind: "tool", origin: "workspace", status: "success", title: "Kept small result", result: { text: "x".repeat(7000) } });
  assert.ok(retryStorage.attempts > 2);
  assert.equal(retryStore.getSnapshot().storageError, undefined);
  assert.equal(retryStore.getSnapshot().sessions[0].events.length, 2);
  const prior = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage(1) });
  const id = sessionStore.createSession("Quota"), before = sessionStore.getSnapshot().sessions.find(s => s.id === id)!.events.length;
  try {
    for (let index = 0; index < 10; index++) assert.doesNotThrow(() => { updateChatState(id, { definition: "x".repeat(5000) }); mirrorWorkspace(getChatState(id)); });
    assert.equal(sessionStore.getSnapshot().sessions.find(s => s.id === id)!.events.length, before);
    assert.match(getChatState(id).storageNotice!, /storage is full/);
  } finally { if (prior) Object.defineProperty(globalThis, "localStorage", prior); else Reflect.deleteProperty(globalThis, "localStorage"); }
});


test("company reload failures can retry, and criteria edits discard an in-flight reload", async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), previousFetch = globalThis.fetch;
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  const row = gridRow(1);
  const seed = () => {
    const id = sessionStore.createSession("Reload recovery");
    storage.setItem(`screening-chat-v1:${id}`, JSON.stringify({ ...emptyChatState(id), revision: 1, backendRunId: "recovery-run", companiesTrimmed: true }));
    return id;
  };
  try {
    let fail = true;
    globalThis.fetch = async (_url, init) => {
      const { tool } = JSON.parse(String(init?.body));
      if (fail) return Response.json({ error: "Service unavailable" }, { status: 503 });
      const result = tool === "get_screening_grid" ? { rows: [row], total: 1 }
        : tool === "get_shortlist_context" ? { candidates: [{ company_id: row.company_id, considered: true }], total: 1, considered_count: 1, selection_revision: 0, source_hash: "hash", review_columns: {}, coverage: { PB: 0, ROGO: 0, BING: 0 } }
        : { rows: [], total: 0 };
      return Response.json({ ok: true, result });
    };
    const retryId = seed();
    getChatState(retryId);
    await restoreChatCompanies(retryId);
    assert.match(getChatState(retryId).companiesLoadError!, /Service unavailable/);
    fail = false;
    await restoreChatCompanies(retryId);
    assert.equal(getChatState(retryId).companiesLoading, false);
    assert.equal(getChatState(retryId).companiesLoadError, undefined);
    assert.deepEqual(getChatState(retryId).companies, [companyFromGridRow(row)]);

    let release!: (response: Response) => void;
    let started!: () => void;
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    globalThis.fetch = () => new Promise<Response>(resolve => { release = resolve; started(); });
    const editedId = seed();
    getChatState(editedId);
    const pending = restoreChatCompanies(editedId);
    await requestStarted;
    updateChatState(editedId, { revision: 2, companies: [], counts: { midOnly: 0, isccOnly: 0, both: 0 } });
    release(Response.json({ ok: true, result: { rows: [row], total: 1 } }));
    await pending;
    assert.deepEqual(getChatState(editedId).companies, []);
    assert.equal(getChatState(editedId).companiesLoading, false);
    assert.equal(getChatState(editedId).companiesTrimmed, false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
