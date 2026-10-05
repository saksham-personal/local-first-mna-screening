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
