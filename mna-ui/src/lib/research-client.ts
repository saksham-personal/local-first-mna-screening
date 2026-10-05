import { artifactBase, getChatState, saveArtifact, updateChatState } from "./chat-store";
import { sessionStore } from "./session-store";
import { refreshCompanyContext } from "./company-data-client";
import { refreshShortlist } from "./review-client";
import { addResearchToCriteria } from "./chat-driver";
import type { ChatArtifact } from "./chat-contract";
type ResearchPage = { executed: boolean; planId: string; rows: Record<string, unknown>[]; message: string; more?: boolean; processedQueries?: number; queryCount: number; [key: string]: unknown };
type ResearchPreview = { token: string; queries: { company_id?: string; query: string }[]; queryCount?: number; companyCount?: number; executed: false };
async function request<T>(sessionId: string, route: string, input: unknown): Promise<T> {
  const response = await fetch(`/api/research/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const data = await response.json();
  for (const trace of data.calls ?? []) sessionStore.addEvent({ sessionId, kind: "tool", origin: "workspace", status: trace.status, title: trace.tool === "bing_search" ? "Bing grounding search" : trace.tool.replaceAll("_", " "), toolName: trace.tool, args: trace.args, result: trace.result, error: trace.error, startedAt: trace.startedAt, finishedAt: trace.finishedAt, durationMs: Math.max(0, Date.parse(trace.finishedAt) - Date.parse(trace.startedAt)) });
  if (!response.ok) throw new Error(data.error ?? "Bing research could not be prepared.");
  return data as T;
}
export async function previewBingResearch(sessionId: string, input: { mode?: "company" | "general"; queries: string[]; companyIds: string[] }) {
  return request<ResearchPreview>(sessionId, "preview", { ...input, runId: getChatState(sessionId).backendRunId });
}
const running = new Set<string>();
export async function runBingResearch(sessionId: string, token: string, options?: { includeInCriteria: boolean }) {
  if (running.has(token)) throw new Error("This research is already running.");
  running.add(token);
  try {
  let data: ResearchPage, artifact: ChatArtifact | undefined, executed = false;
  const rows: Record<string, unknown>[] = [], seen = new Set<string>();
  let processed = -1;
  do {
    data = await request<ResearchPage>(sessionId, "run", { token, approved: true });
    executed ||= data.executed === true;
    if (data.more && Number(data.processedQueries) <= processed) throw new Error("Research paging did not advance. Retry the saved research.");
    processed = Number(data.processedQueries ?? 0);
    for (const row of data.rows ?? []) {
      const key = JSON.stringify([row.pk, row.Query, row.URL, row.evidence_id, row.Answer]);
      if (!seen.has(key)) { seen.add(key); rows.push(row); }
    }
    if (rows.length) {
      const planId = data.planId;
      const existing = getChatState(sessionId).artifacts.find(item => item.type === "data-table" && item.planId === planId);
      const historical = existing?.type === "data-table" ? existing.rows : [];
      const combined = [...new Map([...historical, ...rows].map(row => [JSON.stringify([row.pk, row.Query, row.URL, row.evidence_id, row.Answer]), row])).values()];
      artifact = saveArtifact(sessionId, { ...(existing ?? artifactBase("Bing research sources")), type: "data-table", planId: data.planId, rows: combined, columns: [...new Set<string>(combined.flatMap(row => Object.keys(row)))], note: `${processed.toLocaleString()} of ${Number(data.queryCount).toLocaleString()} queries processed. Research is saved with source links; these observations are not verified facts.` });
    }
  } while (data.more);
  artifact ??= saveArtifact(sessionId, { ...artifactBase("Bing research"), type: "handoff", service: "Bing", state: executed ? "complete" : "unavailable", detail: data.message });
  const runId = getChatState(sessionId).backendRunId;
  if (executed && runId) { await refreshCompanyContext(sessionId, runId); await refreshShortlist(sessionId, runId); }
  const messageId = crypto.randomUUID();
  updateChatState(sessionId, state => ({ ...state, branchMessageIds: [...state.branchMessageIds, messageId] }));
  sessionStore.addEvent({ sessionId, messageId, kind: "message", role: "assistant", origin: "workspace", status: data.executed ? "success" : "error", title: "Bing research", text: data.message, content: [{ type: "text", text: data.message }, { type: "data", name: "screening-artifact", data: { artifactId: artifact.id } }] });
  if (options?.includeInCriteria && executed && rows.length) await addResearchToCriteria(sessionId, rows.slice(0, 30).map(row => `${row.Query}: ${row.Answer ?? row.Excerpt ?? ""}${row.URL ? ` [${row.URL}]` : ""}`).join("\n"), "Analyst-selected general Bing research");
  return { ...data, executed, rows };
  } finally { running.delete(token); }
}
