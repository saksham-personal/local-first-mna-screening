import { artifactBase, getChatState, saveArtifact, updateChatState } from "./chat-store";
import { sessionStore } from "./session-store";
async function request(sessionId: string, route: string, input: unknown) {
  const response = await fetch(`/api/research/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const data = await response.json();
  for (const trace of data.calls ?? []) sessionStore.addEvent({ sessionId, kind: "tool", origin: "workspace", status: trace.status, title: trace.tool === "bing_search" ? "Bing grounding search" : trace.tool.replaceAll("_", " "), toolName: trace.tool, args: trace.args, result: trace.result, error: trace.error, startedAt: trace.startedAt, finishedAt: trace.finishedAt, durationMs: Math.max(0, Date.parse(trace.finishedAt) - Date.parse(trace.startedAt)) });
  if (!response.ok) throw new Error(data.error ?? "Bing research could not be prepared.");
  return data;
}
export async function previewBingResearch(sessionId: string, input: { queries: string[]; companyIds: string[] }) {
  return request(sessionId, "preview", { ...input, runId: getChatState(sessionId).backendRunId });
}
export async function runBingResearch(sessionId: string, token: string) {
  const data = await request(sessionId, "run", { token, approved: true });
  const artifact = saveArtifact(sessionId, data.executed && data.rows.length ? { ...artifactBase("Bing research sources"), type: "data-table", rows: data.rows, columns: [...new Set<string>(data.rows.flatMap((row: Record<string, unknown>) => Object.keys(row)))], note: "Saved research leads. Source links are retained; these observations have not been verified." } : { ...artifactBase("Bing research"), type: "handoff", service: "Bing", state: data.executed ? "complete" : "unavailable", detail: data.message });
  const messageId = crypto.randomUUID();
  updateChatState(sessionId, state => ({ ...state, branchMessageIds: [...state.branchMessageIds, messageId] }));
  sessionStore.addEvent({ sessionId, messageId, kind: "message", role: "assistant", origin: "workspace", status: data.executed ? "success" : "error", title: "Bing research", text: data.message, content: [{ type: "text", text: data.message }, { type: "data", name: "screening-artifact", data: { artifactId: artifact.id } }] });
  return data;
}
