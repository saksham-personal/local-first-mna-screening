import { callTool, type ToolResult } from "./tool-client";
import { getChatState, mirrorWorkspace, updateChatState } from "./chat-store";
import { sessionStore } from "./session-store";
import { refreshCompanyContext } from "./company-data-client";

const criteriaQueues = new Map<string, Promise<void>>();
async function traced(sessionId: string, tool: string, args: ToolResult, approved = false) {
  const receipt = sessionStore.startTool(tool, args, { sessionId, origin: "workspace", title: tool.replaceAll("_", " ") });
  try { const result = await callTool(tool, args, { analystApproved: approved }); sessionStore.finishTool(receipt, result); return result; }
  catch (error) { sessionStore.finishTool(receipt, null, "error", String(error)); throw error; }
}
export function persistCriteriaDraft(sessionId: string): Promise<void> {
  const snapshot = getChatState(sessionId);
  const prior = criteriaQueues.get(sessionId) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(async () => {
    let state = getChatState(sessionId);
    let runId = state.backendRunId;
    if (!runId) {
      const result = await traced(sessionId, "create_run", { objective: sessionStore.getSnapshot().sessions.find(session => session.id === sessionId)?.title ?? "Screening", original_criteria: { text: snapshot.criteriaText } }, true);
      if (typeof result.run_id !== "string") throw new Error("The screening could not be saved.");
      runId = result.run_id;
      updateChatState(sessionId, { backendRunId: runId });
    }
    const result = await traced(sessionId, "save_criteria_revision", { run_id: runId, criteria_text: snapshot.criteriaText, business_definition: snapshot.definition, good_fit_examples: snapshot.goodFitExamples?.trim() ? [snapshot.goodFitExamples.trim()] : [], bad_fit_examples: snapshot.badFitExamples?.trim() ? [snapshot.badFitExamples.trim()] : [] }, true);
    state = getChatState(sessionId);
    if (state.revision === snapshot.revision && state.definition === snapshot.definition)
      updateChatState(sessionId, { durableCriteria: { revision: Number(result.revision), digest: String(result.digest), localRevision: snapshot.revision } });
  });
  criteriaQueues.set(sessionId, next);
  void next.finally(() => { if (criteriaQueues.get(sessionId) === next) criteriaQueues.delete(sessionId); }).catch(() => {});
  return next;
}
export function flushCriteriaDraft(sessionId: string) {
  return criteriaQueues.get(sessionId) ?? persistCriteriaDraft(sessionId);
}
export async function approveDurableCriteria(sessionId: string) {
  await criteriaQueues.get(sessionId);
  if (getChatState(sessionId).durableCriteria?.localRevision !== getChatState(sessionId).revision) await persistCriteriaDraft(sessionId);
  const state = getChatState(sessionId), revision = state.durableCriteria;
  if (!state.backendRunId || !revision || revision.localRevision !== state.revision) throw new Error("The criteria changed. Review the current draft again.");
  await traced(sessionId, "approve_criteria_revision", { run_id: state.backendRunId, revision: revision.revision, digest: revision.digest, approved_by: "Analyst approval in Screening" }, true);
  if (getChatState(sessionId).revision !== state.revision) throw new Error("The criteria changed during approval. Review the latest draft.");
}

export async function readShortlist(sessionId: string, runId: string, includeHidden = true): Promise<ToolResult & { candidates: Record<string, unknown>[] }> {
  const candidates: Record<string, unknown>[] = [];
  let cursor: string | undefined, selection: number | undefined, sourceHash: string | undefined, summary: ToolResult = {};
  do {
    const page = await traced(sessionId, "get_shortlist_context", { run_id: runId, include_hidden: includeHidden, limit: 1000, ...(cursor ? { after_company_id: cursor } : {}) });
    if (!Array.isArray(page.candidates)) throw new Error("The shortlist could not be read.");
    if ((selection !== undefined && selection !== page.selection_revision) || (sourceHash !== undefined && sourceHash !== page.source_hash)) throw new Error("The shortlist changed while reading it. Please open it again.");
    selection = Number(page.selection_revision); sourceHash = String(page.source_hash); summary = page;
    candidates.push(...page.candidates as Record<string, unknown>[]);
    const next = typeof page.next_after_company_id === "string" ? page.next_after_company_id : undefined;
    if (page.has_more && (!next || next === cursor || !page.candidates.length)) throw new Error("Shortlist paging did not advance.");
    cursor = page.has_more ? next : undefined;
  } while (cursor);
  if (candidates.length !== Number(includeHidden ? summary.total : summary.considered_count)) throw new Error("The shortlist changed. Please open it again.");
  return { ...summary, candidates };
}
export async function refreshShortlist(sessionId: string, runId: string) {
  const data = await readShortlist(sessionId, runId);
  const state = getChatState(sessionId);
  if (state.backendRunId !== runId) return data;
  const flags = new Map(data.candidates.map(row => [String(row.company_id ?? row.pk), row.considered === true]));
  const companies = state.companies.map(company => ({ ...company, considered: flags.get(company.pk) ?? company.considered ?? true }));
  const considered = companies.filter(company => company.considered);
  const counts = { midOnly: considered.filter(company => company.source === "MID").length, isccOnly: considered.filter(company => company.source === "ISCC").length, both: considered.filter(company => company.source === "both").length };
  const next = updateChatState(sessionId, { companies, counts, selectionRevision: Number(data.selection_revision), selectedResults: data.review_columns as Record<string, string[]>, coverage: data.coverage as { PB: number; ROGO: number; BING: number } });
  mirrorWorkspace(next);
  return data;
}
export async function reviewShortlist(sessionId: string, keepCompanyIds: string[], planId?: string, outputColumns?: string[]) {
  const state = getChatState(sessionId);
  if (!state.backendRunId) throw new Error("Find companies before reviewing the shortlist.");
  const columns = { ...state.selectedResults, ...(planId && outputColumns ? { [planId]: outputColumns.filter(column => !["index", "pk", "Company Name", "considered"].includes(column)) } : {}) };
  await traced(sessionId, "review_shortlist", { run_id: state.backendRunId, keep_company_ids: keepCompanyIds, review_columns: columns, ...(state.selectionRevision !== undefined ? { expected_selection_revision: state.selectionRevision } : {}), reason: "Analyst shortlist review" }, true);
  await refreshShortlist(sessionId, state.backendRunId);
  await refreshCompanyContext(sessionId, state.backendRunId);
}
