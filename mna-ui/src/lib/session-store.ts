import { useSyncExternalStore } from "react";
import type {
  EventInput,
  ResearchSession,
  SessionEvent,
  SessionSnapshot,
  SessionStoreApi,
} from "./session-contract";

const STORAGE_KEY = "mna-research-session-log-v1";
const seedDate = new Date().toISOString();
const FIXTURES: ResearchSession[] = [
  {
    id: "run-insurance",
    title: "Insurance software",
    createdAt: seedDate,
    events: [fixtureEvent("run-insurance")],
  },
  {
    id: "run-claims",
    title: "Claims operations",
    createdAt: seedDate,
    events: [fixtureEvent("run-claims")],
  },
];

function fixtureEvent(sessionId: string): SessionEvent {
  return {
    id: `fixture-${sessionId}`,
    sequence: 1,
    sessionId,
    kind: "system",
    status: "success",
    origin: "system",
    title: "Session initialized",
    text: "Local demo session initialized.",
    startedAt: seedDate,
    finishedAt: seedDate,
    durationMs: 0,
  };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value as object)) {
    seen.add(value as object);
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

function cloneValue<T>(value: T): T {
  if (value === undefined) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function freezeSnapshot(value: SessionSnapshot): SessionSnapshot {
  for (const session of value.sessions) {
    for (const event of session.events) deepFreeze(event);
    Object.freeze(session.events);
    Object.freeze(session);
  }
  Object.freeze(value.sessions);
  return Object.freeze(value);
}

function validEvent(value: unknown, sessionId: string): value is SessionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as SessionEvent;
  return (
    typeof event.id === "string" &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence > 0 &&
    event.sessionId === sessionId &&
    ["message", "tool", "approval", "system", "artifact"].includes(
      event.kind,
    ) &&
    ["running", "success", "error", "cancelled", "pending"].includes(
      event.status,
    ) &&
    ["assistant", "workspace", "system"].includes(event.origin) &&
    typeof event.title === "string" &&
    typeof event.startedAt === "string" &&
    Number.isFinite(Date.parse(event.startedAt)) &&
    (event.role === undefined ||
      event.role === "user" ||
      event.role === "assistant") &&
    (event.text === undefined || typeof event.text === "string") &&
    (event.toolName === undefined || typeof event.toolName === "string") &&
    (event.turnId === undefined || typeof event.turnId === "string") &&
    (event.error === undefined || typeof event.error === "string") &&
    (event.finishedAt === undefined ||
      (typeof event.finishedAt === "string" &&
        Number.isFinite(Date.parse(event.finishedAt)))) &&
    (event.durationMs === undefined ||
      (typeof event.durationMs === "number" &&
        Number.isFinite(event.durationMs) &&
        event.durationMs >= 0))
  );
}

function hydrate(raw: string): SessionSnapshot {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object")
    throw new Error("Saved session data has an invalid structure.");
  const value = parsed as SessionSnapshot;
  if (
    value.version !== 1 ||
    typeof value.activeId !== "string" ||
    !Array.isArray(value.sessions) ||
    value.sessions.length === 0
  )
    throw new Error(
      "Saved session data has an unsupported version or structure.",
    );
  const ids = new Set<string>();
  for (const session of value.sessions) {
    if (
      !session ||
      typeof session.id !== "string" ||
      !session.id ||
      ids.has(session.id) ||
      typeof session.title !== "string" ||
      typeof session.createdAt !== "string" ||
      !Array.isArray(session.events)
    )
      throw new Error("Saved session data has an invalid session.");
    ids.add(session.id);
    if (!session.events.every((event) => validEvent(event, session.id)))
      throw new Error(`Saved session “${session.id}” has an invalid event.`);
    const seq = session.events.map((event) => event.sequence);
    if (
      new Set(seq).size !== seq.length ||
      seq.some((n, i) => i > 0 && n <= seq[i - 1])
    )
      throw new Error(
        `Saved session “${session.id}” has invalid event ordering.`,
      );
  }
  if (!ids.has(value.activeId))
    throw new Error("Saved active session does not exist.");
  const sessions = value.sessions.map((session) => ({
    ...session,
    events: session.events.map((event) =>
      event.status === "running" && !event.jobId
        ? {
            ...event,
            status: "cancelled" as const,
            error: "Interrupted on reload; finish not recorded",
            finishedAt: undefined,
            durationMs: undefined,
          }
        : { ...event },
    ),
  }));
  return { version: 1, activeId: value.activeId, sessions };
}

function makeId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function")
    return globalThis.crypto.randomUUID();
  return `event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${(++fallbackId).toString(36)}`;
}
let fallbackId = 0;

export function createSessionStore(
  storage?: Pick<Storage, "getItem" | "setItem">,
): SessionStoreApi {
  let actualStorage = storage;
  let snapshot: SessionSnapshot;
  let storageError: string | undefined;
  if (!actualStorage && typeof window !== "undefined") {
    try {
      actualStorage = window.localStorage;
    } catch (error) {
      storageError = `Local storage is unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (actualStorage) {
    try {
      const raw = actualStorage.getItem(STORAGE_KEY);
      snapshot = raw
        ? hydrate(raw)
        : {
            version: 1,
            activeId: "run-insurance",
            sessions: FIXTURES.map((s) => ({
              ...s,
              events: s.events.map((e) => ({ ...e })),
            })),
          };
    } catch (error) {
      snapshot = {
        version: 1,
        activeId: "run-insurance",
        sessions: FIXTURES.map((s) => ({
          ...s,
          events: s.events.map((e) => ({ ...e })),
        })),
      };
      storageError = `Saved session history could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    snapshot = {
      version: 1,
      activeId: "run-insurance",
      sessions: FIXTURES.map((s) => ({
        ...s,
        events: s.events.map((e) => ({ ...e })),
      })),
    };
  }
  snapshot = freezeSnapshot({
    ...snapshot,
    ...(storageError ? { storageError } : {}),
  });
  const listeners = new Set<() => void>();
  const commit = (next: SessionSnapshot) => {
    let error = storageError;
    if (actualStorage) {
      try {
        actualStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            version: next.version,
            activeId: next.activeId,
            sessions: next.sessions,
          }),
        );
        error = undefined;
      } catch (caught) {
        error = `Session history could not be saved: ${caught instanceof Error ? caught.message : String(caught)}. Your current changes remain available until this page closes.`;
      }
    }
    storageError = error;
    snapshot = freezeSnapshot({
      ...next,
      ...(error ? { storageError: error } : {}),
    });
    listeners.forEach((listener) => listener());
  };
  const requireSession = (id: string) => {
    const session = snapshot.sessions.find((candidate) => candidate.id === id);
    if (!session) throw new Error(`Unknown session: ${id}`);
    return session;
  };
  const api: SessionStoreApi = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    createSession(title) {
      const id = `run-${makeId()}`;
      const session: ResearchSession = {
        id,
        title: title.trim() || "New session",
        createdAt: new Date().toISOString(),
        events: [],
      };
      commit({
        version: 1,
        activeId: id,
        sessions: [...snapshot.sessions, session],
      });
      return id;
    },
    selectSession(id) {
      requireSession(id);
      if (id !== snapshot.activeId)
        commit({ version: 1, activeId: id, sessions: [...snapshot.sessions] });
    },
    addEvent(input: EventInput) {
      const sessionId = input.sessionId ?? snapshot.activeId;
      const session = requireSession(sessionId);
      const event: SessionEvent = {
        ...input,
        ...(input.args !== undefined ? { args: cloneValue(input.args) } : {}),
        ...(input.result !== undefined
          ? { result: cloneValue(input.result) }
          : {}),
        ...(input.content !== undefined
          ? { content: cloneValue(input.content) }
          : {}),
        id: makeId(),
        sequence: (session.events.at(-1)?.sequence ?? 0) + 1,
        sessionId,
        startedAt: input.startedAt ?? new Date().toISOString(),
      };
      commit({
        version: 1,
        activeId: snapshot.activeId,
        sessions: snapshot.sessions.map((s) =>
          s.id === sessionId ? { ...s, events: [...s.events, event] } : s,
        ),
      });
      return event.id;
    },
    startTool(toolName, args, options = {}) {
      return api.addEvent({
        kind: "tool",
        status: "running",
        origin: options.origin ?? "workspace",
        title: options.title ?? toolName,
        toolName,
        args,
        ...(options.turnId ? { turnId: options.turnId } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      });
    },
    finishTool(id, result, status = "success", error, recordedFinish) {
      const session = snapshot.sessions.find((candidate) =>
        candidate.events.some((event) => event.id === id),
      );
      if (!session) return;
      const target = session.events.find((event) => event.id === id)!;
      if (target.kind !== "tool" || target.status !== "running") return;
      const candidate =
        recordedFinish === undefined
          ? new Date().toISOString()
          : recordedFinish;
      const finishedAt =
        candidate && Number.isFinite(Date.parse(candidate))
          ? candidate
          : undefined;
      const elapsed = finishedAt
        ? Date.parse(finishedAt) - Date.parse(target.startedAt)
        : undefined;
      const durationMs =
        elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0
          ? elapsed
          : undefined;
      const resultCopy = result === undefined ? undefined : cloneValue(result);
      commit({
        version: 1,
        activeId: snapshot.activeId,
        sessions: snapshot.sessions.map((s) =>
          s.id === session.id
            ? {
                ...s,
                events: s.events.map((event) =>
                  event.id === id
                    ? {
                        ...event,
                        ...(resultCopy !== undefined
                          ? { result: resultCopy }
                          : {}),
                        status,
                        ...(error ? { error } : {}),
                        finishedAt,
                        durationMs,
                      }
                    : event,
                ),
              }
            : s,
        ),
      });
    },
    renameSession(id, title) {
      requireSession(id);
      commit({
        version: 1,
        activeId: snapshot.activeId,
        sessions: snapshot.sessions.map((s) =>
          s.id === id ? { ...s, title: title.trim() || "Untitled session" } : s,
        ),
      });
    },
  };
  return api;
}

export const sessionStore = createSessionStore();
export function useSessionSnapshot(): SessionSnapshot {
  return useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSnapshot,
    sessionStore.getSnapshot,
  );
}
