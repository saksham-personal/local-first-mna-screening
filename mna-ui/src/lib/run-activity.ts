import { plural } from "./format";

export type ActivityStepState = "done" | "running" | "pending" | "failed" | "cancelled";
export type ActivityAction = "pause" | "resume" | "cancel" | "retry" | "stage" | "open" | "dismiss" | "check";
export type ActivitySource = "screening" | "bing";

export type ServerRunStep = { id: string; label: string; state: string };
export type ScreeningActivityJob = {
  id: string;
  title?: string;
  planId: string;
  runId: string;
  sessionId?: string;
  digest: string;
  provider: "llm_suite" | "copilot";
  state: "queued" | "running" | "paused" | "completed" | "error" | "blocked" | "cancelling" | "cancelled";
  total: number;
  completed: number;
  failed: number;
  running: number;
  staged: number;
  current: boolean;
  executed?: boolean;
  message?: string;
  errors?: { batch: number; message: string; retryable: boolean }[];
  updatedAt?: string;
  startedAt?: string;
  observedAt?: string;
  busy?: boolean;
  steps?: ServerRunStep[];
  events?: { startedAt?: string }[];
};

export type BingActivityJob = {
  id: string;
  kind: "bing";
  runId: string;
  sessionId?: string;
  planId: string;
  title: string;
  state: "queued" | "running" | "paused" | "cancelling" | "completed" | "cancelled" | "failed";
  steps: ServerRunStep[];
  processedQueries: number;
  queryCount: number;
  failedQueries: number;
  startedAt: string;
  updatedAt: string;
  message?: string;
};

export type RunActivityRow = {
  id: string;
  source: ActivitySource;
  title: string;
  state: ScreeningActivityJob["state"] | BingActivityJob["state"];
  stateLabel: string;
  processed: number;
  total: number;
  percent: number;
  steps: { id: string; label: string; state: ActivityStepState }[];
  elapsedMs?: number;
  startedAt?: string;
  updatedAt?: string;
  message?: string;
  sessionId?: string;
  planId: string;
  provider?: ScreeningActivityJob["provider"];
  retryable?: boolean;
  stageCount?: number;
  actions: ActivityAction[];
};

function stepState(state: string): ActivityStepState {
  if (["completed", "complete", "done", "succeeded", "success"].includes(state)) return "done";
  if (["running", "current"].includes(state)) return "running";
  if (["failed", "error"].includes(state)) return "failed";
  if (["cancelled", "canceled"].includes(state)) return "cancelled";
  return "pending";
}

function percent(processed: number, total: number, completed: boolean) {
  if (total <= 0) return completed ? 100 : 0;
  return Math.max(0, Math.min(100, (Math.max(0, processed) / total) * 100));
}

function elapsed(startedAt: string | undefined, now: number) {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  return Number.isFinite(start) ? Math.max(0, now - start) : undefined;
}

const activeRunStates = new Set<string>(["queued", "running", "cancelling"]);
/** Active runs tick against the clock. Paused, blocked, finished, and stopped runs stop at their last update. */
function runElapsed(state: string, startedAt: string | undefined, updatedAt: string | undefined, now: number) {
  const end = activeRunStates.has(state) ? now : Date.parse(updatedAt ?? "");
  return elapsed(startedAt, Number.isFinite(end) ? end : now);
}

function displayState(state: RunActivityRow["state"]) {
  return ({
    queued: "Queued", running: "Running", paused: "Paused", cancelling: "Cancelling",
    completed: "Completed", cancelled: "Cancelled", failed: "Failed", error: "Failed", blocked: "Blocked",
  } as Record<string, string>)[state] ?? state;
}

export function mapScreeningJobToActivity(
  job: ScreeningActivityJob,
  options: { title?: string; now?: number } = {},
): RunActivityRow {
  const processed = Math.max(0, job.completed) + Math.max(0, job.failed);
  const discarded = job.state === "cancelled" && /discarded/i.test(job.message ?? "");
  const stageCount = job.current && !discarded ? Math.max(0, job.completed - job.staged) : 0;
  const retryable = job.errors?.some(error => error.retryable) ?? false;
  const actions: ActivityAction[] = [];
  if (job.state === "running" || job.state === "queued") actions.push("pause", "cancel");
  else if (job.state === "paused") actions.push("resume", "cancel");
  else if (job.state === "completed") actions.push(stageCount ? "stage" : "open", "dismiss");
  else if (job.state === "cancelled") actions.push(...(stageCount ? ["stage" as const] : []), "dismiss");
  else if (job.state === "error") actions.push(...(retryable ? ["retry" as const] : []), ...(stageCount ? ["stage" as const] : []), "dismiss");
  else if (job.state === "blocked") actions.push("check", "dismiss");

  const startedAt = job.startedAt ?? job.events?.map(event => event.startedAt).filter((value): value is string => Boolean(value)).sort()[0] ?? job.observedAt ?? job.updatedAt;
  const steps = job.steps?.map(step => ({ id: step.id, label: step.label, state: stepState(step.state) })) ?? [
    { id: "build-input-table", label: "Build input table", state: "done" as const },
    { id: "send-batches", label: `Send batches · ${processed} of ${job.total}`, state: job.state === "running" ? "running" as const : "pending" as const },
    { id: "parse-results", label: "Parse results", state: "pending" as const },
    { id: "stage-results", label: "Stage results", state: "pending" as const },
  ];

  return {
    id: job.id,
    source: "screening",
    title: options.title ?? job.title ?? "Provider screening",
    state: job.state,
    stateLabel: displayState(job.state),
    processed,
    total: Math.max(0, job.total),
    percent: percent(processed, job.total, job.state === "completed"),
    steps,
    elapsedMs: runElapsed(job.state, startedAt, job.updatedAt, options.now ?? Date.now()),
    startedAt,
    updatedAt: job.updatedAt,
    message: job.message,
    sessionId: job.sessionId,
    planId: job.planId,
    provider: job.provider,
    retryable,
    stageCount,
    actions,
  };
}

export function mapBingJobToActivity(
  job: BingActivityJob,
  options: { title?: string; now?: number } = {},
): RunActivityRow {
  const processed = Math.max(0, job.processedQueries);
  const actions: ActivityAction[] = [];
  if (job.state === "running" || job.state === "queued") actions.push("pause", "cancel");
  else if (job.state === "paused") actions.push("resume", "cancel");
  else if (job.state === "completed") actions.push("open", "dismiss");
  else if (job.state === "failed" || job.state === "cancelled") actions.push("dismiss");
  return {
    id: job.id,
    source: "bing",
    title: options.title ?? job.title,
    state: job.state,
    stateLabel: displayState(job.state),
    processed,
    total: Math.max(0, job.queryCount),
    percent: percent(processed, job.queryCount, job.state === "completed"),
    steps: job.steps.map(step => ({ id: step.id, label: step.label, state: stepState(step.state) })),
    elapsedMs: runElapsed(job.state, job.startedAt, job.updatedAt, options.now ?? Date.now()),
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    message: job.message,
    sessionId: job.sessionId,
    planId: job.planId,
    actions,
  };
}

export function formatElapsed(ms: number | undefined) {
  if (ms === undefined) return "Elapsed time unavailable";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `Elapsed ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `Elapsed ${minutes}m ${seconds % 60}s`;
}

/** The unit a run's progress counts in, with its plural, e.g. "28,712 queries" or "1 batch". */
export function processedUnit(source: ActivitySource, total: number) {
  return source === "bing" ? plural(total, "query", "queries") : plural(total, "batch", "batches");
}

export function buildRunCancelRequest(planId: string, keep: boolean) {
  return { planId, keep };
}

export type StorageLike = Pick<Storage, "getItem" | "setItem">;
export const RUN_OUTCOMES_KEY = "screening-bing-outcomes-v1";
export function createOutcomeOnceGuard(storage?: StorageLike) {
  const pending = new Set<string>();
  const memoryRecorded = new Set<string>();
  const read = () => {
    try {
      const target = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
      const value = target?.getItem(RUN_OUTCOMES_KEY);
      const ids: unknown = value ? JSON.parse(value) : [];
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
    } catch { return [...memoryRecorded]; }
  };
  const write = (ids: string[]) => {
    memoryRecorded.clear();
    ids.forEach(id => memoryRecorded.add(id));
    try {
      const target = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
      target?.setItem(RUN_OUTCOMES_KEY, JSON.stringify(ids));
    } catch { /* Memory still protects this page session. */ }
  };
  return {
    has(jobId: string) { return memoryRecorded.has(jobId) || read().includes(jobId); },
    claim(jobId: string) {
      if (this.has(jobId) || pending.has(jobId)) return false;
      pending.add(jobId);
      return true;
    },
    complete(jobId: string) {
      pending.delete(jobId);
      const ids = read();
      if (!ids.includes(jobId)) ids.push(jobId);
      write(ids);
    },
    release(jobId: string) { pending.delete(jobId); },
  };
}
