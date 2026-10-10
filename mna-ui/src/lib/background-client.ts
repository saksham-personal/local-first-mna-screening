import type { BackgroundRunView } from "../screening/BackgroundRuns";
import type { PreparedScreening } from "./screening-contract";
import { artifactBase, getChatState, mirrorWorkspace, patchArtifact, saveArtifact, updateChatState } from "./chat-store";
import { sessionStore } from "./session-store";
import { refreshCompanyContext } from "./company-data-client";
import { refreshShortlist } from "./review-client";
import { buildRunCancelRequest } from "./run-activity";

type Trace = { id: string; tool: string; args: Record<string, unknown>; status: "running" | "success" | "error"; startedAt: string; finishedAt?: string; result?: unknown; error?: string };
export type BackgroundJob = BackgroundRunView & { planId: string; runId: string; sessionId?: string; digest: string; executed: boolean; events?: Trace[] };
let snapshot: BackgroundJob[] = [];
const listeners = new Set<() => void>();
const receipts = new Map<string, string>();
const dismissed = new Set<string>();
const emit = () => listeners.forEach(fn => fn());
const reschedulers = new Set<() => void>();
export const ACTIVE_POLL_MS = 2000;
export const IDLE_POLL_MS = 15000;
/** Runs that are still moving; everything else is waiting on the analyst or finished. */
export const isBackgroundActive = (jobs: readonly Pick<BackgroundJob, "state">[]) => jobs.some(job => job.state === "running" || job.state === "queued" || String(job.state) === "cancelling");
/** Delay before the next poll, or undefined to pause (tab hidden). */
export const backgroundPollDelay = (jobs: readonly Pick<BackgroundJob, "state">[], hidden: boolean) => hidden ? undefined : isBackgroundActive(jobs) ? ACTIVE_POLL_MS : IDLE_POLL_MS;
export const subscribeBackground = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getBackgroundJobs = () => snapshot;
/** The background run for one prepared plan, if it was started or restored. */
export const getBackgroundJobForPlan = (planId: string | undefined) => planId ? snapshot.find(job => job.planId === planId) : undefined;
function record(job: BackgroundJob) {
  if (!job.sessionId) return;
  const session = sessionStore.getSnapshot().sessions.find(s => s.id === job.sessionId);
  if (!session) return;
  for (const trace of job.events ?? []) {
    if (session.events.some(e => e.kind === "tool" && (e.result as { sourceEventId?: string } | null)?.sourceEventId === trace.id)) continue;
    const receipt = receipts.get(trace.id) ?? sessionStore.startTool(trace.tool, trace.args, { sessionId: job.sessionId, origin: "workspace", title: "Run screening batch" });
    receipts.set(trace.id, receipt);
    if (trace.status !== "running") sessionStore.finishTool(receipt, { sourceEventId: trace.id, ...(trace.result as object ?? {}), executed: job.executed }, trace.status, trace.error);
  }
}
function merge(job: BackgroundJob) {
  const prior = snapshot.find(item => item.id === job.id);
  const firstEvent = job.events?.map(event => event.startedAt).filter((value): value is string => Boolean(value)).sort()[0];
  job = { ...job, observedAt: job.observedAt ?? prior?.observedAt ?? job.startedAt ?? firstEvent ?? new Date().toISOString() };
  record(job);
  snapshot = [...snapshot.filter(item => item.id !== job.id), job].filter(item => !dismissed.has(item.id));
  emit();
  // A run that just started should be followed at the fast cadence, not the idle one.
  if (isBackgroundActive([job])) reschedulers.forEach(fn => fn());
}
async function request(route: string, input: unknown) {
  const response = await fetch(`/api/background-runs/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Background screening could not be updated.");
  if (data.job) merge(data.job);
  return data;
}
export async function startBackgroundScreening(sessionId: string, prepared: PreparedScreening) {
  const { job } = await request("start", { planId: prepared.planId ?? prepared.id, sessionId, digest: prepared.fingerprint, approved: true });
  sessionStore.addEvent({ sessionId, kind: "approval", origin: "workspace", status: job.state === "blocked" ? "error" : "success", title: job.state === "blocked" ? "Screening saved; provider unavailable" : "Background screening started", result: { planId: job.planId, digest: job.digest, executed: job.executed }, text: job.message });
  return job as BackgroundJob;
}
export async function backgroundAction(id: string, action: "pause" | "resume" | "retry" | "stage" | "cancel", keep = true) {
  const previous = snapshot.find(job => job.id === id);
  if (!previous) throw new Error("Background run is unavailable. Refresh and try again.");
  merge({ ...previous, busy: true });
  try {
    const result = await request(action, action === "cancel" ? buildRunCancelRequest(previous.planId, keep) : { planId: previous.planId });
    if (action === "stage" && previous.sessionId) {
      const sessionId = previous.sessionId, state = getChatState(sessionId);
      const assessments = result.rows as { company_id: string; index: number; result: Record<string, unknown>; provider: string; job_id: string }[];
      const byId = new Map(state.companies.map(c => [c.pk, c]));
      const rows: Record<string, unknown>[] = assessments.map(row => ({ ...row.result, index: row.index, pk: row.company_id, "Company Name": byId.get(row.company_id)?.name ?? "", Website: byId.get(row.company_id)?.website ?? "" }));
      for (const answer of result.answers ?? []) rows.push({ index: "", pk: "", "Company Name": "", Website: "", Answer: answer.answer });
      rows.sort((a, b) => Number(a.index) - Number(b.index));
      const existing = state.artifacts.find(a => a.type === "data-table" && a.planId === previous.planId);
      const data = { rows, columns: [...new Set(rows.flatMap(row => Object.keys(row)))], note: `${result.job.completed} completed batches. Review scores to keep matches, then choose the output columns to reuse in future screening.`, planId: previous.planId, reviewable: true };
      if (existing) patchArtifact(sessionId, existing.id, data);
      const artifact = existing ? getChatState(sessionId).artifacts.find(a => a.id === existing.id) : saveArtifact(sessionId, { ...artifactBase("Screening results"), type: "data-table", ...data });
      const next = updateChatState(sessionId, s => ({ ...s, companies: s.companies.map(company => ({ ...company, enrichment: { ...company.enrichment, [`Assessment:${previous.planId}`]: assessments.filter(row => row.company_id === company.pk).map(row => row.result) } })) }));
      mirrorWorkspace(next);
      if (state.backendRunId) { await refreshCompanyContext(sessionId, state.backendRunId); await refreshShortlist(sessionId, state.backendRunId); }
      if (artifact && (!existing || previous.staged !== result.job.staged)) {
        const messageId = crypto.randomUUID();
        updateChatState(sessionId, s => ({ ...s, branchMessageIds: [...s.branchMessageIds, messageId] }));
        sessionStore.addEvent({ sessionId, messageId, kind: "message", role: "assistant", origin: "workspace", status: "success", title: "Screening results staged", text: `${rows.length} accepted results are ready for review.`, content: [{ type: "text", text: `${rows.length} accepted results are ready for review.` }, { type: "data", name: "screening-artifact", data: { artifactId: artifact.id } }] });
      }
    }
    sessionStore.addEvent({ sessionId: previous.sessionId, kind: "system", origin: "workspace", status: "success", title: action === "stage" ? "Completed results staged" : action === "pause" ? "Screening paused" : action === "retry" ? "Failed batches queued for retry" : action === "cancel" ? "Screening cancelled" : "Screening resumed", text: action === "cancel" ? result.job?.message : undefined, result: { planId: previous.planId, executed: result.job?.executed } });
    return result;
  } finally {
    const latest = snapshot.find(job => job.id === id);
    if (latest) merge({ ...latest, busy: false });
  }
}
export function dismissBackground(id: string) { dismissed.add(id); snapshot = snapshot.filter(job => job.id !== id); emit(); }
export function startBackgroundPolling() {
  let active = true, inFlight = false, timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!active) return;
    const delay = backgroundPollDelay(snapshot, document.hidden);
    if (delay !== undefined) timer = setTimeout(() => void poll(), delay);
  };
  const poll = async () => {
    if (inFlight || !active) return;
    inFlight = true;
    try {
      const response = await fetch("/api/background-runs");
      if (response.ok) {
        const data = await response.json();
        if (active && Array.isArray(data.jobs)) {
          snapshot = data.jobs.filter((job: BackgroundJob) => !dismissed.has(job.id)).map((job: BackgroundJob) => {
            const prior = snapshot.find(item => item.id === job.id);
            const firstEvent = job.events?.map(event => event.startedAt).filter((value): value is string => Boolean(value)).sort()[0];
            const next = { ...job, busy: prior?.busy, observedAt: job.observedAt ?? prior?.observedAt ?? job.startedAt ?? firstEvent ?? new Date().toISOString() };
            record(next);
            return next;
          });
          emit();
        }
      }
    } catch { /* The saved UI state survives a bridge restart. */ }
    inFlight = false;
    schedule();
  };
  // Pause while the tab is hidden and catch up as soon as it is visible again.
  const visibility = () => { if (document.hidden) { clearTimeout(timer); timer = undefined; } else { clearTimeout(timer); void poll(); } };
  document.addEventListener("visibilitychange", visibility);
  reschedulers.add(schedule);
  if (!document.hidden) void poll();
  return () => { active = false; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); reschedulers.delete(schedule); };
}
