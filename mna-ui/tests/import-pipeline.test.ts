import assert from "node:assert/strict";
import test from "node:test";
import { companies } from "../src/lib/fixtures";
import { getChatState, updateChatState } from "../src/lib/chat-store";
import { processStagedUploads } from "../src/lib/import-pipeline";
import { sessionStore } from "../src/lib/session-store";
import { reportSummary, applyEnrichmentReview, type EnrichmentReport } from "../src/lib/enrichment-client";
import { stageUploads } from "../src/lib/tool-client";

test("enrichment waits for companies and replays imported files when discovery broadens the scope", async () => {
  const id = sessionStore.createSession("Import scope regression");
  const prior = globalThis.fetch, calls: string[] = [];
  updateChatState(id, { backendRunId: "run-1", files: [{ id: "upload-1.xlsx", name: "Company research.xlsx", kind: "xlsx", bytes: 200, importable: true, purpose: "rogo", sourceKinds: ["rogo"], stagingStatus: "waiting" }] });
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls.push(request.tool);
    if (request.tool === "get_shortlist_context") return new Response(JSON.stringify({ ok: true, result: { total: getChatState(id).companies.length, considered_count: getChatState(id).companies.length, selection_revision: 0, source_hash: 'stable', has_more: false, candidates: getChatState(id).companies.map(company => ({ company_id: company.pk, considered: true })), review_columns: {}, coverage: { PB: 0, ROGO: getChatState(id).companies.length, BING: 0 } } }), { status: 200 });
    const result = request.tool === "import_enrichment_files" ? { reports: [{ report_id: "report-1", run_id: "run-1", purpose: "rogo", summary: { matched_count: getChatState(id).companies.length, unmatched_row_count: 0, ambiguous_count: 0 }, matched: [], unmatched_rows: { count: 0, sample: [] }, ambiguous: [] }] } : { total: getChatState(id).companies.length, rows: getChatState(id).companies.map(company => ({ pk: company.pk, PBId: null, sources: { MID: { "Company Name": company.name, Website: company.website, Description: company.description }, ISCC: {}, PB: {}, ROGO: { Notes: "Uploaded research" } }, provenance: {} })), next_cursor: null };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await processStagedUploads(id);
    assert.deepEqual(calls, []);
    assert.equal(getChatState(id).files[0].stagingStatus, "waiting");
    updateChatState(id, { companies: companies.slice(0, 1) });
    await Promise.all([processStagedUploads(id), processStagedUploads(id)]);
    assert.equal(calls.filter(tool => tool === "import_enrichment_files").length, 1);
    const firstScope = getChatState(id).files[0].hydratedScope;
    assert.equal(getChatState(id).files[0].stagingStatus, "imported");
    updateChatState(id, { companies: companies.slice(0, 2) });
    await processStagedUploads(id);
    assert.equal(calls.filter(tool => tool === "import_enrichment_files").length, 2);
    assert.notEqual(getChatState(id).files[0].hydratedScope, firstScope);
    await processStagedUploads(id);
    assert.equal(calls.filter(tool => tool === "import_enrichment_files").length, 2);
  } finally { globalThis.fetch = prior; }
});

test("unknown or mixed spreadsheet headers remain staged without a guessed import", async () => {
  const id = sessionStore.createSession("Unknown sheet regression"), prior = globalThis.fetch;
  updateChatState(id, { backendRunId: "run-1", companies: companies.slice(0, 1), files: [{ id: "unknown.xlsx", name: "Pitchbook.xlsx", bytes: 50, kind: "xlsx", importable: true, purpose: "pitchbook", stagingStatus: "checking" }] });
  const calls: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls.push(request.tool);
    return new Response(JSON.stringify({ ok: true, result: { files: [{ file: "unknown.xlsx", eligible: false, sheets: [{ kind: "ROGO" }, { kind: null }] }], import_files: [] } }), { status: 200 });
  };
  try {
    await processStagedUploads(id);
    assert.deepEqual(calls, ["inspect_enrichment_files"]);
    assert.equal(getChatState(id).files[0].stagingStatus, "error");
    assert.equal(getChatState(id).companies.length, 1);
  } finally { globalThis.fetch = prior; }
});

test('recognized spreadsheets attached to chat stay attached without hydrating company data', async () => {
  const id = sessionStore.createSession('Chat attachment routing'), prior = globalThis.fetch;
  updateChatState(id, { backendRunId: 'run-1', companies: companies.slice(0, 1), files: [{ id: 'chat.xlsx', name: 'company-data.xlsx', bytes: 50, kind: 'xlsx', purpose: 'chat', passToProvider: true, importable: true, stagingStatus: 'checking' }] });
  const calls: any[] = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls.push(request);
    assert.fail('Chat attachments must never call enrichment tools');
    return new Response(JSON.stringify({ ok: true, result: { files: [{ file: 'chat.xlsx', eligible: true, sheets: [{ kind: 'PB_DATA' }] }] } }));
  };
  try {
    await processStagedUploads(id); await processStagedUploads(id);
    assert.equal(calls.length, 0);
    assert.equal(getChatState(id).files[0].stagingStatus, 'checking');
    assert.equal(getChatState(id).files[0].passToProvider, true);

  } finally { globalThis.fetch = prior; }
});

test('an unrelated ROGO upload does not replay PitchBook exclusions after a manual restoration', async () => {
  const id = sessionStore.createSession('Mapping replay regression'), prior = globalThis.fetch;
  const company = { ...companies[0], considered: true };
  const bytes = new TextEncoder().encode(JSON.stringify(['run-1', [company.pk]]));
  const scope = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  updateChatState(id, { backendRunId: 'run-1', companies: [company], files: [
    { id: 'old-mapping.csv', name: 'mapping.csv', bytes: 50, kind: 'csv', purpose: 'pitchbook', sourceKinds: ['mapping'], stagingStatus: 'imported', hydratedScope: scope },
    { id: 'new-rogo.xlsx', name: 'rogo.xlsx', bytes: 50, kind: 'xlsx', purpose: 'rogo', sourceKinds: ['rogo'], stagingStatus: 'waiting' },
  ] });
  const imports: any[] = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.tool === 'import_enrichment_files') { imports.push(request.arguments); return new Response(JSON.stringify({ ok: true, result: { reports: [{ report_id: "report-2", run_id: "run-1", purpose: "rogo", summary: { matched_count: 1, unmatched_row_count: 0, ambiguous_count: 0 }, matched: [], unmatched_rows: { count: 0, sample: [] }, ambiguous: [] }] } })); }
    if (request.tool === 'get_shortlist_context') return new Response(JSON.stringify({ ok: true, result: { total: 1, considered_count: 1, selection_revision: 2, source_hash: 'stable', has_more: false, candidates: [{ company_id: company.pk, considered: true }], review_columns: {}, coverage: { ROGO: 1 } } }));
    return new Response(JSON.stringify({ ok: true, result: { total: 1, rows: [{ pk: company.pk, PBId: null, sources: { MID: {}, ISCC: {}, PB: {}, ROGO: { Notes: 'Research' } }, provenance: {} }], next_cursor: null } }));
  };
  try {
    await processStagedUploads(id);
    assert.equal(imports.length, 1);
    assert.deepEqual(imports[0].files, ['new-rogo.xlsx']);
    assert.equal("exclude_unmapped" in imports[0], false);
    assert.equal(imports[0].purpose_hint, "rogo");
    assert.deepEqual(imports[0].display_names, { "new-rogo.xlsx": "rogo.xlsx" });
    assert.match(getChatState(id).files[1].stagingMessage!, /1 company matched; 0 rows unmatched; 0 rows ambiguous; 0 hidden by this action/);
    assert.equal(getChatState(id).companies[0].considered, true);
  } finally { globalThis.fetch = prior; }
});

test("wrong-zone sheets are rejected using the original name and purpose hint", async () => {
  const id = sessionStore.createSession("Wrong zone"), prior = globalThis.fetch;
  updateChatState(id, { backendRunId: "run-1", companies: companies.slice(0, 1), files: [{ id: "uuid.xlsx", name: "Original Research.xlsx", kind: "xlsx", bytes: 50, importable: true, purpose: "pitchbook", stagingStatus: "checking" }] });
  const calls: any[] = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls.push(request);
    return new Response(JSON.stringify({ ok: true, result: { files: [{ file: "uuid.xlsx", eligible: false, sheets: [{ kind: "ROGO" }], reason: "Wrong destination" }] } }));
  };
  try {
    await processStagedUploads(id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, "inspect_enrichment_files");
    assert.equal(calls[0].arguments.purpose_hint, "pitchbook");
    assert.deepEqual(calls[0].arguments.display_names, { "uuid.xlsx": "Original Research.xlsx" });
    assert.equal(getChatState(id).files[0].stagingStatus, "error");
    assert.match(getChatState(id).files[0].stagingMessage!, /Original Research.xlsx: This looks like a ROGO file — drop it in ROGO data/);
    assert.notEqual(getChatState(id).companies[0].considered, false);
  } finally { globalThis.fetch = prior; }
});

test("PitchBook summary uses match report counts without treating saved hidden totals as new actions", () => {
  const report: EnrichmentReport = { report_id: "ER-counts", run_id: "run-1", matched: [], summary: { matched_count: 2, not_matched_count: 3, hidden_count: 99 }, purpose: "pitchbook" };
  assert.equal(reportSummary(report), "2 companies matched; 3 companies not matched; 0 hidden by this action.");
  assert.equal(reportSummary(report, 1), "2 companies matched; 3 companies not matched; 1 hidden by this action.");
});

test("review applies through the approved backend action, refreshes context and posts the real action count", async () => {
  const id = sessionStore.createSession("PitchBook decisions"), prior = globalThis.fetch;
  const company = companies[0];
  const report: EnrichmentReport = { report_id: "ER-test", run_id: "run-1", purpose: "pitchbook", summary: { matched_count: 0, not_matched_count: 1 }, matched: [], not_matched: [{ company_id: company.pk, name: company.name, website: company.website, considered: true, reason: "not_in_mapping" }] };
  updateChatState(id, { backendRunId: "run-1", companies: [company], selectionRevision: 4 });
  const calls: any[] = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls.push(request);
    const result = request.tool === "apply_enrichment_review" ? { hidden: 1, restored: 0, hidden_count: 25 }
      : request.tool === "get_shortlist_context" ? { total: 1, considered_count: 0, selection_revision: 5, source_hash: "stable", has_more: false, candidates: [{ company_id: company.pk, considered: false }], review_columns: {}, coverage: {} }
      : { total: 1, rows: [{ pk: company.pk, PBId: null, sources: { MID: { "Company Name": company.name }, ISCC: {}, PB: {}, ROGO: {} }, provenance: {} }], next_cursor: null };
    return new Response(JSON.stringify({ ok: true, result }));
  };
  try {
    await applyEnrichmentReview(id, report, [company.pk], [], 4);
    assert.equal(calls[0].analystApproved, true);
    assert.deepEqual(calls[0].arguments, { run_id: "run-1", report_id: "ER-test", hide_company_ids: [company.pk], keep_company_ids: [], expected_selection_revision: 4 });
    assert.deepEqual(calls.map(call => call.tool), ["apply_enrichment_review", "get_shortlist_context", "get_candidate_source_data"]);
    assert.equal(getChatState(id).companies[0].considered, false);
    const note = sessionStore.getSnapshot().sessions.find(session => session.id === id)!.events.find(event => event.role === "assistant")!;
    assert.equal(note.text, "Hid 1 company without PitchBook data. They can be restored any time.");
    assert.ok(getChatState(id).branchMessageIds.includes(note.messageId!));
  } finally { globalThis.fetch = prior; }
});

test("identical staged IDs do not duplicate files or reset an already imported upload", async () => {
  const id = sessionStore.createSession("Deduplicated upload"), priorFetch = globalThis.fetch, priorReader = globalThis.FileReader;
  updateChatState(id, { files: [{ id: "same.xlsx", name: "Research.xlsx", kind: "xlsx", bytes: 4, purpose: "rogo", importable: true, stagingStatus: "imported", stagingMessage: "1 company matched", hydratedScope: "saved-scope" }] });
  class Reader {
    result = ""; onload: (() => void) | null = null; onerror: (() => void) | null = null;
    readAsDataURL(file: File) { void file.arrayBuffer().then(buffer => { this.result = `data:application/octet-stream;base64,${Buffer.from(buffer).toString("base64")}`; this.onload?.(); }); }
  }
  globalThis.FileReader = Reader as unknown as typeof FileReader;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/files");
    assert.equal(JSON.parse(String(init?.body)).purpose, "rogo");
    return new Response(JSON.stringify({ files: [{ id: "same.xlsx", name: "Research.xlsx", kind: "xlsx", bytes: 4, importable: true, deduplicated: true }] }));
  };
  try {
    await stageUploads([new File(["same"], "Research.xlsx")], { sessionId: id, purpose: "rogo" });
    await processStagedUploads(id);
    assert.equal(getChatState(id).files.length, 1);
    assert.equal(getChatState(id).files[0].stagingStatus, "imported");
    assert.equal(getChatState(id).files[0].hydratedScope, "saved-scope");
  } finally { globalThis.fetch = priorFetch; globalThis.FileReader = priorReader; }
});
