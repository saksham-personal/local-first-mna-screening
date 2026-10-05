import { artifactBase, getChatState, patchArtifact, saveArtifact, updateChatState } from "./chat-store";
import { callTool, type ToolResult } from "./tool-client";
import { refreshCompanyContext } from "./company-data-client";
import { sessionStore } from "./session-store";
import type { StagedFile } from "./chat-contract";

type Inspection = { file: string; eligible: boolean; sheets: { kind: string }[] };
const queues = new Map<string, Promise<void>>();
function patchFile(sessionId: string, id: string, patch: Partial<StagedFile>) {
  updateChatState(sessionId, state => ({ ...state, files: state.files.map(file => file.id === id ? { ...file, ...patch } : file) }));
  const artifact = getChatState(sessionId).artifacts.find(a => a.type === "file" && a.file.id === id);
  if (artifact?.type === "file") patchArtifact(sessionId, artifact.id, { file: { ...artifact.file, ...patch }, importStatus: patch.stagingMessage });
}
async function traced(sessionId: string, name: string, args: ToolResult) {
  const receipt = sessionStore.startTool(name, args, { sessionId, origin: "workspace", title: name === "inspect_enrichment_files" ? "Identify uploaded spreadsheets" : "Add company data" });
  try { const result = await callTool(name, args); sessionStore.finishTool(receipt, result); return result; }
  catch (error) { sessionStore.finishTool(receipt, null, "error", String(error)); throw error; }
}
async function process(sessionId: string) {
  const unchecked = getChatState(sessionId).files.filter(f => f.importable && (!f.stagingStatus || f.stagingStatus === "checking"));
  for (let offset = 0; offset < unchecked.length; offset += 32) {
    const batch = unchecked.slice(offset, offset + 32);
    try {
      const inspection = await traced(sessionId, "inspect_enrichment_files", { files: batch.map(f => f.id) });
      for (const item of inspection.files as Inspection[]) patchFile(sessionId, item.file, {
        sourceKinds: [...new Set(item.sheets.map(s => s.kind === "PB_MAPPING" ? "mapping" : s.kind === "PB_DATA" ? "pitchbook" : s.kind === "ROGO" ? "rogo" : s.kind))], stagingStatus: item.eligible ? "waiting" : "unrecognized",
        stagingMessage: item.eligible ? "Ready to add to companies" : "Headers do not identify PitchBook or ROGO data. Saved for review.",
      });
    } catch (error) {
      batch.forEach(file => patchFile(sessionId, file.id, { stagingStatus: "error", stagingMessage: String(error) }));
      return;
    }
  }
  const state = getChatState(sessionId);
  if (!state.backendRunId || !state.companies.length) return;
  const discovery = state.jobId ? (await import("./chat-jobs")).getJob(state.jobId) : undefined;
  if (discovery?.state === "running") return;
  const bytes = new TextEncoder().encode(JSON.stringify([state.backendRunId, state.companies.map(company => company.pk).sort()]));
  const scope = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const pending = state.files.filter(file => file.stagingStatus === "waiting" || (file.stagingStatus === "imported" && file.hydratedScope !== scope));
  if (!pending.length) return;
  // Re-read previously imported sheets with new mappings: a data workbook may arrive before its mapping CSV.
  const files = state.files.filter(file => file.stagingStatus === "waiting" || file.stagingStatus === "imported");
  pending.forEach(file => patchFile(sessionId, file.id, { stagingStatus: "importing", stagingMessage: "Adding company data…" }));
  try {
    const totals: ToolResult = {};
    // Mapping sheets go first if separate requests are needed.
    files.sort((a, b) => Number(b.sourceKinds?.includes("mapping")) - Number(a.sourceKinds?.includes("mapping")));
    for (let offset = 0; offset < files.length; offset += 32) {
      const result = await traced(sessionId, "import_enrichment_files", { run_id: state.backendRunId, files: files.slice(offset, offset + 32).map(f => f.id) });
      for (const [key, value] of Object.entries(result)) if (typeof value === "number") totals[key] = Number(totals[key] ?? 0) + value;
    }
    await refreshCompanyContext(sessionId, state.backendRunId);
    const summary = `${totals.mapping_unique_companies ?? 0} PitchBook IDs, ${totals.pb_unique_companies ?? 0} PitchBook company records and ${totals.rogo_unique_companies ?? 0} ROGO records matched. ${Number(totals.pb_unmatched ?? 0) + Number(totals.rogo_unmatched ?? 0)} rows unmatched; ${totals.quarantined ?? 0} rows need review.`;
    pending.forEach(file => patchFile(sessionId, file.id, { stagingStatus: "imported", stagingMessage: "Data added", hydratedScope: scope }));
    const sources = new Set(files.flatMap(f => f.sourceKinds ?? []));
    saveArtifact(sessionId, { ...artifactBase(sources.has("rogo") && (sources.has("pitchbook") || sources.has("mapping")) ? "PitchBook and ROGO data added" : sources.has("rogo") ? "ROGO data added" : "PitchBook data added"), type: "handoff", service: "Company data", state: "complete", detail: `${summary} Use /data to view the current table. Saved screening setups need a fresh preview and approval.` });
    sessionStore.addEvent({ sessionId, kind: "artifact", origin: "workspace", status: "success", title: "Company context updated", text: summary, result: { ...totals, files: pending.map(f => f.id), runId: state.backendRunId } });
  } catch (error) {
    pending.forEach(file => patchFile(sessionId, file.id, { stagingStatus: "error", stagingMessage: String(error) }));
  }
}
export function processStagedUploads(sessionId: string): Promise<void> {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => process(sessionId));
  queues.set(sessionId, next);
  void next.finally(() => { if (queues.get(sessionId) === next) queues.delete(sessionId); });
  return next;
}

export function retryStagedUploads(sessionId: string): Promise<void> {
  updateChatState(sessionId, state => ({ ...state, files: state.files.map(file => file.stagingStatus === "error" ? { ...file, stagingStatus: "checking", stagingMessage: "Checking again…" } : file) }));
  return processStagedUploads(sessionId);
}
