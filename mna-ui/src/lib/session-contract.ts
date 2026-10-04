export type EventKind = "message" | "tool" | "approval" | "system" | "artifact";
export type EventStatus =
  | "running"
  | "success"
  | "error"
  | "cancelled"
  | "pending";
export type EventOrigin = "assistant" | "workspace" | "system";
export type SessionEvent = {
  id: string;
  sequence: number;
  sessionId: string;
  turnId?: string;
  messageId?: string;
  jobId?: string;
  callId?: string;
  kind: EventKind;
  status: EventStatus;
  origin: EventOrigin;
  title: string;
  role?: "user" | "assistant";
  text?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  content?: unknown;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
};
export type ResearchSession = {
  id: string;
  title: string;
  createdAt: string;
  events: SessionEvent[];
};
export type SessionSnapshot = {
  version: 1;
  activeId: string;
  sessions: ResearchSession[];
  storageError?: string;
};
export type EventInput = Omit<
  SessionEvent,
  "id" | "sequence" | "sessionId" | "startedAt"
> & { startedAt?: string; sessionId?: string };
export type LogFormat = "jsonl" | "markdown" | "zip";

export interface SessionStoreApi {
  getSnapshot(): SessionSnapshot;
  subscribe(listener: () => void): () => void;
  createSession(title: string): string;
  selectSession(id: string): void;
  addEvent(input: EventInput): string;
  startTool(
    toolName: string,
    args: unknown,
    options?: {
      sessionId?: string;
      turnId?: string;
      origin?: EventOrigin;
      title?: string;
    },
  ): string;
  /** Pass null when recovery knows a call stopped but its finish was not recorded. */
  finishTool(
    id: string,
    result: unknown,
    status?: "success" | "error" | "cancelled",
    error?: string,
    finishedAt?: string | null,
  ): void;
  renameSession(id: string, title: string): void;
}
