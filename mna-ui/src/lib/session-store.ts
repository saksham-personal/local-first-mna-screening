import { useSyncExternalStore } from "react";
import type {
  EventInput,
  ResearchSession,
  SessionEvent,
  SessionSnapshot,
  SessionStoreApi,
} from "./session-contract";

const STORAGE_KEY = "mna-research-session-log-v1";
const PAYLOAD_LIMIT = 16 * 1024;
const SNAPSHOT_LIMIT = 1.5 * 1024 * 1024;
export function resultOmitted(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as Record<string, unknown>)._omitted === true;
}

/** Browser storage is a receipt ledger; full tool responses live only in memory. */
export function compactPayload(value: unknown): unknown {
  if (value === undefined) return value;
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes <= PAYLOAD_LIMIT) return value;
  const summary = typeof value === "string" ? value.slice(0, 500) :
    Object.entries((value && typeof value === "object" ? value : {}) as Record<string, unknown>)
      .map(([key, item]) => `${key}: ${Array.isArray(item) ? `${item.length} items` : typeof item === "object" ? "object" : String(item).slice(0, 80)}`).join(", ").slice(0, 500);
  const retained: Record<string, unknown> = {};
  // These references are used by approval chips and enrichment review after reload.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["revision", "mandate", "definition", "sourceArtifactId", "artifactId", "report", "report_id", "report_ids", "summary", "run_id", "purpose", "sourceEventId"]) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) retained[key] = compactPayload(item);
    }
  }
  return { _omitted: true, bytes, summary, ...retained };
}

const compactEvents = new WeakMap<SessionEvent, SessionEvent>();
function compactEvent(event: SessionEvent): SessionEvent {
  const cached = compactEvents.get(event);
  if (cached) return cached;
  const content = Array.isArray(event.content) ? event.content.map(part => {
    if (!part || typeof part !== "object") return compactPayload(part);
    return Object.fromEntries(Object.entries(part).map(([key, value]) => {
      const compact = compactPayload(value);
      // assistant-ui expects these fields to remain strings, even when a tool
      // response was also embedded as a text part or serialized arguments.
      return [key, typeof value === "string" && resultOmitted(compact) && (key === "text" || key === "argsText")
        ? key === "argsText" ? JSON.stringify(compact) : `${value.slice(0, 500)}\n\nResult not saved (large)`
        : compact];
    }));
  }) : compactPayload(event.content);
  const saved = { ...event, args: compactPayload(event.args), result: compactPayload(event.result), content };
  compactEvents.set(event, saved);
  return saved;
}

export function serializeSessionSnapshot(snapshot: SessionSnapshot, limit = SNAPSHOT_LIMIT): string {
  const sessions = snapshot.sessions.map(session => {
    const previousMarker = session.events.find(event => event.id === `omitted-${session.id}`);
    const events = session.events.filter(event => event !== previousMarker);
    const newest = events.slice(-400);
    // A revision approval must remain available even after a long tool timeline.
    const approval = session.events.filter(event => event.kind === "approval" && event.title === "Discovery criteria approved").at(-1);
    if (approval && !newest.includes(approval)) newest.splice(0, 1, approval);
    return { ...session, events: newest.map(compactEvent), omitted: events.length - newest.length + (previousMarker ? Number.parseInt(previousMarker.title, 10) || 0 : 0) };
  });
  const serialize = () => JSON.stringify({ version: 1, activeId: snapshot.activeId, sessions: sessions.map(({ omitted, ...session }) => ({
    ...session, events: omitted ? [...session.events, { id: `omitted-${session.id}`, sessionId: session.id, sequence: (session.events.at(-1)?.sequence ?? 0) + 1, kind: "system", status: "success", origin: "system", title: `${omitted} older events not saved`, startedAt: session.createdAt }] : session.events,
  })) });
  let raw = serialize();
  if (raw.length * 2 > limit) {
    const strip = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(strip);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).filter(([key]) => !resultOmitted(value) || key !== "summary").map(([key, item]) => [key, strip(item)]));
    };
    for (const session of sessions) session.events = session.events.map(event => strip(event) as SessionEvent);
    raw = serialize();
  }
  while (raw.length * 2 > limit) {
    const candidates = sessions.flatMap(session => {
      const approval = session.events.filter(event => event.kind === "approval" && event.title === "Discovery criteria approved").at(-1);
      return session.events.filter(event => event !== approval).map(event => ({ session, event }));
    });
    // In an origin with many sessions, even approval receipts may exhaust the
    // budget. Losing a receipt safely clears approval on reload.
    const available = candidates.length ? candidates : sessions.flatMap(session => session.events.map(event => ({ session, event })));
    const oldest = available.sort((a, b) => a.event.startedAt.localeCompare(b.event.startedAt))[0];
    if (!oldest) break;
    oldest.session.events = oldest.session.events.filter(event => event !== oldest.event);
    oldest.session.omitted++;
    raw = serialize();
  }
  return raw;
}
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
  let migrateStorage = false;
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
      migrateStorage = !!raw && raw.length > PAYLOAD_LIMIT;
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
          serializeSessionSnapshot(next),
        );
        error = undefined;
      } catch (caught) {
        error = storageError ?? `Session history could not be saved: ${caught instanceof Error ? caught.message : String(caught)}. Your current changes remain available until this page closes.`;
        for (const budget of [64 * 1024, 8 * 1024]) {
          try {
            actualStorage.setItem(STORAGE_KEY, serializeSessionSnapshot(next, budget));
            error = undefined;
            break;
          } catch { /* Keep full receipts in memory; do not append another event. */ }
        }
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
  if (migrateStorage) commit(snapshot);
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
