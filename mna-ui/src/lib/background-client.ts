import type { BackgroundRunView } from "../screening/BackgroundRuns";
import type { PreparedScreening } from "./screening-contract";
import { artifactBase, getChatState, mirrorWorkspace, patchArtifact, saveArtifact, updateChatState } from "./chat-store";
import { sessionStore } from "./session-store";

type Trace = { id: string; tool: string; args: Record<string, unknown>; status: "running" | "success" | "error"; startedAt: string; finishedAt?: string; result?: unknown; error?: string };
export type BackgroundJob = BackgroundRunView & { planId: string; runId: string; sessionId?: string; digest: string; executed: boolean; events?: Trace[] };
let snapshot: BackgroundJob[] = [];
const listeners = new Set<() => void>();
const receipts = new Map<string, string>();
const dismissed = new Set<string>();
const emit = () => listeners.forEach(fn => fn());
export const subscribeBackground = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getBackgroundJobs = () => snapshot;
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
  record(job);
  snapshot = [...snapshot.filter(item => item.id !== job.id), job].filter(item => !dismissed.has(item.id));
  emit();
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
export async function backgroundAction(id: string, action: "pause" | "resume" | "retry" | "stage") {
  const previous = snapshot.find(job => job.id === id);
  if (!previous) throw new Error("Background run is unavailable. Refresh and try again.");
  merge({ ...previous, busy: true });
  try {
    const result = await request(action, { planId: previous.planId });
    if (action === "stage" && previous.sessionId) {
      const sessionId = previous.sessionId, state = getChatState(sessionId);
      const assessments = result.rows as { company_id: string; index: number; result: Record<string, unknown>; provider: string; job_id: string }[];
      const byId = new Map(state.companies.map(c => [c.pk, c]));
      const rows: Record<string, unknown>[] = assessments.map(row => ({ ...row.result, index: row.index, pk: row.company_id, "Company Name": byId.get(row.company_id)?.name ?? "", Website: byId.get(row.company_id)?.website ?? "" }));
      for (const answer of result.answers ?? []) rows.push({ index: "", pk: "", "Company Name": "", Website: "", Answer: answer.answer });
      rows.sort((a, b) => Number(a.index) - Number(b.index));
      const existing = state.artifacts.find(a => a.type === "data-table" && a.planId === previous.planId);
      const data = { rows, columns: [...new Set(rows.flatMap(row => Object.keys(row)))], note: `${result.job.completed} completed batches. These are accepted model assessments, separate from retrieval scores and verified evidence.`, planId: previous.planId };
      if (existing) patchArtifact(sessionId, existing.id, data);
      const artifact = existing ? getChatState(sessionId).artifacts.find(a => a.id === existing.id) : saveArtifact(sessionId, { ...artifactBase("Screening results"), type: "data-table", ...data });
      const next = updateChatState(sessionId, s => ({ ...s, companies: s.companies.map(company => ({ ...company, enrichment: { ...company.enrichment, [`Assessment:${previous.planId}`]: assessments.filter(row => row.company_id === company.pk).map(row => row.result) } })) }));
      mirrorWorkspace(next);
      if (artifact && (!existing || previous.staged !== result.job.staged)) {
        const messageId = crypto.randomUUID();
        updateChatState(sessionId, s => ({ ...s, branchMessageIds: [...s.branchMessageIds, messageId] }));
        sessionStore.addEvent({ sessionId, messageId, kind: "message", role: "assistant", origin: "workspace", status: "success", title: "Screening results staged", text: `${rows.length} accepted results are ready for review.`, content: [{ type: "text", text: `${rows.length} accepted results are ready for review.` }, { type: "data", name: "screening-artifact", data: { artifactId: artifact.id } }] });
      }
    }
    sessionStore.addEvent({ sessionId: previous.sessionId, kind: "system", origin: "workspace", status: "success", title: action === "stage" ? "Completed results staged" : action === "pause" ? "Screening paused" : action === "retry" ? "Failed batches queued for retry" : "Screening resumed", result: { planId: previous.planId, executed: result.job?.executed } });
    return result;
  } finally {
    const latest = snapshot.find(job => job.id === id);
    if (latest) merge({ ...latest, busy: false });
  }
}
export function dismissBackground(id: string) { dismissed.add(id); snapshot = snapshot.filter(job => job.id !== id); emit(); }
export function startBackgroundPolling() {
  let active = true, timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    try {
      const response = await fetch("/api/background-runs");
      if (response.ok) {
        const data = await response.json();
        if (active && Array.isArray(data.jobs)) {
          data.jobs.forEach(record);
          snapshot = data.jobs.filter((job: BackgroundJob) => !dismissed.has(job.id)).map((job: BackgroundJob) => ({ ...job, busy: snapshot.find(item => item.id === job.id)?.busy }));
          emit();
        }
      }
    } catch { /* The saved UI state survives a bridge restart. */ }
    if (active) timer = setTimeout(() => void poll(), 2000);
  };
  void poll();
  return () => { active = false; clearTimeout(timer); };
}
