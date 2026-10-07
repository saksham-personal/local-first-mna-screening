import { callTool } from "./tool-client";
import { getChatState, updateChatState } from "./chat-store";
import { refreshShortlist } from "./review-client";
import { refreshCompanyContext } from "./company-data-client";
import { sessionStore } from "./session-store";
import { plural } from "./format";

export type EnrichmentCompany = {
  company_id: string; name: string; website: string | null; pbid?: string | null;
  considered: boolean; reason?: "not_in_mapping" | "profile_not_company" | "blank_pbid" | "no_data_row" | "conflict";
  fields_hydrated?: string[];
};
export type EnrichmentReport = {
  report_id: string; run_id: string; purpose: "pitchbook" | "rogo";
  report_ids?: string[];
  summary: Record<string, number>; matched: EnrichmentCompany[]; not_matched?: EnrichmentCompany[];
  unmatched_rows?: { count: number; sample: { row: number; website: string | null }[] };
  ambiguous?: { website: string | null; company_ids: string[] }[];
};
export function mergeEnrichmentReports(previous: EnrichmentReport | undefined, next: EnrichmentReport): EnrichmentReport {
  if (!previous) return { ...next, report_ids: next.report_ids ?? [next.report_id] };
  const summary = { ...previous.summary, ...next.summary };
  for (const [key, value] of Object.entries(next.summary)) {
    if (typeof value === "number") summary[key] = (typeof previous.summary[key] === "number" ? previous.summary[key] : 0) + value;
  }
  return {
    ...next, summary,
    report_ids: [...(previous.report_ids ?? [previous.report_id]), ...(next.report_ids ?? [next.report_id])],
    matched: [...previous.matched, ...next.matched],
    ...(next.purpose === "pitchbook" ? { not_matched: [...(previous.not_matched ?? []), ...(next.not_matched ?? [])] } : {
      unmatched_rows: { count: (previous.unmatched_rows?.count ?? 0) + (next.unmatched_rows?.count ?? 0), sample: [...(previous.unmatched_rows?.sample ?? []), ...(next.unmatched_rows?.sample ?? [])] },
      ambiguous: [...(previous.ambiguous ?? []), ...(next.ambiguous ?? [])],
    }),
  };
}
export function initialReviewDecisions(companies: EnrichmentCompany[], flags: ReadonlyMap<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(companies.map(company => [company.company_id, flags.get(company.company_id) ?? company.considered]));
}
export function enrichmentReviewChanges(companies: EnrichmentCompany[], decisions: Record<string, boolean>, flags: ReadonlyMap<string, boolean>) {
  const changes = [...new Map(companies.map(company => [company.company_id, company])).values()]
    .filter(company => decisions[company.company_id] !== (flags.get(company.company_id) ?? company.considered));
  return { hide: changes.filter(company => !decisions[company.company_id]).map(company => company.company_id), keep: changes.filter(company => decisions[company.company_id]).map(company => company.company_id) };
}
const latestReports = new Map<string, Map<string, EnrichmentReport>>();
export function reportSummary(report: EnrichmentReport, hidden = 0) {
  const count = report.summary;
  return report.purpose === "pitchbook"
    ? `${plural(count.matched_count, "company", "companies")} matched; ${plural(count.not_matched_count, "company", "companies")} not matched; ${hidden} hidden by this action.`
    : `${plural(count.matched_count, "company", "companies")} matched; ${plural(count.unmatched_row_count, "row")} unmatched; ${plural(count.ambiguous_count, "row")} ambiguous; ${hidden} hidden by this action.`;
}
export function rememberEnrichmentReport(sessionId: string, report: EnrichmentReport, artifactIds: string[] = []) {
  const saved = latestReports.get(sessionId) ?? new Map<string, EnrichmentReport>();
  saved.set(report.purpose, report);
  artifactIds.forEach(id => saved.set(id, report));
  latestReports.set(sessionId, saved);
}
export function notifyPitchBookReview(sessionId: string, report: EnrichmentReport) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("screening:enrichment-review", { detail: { sessionId, report } }));
}
export async function requestPitchBookReview(sessionId: string, artifactId?: string) {
  const state = getChatState(sessionId);
  if (!state.backendRunId) throw new Error("Import PitchBook data after finding companies.");
  const cached = latestReports.get(sessionId)?.get(artifactId ?? "pitchbook");
  const report = cached?.run_id === state.backendRunId ? cached : await getEnrichmentReport(state.backendRunId);
  notifyPitchBookReview(sessionId, report);
}
export async function getEnrichmentReport(runId: string, reportId?: string) {
  return await callTool("get_enrichment_report", { run_id: runId, ...(reportId ? { report_id: reportId } : { purpose: "pitchbook" }) }) as unknown as EnrichmentReport;
}
export async function applyEnrichmentReview(sessionId: string, report: EnrichmentReport, hide: string[], keep: string[], selectionRevision?: number) {
  if (getChatState(sessionId).backendRunId !== report.run_id) throw new Error("The screening changed. Reopen the match review.");
  const args = { run_id: report.run_id, report_id: report.report_id, hide_company_ids: hide, keep_company_ids: keep, ...(selectionRevision !== undefined ? { expected_selection_revision: selectionRevision } : {}) };
  const receipt = sessionStore.startTool("apply_enrichment_review", args, { sessionId, origin: "workspace", title: "PitchBook match review" });
  let result;
  try { result = await callTool("apply_enrichment_review", args, { analystApproved: true }); sessionStore.finishTool(receipt, result); }
  catch (error) { sessionStore.finishTool(receipt, null, "error", String(error)); throw error; }
  await refreshShortlist(sessionId, report.run_id);
  await refreshCompanyContext(sessionId, report.run_id);
  const hidden = Number(result.hidden ?? 0), restored = Number(result.restored ?? 0), leftHidden = Number(result.left_hidden_count ?? 0);
  const unmatchedIds = new Set(report.not_matched?.map(company => company.company_id));
  const text = `${hidden ? `Hid ${plural(hidden, "company", "companies")}${hide.every(id => unmatchedIds.has(id)) ? " without PitchBook data" : " in PitchBook match review"}. They can be restored any time.` : "PitchBook match review applied. No companies hidden."}${restored ? ` Restored ${plural(restored, "company", "companies")}.` : ""}${leftHidden ? ` ${plural(leftHidden, "company", "companies")} remain hidden by an earlier shortlist decision.` : ""}`;
  const messageId = crypto.randomUUID();
  updateChatState(sessionId, state => ({ ...state, branchMessageIds: [...state.branchMessageIds, messageId] }));
  sessionStore.addEvent({ sessionId, messageId, kind: "message", role: "assistant", origin: "workspace", status: "success", title: "PitchBook match review", text, content: [{ type: "text", text }] });
  return result;
}
