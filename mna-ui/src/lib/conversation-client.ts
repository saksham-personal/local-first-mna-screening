import { getChatState } from "./chat-store";
import { sessionStore } from "./session-store";
import type { ScreeningProvider } from "./screening-contract";
import type { StagedFile } from "./chat-contract";

export type ConversationResult = { executed: boolean; text?: string; templates?: string[]; message?: string };
async function conversation(sessionId: string, route: string, input: object): Promise<ConversationResult> {
  const response = await fetch(`/api/conversation/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const value = await response.json();
  for (const call of value.calls ?? []) sessionStore.addEvent({ sessionId, kind: "tool", origin: "workspace", title: "Provider response", toolName: call.tool, status: call.status === "success" ? "success" : call.status === "error" ? "error" : "cancelled", startedAt: call.startedAt, finishedAt: call.finishedAt, error: call.error, result: { executed: call.status === "success" } });
  if (!response.ok) throw new Error(value.error ?? "The service could not complete this request.");
  return value;
}
export function askProvider(sessionId: string, provider: ScreeningProvider, question: string, files: StagedFile[] = [], requestId: string = crypto.randomUUID()) {
  const state = getChatState(sessionId);
  return conversation(sessionId, "ask", { sessionId, requestId, runId: state.backendRunId, provider, question, attachments: files.filter(file => file.purpose === "chat" || !file.purpose).map(file => ({ id: file.id, include: file.passToProvider !== false })) });
}
export function generateDraft(sessionId: string, purpose: "screening-prompt" | "bing-templates" | "criteria", extra: { request?: string; outputColumns?: string[]; requestId?: string } = {}) {
  const state = getChatState(sessionId);
  return conversation(sessionId, "generate", { sessionId, requestId: extra.requestId ?? crypto.randomUUID(), purpose, runId: state.backendRunId, criteriaText: state.criteriaText, businessDefinition: state.definition, goodFitExamples: state.goodFitExamples, badFitExamples: state.badFitExamples, ...extra });
}
