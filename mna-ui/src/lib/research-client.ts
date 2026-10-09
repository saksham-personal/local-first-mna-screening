import { artifactBase, getChatState, patchArtifact, saveArtifact, updateChatState } from "./chat-store";
import { sessionStore } from "./session-store";
import { refreshCompanyContext } from "./company-data-client";
import { refreshShortlist } from "./review-client";
import { addResearchToCriteria } from "./chat-driver";
import type { BingActivityJob, StorageLike } from "./run-activity";
import { buildRunCancelRequest, createOutcomeOnceGuard } from "./run-activity";

type ResearchPreview = { token: string; queries: { company_id?: string; query: string }[]; queryCount?: number; companyCount?: number; executed: false };
type ResearchRows = { job: BingActivityJob; rows: Record<string, unknown>[]; total: number; capped: boolean; discarded: boolean };
type ResearchAction = "pause" | "resume" | "cancel";
type ResearchRequest = { sessionId?: string; route: string; method?: "GET" | "POST"; input?: unknown };

const activeStates = new Set(["queued", "running", "cancelling"]);
const outcomeGuard = createOutcomeOnceGuard();
const listeners = new Set<() => void>();
const reschedulers = new Set<() => void>();
const dismissed = new Set<string>();
const criteriaPreferences = new Map<string, boolean>();
const PREFERENCE_KEY = "screening-bing-outcome-options-v1";
let snapshot: BingActivityJob[] = [];
let outcomeQueue = Promise.resolve();

export const ACTIVE_RESEARCH_POLL_MS = 2000;
export const IDLE_RESEARCH_POLL_MS = 15000;
export const subscribeResearch = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getResearchJobs = () => snapshot;
export const isResearchActive = (jobs: readonly Pick<BingActivityJob, "state">[]) => jobs.some(job => activeStates.has(job.state));
export const researchPollDelay = (jobs: readonly Pick<BingActivityJob, "state">[], hidden: boolean) => hidden ? undefined : isResearchActive(jobs) ? ACTIVE_RESEARCH_POLL_MS : IDLE_RESEARCH_POLL_MS;

function emit() { listeners.forEach(listener => listener()); }
function merge(job: BingActivityJob) {
  snapshot = [...snapshot.filter(item => item.id !== job.id), job].filter(item => !dismissed.has(item.id));
  emit();
  if (isResearchActive([job])) reschedulers.forEach(schedule => schedule());
}

async function request<T>({ sessionId, route, method = "POST", input }: ResearchRequest): Promise<T> {
  const response = await fetch(`/api/research/${route}`, {
    method,
    ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}),
  });
  const data = await response.json();
  if (sessionId) for (const trace of data.calls ?? []) sessionStore.addEvent({ sessionId, kind: "tool", origin: "workspace", status: trace.status, title: trace.tool === "bing_search" ? "Bing grounding search" : trace.tool.replaceAll("_", " "), toolName: trace.tool, args: trace.args, result: trace.result, error: trace.error, startedAt: trace.startedAt, finishedAt: trace.finishedAt, durationMs: Math.max(0, Date.parse(trace.finishedAt) - Date.parse(trace.startedAt)) });
  if (!response.ok) throw new Error(data.error ?? "Bing research could not be prepared.");
  return data as T;
}

export async function previewBingResearch(sessionId: string, input: { mode?: "company" | "general"; queries: string[]; companyIds: string[] }) {
  return request<ResearchPreview>({ sessionId, route: "preview", input: { ...input, runId: getChatState(sessionId).backendRunId } });
}

function readCriteriaPreferences(storage?: StorageLike) {
  try {
    const target = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    const parsed: unknown = JSON.parse(target?.getItem(PREFERENCE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, boolean> : {};
  } catch { return {}; }
}
function writeCriteriaPreference(jobId: string, value: boolean) {
  criteriaPreferences.set(jobId, value);
  if (value) {
    const preferences = readCriteriaPreferences();
    preferences[jobId] = true;
    try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preferences)); } catch { /* Keep the choice for this page session. */ }
  }
}
function takeCriteriaPreference(jobId: string) {
  if (criteriaPreferences.has(jobId)) return criteriaPreferences.get(jobId) === true;
  const preferences = readCriteriaPreferences();
  const value = preferences[jobId] === true;
  delete preferences[jobId];
  try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preferences)); } catch { /* Preference cleanup is best effort. */ }
  return value;
}
function clearCriteriaPreference(jobId: string) {
  criteriaPreferences.delete(jobId);
  const preferences = readCriteriaPreferences();
  delete preferences[jobId];
  try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preferences)); } catch { /* Preference cleanup is best effort. */ }
}

export async function startBingResearch(sessionId: string, token: string, options?: { includeInCriteria: boolean }) {
  const data = await request<{ job: BingActivityJob }>({ sessionId, route: "start", input: { token, approved: true, sessionId } });
  if (!data.job || data.job.kind !== "bing") throw new Error("Bing research did not return a background run.");
  writeCriteriaPreference(data.job.id, options?.includeInCriteria === true);
  merge(data.job);
  return data.job;
}

export async function researchAction(id: string, action: ResearchAction, keep?: boolean) {
  const previous = snapshot.find(job => job.id === id);
  if (!previous) throw new Error("Bing research is unavailable. Refresh Activity and try again.");
  const input = action === "cancel" ? buildRunCancelRequest(previous.planId, keep === true) : { planId: previous.planId };
  const data = await request<{ job: BingActivityJob }>({ route: action, input });
  if (data.job) merge(data.job);
  return data.job;
}

export function dismissResearch(id: string) {
  dismissed.add(id);
  snapshot = snapshot.filter(job => job.id !== id);
  emit();
}

function recordedSystemNote(job: BingActivityJob, text: string) {
  const session = sessionStore.getSnapshot().sessions.find(item => item.id === job.sessionId);
  if (session?.events.some(event => event.jobId === job.id && event.kind === "system")) return;
  sessionStore.addEvent({ sessionId: job.sessionId, jobId: job.id, kind: "system", origin: "workspace", status: "success", title: text, text });
}

async function recordBingOutcome(job: BingActivityJob) {
  if (!job.sessionId || outcomeGuard.has(job.id) || !outcomeGuard.claim(job.id)) return;
  try {
    const response = await fetch(`/api/research/runs/rows?id=${encodeURIComponent(job.id)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Bing research results could not be loaded.");
    const result = data as ResearchRows;
    if (result.discarded) {
      recordedSystemNote(job, "Bing research cancelled · results discarded");
      outcomeGuard.complete(job.id);
      clearCriteriaPreference(job.id);
      return;
    }

    const rows = Array.isArray(result.rows) ? result.rows.slice(0, 500) : [];
    const total = Math.max(0, Number(result.total) || rows.length);
    const capped = result.capped === true || total > rows.length;
    const capNote = capped ? " showing first 500; all observations are saved." : "";
    const note = `${job.processedQueries.toLocaleString()} of ${job.queryCount.toLocaleString()} queries processed. Research observations remain unverified leads.${capNote}`;
    const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
    const existing = getChatState(job.sessionId).artifacts.find(item => item.type === "data-table" && item.planId === job.planId && item.title === "Bing research sources");
    let artifactId: string;
    if (existing?.type === "data-table") {
      artifactId = existing.id;
      patchArtifact(job.sessionId, artifactId, { rows, columns, note, planId: job.planId });
    } else {
      const artifact = saveArtifact(job.sessionId, { ...artifactBase("Bing research sources"), type: "data-table", planId: job.planId, rows, columns, note });
      artifactId = artifact.id;
    }

    const messageId = `bing-research-${job.id}`;
    const chat = getChatState(job.sessionId);
    if (!chat.branchMessageIds.includes(messageId)) updateChatState(job.sessionId, state => ({ ...state, branchMessageIds: [...state.branchMessageIds, messageId] }));
    const session = sessionStore.getSnapshot().sessions.find(item => item.id === job.sessionId);
    const message = job.message ?? (job.state === "cancelled" ? "Research cancelled. Completed observations were kept." : "Bing research completed.");
    if (!session?.events.some(event => event.messageId === messageId)) sessionStore.addEvent({
      sessionId: job.sessionId,
      jobId: job.id,
      messageId,
      kind: "message",
      role: "assistant",
      origin: "workspace",
      status: "success",
      title: "Bing research",
      text: message,
      content: [{ type: "text", text: message }, { type: "data", name: "screening-artifact", data: { artifactId } }],
    });

    if (job.runId) {
      await refreshCompanyContext(job.sessionId, job.runId);
      await refreshShortlist(job.sessionId, job.runId);
    }
    if (takeCriteriaPreference(job.id) && rows.length) await addResearchToCriteria(job.sessionId, rows.slice(0, 30).map(row => `${row.Query}: ${row.Answer ?? row.Excerpt ?? ""}${row.URL ? ` [${row.URL}]` : ""}`).join("\n"), "Analyst-selected general Bing research");
    outcomeGuard.complete(job.id);
    clearCriteriaPreference(job.id);
  } catch (error) {
    outcomeGuard.release(job.id);
    throw error;
  }
}

function enqueueOutcome(job: BingActivityJob) {
  outcomeQueue = outcomeQueue.then(() => recordBingOutcome(job)).catch(() => {
    // The next poll retries a failed result read while the persisted guard prevents duplicate outcomes.
  });
}

export function startResearchPolling() {
  let active = true, inFlight = false, timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!active) return;
    const delay = researchPollDelay(snapshot, document.hidden);
    if (delay !== undefined) timer = setTimeout(() => void poll(), delay);
  };
  const poll = async () => {
    if (inFlight || !active) return;
    inFlight = true;
    try {
      const response = await fetch("/api/research/runs");
      if (response.ok) {
        const data = await response.json();
        if (active && Array.isArray(data.jobs)) {
          const next = data.jobs as BingActivityJob[];
          snapshot = next.filter(job => !dismissed.has(job.id));
          emit();
          for (const job of next) if (job.state === "completed" || job.state === "cancelled") enqueueOutcome(job);
        }
      }
    } catch { /* Background state is restored by the next poll. */ }
    inFlight = false;
    schedule();
  };
  const visibility = () => { if (document.hidden) { clearTimeout(timer); timer = undefined; } else { clearTimeout(timer); void poll(); } };
  document.addEventListener("visibilitychange", visibility);
  reschedulers.add(schedule);
  if (!document.hidden) void poll();
  return () => { active = false; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); reschedulers.delete(schedule); };
}
