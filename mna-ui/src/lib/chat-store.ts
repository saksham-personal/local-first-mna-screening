import { useSyncExternalStore } from "react";
import type { ChatArtifact, ChatState } from "./chat-contract";
import { sessionStore } from "./session-store";

const states = new Map<string, ChatState>();
const listeners = new Set<() => void>();
const key = (id: string) => `screening-chat-v1:${id}`;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((x) => typeof x === "string");
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function validSetupConfig(value: unknown): boolean {
  if (!record(value) || !record(value.identitySources)) return false;
  return (
    ["llm_suite", "copilot"].includes(String(value.provider)) &&
    ["screening", "question"].includes(String(value.mode)) &&
    typeof value.model === "string" &&
    !!value.model.trim() &&
    value.model.length <= 160 &&
    typeof value.prompt === "string" &&
    !!value.prompt.trim() &&
    value.prompt.length <= 60_000 &&
    count(value.batchSize) &&
    value.batchSize >= 1 &&
    value.batchSize <= 100 &&
    ["inputColumns", "outputColumns"].every((key) => {
      const columns = value[key];
      return (
        strings(columns) &&
        columns.length >= 1 &&
        columns.length <= 100 &&
        columns[0] === "index" &&
        columns.every((name) => !!name.trim() && name.length <= 160) &&
        new Set(columns.map((name) => name.toLowerCase())).size ===
          columns.length
      );
    }) &&
    ["name", "website", "description"].every((key) => {
      const sources = (value.identitySources as Record<string, unknown>)[key];
      return (
        strings(sources) &&
        sources.every((source) => ["PB", "MID", "ISCC"].includes(source)) &&
        new Set(sources).size === sources.length
      );
    })
  );
}
function validCompany(value: unknown): boolean {
  return (
    record(value) &&
    ["pk", "name", "website", "city", "state", "description"].every(
      (k) => typeof value[k] === "string",
    ) &&
    ["MID", "ISCC", "both"].includes(String(value.source)) &&
    strings(value.tags) &&
    ["midScore", "isccScore", "screeningScore"].every(
      (k) =>
        value[k] === undefined ||
        (typeof value[k] === "number" && Number.isFinite(value[k])),
    )
  );
}
function validFile(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id) &&
    typeof value.name === "string" &&
    count(value.bytes) &&
    typeof value.kind === "string"
  );
}
function validArtifact(value: unknown): boolean {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    return false;
  if (
    ["note", "detail", "importStatus"].some(
      (k) => value[k] !== undefined && typeof value[k] !== "string",
    )
  )
    return false;
  switch (value.type) {
    case "screening-request":
      return (
        ["llm_suite", "copilot"].includes(String(value.provider)) &&
        ["screening", "question"].includes(String(value.mode)) &&
        typeof value.request === "string"
      );
    case "screening-setup": {
      const prepared = value.prepared;
      return (
        record(prepared) &&
        typeof prepared.id === "string" &&
        typeof prepared.title === "string" &&
        typeof prepared.savedAt === "string" &&
        Number.isFinite(Date.parse(prepared.savedAt)) &&
        typeof prepared.fingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(prepared.fingerprint) &&
        prepared.executed === false &&
        prepared.status === "prepared" &&
        ["llm_suite", "copilot"].includes(String(prepared.provider)) &&
        ["screening", "question"].includes(String(prepared.mode)) &&
        typeof prepared.model === "string" &&
        count(prepared.companyCount) &&
        count(prepared.batches) &&
        record(prepared.config) &&
        validSetupConfig(prepared.config) &&
        prepared.config.provider === prepared.provider &&
        prepared.config.mode === prepared.mode &&
        prepared.config.model === prepared.model &&
        ((prepared.schemaVersion === 2 && typeof prepared.planId === "string" && Array.isArray(prepared.jobs)) ||
          (record(prepared.checkpoint) && typeof prepared.checkpoint.runId === "string" && typeof prepared.checkpoint.namespace === "string" && count(prepared.checkpoint.sequence) && prepared.checkpoint.sequence >= 1))
      );
    }
    case "file":
      return validFile(value.file);
    case "data-table":
      return Array.isArray(value.rows) && value.rows.every(record) && strings(value.columns) && (value.planId === undefined || typeof value.planId === "string");
    case "criteria":
      return (
        typeof value.criteriaText === "string" &&
        typeof value.definition === "string" &&
        strings(value.ignored) &&
        count(value.revision) &&
        ["pending", "approved", "declined"].includes(String(value.decision))
      );
    case "companies":
      return (
        Array.isArray(value.companies) &&
        value.companies.every(validCompany) &&
        record(value.counts) &&
        ["midOnly", "isccOnly", "both"].every((k) =>
          count((value.counts as Record<string, unknown>)[k]),
        ) &&
        typeof value.backendRunId === "string"
      );
    case "options":
      return (
        ["pitchbook", "rogo", "llm", "copilot", "bing"].includes(
          String(value.recommended),
        ) &&
        (value.selected === undefined || strings(value.selected)) &&
        (value.dismissed === undefined ||
          typeof value.dismissed === "boolean") &&
        Array.isArray(value.options) &&
        value.options.every(
          (o) =>
            record(o) &&
            ["pitchbook", "rogo", "llm", "copilot", "bing"].includes(
              String(o.id),
            ) &&
            typeof o.label === "string" &&
            typeof o.description === "string" &&
            typeof o.available === "boolean",
        )
      );
    case "plan":
      return (
        typeof value.diagram === "string" &&
        Array.isArray(value.steps) &&
        value.steps.every(
          (s) =>
            record(s) &&
            typeof s.id === "string" &&
            typeof s.label === "string" &&
            (s.detail === undefined || typeof s.detail === "string") &&
            ["pending", "running", "done", "error"].includes(String(s.status)),
        )
      );
    case "research":
      return (
        strings(value.questions) &&
        ["draft", "unavailable", "completed"].includes(String(value.state)) &&
        (value.companies === undefined ||
          (Array.isArray(value.companies) &&
            value.companies.every(
              (c) =>
                record(c) &&
                typeof c.name === "string" &&
                typeof c.website === "string",
            )))
      );
    case "memory":
      return (
        Array.isArray(value.entries) &&
        value.entries.every(
          (e) =>
            record(e) &&
            typeof e.title === "string" &&
            typeof e.text === "string" &&
            typeof e.source === "string",
        )
      );
    case "job":
      return (
        typeof value.jobId === "string" &&
        ["running", "completed", "cancelled", "error"].includes(
          String(value.state),
        )
      );
    case "checkpoint":
      return (
        typeof value.key === "string" &&
        typeof value.backendRunId === "string" &&
        typeof value.summary === "string"
      );
    case "handoff":
      return (
        typeof value.service === "string" &&
        typeof value.detail === "string" &&
        ["awaiting-files", "unavailable", "complete"].includes(
          String(value.state),
        )
      );
    default:
      return false;
  }
}
export const emptyCounts = { midOnly: 0, isccOnly: 0, both: 0 };
export function emptyChatState(sessionId: string): ChatState {
  return {
    version: 1,
    sessionId,
    criteriaText: "",
    definition: "",
    revision: 0,
    ignored: [],
    artifacts: [],
    companies: [],
    counts: { ...emptyCounts },
    files: [],
    model: "local",
    branchMessageIds: [],
  };
}
export function getChatState(id: string): ChatState {
  if (states.has(id)) return states.get(id)!;
  let state = emptyChatState(id);
  try {
    const raw =
      typeof localStorage === "undefined"
        ? null
        : localStorage.getItem(key(id));
    if (raw) {
      const parsed = JSON.parse(raw) as ChatState;
      if (
        !record(parsed) ||
        parsed.version !== 1 ||
        parsed.sessionId !== id ||
        typeof parsed.criteriaText !== "string" ||
        typeof parsed.definition !== "string" ||
        !count(parsed.revision) ||
        !Array.isArray(parsed.artifacts) ||
        !parsed.artifacts.every(validArtifact) ||
        !Array.isArray(parsed.files) ||
        !parsed.files.every(validFile) ||
        !Array.isArray(parsed.companies) ||
        !parsed.companies.every(validCompany) ||
        !strings(parsed.ignored) ||
        !strings(parsed.branchMessageIds) ||
        !record(parsed.counts) ||
        !["midOnly", "isccOnly", "both"].every((k) =>
          count(parsed.counts[k as keyof typeof parsed.counts]),
        )
      )
        throw new Error("Invalid saved screening");
      state = parsed;
      const approval = sessionStore
        .getSnapshot()
        .sessions.find((s) => s.id === id)
        ?.events.filter(
          (e) =>
            e.kind === "approval" && e.title === "Discovery criteria approved",
        )
        .at(-1)?.result as
        | { revision?: number; mandate?: string; definition?: string }
        | undefined;
      if (
        state.approvedRevision !== state.revision ||
        approval?.revision !== state.revision ||
        approval.mandate !== state.criteriaText ||
        approval.definition !== state.definition
      )
        state = { ...state, approvedRevision: undefined };
    }
  } catch {
    sessionStore.addEvent({
      sessionId: id,
      kind: "system",
      origin: "system",
      status: "error",
      title: "Saved chat could not be restored",
      text: "The session log is still available. Set and approve the criteria again before searching.",
    });
  }
  states.set(id, state);
  return state;
}
export function updateChatState(
  id: string,
  change: Partial<ChatState> | ((current: ChatState) => ChatState),
): ChatState {
  const before = getChatState(id);
  const next =
    typeof change === "function" ? change(before) : { ...before, ...change };
  states.set(id, next);
  try {
    if (typeof localStorage !== "undefined")
      localStorage.setItem(key(id), JSON.stringify(next));
  } catch {
    sessionStore.addEvent({
      sessionId: id,
      kind: "system",
      status: "error",
      origin: "system",
      title: "Chat changes could not be saved",
      text: "Browser storage is full. Export this session to keep a copy.",
    });
  }
  listeners.forEach((fn) => fn());
  return next;
}
export function useChatState(id: string): ChatState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => getChatState(id),
    () => getChatState(id),
  );
}
export function saveArtifact(
  sessionId: string,
  artifact: ChatArtifact,
  turnId?: string,
): ChatArtifact {
  updateChatState(sessionId, (state) => ({
    ...state,
    artifacts: [
      ...state.artifacts.filter((a) => a.id !== artifact.id),
      artifact,
    ],
  }));
  sessionStore.addEvent({
    sessionId,
    turnId,
    kind: "artifact",
    status: "success",
    origin: "assistant",
    title: artifact.title,
    result: artifact,
  });
  return artifact;
}
export function patchArtifact(
  sessionId: string,
  id: string,
  change: Partial<ChatArtifact>,
): void {
  const before = getChatState(sessionId).artifacts.find((a) => a.id === id);
  if (!before) return;
  const after = { ...before, ...change } as ChatArtifact;
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  updateChatState(sessionId, (state) => ({
    ...state,
    artifacts: state.artifacts.map((a) => (a.id === id ? after : a)),
  }));
  sessionStore.addEvent({
    sessionId,
    kind: "artifact",
    status: "success",
    origin: "system",
    title: `${after.title} updated`,
    result: after,
  });
}
export function artifactBase(title: string) {
  return {
    id: crypto.randomUUID(),
    title,
    createdAt: new Date().toISOString(),
  };
}
export function approved(state: ChatState): boolean {
  return (
    state.revision > 0 &&
    state.approvedRevision === state.revision &&
    !!state.definition.trim()
  );
}

/** Keep the alternate table view on the same approved criteria and real results. */
export function mirrorWorkspace(state: ChatState): void {
  if (typeof localStorage === "undefined") return;
  const isApproved = approved(state);
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(
      localStorage.getItem(`screening-workspace-v3:${state.sessionId}`) ||
        "null",
    );
    if (record(parsed)) existing = parsed;
  } catch {
    /* A valid chat state replaces corrupt workspace state. */
  }
  const same =
    existing.mandate === state.criteriaText &&
    existing.definition === state.definition;
  const workspace = {
    ...existing,
    mandate: state.criteriaText,
    definition: state.definition,
    example:
      same && typeof existing.example === "string" ? existing.example : "",
    clarification:
      same && typeof existing.clarification === "string"
        ? existing.clarification
        : "",
    criteriaApproved: isApproved,
    uploads: Array.isArray(existing.uploads) ? existing.uploads : [],
    counts: isApproved ? state.counts : emptyCounts,
    moreRequested:
      same && count(existing.moreRequested) ? existing.moreRequested : 0,
    linkedinOverrides: record(existing.linkedinOverrides)
      ? existing.linkedinOverrides
      : {},
    notes: record(existing.notes) ? existing.notes : {},
    plan: same && Array.isArray(existing.plan) ? existing.plan : [],
    planApproved: same && isApproved && existing.planApproved === true,
    queued: same && isApproved && existing.queued === true,
    bingQuery:
      same && typeof existing.bingQuery === "string" ? existing.bingQuery : "",
    screened: same && isApproved && existing.screened === true,
    stage:
      same &&
      isApproved &&
      ["criteria", "discovery", "enrichment", "screening"].includes(
        String(existing.stage),
      )
        ? existing.stage
        : isApproved
          ? "discovery"
          : "criteria",
  };
  localStorage.setItem(
    `screening-workspace-v3:${state.sessionId}`,
    JSON.stringify(workspace),
  );
  if (state.backendRunId && isApproved)
    localStorage.setItem(
      `screening-executed-v1:${state.sessionId}`,
      JSON.stringify({
        backendRunId: state.backendRunId,
        companies: state.companies,
        counts: state.counts,
        criteriaText: state.criteriaText,
        definition: state.definition,
      }),
    );
  else localStorage.removeItem(`screening-executed-v1:${state.sessionId}`);
}

export function syncWorkspaceIntoChat(sessionId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    const workspace = JSON.parse(
      localStorage.getItem(`screening-workspace-v3:${sessionId}`) || "null",
    );
    if (
      !record(workspace) ||
      typeof workspace.mandate !== "string" ||
      typeof workspace.definition !== "string"
    )
      return;
    let state = getChatState(sessionId);
    if (
      state.criteriaText !== workspace.mandate ||
      state.definition !== workspace.definition ||
      (workspace.criteriaApproved === true) !== approved(state)
    ) {
      const approval = sessionStore
        .getSnapshot()
        .sessions.find((s) => s.id === sessionId)
        ?.events.filter(
          (e) =>
            e.kind === "approval" && e.title === "Discovery criteria approved",
        )
        .at(-1);
      const result = approval?.result as Record<string, unknown> | undefined;
      const validApproval =
        workspace.criteriaApproved === true &&
        result?.mandate === workspace.mandate &&
        result?.definition === workspace.definition &&
        result?.example === workspace.example &&
        result?.clarification === workspace.clarification;
      state = updateChatState(sessionId, {
        criteriaText: workspace.mandate,
        definition: workspace.definition,
        revision: state.revision + 1,
        approvedRevision: undefined,
        companies: [],
        counts: { ...emptyCounts },
        backendRunId: undefined,
        criteriaMessageId: undefined,
      });
      if (validApproval) {
        sessionStore.addEvent({
          sessionId,
          kind: "approval",
          status: "success",
          origin: "workspace",
          title: "Discovery criteria approved",
          result: {
            ...result,
            revision: state.revision,
            sourceApprovalEvent: approval!.id,
          },
          text: "Approval carried over from the table workspace.",
        });
        state = updateChatState(sessionId, {
          approvedRevision: state.revision,
        });
      }
      saveArtifact(sessionId, {
        ...artifactBase("Business criteria"),
        type: "criteria",
        criteriaText: state.criteriaText,
        definition: state.definition,
        revision: state.revision,
        ignored: state.ignored,
        decision: approved(state) ? "approved" : "pending",
      });
    }
    const executed = JSON.parse(
      localStorage.getItem(`screening-executed-v1:${sessionId}`) || "null",
    );
    if (
      approved(state) &&
      record(executed) &&
      executed.criteriaText === state.criteriaText &&
      executed.definition === state.definition &&
      typeof executed.backendRunId === "string" &&
      Array.isArray(executed.companies) &&
      executed.companies.every(validCompany) &&
      record(executed.counts) &&
      ["midOnly", "isccOnly", "both"].every((k) =>
        count((executed.counts as Record<string, unknown>)[k]),
      ) &&
      Object.values(executed.counts).reduce(
        (n: number, value) => n + Number(value),
        0,
      ) === executed.companies.length
    ) {
      const changed =
        state.backendRunId !== executed.backendRunId ||
        JSON.stringify(state.companies) !== JSON.stringify(executed.companies);
      const next = updateChatState(sessionId, {
        backendRunId: executed.backendRunId,
        companies: executed.companies as ChatState["companies"],
        counts: executed.counts as ChatState["counts"],
      });
      if (changed)
        saveArtifact(sessionId, {
          ...artifactBase("Company list updated in workspace"),
          type: "companies",
          companies: next.companies,
          counts: next.counts,
          backendRunId: next.backendRunId!,
        });
    }
  } catch {
    sessionStore.addEvent({
      sessionId,
      kind: "system",
      status: "error",
      origin: "system",
      title: "Workspace changes could not be read",
      text: "Existing chat and session records were retained.",
    });
  }
}
