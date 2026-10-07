import { artifactBase, getChatState, patchArtifact, saveArtifact, updateChatState } from "./chat-store";
import { callTool, type ToolResult } from "./tool-client";
import { refreshCompanyContext } from "./company-data-client";
import { sessionStore } from "./session-store";
import { mergeEnrichmentReports, notifyPitchBookReview, rememberEnrichmentReport, reportSummary, type EnrichmentReport } from "./enrichment-client";
import type { StagedFile } from "./chat-contract";

type Inspection = { file: string; eligible: boolean; reason?: string; error?: string; sheets: { kind: string; error?: string }[] };
const isEnrichment = (file: StagedFile) => file.purpose === "pitchbook" || file.purpose === "rogo";
const fileArgs = (files: StagedFile[], purpose: "pitchbook" | "rogo") => ({ files: files.map(file => file.id), purpose_hint: purpose, display_names: Object.fromEntries(files.map(file => [file.id, file.name])) });
const queues = new Map<string, Promise<void>>();
function patchFile(sessionId: string, id: string, patch: Partial<StagedFile>) {
  updateChatState(sessionId, state => ({ ...state, files: state.files.map(file => file.id === id ? { ...file, ...patch } : file) }));
  const artifact = getChatState(sessionId).artifacts.find(a => a.type === "file" && a.file.id === id);
  if (artifact?.type === "file") patchArtifact(sessionId, artifact.id, { file: { ...artifact.file, ...patch }, importStatus: patch.stagingMessage });
  const upload = getChatState(sessionId).artifacts.find(a => a.type === "enrichment-upload" && a.id === getChatState(sessionId).files.find(file => file.id === id)?.uploadArtifactId);
  if (upload?.type === "enrichment-upload") patchArtifact(sessionId, upload.id, { files: getChatState(sessionId).files.filter(file => file.uploadArtifactId === upload.id) });
}
async function traced(sessionId: string, name: string, args: ToolResult) {
  const receipt = sessionStore.startTool(name, args, { sessionId, origin: "workspace", title: name === "inspect_enrichment_files" ? "Identify uploaded spreadsheets" : "Add company data" });
  try { const result = await callTool(name, args); sessionStore.finishTool(receipt, result); return result; }
  catch (error) { sessionStore.finishTool(receipt, null, "error", String(error)); throw error; }
}
async function process(sessionId: string) {
  for (const purpose of ["pitchbook", "rogo"] as const) {
    const unchecked = getChatState(sessionId).files.filter(f => f.purpose === purpose && f.importable && (!f.stagingStatus || f.stagingStatus === "checking"));
    for (let offset = 0; offset < unchecked.length; offset += 32) {
      const batch = unchecked.slice(offset, offset + 32);
      try {
        const inspection = await traced(sessionId, "inspect_enrichment_files", fileArgs(batch, purpose));
        for (const file of batch) {
          const item = (inspection.files as Inspection[]).find(item => item.file === file.id);
          const kinds = item?.sheets.map(sheet => sheet.kind) ?? [];
          const mismatch = purpose === "pitchbook" ? kinds.includes("ROGO") : kinds.some(kind => kind === "PB_MAPPING" || kind === "PB_DATA");
          const message = mismatch ? `This looks like a ${purpose === "pitchbook" ? "ROGO" : "PitchBook"} file \u2014 drop it in ${purpose === "pitchbook" ? "ROGO" : "PitchBook"} data` : item?.error ?? item?.reason ?? item?.sheets.find(sheet => sheet.error)?.error ?? "File format not recognized";
          const eligible = item?.eligible && !mismatch;
          patchFile(sessionId, file.id, {
            sourceKinds: [...new Set(kinds.map(kind => kind === "PB_MAPPING" ? "mapping" : kind === "PB_DATA" ? "pitchbook" : kind === "ROGO" ? "rogo" : kind).filter(Boolean))],
            stagingStatus: eligible ? "waiting" : "error",
            stagingMessage: eligible ? "Ready to import" : `${file.name}: ${message}`,
          });
        }
      } catch (error) {
        batch.forEach(file => patchFile(sessionId, file.id, { stagingStatus: "error", stagingMessage: `${file.name}: ${String(error)}` }));
      }
    }
  }
  const state = getChatState(sessionId);
  if (!state.backendRunId || !state.companies.length) return;
  const discovery = state.jobId ? (await import("./chat-jobs")).getJob(state.jobId) : undefined;
  if (discovery?.state === "running") return;
  const bytes = new TextEncoder().encode(JSON.stringify([state.backendRunId, state.companies.map(company => company.pk).sort()]));
  const scope = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  for (const purpose of ["pitchbook", "rogo"] as const) {
    const pending = getChatState(sessionId).files.filter(file => file.purpose === purpose && (file.stagingStatus === "waiting" || (file.stagingStatus === "imported" && file.hydratedScope !== scope)));
    if (!pending.length) continue;
    const pendingIds = new Set(pending.map(file => file.id));
    // A newly supplied mapping may match a previously imported data workbook.
    const files = getChatState(sessionId).files.filter(file => file.purpose === purpose && (file.stagingStatus === "waiting" || file.stagingStatus === "imported") && (!file.sourceKinds?.includes("mapping") || pendingIds.has(file.id)));
    pending.forEach(file => patchFile(sessionId, file.id, { stagingStatus: "importing", stagingMessage: "Adding company data..." }));
    try {
      let report: EnrichmentReport | undefined;
      files.sort((a, b) => Number(b.sourceKinds?.includes("mapping")) - Number(a.sourceKinds?.includes("mapping")));
      for (let offset = 0; offset < files.length; offset += 32) {
        const group = files.slice(offset, offset + 32);
        const result = await traced(sessionId, "import_enrichment_files", { run_id: state.backendRunId, ...fileArgs(group, purpose) });
        const entries = result.files as { file: string; status: string; error?: string; sheets?: { error?: string }[] }[] | undefined;
        for (const file of group) {
          const entry = entries?.find(item => item.file === file.id);
          if (entry && entry.status !== "imported") throw new Error(`${file.name}: ${entry.error ?? entry.sheets?.find(sheet => sheet.error)?.error ?? "File could not be imported"}`);
        }
        let groupReport = (result.reports as EnrichmentReport[] | undefined)?.find(item => item.purpose === purpose);
        if (!groupReport && typeof result.report_id === "string") groupReport = await (await import("./enrichment-client")).getEnrichmentReport(state.backendRunId, result.report_id);
        if (!groupReport) throw new Error("The import did not return a match report. Recheck these files.");
        report = mergeEnrichmentReports(report, groupReport);
      }
      if (!report) throw new Error("The import did not return a match report. Recheck these files.");
      await refreshCompanyContext(sessionId, state.backendRunId);
      await (await import("./review-client")).refreshShortlist(sessionId, state.backendRunId);
      const summary = reportSummary(report);
      pending.forEach(file => patchFile(sessionId, file.id, { stagingStatus: "imported", stagingMessage: summary, hydratedScope: scope }));
      const artifactIds = [...new Set(pending.map(file => file.uploadArtifactId).filter((id): id is string => Boolean(id)))];
      for (const artifactId of artifactIds) {
        const artifact = getChatState(sessionId).artifacts.find(item => item.id === artifactId);
        if (artifact?.type === "enrichment-upload") patchArtifact(sessionId, artifact.id, { summary });
      }
      rememberEnrichmentReport(sessionId, report, artifactIds);
      saveArtifact(sessionId, { ...artifactBase(purpose === "rogo" ? "ROGO data added" : "PitchBook data added"), type: "handoff", service: "Company data", state: "complete", detail: summary });
      sessionStore.addEvent({ sessionId, kind: "artifact", origin: "workspace", status: "success", title: "Company context updated", text: summary, result: { report, files: pending.map(file => file.id), runId: state.backendRunId } });
      if (purpose === "pitchbook") notifyPitchBookReview(sessionId, report);
    } catch (error) {
      pending.forEach(file => patchFile(sessionId, file.id, { stagingStatus: "error", stagingMessage: `${file.name}: ${String(error)}` }));
    }
  }
}
export function processStagedUploads(sessionId: string): Promise<void> {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => process(sessionId));
  queues.set(sessionId, next);
  void next.finally(() => { if (queues.get(sessionId) === next) queues.delete(sessionId); }).catch(() => {});
  return next;
}

export function retryStagedUploads(sessionId: string): Promise<void> {
  updateChatState(sessionId, state => ({ ...state, files: state.files.map(file => isEnrichment(file) && file.stagingStatus === "error" ? { ...file, stagingStatus: "checking", stagingMessage: "Checking again…" } : file) }));
  return processStagedUploads(sessionId);
}
