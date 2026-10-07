import type {
  AttachmentAdapter,
  ChatModelAdapter,
  ThreadAssistantMessagePart,
  ThreadMessageLike,
} from "@assistant-ui/react";
import type {
  ArtifactAction,
  ChatArtifact,
  ResearchStep,
  ChatState,
} from "./chat-contract";
import {
  approved,
  artifactBase,
  getChatState,
  mirrorWorkspace,
  patchArtifact,
  saveArtifact,
  updateChatState,
} from "./chat-store";
import {
  artifactPart,
  getJob,
  jobContent,
  startDiscovery,
  stopJob,
  toolLabels,
} from "./chat-jobs";
import {
  draftCriteria,
  discoveryRequest,
  nextStepsRequest,
  providerRequestMode,
  exampleCriteria,
  exampleDefinition,
  screeningDiagram,
  nextStepOptions as options,
  recommendedStep,
  nextStepRecommendations,
  consideredCompanies,
} from "./chat-policy";
import { sessionStore } from "./session-store";
import { attachmentAccept, attachmentError } from "./attachment-policy";
import { plural } from "./format";
import {
  callTool,
  stageUploads,
  type ToolResult,
} from "./tool-client";

import { companyDataRows, refreshCompanyContext } from "./company-data-client";
import { processStagedUploads } from "./import-pipeline";
import { approveDurableCriteria, persistCriteriaDraft, flushCriteriaDraft, refreshShortlist } from "./review-client";
import { askProvider, generateDraft } from "./conversation-client";

type Part = ThreadAssistantMessagePart;
export function transcriptFor(sessionId: string): ThreadMessageLike[] {
  const state = getChatState(sessionId);
  const events =
    sessionStore.getSnapshot().sessions.find((s) => s.id === sessionId)
      ?.events ?? [];
  const messages = new Map<string, ThreadMessageLike>();
  for (const event of events.filter((e) => (e.kind === "message" || (e.kind === "system" && (e.result as Record<string, unknown> | undefined)?.chatAction === true)) && e.role)) {
    const id = event.messageId ?? event.id;
    if (state.branchMessageIds.length && !state.branchMessageIds.includes(id))
      continue;
    messages.set(id, {
      id,
      role: event.role!,
      ...((event.result as Record<string, unknown> | undefined)?.chatAction === true ? { metadata: { custom: (event.result as Record<string, unknown>).custom as Record<string, unknown> } } : {}),
      createdAt: new Date(event.startedAt),
      content: Array.isArray(event.content)
        ? (event.content as ThreadMessageLike["content"])
        : (event.text ?? ""),
    });
  }
  if (!state.branchMessageIds.length) return [...messages.values()];
  return state.branchMessageIds.flatMap((id) =>
    messages.has(id) ? [messages.get(id)!] : [],
  );
}
/** Messages saved by workspace actions must also reach the mounted chat.
 * Streaming stays owned by its adapter; inactive branches stay hidden. */
export function pendingWorkspaceMessages(
  sessionId: string,
  knownIds: Iterable<string>,
): ThreadMessageLike[] {
  const known = new Set(knownIds);
  const events =
    sessionStore.getSnapshot().sessions.find((s) => s.id === sessionId)
      ?.events ?? [];
  const workspaceIds = new Set(
    events
      .filter(
        (event) =>
          event.kind === "message" &&
          event.role === "assistant" &&
          event.origin === "workspace",
      )
      .map((event) => event.messageId ?? event.id),
  );
  return transcriptFor(sessionId).filter(
    (message) =>
      message.id && workspaceIds.has(message.id) && !known.has(message.id),
  );
}
export function criteriaArtifact(
  sessionId: string,
  turnId?: string,
): ChatArtifact {
  const state = getChatState(sessionId);
  const existing = state.artifacts.find(
    (a) => a.type === "criteria" && a.revision === state.revision,
  );
  return (
    existing ??
    saveArtifact(
      sessionId,
      {
        ...artifactBase("Business criteria"),
        type: "criteria",
        criteriaText: state.criteriaText,
        definition: state.definition,
        ignored: state.ignored,
        revision: state.revision,
        goodFitExamples: state.goodFitExamples,
        badFitExamples: state.badFitExamples,
        intakeForm: state.intakeForm,
        draftToken: state.criteriaSaveToken,
        decision: approved(state) ? "approved" : "pending",
      },
      turnId,
    )
  );
}
export function reviseCriteria(
  sessionId: string,
  criteriaText: string,
  definition: string,
  ignored = draftCriteria(criteriaText).ignored,
  criteriaMessageId?: string,
  revisionData?: Pick<ChatState, "intakeForm" | "goodFitExamples" | "badFitExamples">,
): ChatArtifact {
  const old = getChatState(sessionId);
  if (!approved(old) && old.revision && old.criteriaText === criteriaText.trim() && old.definition === definition.trim() && JSON.stringify(old.ignored) === JSON.stringify(ignored) && (!revisionData || (JSON.stringify(old.intakeForm) === JSON.stringify(revisionData.intakeForm) && (old.goodFitExamples ?? "") === (revisionData.goodFitExamples ?? old.goodFitExamples ?? "") && (old.badFitExamples ?? "") === (revisionData.badFitExamples ?? old.badFitExamples ?? "")))) {
    if (criteriaMessageId) updateChatState(sessionId, { criteriaMessageId });
    return criteriaArtifact(sessionId);
  }
  const next = updateChatState(sessionId, {
    criteriaText: criteriaText.trim(),
    definition: definition.trim(),
    ignored,
    revision: old.revision + 1,
    approvedRevision: undefined,
    lastCriteria: old.revision ? { text: old.criteriaText, definition: old.definition, revision: old.revision } : undefined,
    criteriaHistory: [...(old.criteriaHistory ?? []), ...(old.revision ? [{ text: old.criteriaText, definition: old.definition, revision: old.revision, good: old.goodFitExamples ?? "", bad: old.badFitExamples ?? "" }] : [])],
    durableCriteria: undefined,
    criteriaSaveError: undefined,
    criteriaSaveToken: crypto.randomUUID(),
    intakeForm: revisionData ? revisionData.intakeForm : old.intakeForm,
    goodFitExamples: revisionData?.goodFitExamples ?? old.goodFitExamples,
    badFitExamples: revisionData?.badFitExamples ?? old.badFitExamples,
    criteriaMessageId,
  });
  for (const artifact of old.artifacts)
    if (artifact.type === "criteria" && artifact.decision === "pending")
      patchArtifact(sessionId, artifact.id, { decision: "declined" });
  mirrorWorkspace(next);
  void persistCriteriaDraft(sessionId).catch(error => {
    if (getChatState(sessionId).criteriaSaveToken === next.criteriaSaveToken) updateChatState(sessionId, { criteriaSaveError: String(error.message ?? error) });
    sessionStore.addEvent({ sessionId, kind: "system", status: "error", origin: "workspace", title: "Criteria draft could not be saved", text: String(error.message ?? error) });
  });
  return criteriaArtifact(sessionId);
}

/** Save edited inline examples before approving the exact resulting revision. */
export async function approveCriteriaWithExamples(sessionId: string, artifactId: string, good?: string, bad?: string) {
  await flushCriteriaDraft(sessionId);
  const state = getChatState(sessionId);
  const card = state.artifacts.find(item => item.id === artifactId);
  if (card?.type !== "criteria" || card.revision !== state.revision || card.decision !== "pending" || (card.draftToken && card.draftToken !== state.criteriaSaveToken)) throw new Error("Review the latest criteria card.");
  good = (good ?? state.goodFitExamples ?? "").trim();
  bad = (bad ?? state.badFitExamples ?? "").trim();
  let targetId = card.id;
  let targetToken = state.criteriaSaveToken;
  if (good !== (state.goodFitExamples ?? "").trim() || bad !== (state.badFitExamples ?? "").trim()) {
    targetId = reviseCriteria(sessionId, state.criteriaText, state.definition, state.ignored, state.criteriaMessageId, { intakeForm: state.intakeForm, goodFitExamples: good, badFitExamples: bad }).id;
    targetToken = getChatState(sessionId).criteriaSaveToken;
    await flushCriteriaDraft(sessionId);
    if (getChatState(sessionId).criteriaSaveToken !== targetToken) throw new Error("The criteria changed. Review the latest draft again.");
    sessionStore.addEvent({ sessionId, kind: "system", origin: "workspace", status: "success", title: "Criteria examples revised", result: { revision: getChatState(sessionId).revision } });
  }
  if (getChatState(sessionId).criteriaSaveToken !== targetToken) throw new Error("The criteria changed. Review the latest draft again.");
  await approveDurableCriteria(sessionId);
  approveCriteria(sessionId, targetId, artifactId);
  return getChatState(sessionId).artifacts.find(item => item.id === targetId)!;
}

export async function addResearchToCriteria(sessionId: string, answer: string, question: string) {
  const state = getChatState(sessionId);
  if (!answer.trim()) throw new Error("There is no research result to add.");
  const research = `Research question: ${question}\nResearch result (requires analyst review):\n${answer}`;
  const result = await generateDraft(sessionId, "criteria", { request: `Propose revised core-business criteria using this analyst-selected research. Keep unsupported claims and non-business conditions as review notes. Do not treat research leads as verified facts.\n${research}` });
  if (getChatState(sessionId).revision !== state.revision) throw new Error("Criteria changed during this request. Add the answer to the latest criteria instead.");
  const next = reviseCriteria(sessionId, `${state.criteriaText}\n\n${research}`, result.executed && result.text ? result.text : `${state.definition}\n\nAnalyst-selected research to review:\n${answer}`, state.ignored);
  await flushCriteriaDraft(sessionId);
  const messageId = crypto.randomUUID();
  updateChatState(sessionId, current => ({ ...current, branchMessageIds: [...current.branchMessageIds, messageId] }));
  sessionStore.addEvent({ sessionId, messageId, kind: "message", role: "assistant", origin: "workspace", status: "success", title: "Criteria draft updated", text: "The research is in a new criteria draft. Review and approve it before the next search or screening.", content: [{ type: "text", text: "Review the updated criteria before continuing." }, artifactPart(next)] });
}
export function approveCriteria(sessionId: string, artifactId?: string, sourceArtifactId?: string): void {
  const state = getChatState(sessionId);
  const artifact = artifactId
    ? state.artifacts.find((a) => a.id === artifactId)
    : criteriaArtifact(sessionId);
  if (
    artifact?.type !== "criteria" ||
    artifact.revision !== state.revision ||
    artifact.definition !== state.definition ||
    !state.definition.trim()
  )
    throw new Error(
      "This criteria card is out of date or has no business definition. Review the current draft first.",
    );
  if (approved(state)) return;
  sessionStore.addEvent({
    sessionId,
    kind: "approval",
    status: "success",
    origin: "workspace",
    title: "Discovery criteria approved",
    result: {
      mandate: state.criteriaText,
      definition: state.definition,
      revision: state.revision,
      example: "",
      clarification: "",
      artifactId: artifact.id,
      sourceArtifactId: sourceArtifactId ?? artifact.id,
    },
  });
  patchArtifact(sessionId, artifact.id, { decision: "approved" });
  const next = updateChatState(sessionId, { approvedRevision: state.revision });
  mirrorWorkspace(next);
}
function nextOptions(sessionId: string, turnId: string): ChatArtifact {
  const state = getChatState(sessionId);
  return saveArtifact(
    sessionId,
    {
      ...artifactBase("Choose the next step"),
      type: "options",
      recommended: nextStepRecommendations(state).recommended,
      companyCount: consideredCompanies(state).length,
      hydrated: nextStepRecommendations(state).hydrated,
      options,
    },
    turnId,
  );
}
function plannedActions(text: string): ResearchStep[] {
  const matches: { at: number; step: ResearchStep }[] = [];
  for (const [step, pattern] of Object.entries({
    pitchbook: /pitch\s?book/i,
    rogo: /rogo/i,
    bing: /bing|web research/i,
    llm: /llm|llmsuite/i,
    copilot: /m365|copilot/i,
  }) as [ResearchStep, RegExp][]) {
    const match = pattern.exec(text);
    if (match) matches.push({ at: match.index, step });
  }
  return matches.sort((a, b) => a.at - b.at).map((m) => m.step);
}
import { defaultResearchQueries } from "./research-queries";
export function researchQuestions(definition: string): string[] {
  return defaultResearchQueries(definition);
}
export function createFileAdapter(sessionId: string): AttachmentAdapter {
  const stagedFiles = new WeakMap<File, import("./chat-contract").StagedFile>();
  return {
    accept: attachmentAccept,
    async add({ file }) {
      const error = attachmentError(file);
      if (error) throw new Error(error);
      {
        const [staged] = await stageUploads([file], { sessionId, purpose: "chat" });
        stagedFiles.set(file, staged);
        return { id: staged.id, name: file.name, file, type: "document", contentType: file.type, status: { type: "requires-action", reason: "composer-send" }, content: [{ type: "data", name: "staged-chat-file", data: { fileId: staged.id } }] };
      }
    },
    async remove() {},
    async send(attachment, { signal } = {}) {
      const cached = stagedFiles.get(attachment.file);
      if (cached) return { ...attachment, id: cached.id, status: { type: "complete" }, content: [{ type: "data", name: "staged-chat-file", data: { fileId: cached.id } }] };
      const [file] = await stageUploads([attachment.file], {
        sessionId,
        signal,
        purpose: "chat",
      });
      const artifact = getChatState(sessionId).artifacts.find(
        (a) => a.type === "file" && a.file.id === file.id,
      )!;
      return {
        ...attachment,
        id: file.id,
        status: { type: "complete" },
        content: [
          {
            type: "data",
            name: "screening-artifact",
            data: { artifactId: artifact.id },
          },
        ],
      };
    },
  };
}
export function createChatAdapter(
  sessionId: string,
  callbacks: { openLog: () => void; title: () => string },
): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal, unstable_assistantMessageId }) {
      const user = messages.at(-1)!;
      const text = user.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
      const turnId = crypto.randomUUID();
      const messageId = unstable_assistantMessageId ?? crypto.randomUUID();
      const action = user.metadata.custom.artifactAction as
        | ArtifactAction
        | undefined;
      const attachmentParts =
        user.role === "user" ? user.attachments.flatMap((a) => a.content) : [];
      const content: Part[] = [];
      const prior = getChatState(sessionId);
      const ancestors = messages.slice(0, -1).map((m) => m.id);
      const editingEarlier =
        prior.branchMessageIds.length > ancestors.length &&
        !prior.branchMessageIds.includes(user.id);
      if (
        editingEarlier &&
        prior.criteriaMessageId &&
        !ancestors.includes(prior.criteriaMessageId)
      ) {
        if (getJob(prior.jobId)?.state === "running")
          await stopJob(prior.jobId!);
        reviseCriteria(
          sessionId,
          prior.criteriaText,
          prior.definition,
          prior.ignored,
          user.id,
        );
        await flushCriteriaDraft(sessionId);
        sessionStore.addEvent({
          sessionId,
          turnId,
          kind: "system",
          status: "success",
          origin: "workspace",
          title: "Edited message changed the criteria history",
          text: "Criteria approval was cleared. Review the current draft before searching.",
        });
      }
      updateChatState(sessionId, {
        branchMessageIds: [...messages.map((m) => m.id), messageId],
      });
      sessionStore.addEvent({
        sessionId,
        turnId,
        messageId: user.id,
        kind: user.metadata.custom.hidden === true ? "system" : "message",
        role: "user",
        ...(user.metadata.custom.hidden === true ? { result: { chatAction: true, custom: user.metadata.custom } } : {}),
        origin: "assistant",
        status: "success",
        title: user.metadata.custom.hidden === true ? "Screening action" : "Your message",
        text,
        content: [...user.content, ...attachmentParts],
      });
      const begun = new Date().toISOString();
      let jobId: string | undefined;
      const pending = new Set<string>();
      const add = (artifact: ChatArtifact) =>
        content.push(artifactPart(artifact));
      const tool = async (
        name: string,
        args: ToolResult,
      ): Promise<ToolResult> => {
        if (abortSignal.aborted)
          throw new DOMException("Stopped", "AbortError");
        const receipt = sessionStore.startTool(name, args, {
          sessionId,
          turnId,
          origin: "assistant",
          title: toolLabels[name] ?? name,
        });
        const index = content.length;
        pending.add(receipt);
        content.push({
          type: "tool-call",
          toolName: name,
          toolCallId: receipt,
          args: args as Extract<Part, { type: "tool-call" }>["args"],
          argsText: JSON.stringify(args),
        });
        try {
          const result = await callTool(name, args, { signal: abortSignal });
          sessionStore.finishTool(receipt, result);
          pending.delete(receipt);
          content[index] = {
            ...(content[index] as Extract<Part, { type: "tool-call" }>),
            result,
          };
          return result;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sessionStore.finishTool(
            receipt,
            null,
            abortSignal.aborted ? "cancelled" : "error",
            message,
          );
          pending.delete(receipt);
          content[index] = {
            ...(content[index] as Extract<Part, { type: "tool-call" }>),
            result: { error: message },
            isError: true,
          };
          throw error;
        }
      };
      try {
        let state = getChatState(sessionId);
        const submittedFiles = [...attachmentParts
          .flatMap((p) =>
            p.type === "data" && p.name === "screening-artifact"
              ? [
                  state.artifacts.find(
                    (a) =>
                      a.id === (p.data as { artifactId: string }).artifactId,
                  ),
                ]
              : [],
          )
          .filter(
            (a): a is Extract<ChatArtifact, { type: "file" }> =>
              a?.type === "file",
          )
          .map((a) => a.file), ...attachmentParts.flatMap(part => part.type === "data" && ["staged-chat-file", "staged-company-file"].includes(part.name) ? state.files.filter(file => file.id === (part.data as { fileId: string }).fileId) : [])];
        const tabular = submittedFiles.filter((f) => f.importable);
        if (action?.type === "approve-criteria") {
          const card = await approveCriteriaWithExamples(sessionId, action.artifactId, action.good, action.bad);
          if (card.id !== action.artifactId) {
            const criteriaMessageId = crypto.randomUUID();
            updateChatState(sessionId, current => ({ ...current, branchMessageIds: [...current.branchMessageIds, criteriaMessageId] }));
            sessionStore.addEvent({ sessionId, messageId: criteriaMessageId, kind: "message", role: "assistant", origin: "workspace", status: "success", title: "Approved criteria", content: [artifactPart(card)] });
          }
          state = getChatState(sessionId);
          jobId = (await startDiscovery(sessionId, callbacks.title(), turnId, messageId)).id;
        } else if (
          /^\/example$|^(?:start|run)(?: the)? (?:local |screening )?example$/i.test(
            text,
          )
        ) {
          if (getJob(state.jobId)?.state === "running")
            await stopJob(state.jobId!);
          add(
            state.criteriaMessageId === user.id && state.criteriaText
              ? criteriaArtifact(sessionId, turnId)
              : reviseCriteria(
                  sessionId,
                  exampleCriteria,
                  exampleDefinition,
                  [],
                  user.id,
                ),
          );
          await flushCriteriaDraft(sessionId);
          content.push({
            type: "text",
            text: "This example searches fictional MID data. Review and approve the criteria before discovery. ISCC and model services are disconnected.",
          });
        } else if (
          /^\/export$|^(?:show|open)(?: the)? session log$/i.test(text)
        ) {
          callbacks.openLog();
          content.push({
            type: "text",
            text: "The session log includes tool history, timings, and downloads. ZIP keeps original files.",
          });
        } else if (
          /^\/criteria$|^(?:review|show)(?: the)? criteria$/i.test(text)
        ) {
          if (state.criteriaText) add(criteriaArtifact(sessionId, turnId));
          else
            content.push({
              type: "text",
              text: "Describe the core business or attach an Intake Form. Review the draft before discovery.",
            });
        } else if (
          /^\/(?:companies|data|review)$|^(?:show|review)(?: the)? (?:companies|company data|shortlist)$/i.test(text)
        ) {
          if (state.backendRunId) {
            await refreshShortlist(sessionId, state.backendRunId);
            const rows = await refreshCompanyContext(sessionId, state.backendRunId);
            const latest = getChatState(sessionId), byId = new Map(latest.companies.map(company => [company.pk, company]));
            const data = companyDataRows(rows).map(row => ({ ...row, Considered: byId.get(String(row.pk))?.considered !== false ? "Yes" : "Hidden" }));
            add(saveArtifact(sessionId, { ...artifactBase("Review company data"), type: "data-table", rows: data, columns: [...new Set(data.flatMap(row => Object.keys(row)))], reviewable: true, note: "Keep the companies you want to consider. Hidden companies and their data remain saved." }, turnId));
          }
          else
            content.push({
              type: "text",
              text: "Set and approve the criteria, then run a company search.",
            });
        } else if (
          /^\/flow$|^(?:show|explain)(?: the)? (?:flow|process)(?: map)?$/i.test(
            text,
          )
        ) {
          add(
            saveArtifact(
              sessionId,
              {
                ...artifactBase("Screening process"),
                type: "plan",
                diagram: screeningDiagram,
                steps: [
                  {
                    id: "criteria",
                    label: "Review and approve business criteria",
                    status: approved(state) ? "done" : "pending",
                  },
                  {
                    id: "search",
                    label: "Find and combine companies",
                    status: state.companies.length
                      ? "done"
                      : getJob(state.jobId)?.state === "running"
                        ? "running"
                        : "pending",
                  },
                  {
                    id: "data",
                    label: "Choose data or screening",
                    status: "pending",
                    detail:
                      "Every external research step requires an available service and your approval.",
                  },
                  {
                    id: "save",
                    label: "Save progress and export",
                    status: state.backendRunId ? "done" : "pending",
                  },
                ],
              },
              turnId,
            ),
          );
        } else if (
          /^\/checkpoint$|^(?:read|show|restore)(?: the)? (?:checkpoint|saved progress)$/i.test(
            text,
          ) ||
          action?.type === "inspect-checkpoint"
        ) {
          const clicked =
            action?.type === "inspect-checkpoint"
              ? state.artifacts.find((a) => a.id === action.artifactId)
              : undefined;
          const runId =
            clicked?.type === "checkpoint"
              ? clicked.backendRunId
              : action?.type === "inspect-checkpoint"
                ? undefined
                : state.backendRunId;
          if (!runId)
            content.push({
              type: "text",
              text: "A saved checkpoint is saved after the first completed search. This checkpoint card is not available.",
            });
          else {
            const read = tool("get_checkpoint", {
              run_id: runId,
              namespace: "screening-ui",
            });
            yield { content: [...content] };
            const result = await read;
            content.push({
              type: "text",
              text: `Saved checkpoint:\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
            });
          }
        } else if (
          /^\/memory$|^(?:show|read)(?: the)? (?:memory|company context)$/i.test(
            text,
          ) ||
          /^@/.test(text) ||
          action?.type === "inspect-company"
        ) {
          const clicked =
            action?.type === "inspect-company"
              ? state.artifacts.find((a) => a.id === action.artifactId)
              : undefined;
          const list = clicked?.type === "companies" ? clicked.companies : state.companies;
          const target =
            action?.type === "inspect-company"
              ? action.companyId
              : text.startsWith("@")
                ? text.slice(1).split(/\s/)[0]
                : undefined;
          const company = target ? list.find((c) => c.pk === target) : consideredCompanies(state)[0];
          const runId =
            clicked?.type === "companies"
              ? clicked.backendRunId
              : state.backendRunId;
          if (
            !company ||
            !runId ||
            (action?.type === "inspect-company" &&
              clicked?.type !== "companies" && clicked?.type !== "data-table")
          )
            content.push({
              type: "text",
              text: target
                ? "That company is not in this saved company list. Choose a company from a result card or the @ menu."
                : "Company context becomes available after a search. Use @ to reference a saved company.",
            });
          else {
            const read = tool("get_company_context", {
              run_id: runId,
              company_id: company.pk,
              sections: ["core", "description", "identifiers", "enrichment"],
              max_chars: 12000,
            });
            yield { content: [...content] };
            const result = await read;
            add(
              saveArtifact(
                sessionId,
                {
                  ...artifactBase(company.name),
                  type: "memory",
                  entries: [
                    {
                      title: "Business description",
                      text: company.description || "Description not supplied.",
                      source: company.enrichment?.PB_Description
                        ? "PitchBook description · imported company data"
                        : "MID description · saved local data",
                      companyId: company.pk,
                    },
                    {
                      title: "Full company context",
                      text: JSON.stringify(result, null, 2),
                      source: "Saved company context",
                      companyId: company.pk,
                    },
                  ],
                },
                turnId,
              ),
            );
          }
        } else if (
          !action && !discoveryRequest.test(text) && !nextStepsRequest.test(text) && ((state.model !== "local" && !text.startsWith("/") && !/^(?:find|update|revise|change)\s+(?:the\s+)?criteria/i.test(text)) || /^\/(?:llm|copilot|screen)(?:\s|$)|\b(?:ask|screen|screening|question|evaluate|analyse|analyze)\b[\s\S]*\b(?:llmsuite|llm suite|llm|m365|copilot)\b|\b(?:llmsuite|llm suite|llm|m365|copilot)\b[\s\S]*\?/i.test(
            text,
          )) &&
          !/\b(?:populate|upload|add)\b[\s\S]{0,35}\b(?:pitch\s?book|rogo)\b|\b(?:run|do)\s+(?:a\s+)?(?:bing|web research)\b/i.test(
            text,
          )
        ) {
          const providers: ("copilot" | "llm_suite")[] = [];
          if (/\bllm(?:\s?suite)?\b|^\/screen/i.test(text))
            providers.push("llm_suite");
          if (/m365|copilot/i.test(text)) providers.push("copilot");
          if (!providers.length) providers.push(state.model === "copilot" ? "copilot" : "llm_suite");
          const mode = providerRequestMode(text);
          const request = text
            .replace(/^\/(?:llm|copilot|screen)\s*/i, "")
            .trim();
          if (mode === "question") {
            for (const provider of providers) {
              if (!request) {
                updateChatState(sessionId, { model: provider });
                content.push({ type: "text", text: `Use ${provider === "llm_suite" ? "LLM Suite" : "M365 Copilot"} for a question in the message box. Attached files are included unless you turn them off.` });
              } else {
                const response = await askProvider(sessionId, provider, request, submittedFiles, `${user.id}-${provider}`);
                content.push({ type: "text", text: response.text ?? response.message ?? "The service has no answer yet." });
                if (response.executed && response.text) add(saveArtifact(sessionId, { ...artifactBase("Use this answer"), type: "research-answer", provider: provider === "llm_suite" ? "LLM Suite" : "M365 Copilot", question: request, answer: response.text }, turnId));
                if (!response.executed) add(saveArtifact(sessionId, { ...artifactBase(provider === "llm_suite" ? "LLM Suite" : "M365 Copilot"), type: "handoff", service: provider === "llm_suite" ? "LLM Suite" : "M365 Copilot", state: "unavailable", detail: "Not sent: provider not connected." }, turnId));
              }
            }
          } else {
          for (const provider of providers)
            add(
              saveArtifact(
                sessionId,
                {
                  ...artifactBase(
                    mode === "screening"
                      ? "Prepare screening"
                      : "Prepare a question",
                  ),
                  type: "screening-request",
                  provider,
                  mode,
                  request,
                },
                turnId,
              ),
            );
          content.push({
            type: "text",
            text: "Review the inputs, prompt, and output columns before starting batch screening.",
          });
          }
        } else if (
          action?.type === "choose-option" ||
          (/\b(?:populate|add|run|research)\b|^\/bing\b/i.test(text) &&
            plannedActions(text).length)
        ) {
          const actions =
            action?.type === "choose-option"
              ? [action.option]
              : plannedActions(text);
          if (action?.type === "choose-option") {
            const card = state.artifacts.find(
              (a) => a.id === action.artifactId,
            );
            if (card?.type === "options")
              patchArtifact(sessionId, card.id, {
                selected: [
                  ...new Set([...(card.selected ?? []), action.option]),
                ],
              });
          }
          sessionStore.addEvent({
            sessionId,
            turnId,
            kind: "approval",
            status: "success",
            origin: "workspace",
            title: "Next step selected",
            result: {
              actions,
              artifactId: action?.artifactId,
              externalExecution: false,
            },
          });
          for (const step of actions) {
            if (step === "llm" || step === "copilot")
              add(
                saveArtifact(
                  sessionId,
                  {
                    ...artifactBase(
                      step === "llm" ? "LLM Suite screening" : "M365 Copilot screening",
                    ),
                    type: "screening-request",
                    provider: step === "llm" ? "llm_suite" : "copilot",
                    mode: "screening",
                    request: text,
                  },
                  turnId,
                ),
              );
            else if (step === "bing")
              add(
                saveArtifact(
                  sessionId,
                  {
                    ...artifactBase("Bing research questions"),
                    type: "research",
                    questions: researchQuestions(
                      state.definition || "the approved business criteria",
                    ),
                    state: "draft",
                    companies: consideredCompanies(state).map((c) => ({
                      name: c.name,
                      website: c.pbWebsite || c.website,
                    })),
                  },
                  turnId,
                ),
              );
            else
              add(
                saveArtifact(
                  sessionId,
                  {
                    ...artifactBase(options.find((o) => o.id === step)!.label),
                    type: "enrichment-upload",
                    source: step as "pitchbook" | "rogo",
                    files: [],
                  },
                  turnId,
                ),
              );
          }
        } else if (
          nextStepsRequest.test(text) &&
          state.companies.length
        ) {
          add(nextOptions(sessionId, turnId));
        } else if (
          discoveryRequest.test(text)
        ) {
          if (!approved(state)) {
            if (state.criteriaText) add(criteriaArtifact(sessionId, turnId));
            content.push({
              type: "text",
              text: "Review and approve the current criteria before searching.",
            });
          } else
            jobId = (
              await startDiscovery(
                sessionId,
                callbacks.title(),
                turnId,
                messageId,
                /more|again|broaden/i.test(text),
              )
            ).id;
        } else if (
          submittedFiles.length &&
          !text &&
          !submittedFiles.some((f) => f.excerpt)
        ) {
          content.push({
            type: "text",
            text: `Saved ${plural(submittedFiles.length, "file", "files")}. ${tabular.length ? "Run discovery before adding enrichment data." : "Open an Intake Form PDF to pre-fill fields by label, then check each field. Full parsing is deferred. Use a UTF-8 TXT file or describe the business to prepare a draft."}`,
          });
        } else if (text.startsWith("/")) {
          content.push({
            type: "text",
            text: "Choose a supported command from the / menu. For criteria, type a description of the core business.",
          });
        } else if (
          submittedFiles.length &&
          state.criteriaText &&
          !/^(?:find|screen|look for|identify|target|update|revise|change)\b/i.test(
            text,
          )
        ) {
          content.push({
            type: "text",
            text: `Saved ${plural(submittedFiles.length, "supporting file", "supporting files")}. Criteria and companies are unchanged. Preview PDFs from their cards. Edit criteria to change the search.`,
          });
        } else {
          const input =
            text || submittedFiles.find((f) => f.excerpt)?.excerpt || "";
          if (input) {
            if (getJob(state.jobId)?.state === "running")
              await stopJob(state.jobId!);
            const draft = draftCriteria(input);
            const samePrompt =
              state.criteriaMessageId === user.id &&
              state.criteriaText === input;
            add(
              samePrompt
                ? criteriaArtifact(sessionId, turnId)
                : reviseCriteria(
                    sessionId,
                    input,
                    draft.definition,
                    draft.ignored,
                    user.id,
                  ),
            );
            if (!samePrompt) await flushCriteriaDraft(sessionId);
            content.push({
              type: "text",
              text:
                samePrompt && approved(state)
                  ? "The criteria are unchanged. Your previous approval still applies."
                  : draft.definition
                  ? "Review the draft, edit the core business if needed, and approve the search. Size, financials, geography, ownership, and industry codes are review details, not search filters."
                  : "Describe the products, services, and customer workflows you want to find.",
            });
          }
        }
        if (jobId) {
          while (getJob(jobId)?.state === "running") {
            if (abortSignal.aborted) return; // Detach the conversation; the server job keeps running.
            yield { content: jobContent(getJob(jobId)!) };
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
          const job = getJob(jobId)!;
          yield {
            content: jobContent(job),
            ...(job.state === "error"
              ? {
                  status: {
                    type: "incomplete" as const,
                    reason: "error" as const,
                    error: job.error ?? "Search failed",
                  },
                }
              : {}),
          };
          return;
        }
        if (!content.length)
          content.push({
            type: "text",
            text: "Describe the core business, upload a file, or use / to choose a step.",
          });
        yield { content: [...content] };
        sessionStore.addEvent({
          sessionId,
          turnId,
          messageId,
          kind: "message",
          role: "assistant",
          origin: "assistant",
          status: "success",
          title: "Assistant response",
          text: content
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n"),
          content,
          startedAt: begun,
          finishedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (abortSignal.aborted && jobId) return;
        const message = error instanceof Error ? error.message : String(error);
        for (const id of pending)
          sessionStore.finishTool(
            id,
            null,
            abortSignal.aborted ? "cancelled" : "error",
            message,
          );
        content.push({
          type: "text",
          text: abortSignal.aborted
            ? "Reply stopped. Completed work remains saved."
            : `Could not complete this step: ${message}`,
        });
        sessionStore.addEvent({
          sessionId,
          turnId,
          messageId,
          kind: "message",
          role: "assistant",
          origin: "assistant",
          status: abortSignal.aborted ? "cancelled" : "error",
          title: "Step interrupted",
          text: message,
          content,
          error: message,
          startedAt: begun,
          finishedAt: new Date().toISOString(),
        });
        if (!abortSignal.aborted)
          yield {
            content: [...content],
            status: { type: "incomplete", reason: "error", error: message },
          };
      }
    },
  };
}

/** Used only for programmatic sends; the analyst's typed messages bypass it. */
export function hiddenActionMetadata(text: string, action?: ArtifactAction) {
  const artifactAction = action ?? { type: "command" as const, artifactId: "" };
  const commands: Record<string, string> = { "/criteria": "Opened criteria", "/plan": "Opened next steps", "/review": "Opened company review", "/example": "Tried the example", "/checkpoint": "Opened checkpoint", "/bing": "Opened Bing research" };
  const label = artifactAction.type === "command" && artifactAction.label ? artifactAction.label : commands[text] ?? text.replace(/^Choose /, "Chose ");
  return { hidden: true, artifactAction, label };
}
