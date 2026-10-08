export type ControllerInstruction = {
  index: number;
  action: string;
  title: string | null;
  status: "executed" | "rejected" | "failed";
  arguments: Record<string, unknown> | null;
  result_summary: unknown;
  reason: string | null;
  warnings?: string[];
};
export type ControllerTurn = {
  turn_id: string;
  conversation_id: string;
  parent_turn_id: string | null;
  kind: "analyst" | "feedback" | "handoff";
  created_at: string;
  context: string | null;
  reasoning: string | null;
  notes: string | null;
  instructions: ControllerInstruction[];
  warnings?: string[] | null;
  feedback_sent: boolean;
  simulated: boolean;
  estimated_tokens: number;
  error?: string | null;
  reply_markdown?: string | null;
};
export type ControllerResponse = {
  conversation_id: string | null;
  rotated: boolean;
  rotated_from: string | null;
  rotation: "token_budget" | "new_conversation" | null;
  estimated_tokens: number;
  turns: ControllerTurn[];
};
export type ControllerView = ControllerTurn & {
  rotatedFrom: string | null;
  estimatedTokens: number;
  divider?: string;
  feedbackParent?: string;
};

export function controllerAvailable(runId: string | undefined, health: { ready?: boolean; controller?: { available?: boolean } } | undefined) {
  return !!runId && health?.ready === true && health.controller?.available === true;
}

export function controllerViews(response: ControllerResponse): ControllerView[] {
  const seen = new Set<string>();
  return response.turns.map(turn => {
    const first = !seen.has(turn.conversation_id);
    seen.add(turn.conversation_id);
    const activeRotation = turn.conversation_id === response.conversation_id && response.rotated;
    const divider = first && (activeRotation || turn.kind === "handoff")
      ? `${turn.kind === "handoff" || response.rotation === "token_budget" ? "Context full — continued in a new conversation" : "New LLM Suite conversation"} · ${turn.conversation_id.slice(0, 13)}`
      : undefined;
    return { turn_id: turn.turn_id, conversation_id: turn.conversation_id, parent_turn_id: turn.parent_turn_id,
      kind: turn.kind, created_at: turn.created_at, context: turn.context, reasoning: turn.reasoning, notes: turn.notes,
      feedback_sent: turn.feedback_sent, simulated: turn.simulated, estimated_tokens: turn.estimated_tokens,
      error: turn.error, reply_markdown: turn.kind === "handoff" ? turn.reply_markdown : undefined,
      instructions: [...turn.instructions].sort((a, b) => a.index - b.index),
      warnings: [...(turn.warnings ?? []), ...turn.instructions.flatMap(instruction => instruction.warnings ?? [])],
      rotatedFrom: activeRotation ? response.rotated_from : null,
      estimatedTokens: turn.conversation_id === response.conversation_id ? response.estimated_tokens : turn.estimated_tokens,
      divider, feedbackParent: turn.kind === "feedback" ? turn.parent_turn_id ?? undefined : undefined };
  });
}

/** Bounded, readable key/value lines rather than serialised provider payloads. */
export function valueLines(value: unknown, prefix = "", depth = 0): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    if (value.every(item => item === null || typeof item !== "object")) return [`${prefix}: ${value.join("; ").slice(0, 240)}`];
    return [`${prefix || "items"}: ${value.length} items`];
  }
  if (typeof value === "object") return Object.entries(value).slice(0, 12).flatMap(([key, item]) =>
    depth >= 2 && typeof item === "object" ? [] : valueLines(item, prefix ? `${prefix} · ${key}` : key, depth + 1));
  return [`${prefix ? `${prefix}: ` : ""}${String(value).slice(0, 240)}`];
}
export function shortResult(value: unknown) { return valueLines(value).slice(0, 4).join(" · "); }

type Preferences = { mode: boolean; newConversation: boolean };
const preferences = new Map<string, Preferences>();
const listeners = new Set<() => void>();
const local: Preferences = { mode: false, newConversation: false };
export function getControllerPreferences(sessionId: string) { return preferences.get(sessionId) ?? local; }
export function setControllerPreferences(sessionId: string, patch: Partial<Preferences>) {
  preferences.set(sessionId, { ...getControllerPreferences(sessionId), ...patch });
  listeners.forEach(listener => listener());
}
export function subscribeControllerPreferences(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

async function read<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "LLM Suite is disconnected or unavailable.");
  return value;
}
export function controllerHealth() { return read<{ ready: boolean; controller: { available: boolean; simulated: boolean } }>("/api/health"); }
export function readControllerTurns(runId: string) { return read<ControllerResponse>(`/api/controller/turns?runId=${encodeURIComponent(runId)}`); }
export function sendControllerTurn(sessionId: string, runId: string, message: string, newConversation: boolean, signal: AbortSignal) {
  return read<ControllerResponse>("/api/controller/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, runId, message, newConversation }), signal });
}
