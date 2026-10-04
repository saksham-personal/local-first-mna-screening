import type { EventKind, EventStatus, SessionEvent } from "./session-contract";

export type TrajectoryFilters = {
  kind: "all" | EventKind;
  status: "all" | EventStatus | "completed" | "errors";
  query: string;
};

export type TurnGroup = { key: string; label: string; events: SessionEvent[] };

const stableJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
};

export function eventSearchText(event: SessionEvent): string {
  return [
    event.title,
    event.text,
    event.toolName,
    event.error,
    stableJson(event.args),
    stableJson(event.result),
    stableJson(event.content),
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLocaleLowerCase();
}

export function filterTrajectoryEvents(
  events: readonly SessionEvent[],
  filters: TrajectoryFilters,
): SessionEvent[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return events.filter((event) => {
    if (filters.kind !== "all" && event.kind !== filters.kind) return false;
    if (filters.status === "completed" && event.status !== "success")
      return false;
    if (filters.status === "errors" && event.status !== "error") return false;
    if (
      !["all", "completed", "errors"].includes(filters.status) &&
      event.status !== filters.status
    )
      return false;
    return !query || eventSearchText(event).includes(query);
  });
}

export function groupTrajectoryEvents(
  events: readonly SessionEvent[],
  allEvents: readonly SessionEvent[] = events,
): TurnGroup[] {
  const turnNumbers = new Map<string, number>();
  for (const event of allEvents)
    if (event.turnId && !turnNumbers.has(event.turnId))
      turnNumbers.set(event.turnId, turnNumbers.size + 1);
  const groups: TurnGroup[] = [];
  for (const event of events) {
    const key = event.turnId
      ? `turn:${event.turnId}`
      : event.origin === "workspace"
        ? "workspace"
        : "between";
    const label = event.turnId
      ? `Turn ${turnNumbers.get(event.turnId) ?? "—"}`
      : event.origin === "workspace"
        ? "Workspace activity"
        : "Between turns";
    const group = groups.at(-1);
    if (group?.key === key) group.events.push(event);
    else groups.push({ key, label, events: [event] });
  }
  return groups;
}

export type RecordedSpan = {
  event: SessionEvent;
  start: number;
  finish?: number;
  durationMs?: number;
};

export function recordedSpan(event: SessionEvent): RecordedSpan | undefined {
  const start = Date.parse(event.startedAt);
  if (!Number.isFinite(start)) return undefined;
  if (!event.finishedAt) return { event, start };
  const finish = Date.parse(event.finishedAt);
  if (!Number.isFinite(finish) || finish < start) return { event, start };
  return { event, start, finish, durationMs: finish - start };
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
