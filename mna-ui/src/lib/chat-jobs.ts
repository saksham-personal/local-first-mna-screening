import type { ThreadAssistantMessagePart } from "@assistant-ui/react";
import type { ChatArtifact, JobSnapshot } from "./chat-contract";
import {
  approved,
  artifactBase,
  getChatState,
  mirrorWorkspace,
  patchArtifact,
  saveArtifact,
  updateChatState,
} from "./chat-store";
import { sessionStore } from "./session-store";
import { companyFromRust, type SearchRow } from "./tool-client";
import { nextStepOptions, recommendedStep } from "./chat-policy";

type Part = ThreadAssistantMessagePart;
const jobs = new Map<string, JobSnapshot>();
const subscribers = new Set<() => void>();
const starting = new Set<string>();
let polling: ReturnType<typeof setTimeout> | undefined;
const pollClients = new Set<symbol>();
let pollGeneration = 0;
let lastPollError = "";
export const toolLabels: Record<string, string> = {
  create_run: "Create screening",
  import_company_files: "Read example companies",
  approve_screening_profile: "Apply criteria approval",
  get_active_screening_profile: "Read approved criteria",
  search_mid: "Search MID",
  add_candidates: "Save companies",
  get_candidate_set: "Read company list",
  get_company: "Read company details",
  get_source_rows: "Read original source fields",
  get_company_context: "Read company context",
  get_discovery_summary: "Count companies",
  save_checkpoint: "Save progress",
  get_checkpoint: "Read saved progress",
  import_enrichment_files: "Import PitchBook and ROGO data",
  get_run_context: "Read screening context",
};
export function getJob(id?: string): JobSnapshot | undefined {
  return id ? jobs.get(id) : undefined;
}
export function subscribeJobs(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
export function getJobParts(job: JobSnapshot): Part[] {
  const receipts =
    sessionStore.getSnapshot().sessions.find((s) => s.id === job.sessionId)
      ?.events ?? [];
  return receipts
    .filter((e) => e.kind === "tool" && e.jobId === job.id)
    .map((e) => ({
      type: "tool-call",
      toolName: e.toolName!,
      toolCallId: e.id,
      args: (e.args ?? {}) as Extract<Part, { type: "tool-call" }>["args"],
      argsText: JSON.stringify(e.args ?? {}),
      ...(e.status !== "running"
        ? {
            result: e.result ?? { error: e.error },
            isError: e.status === "error" || e.status === "cancelled",
          }
        : {}),
    }));
}
export function artifactPart(artifact: ChatArtifact): Part {
  return {
    type: "data",
    name: "screening-artifact",
    data: { artifactId: artifact.id },
  };
}
export function jobContent(job: JobSnapshot): Part[] {
  const session = sessionStore
    .getSnapshot()
    .sessions.find((s) => s.id === job.sessionId);
  const complete = session?.events.find(
    (e) => e.kind === "message" && e.role === "assistant" && e.jobId === job.id,
  );
  if (complete && Array.isArray(complete.content))
    return complete.content as Part[];
  return [
    {
      type: "text",
      text: "Searching the local MID example. You can keep chatting or open another screening while this runs.",
    },
    ...getJobParts(job),
  ];
}
export function syncJob(job: JobSnapshot): void {
  const knownSession = sessionStore
    .getSnapshot()
    .sessions.some((s) => s.id === job.sessionId);
  if (!knownSession) return;
  if (
    jobs.get(job.id)?.state !== "running" &&
    jobs.has(job.id) &&
    job.state === "running"
  )
    return;
  jobs.set(job.id, job);
  const state = getChatState(job.sessionId);
  const context =
    state.jobContext?.id === job.id ? state.jobContext : undefined;
  for (const event of job.events) {
    const existing = sessionStore
      .getSnapshot()
      .sessions.find((s) => s.id === job.sessionId)
      ?.events.find((e) => e.jobId === job.id && e.callId === event.id);
    if (event.type === "tool-start") {
      if (!existing)
        sessionStore.addEvent({
          sessionId: job.sessionId,
          jobId: job.id,
          callId: event.id,
          turnId: context?.turnId ?? job.id,
          kind: "tool",
          origin: "assistant",
          status: "running",
          title: toolLabels[event.tool] ?? event.tool,
          toolName: event.tool,
          args: event.args,
          startedAt: event.timestamp,
        });
    } else if (existing?.status === "running") {
      const error =
        event.type === "tool-error"
          ? String(event.result?.error ?? "Tool failed")
          : undefined;
      sessionStore.finishTool(
        existing.id,
        event.result,
        error ? (job.state === "cancelled" ? "cancelled" : "error") : "success",
        error,
        event.timestamp,
      );
    }
  }
  const jobArtifact = getChatState(job.sessionId).artifacts.find(
    (a) => a.type === "job" && a.jobId === job.id,
  );
  if (jobArtifact?.type === "job" && jobArtifact.state !== job.state)
    patchArtifact(job.sessionId, jobArtifact.id, {
      state: job.state,
      detail: job.error,
    });
  if (job.state !== "running") finishJob(job, context);
  subscribers.forEach((fn) => fn());
}
function finishJob(
  job: JobSnapshot,
  context: ReturnType<typeof getChatState>["jobContext"],
): void {
  const session = sessionStore
    .getSnapshot()
    .sessions.find((s) => s.id === job.sessionId)!;
  if (
    session.events.some(
      (e) =>
        e.kind === "message" && e.role === "assistant" && e.jobId === job.id,
    )
  )
    return;
  const parts: Part[] = [...getJobParts(job)];
  const state = getChatState(job.sessionId);
  let text: string;
  if (job.state === "completed" && job.result) {
    const companies = job.result.companies.map(
      ({ row, detail, sourceRows }) => {
        const company = companyFromRust(row as SearchRow, detail);
        const source = sourceRows.find((row) => row.source === "MID");
        if (source && source.row && typeof source.row === "object")
          company.rawMid = source.row as Record<string, string | number>;
        return company;
      },
    );
    const counts = job.result.counts as unknown as {
      midOnly: number;
      isccOnly: number;
      both: number;
    };
    const current =
      !!context && context.revision === state.revision && approved(state);
    const artifact = saveArtifact(
      job.sessionId,
      {
        ...artifactBase(`${companies.length} companies found`),
        type: "companies",
        companies,
        counts,
        backendRunId: job.result.backendRunId,
        note: current
          ? "Saved results from the fictional MID example. ISCC is not connected. Source scores stay separate."
          : "Results from an earlier criteria revision. Review and approve the current criteria before continuing.",
      },
      context?.turnId,
    );
    parts.push(artifactPart(artifact));
    const checkpoint = saveArtifact(
      job.sessionId,
      {
        ...artifactBase("Progress saved"),
        type: "checkpoint",
        key: "screening-ui",
        backendRunId: job.result.backendRunId,
        summary: `${companies.length} company IDs, source counts, and the approved business definition are saved locally.`,
      },
      context?.turnId,
    );
    parts.push(artifactPart(checkpoint));
    if (current) {
      const next = updateChatState(job.sessionId, {
        companies,
        counts,
        backendRunId: job.result.backendRunId,
      });
      mirrorWorkspace(next);
      void import("./import-pipeline").then(({ processStagedUploads }) => processStagedUploads(job.sessionId));
      parts.push(
        artifactPart(
          saveArtifact(
            job.sessionId,
            {
              ...artifactBase("Choose the next step"),
              type: "options",
              recommended: recommendedStep(companies.length),
              options: nextStepOptions,
            },
            context?.turnId,
          ),
        ),
      );
    }
    text = `Found **${companies.length} unique companies**: ${counts.midOnly} from MID, ${counts.isccOnly} from ISCC, and ${counts.both} from both. ${current ? "Review the list or choose a next step." : "These results belong to earlier criteria."}`;
  } else
    text =
      job.state === "cancelled"
        ? "Search stopped. Completed tool calls and saved writes remain in the session log."
        : `Search could not finish: ${job.error ?? "The local service is unavailable."} You can retry after reviewing the error in the session log.`;
  parts.push({ type: "text", text });
  const finalMessageId = context?.messageId ?? `job-${job.id}`;
  updateChatState(job.sessionId, (current) => ({
    ...current,
    branchMessageIds: current.branchMessageIds.includes(finalMessageId)
      ? current.branchMessageIds
      : [...current.branchMessageIds, finalMessageId],
  }));
  sessionStore.addEvent({
    sessionId: job.sessionId,
    turnId: context?.turnId ?? job.id,
    messageId: finalMessageId,
    jobId: job.id,
    kind: "message",
    role: "assistant",
    origin: "assistant",
    title:
      job.state === "completed"
        ? "Companies ready"
        : job.state === "cancelled"
          ? "Search stopped"
          : "Search failed",
    status:
      job.state === "completed"
        ? "success"
        : job.state === "cancelled"
          ? "cancelled"
          : "error",
    text,
    content: parts,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
  });
}
async function jsonRequest(
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}
export async function startDiscovery(
  sessionId: string,
  title: string,
  turnId: string,
  messageId: string,
  broader = false,
): Promise<JobSnapshot> {
  const state = getChatState(sessionId);
  if (!approved(state))
    throw new Error("Review and approve the current business criteria first.");
  if (starting.has(sessionId))
    throw new Error("A search is already starting for this screening.");
  const existing = getJob(state.jobId);
  if (
    existing?.state === "running" &&
    state.jobContext?.revision === state.revision
  )
    return existing;
  starting.add(sessionId);
  try {
    if (existing?.state === "running") await stopJob(existing.id);
    if (
      getChatState(sessionId).revision !== state.revision ||
      !approved(getChatState(sessionId))
    )
      throw new Error(
        "The criteria changed while the previous search stopped. Review the current draft first.",
      );
    const response = await jsonRequest("/api/jobs", {
      sessionId,
      criteriaApproved: true,
      title,
      criteriaText: state.criteriaText,
      definition: state.definition,
      ...(broader && state.backendRunId
        ? { backendRunId: state.backendRunId }
        : {}),
    });
    const job = response.job as JobSnapshot;
    updateChatState(sessionId, {
      jobId: job.id,
      jobContext: {
        id: job.id,
        revision: state.revision,
        turnId,
        messageId,
        startedAt: job.startedAt,
      },
    });
    saveArtifact(
      sessionId,
      {
        ...artifactBase("Finding companies"),
        type: "job",
        jobId: job.id,
        state: job.state,
        detail:
          "A background job runs working tools. External providers are off.",
      },
      turnId,
    );
    syncJob(job);
    if (getChatState(sessionId).revision !== state.revision)
      await stopJob(job.id);
    return job;
  } finally {
    starting.delete(sessionId);
  }
}
export async function stopJob(id: string): Promise<void> {
  const result = await jsonRequest(
    `/api/jobs/${encodeURIComponent(id)}/cancel`,
    {},
  );
  syncJob(result.job as JobSnapshot);
  for (
    let attempt = 0;
    getJob(id)?.state === "running" && attempt < 50;
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const update = await jsonRequest(`/api/jobs/${encodeURIComponent(id)}`);
    syncJob(update.job as JobSnapshot);
  }
  if (getJob(id)?.state === "running")
    throw new Error(
      "The previous search is still stopping. Wait for its stopped state before starting another search.",
    );
}
export async function refreshJobs(): Promise<void> {
  const knownBeforeRequest = new Set(
    sessionStore
      .getSnapshot()
      .sessions.map((session) => getChatState(session.id).jobId)
      .filter(Boolean),
  );
  const result = await jsonRequest("/api/jobs");
  const remote = result.jobs as JobSnapshot[];
  remote.forEach(syncJob);
  for (const session of sessionStore.getSnapshot().sessions) {
    const state = getChatState(session.id);
    if (
      state.jobId &&
      knownBeforeRequest.has(state.jobId) &&
      !remote.some((j) => j.id === state.jobId) &&
      !session.events.some(
        (e) => e.kind === "message" && e.jobId === state.jobId,
      )
    ) {
      const prior = getJob(state.jobId);
      for (const event of session.events.filter(
        (e) =>
          e.jobId === state.jobId &&
          e.kind === "tool" &&
          e.status === "running",
      ))
        sessionStore.finishTool(
          event.id,
          null,
          "cancelled",
          "Local server restarted; finish not recorded",
          null,
        );
      syncJob({
        id: state.jobId,
        sessionId: session.id,
        state: "error",
        startedAt:
          prior?.startedAt ??
          state.jobContext?.startedAt ??
          session.events.find((e) => e.jobId === state.jobId)?.startedAt ??
          session.createdAt,
        events: [],
        error:
          "The local server restarted. Running jobs cannot resume; saved saved checkpoints remain available. Tool finish times were not recorded.",
      });
    }
  }
  lastPollError = "";
}
export function getJobsConnectionError(): string {
  return lastPollError;
}
export function startJobPolling(): () => void {
  const client = Symbol("job-poller");
  pollClients.add(client);
  const generation = pollClients.size === 1 ? ++pollGeneration : pollGeneration;
  const tick = async () => {
    if (generation !== pollGeneration || !pollClients.size) return;
    try {
      await refreshJobs();
    } catch {
      lastPollError = "The local tool server is unavailable. Reconnecting…";
      subscribers.forEach((fn) => fn());
    }
    if (pollClients.size > 0 && generation === pollGeneration)
      polling = setTimeout(
        tick,
        [...jobs.values()].some((j) => j.state === "running") ? 250 : 1500,
      );
  };
  if (pollClients.size === 1) void tick();
  return () => {
    if (!pollClients.delete(client)) return;
    if (!pollClients.size) {
      pollGeneration++;
      if (polling) clearTimeout(polling);
    }
  };
}
export async function waitForJob(
  id: string,
  signal: AbortSignal,
): Promise<void> {
  while (getJob(id)?.state === "running") {
    if (signal.aborted)
      throw new DOMException(
        "Conversation detached from the background job.",
        "AbortError",
      );
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
  }
}
