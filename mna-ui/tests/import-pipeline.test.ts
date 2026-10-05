import assert from "node:assert/strict";
import test from "node:test";
import { companies } from "../src/lib/fixtures";
import { getChatState, updateChatState } from "../src/lib/chat-store";
import { processStagedUploads } from "../src/lib/import-pipeline";
import { sessionStore } from "../src/lib/session-store";

test("enrichment waits for companies and replays imported files when discovery broadens the scope", async () => {
  const id = sessionStore.createSession("Import scope regression");
  const prior = globalThis.fetch, calls: string[] = [];
  updateChatState(id, { backendRunId: "run-1", files: [{ id: "upload-1.xlsx", name: "Company research.xlsx", kind: "xlsx", bytes: 200, importable: true, sourceKinds: ["rogo"], stagingStatus: "waiting" }] });
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls.push(request.tool);
    if (request.tool === "get_shortlist_context") return new Response(JSON.stringify({ ok: true, result: { total: getChatState(id).companies.length, considered_count: getChatState(id).companies.length, selection_revision: 0, source_hash: 'stable', has_more: false, candidates: getChatState(id).companies.map(company => ({ company_id: company.pk, considered: true })), review_columns: {}, coverage: { PB: 0, ROGO: getChatState(id).companies.length, BING: 0 } } }), { status: 200 });
    const result = request.tool === "import_enrichment_files" ? { rogo_unique_companies: getChatState(id).companies.length, rogo_unmatched: 0 } : { total: getChatState(id).companies.length, rows: getChatState(id).companies.map(company => ({ pk: company.pk, PBId: null, sources: { MID: { "Company Name": company.name, Website: company.website, Description: company.description }, ISCC: {}, PB: {}, ROGO: { Notes: "Uploaded research" } }, provenance: {} })), next_cursor: null };
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
  updateChatState(id, { backendRunId: "run-1", companies: companies.slice(0, 1), files: [{ id: "unknown.xlsx", name: "Pitchbook.xlsx", bytes: 50, kind: "xlsx", importable: true, stagingStatus: "checking" }] });
  const calls: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls.push(request.tool);
    return new Response(JSON.stringify({ ok: true, result: { files: [{ file: "unknown.xlsx", eligible: false, sheets: [{ kind: "ROGO" }, { kind: null }] }], import_files: [] } }), { status: 200 });
  };
  try {
    await processStagedUploads(id);
    assert.deepEqual(calls, ["inspect_enrichment_files"]);
    assert.equal(getChatState(id).files[0].stagingStatus, "unrecognized");
    assert.equal(getChatState(id).companies.length, 1);
  } finally { globalThis.fetch = prior; }
});

test('recognized spreadsheets attached to chat stay attached without hydrating company data', async () => {
  const id = sessionStore.createSession('Chat attachment routing'), prior = globalThis.fetch;
  updateChatState(id, { backendRunId: 'run-1', companies: companies.slice(0, 1), files: [{ id: 'chat.xlsx', name: 'company-data.xlsx', bytes: 50, kind: 'xlsx', purpose: 'chat', passToProvider: true, importable: true, stagingStatus: 'checking' }] });
  const calls: any[] = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls.push(request);
    assert.equal(request.tool, 'inspect_enrichment_files');
    return new Response(JSON.stringify({ ok: true, result: { files: [{ file: 'chat.xlsx', eligible: true, sheets: [{ kind: 'PB_DATA' }] }] } }));
  };
  try {
    await processStagedUploads(id); await processStagedUploads(id);
    assert.equal(calls.length, 1);
    assert.equal(getChatState(id).files[0].stagingStatus, 'waiting');
    assert.equal(getChatState(id).files[0].passToProvider, true);
    assert.match(getChatState(id).files[0].stagingMessage!, /attached to chat/);
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
    if (request.tool === 'import_enrichment_files') { imports.push(request.arguments); return new Response(JSON.stringify({ ok: true, result: { rogo_unique_companies: 1 } })); }
    if (request.tool === 'get_shortlist_context') return new Response(JSON.stringify({ ok: true, result: { total: 1, considered_count: 1, selection_revision: 2, source_hash: 'stable', has_more: false, candidates: [{ company_id: company.pk, considered: true }], review_columns: {}, coverage: { ROGO: 1 } } }));
    return new Response(JSON.stringify({ ok: true, result: { total: 1, rows: [{ pk: company.pk, PBId: null, sources: { MID: {}, ISCC: {}, PB: {}, ROGO: { Notes: 'Research' } }, provenance: {} }], next_cursor: null } }));
  };
  try {
    await processStagedUploads(id);
    assert.equal(imports.length, 1);
    assert.deepEqual(imports[0].files, ['new-rogo.xlsx']);
    assert.equal(imports[0].exclude_unmapped, false);
    assert.equal(getChatState(id).companies[0].considered, true);
  } finally { globalThis.fetch = prior; }
});
