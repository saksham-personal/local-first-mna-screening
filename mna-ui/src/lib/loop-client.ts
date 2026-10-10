import { getChatState, updateChatState } from "./chat-store";
import { refreshCompanyContext } from "./company-data-client";
import { refreshShortlist } from "./review-client";
import { sessionStore } from "./session-store";
import { callTool } from "./tool-client";
import { createOutcomeOnceGuard } from "./run-activity";
import type { LoopActivityJob, LoopQuery, StorageLike } from "./run-activity";

export type LoopStartRequest = { runId: string; message: string; sessionId: string; title: string; maxTurns?: number };
export type ControllerLoopTurn = {
  turn: number;
  turn_id: string;
  kind: string;
  reply_markdown: string | null;
  instructions: {
    index: number;
    action: string;
    title: string | null;
    status: "executed" | "rejected" | "failed";
    arguments: Record<string, unknown> | null;
    result_summary: unknown;
    reason: string | null;
  }[];
  status: string;
  error: string | null;
  simulated: boolean;
};
export type ControllerLoopDetail = {
  loop_id: string;
  turns: ControllerLoopTurn[];
  queries: LoopQuery[];
  keeps: LoopQuery[];
  consolidated_count: number;
  drops: number;
  simulated: boolean;
};
export type LoopSummaryQuery = {
  id: string;
  source: string;
  label: string;
  labelTitle: string;
  hits: number;
  threshold: number | null;
  thresholdBinIndex: number | null;
  kept: number;
  histogram: number[];
};
export type LoopSummaryViewModel = {
  heading: string;
  noKeeps: boolean;
  summary: string;
  appliedText: string;
  considered: number;
  hidden: number;
  simulated: boolean;
  queries: LoopSummaryQuery[];
};

export const LOOP_OUTCOMES_KEY = "screening-loop-outcomes-v1";
export const LOOP_STARTED_EVENT = "screening-loop-started";
export const LOOP_UNDO_EVENT = "screening-loop-undo-requested";
const LOOP_TOGGLE_KEY = "screening-loop-toggle-v1";
const activeStates = new Set(["queued", "running", "paused", "consolidating", "cancelling"]);
const terminalStates = new Set(["completed", "cancelled", "failed"]);
const listeners = new Set<() => void>();
const reschedulers = new Set<() => void>();
const dismissed = new Set<string>();
const toggles = new Map<string, boolean>();
const details = new Map<string, ControllerLoopDetail>();
const detailRequests = new Map<string, Promise<ControllerLoopDetail>>();
const outcomeGuard = createOutcomeOnceGuard(undefined, LOOP_OUTCOMES_KEY);
let snapshot: LoopActivityJob[] = [];
let visibleSnapshot: LoopActivityJob[] = [];
let outcomeQueue = Promise.resolve();

export const ACTIVE_LOOP_POLL_MS = 2000;
export const IDLE_LOOP_POLL_MS = 15000;
export const subscribeLoops = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const subscribeLoopPreferences = subscribeLoops;
export const getLoopJobs = () => visibleSnapshot;
export const getLoopById = (id: string) => snapshot.find(job => job.id === id);
const emit = () => listeners.forEach(listener => listener());

export const isLoopActive = (job: Pick<LoopActivityJob, "state">) => activeStates.has(job.state);
export const isLoopActiveForRun = (runId: string | undefined) => !!runId && snapshot.some(job => job.runId === runId && isLoopActive(job));
export const isLoopPollActive = (jobs: readonly Pick<LoopActivityJob, "state">[]) => jobs.some(job => activeStates.has(job.state));
export const loopPollDelay = (jobs: readonly Pick<LoopActivityJob, "state">[], hidden: boolean) => hidden ? undefined : isLoopPollActive(jobs) ? ACTIVE_LOOP_POLL_MS : IDLE_LOOP_POLL_MS;

function storageTarget(storage?: StorageLike): StorageLike | undefined {
  try { return storage ?? (typeof localStorage === "undefined" ? undefined : localStorage); }
  catch { return undefined; }
}
function toggleKey(sessionId: string) { return `${LOOP_TOGGLE_KEY}:${sessionId}`; }
export function readLoopToggle(sessionId: string, storage?: StorageLike): boolean {
  try { return storageTarget(storage)?.getItem(toggleKey(sessionId)) === "true"; }
  catch { return false; }
}
export function writeLoopToggle(sessionId: string, enabled: boolean, storage?: StorageLike): void {
  try { storageTarget(storage)?.setItem(toggleKey(sessionId), String(enabled)); }
  catch { /* The in-memory preference still works for this page session. */ }
}
export function getLoopToggle(sessionId: string): boolean {
  if (toggles.has(sessionId)) return toggles.get(sessionId)!;
  const enabled = readLoopToggle(sessionId);
  toggles.set(sessionId, enabled);
  return enabled;
}
export function setLoopToggle(sessionId: string, enabled: boolean, storage?: StorageLike): void {
  toggles.set(sessionId, enabled);
  writeLoopToggle(sessionId, enabled, storage);
  emit();
}

export function buildLoopStartRequest(runId: string, message: string, sessionId: string, sessionTitle: string, maxTurns?: number): LoopStartRequest {
  return { runId, message, sessionId, title: `Loop · ${sessionTitle}`, ...(maxTurns === undefined ? {} : { maxTurns }) };
}
export function buildLoopCancelRequest(id: string, keep: boolean) { return { id, keep }; }
export function buildCollapsedTurnLine(turn: Pick<ControllerLoopTurn, "turn" | "instructions">, queries: readonly LoopQuery[]): string {
  const actions = turn.instructions.length;
  const kept = queries.find(query => query.keep_turn === turn.turn && query.min_score !== null);
  const actionText = `${actions} ${actions === 1 ? "action" : "actions"}`;
  return `Turn ${turn.turn} · ${actionText}${kept ? ` · kept ${kept.id} ≥ ${Number(kept.min_score).toFixed(2)}` : ""}`;
}
export function thresholdBinIndex(score: number | null | undefined): number | null {
  if (score == null || !Number.isFinite(score)) return null;
  return Math.max(0, Math.min(9, Math.floor(Math.max(0, Math.min(1, score)) * 10)));
}
export function buildLoopSummaryViewModel(
  loop: LoopActivityJob,
  counts: { considered: number; total: number },
): LoopSummaryViewModel {
  const queries = loop.queries ?? [];
  const noKeeps = !queries.some(query => query.min_score !== null && Number.isFinite(query.min_score));
  const considered = Math.max(0, counts.considered);
  const hidden = Math.max(0, counts.total - considered);
  const summaryCount = loop.finalCount ?? considered;
  const heading = noKeeps ? "No keep decisions — shortlist unchanged"
    : loop.state === "cancelled" ? `Loop cancelled · ${summaryCount.toLocaleString()} companies considered`
      : `Loop finished · ${summaryCount.toLocaleString()} companies considered`;
  return {
    heading,
    noKeeps,
    summary: loop.message ?? "",
    appliedText: `Applied to shortlist: ${considered.toLocaleString()} considered · ${hidden.toLocaleString()} hidden`,
    considered,
    hidden,
    simulated: loop.simulated === true,
    queries: queries.map(query => {
      const label = query.label ?? "";
      const trimmed = label.length > 64 ? `${label.slice(0, 61)}…` : label;
      return {
        id: query.id,
        source: query.source,
        label: trimmed,
        labelTitle: label,
        hits: Math.max(0, query.total),
        threshold: query.min_score,
        thresholdBinIndex: thresholdBinIndex(query.min_score),
        kept: Math.max(0, query.kept_count ?? 0),
        histogram: Array.from({ length: 10 }, (_, index) => Math.max(0, query.histogram?.[index] ?? 0)),
      };
    }),
  };
}

function emitStarted() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LOOP_STARTED_EVENT));
}
function setSnapshot(next: LoopActivityJob[]) {
  snapshot = next;
  visibleSnapshot = next.filter(job => !dismissed.has(job.id));
  emit();
}
function mergeLoop(job: LoopActivityJob) {
  const previous = snapshot.find(item => item.id === job.id);
  if (previous && previous.turn !== job.turn) details.delete(job.id);
  setSnapshot([...snapshot.filter(item => item.id !== job.id), job]);
  if (isLoopActive(job)) reschedulers.forEach(schedule => schedule());
  if (isSummaryEligible(job)) enqueueOutcome(job);
}
function isSummaryEligible(job: LoopActivityJob) {
  if (job.state === "completed") return true;
  return job.state === "cancelled" && (!!job.appliedReviewId || /no keep decisions were made/i.test(job.message ?? ""));
}

async function request<T>(route: string, input?: unknown, method: "GET" | "POST" = "POST"): Promise<T> {
  const response = await fetch(`/api/loop/${route}`, {
    method,
    ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input ?? {}) } : {}),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error ?? "The discovery loop could not be updated.") as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return data as T;
}
export function canForceLoopUndo(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number } | null)?.status;
  return status === 409 || /shortlist (?:has )?changed|selection revision|changed since/i.test(message);
}
export async function startLoop(input: LoopStartRequest): Promise<LoopActivityJob> {
  const job = await request<LoopActivityJob>("start", input);
  if (!job || job.kind !== "loop") throw new Error("The bridge did not return a discovery loop.");
  mergeLoop(job);
  emitStarted();
  return job;
}
export async function controlLoop(id: string, action: "pause" | "resume" | "cancel", keep = true): Promise<LoopActivityJob> {
  const payload = action === "cancel" ? buildLoopCancelRequest(id, keep) : { id };
  const job = await request<LoopActivityJob>(action, payload);
  mergeLoop(job);
  return job;
}
export async function undoLoop(id: string, force = false): Promise<LoopActivityJob> {
  const job = await request<LoopActivityJob>("undo", { id, ...(force ? { force: true } : {}) });
  mergeLoop(job);
  if (job.sessionId && job.runId) {
    await refreshCompanyContext(job.sessionId, job.runId);
    await refreshShortlist(job.sessionId, job.runId);
  }
  return job;
}
export function dismissLoop(id: string) {
  dismissed.add(id);
  visibleSnapshot = snapshot.filter(job => !dismissed.has(job.id));
  emit();
}
export function loadControllerLoopDetail(id: string): Promise<ControllerLoopDetail> {
  const cached = details.get(id);
  if (cached) return Promise.resolve(cached);
  const pending = detailRequests.get(id);
  if (pending) return pending;
  const request = callTool("get_controller_loop", { loop_id: id }).then(value => {
    const detail = value as unknown as ControllerLoopDetail;
    if (detail.loop_id !== id || !Array.isArray(detail.turns)) throw new Error("Loop turn history could not be read.");
    details.set(id, detail);
    emit();
    return detail;
  }).finally(() => detailRequests.delete(id));
  detailRequests.set(id, request);
  return request;
}

export function persistLoopTurnMessage(sessionId: string, job: LoopActivityJob, messageId: string, startedAt: string, content: unknown) {
  const current = getChatState(sessionId);
  if (!current.branchMessageIds.includes(messageId)) updateChatState(sessionId, state => ({ ...state, branchMessageIds: [...state.branchMessageIds, messageId] }));
  const events = sessionStore.getSnapshot().sessions.find(item => item.id === sessionId)?.events ?? [];
  if (events.some(event => event.messageId === messageId)) return;
  sessionStore.addEvent({ sessionId, jobId: job.id, messageId, kind: "message", role: "assistant", origin: "assistant", status: "success", title: "LLM Suite discovery loop", text: `Loop · turn ${job.turn} of ${job.maxTurns}`, content, startedAt, finishedAt: new Date().toISOString() });
}

export type LoopSummaryEventData = { loopId: string; view: LoopSummaryViewModel; appliedReviewId?: string | null; undoneReviewId?: string | null };
function postLoopSummary(job: LoopActivityJob, view: LoopSummaryViewModel) {
  if (!job.sessionId) return;
  const sessionId = job.sessionId;
  const messageId = `loop-summary-${job.id}`;
  const state = getChatState(sessionId);
  if (!state.branchMessageIds.includes(messageId)) updateChatState(sessionId, current => ({ ...current, branchMessageIds: [...current.branchMessageIds, messageId] }));
  const events = sessionStore.getSnapshot().sessions.find(item => item.id === sessionId)?.events ?? [];
  if (events.some(event => event.messageId === messageId)) return;
  const data: LoopSummaryEventData = { loopId: job.id, view, appliedReviewId: job.appliedReviewId, undoneReviewId: job.undoneReviewId };
  sessionStore.addEvent({ sessionId, jobId: job.id, messageId, kind: "message", role: "assistant", origin: "workspace", status: "success", title: "LLM Suite discovery loop summary", text: view.heading, content: [{ type: "data", name: "loop-summary", data }], startedAt: job.updatedAt, finishedAt: job.updatedAt });
}
export async function recordLoopOutcome(job: LoopActivityJob): Promise<void> {
  if (!job.sessionId || !isSummaryEligible(job) || outcomeGuard.has(job.id) || !outcomeGuard.claim(job.id)) return;
  try {
    let counts = { considered: Math.max(0, job.finalCount ?? getChatState(job.sessionId).counts.midOnly + getChatState(job.sessionId).counts.isccOnly + getChatState(job.sessionId).counts.both), total: getChatState(job.sessionId).companies.length };
    if (job.runId) {
      await refreshCompanyContext(job.sessionId, job.runId);
      const shortlist = await refreshShortlist(job.sessionId, job.runId);
      counts = { considered: Number(shortlist.considered_count) || 0, total: Number(shortlist.total) || 0 };
    }
    const view = buildLoopSummaryViewModel(job, counts);
    postLoopSummary(job, view);
    outcomeGuard.complete(job.id);
  } catch (error) {
    outcomeGuard.release(job.id);
    throw error;
  }
}
function enqueueOutcome(job: LoopActivityJob) {
  outcomeQueue = outcomeQueue.then(() => recordLoopOutcome(job)).catch(() => {
    // A later poll retries a failed refresh while the persisted guard prevents duplicate cards.
  });
}

export function startLoopPolling() {
  let active = true, inFlight = false, timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!active) return;
    const delay = loopPollDelay(snapshot, document.hidden);
    if (delay !== undefined) timer = setTimeout(() => void poll(), delay);
  };
  const poll = async () => {
    if (inFlight || !active) return;
    inFlight = true;
    try {
      const data = await request<{ jobs: LoopActivityJob[] }>("runs", undefined, "GET");
      if (active && Array.isArray(data.jobs)) {
        const next = data.jobs;
        for (const job of next) {
          const previous = snapshot.find(item => item.id === job.id);
          if (previous && previous.turn !== job.turn) details.delete(job.id);
        }
        setSnapshot(next);
        for (const job of next) if (isSummaryEligible(job)) enqueueOutcome(job);
      }
    } catch { /* The persisted bridge state is restored on the next activity poll. */ }
    inFlight = false;
    schedule();
  };
  const visibility = () => { if (document.hidden) { clearTimeout(timer); timer = undefined; } else { clearTimeout(timer); void poll(); } };
  document.addEventListener("visibilitychange", visibility);
  reschedulers.add(schedule);
  if (!document.hidden) void poll();
  return () => { active = false; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); reschedulers.delete(schedule); };
}
