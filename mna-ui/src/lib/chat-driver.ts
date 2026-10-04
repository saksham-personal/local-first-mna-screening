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
  exampleCriteria,
  exampleDefinition,
  screeningDiagram,
  nextStepOptions as options,
  recommendedStep,
} from "./chat-policy";
import { sessionStore } from "./session-store";
import { attachmentAccept, attachmentError } from "./attachment-policy";
import {
  callTool,
  companyFromRust,
  stageUploads,
  type ToolResult,
} from "./tool-client";

type Part = ThreadAssistantMessagePart;
export function transcriptFor(sessionId: string): ThreadMessageLike[] {
  const state = getChatState(sessionId);
  const events =
    sessionStore.getSnapshot().sessions.find((s) => s.id === sessionId)
      ?.events ?? [];
  const messages = new Map<string, ThreadMessageLike>();
  for (const event of events.filter((e) => e.kind === "message" && e.role)) {
    const id = event.messageId ?? event.id;
    if (state.branchMessageIds.length && !state.branchMessageIds.includes(id))
      continue;
    messages.set(id, {
      id,
      role: event.role!,
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
): ChatArtifact {
  const old = getChatState(sessionId);
  const next = updateChatState(sessionId, {
    criteriaText: criteriaText.trim(),
    definition: definition.trim(),
    ignored,
    revision: old.revision + 1,
    approvedRevision: undefined,
    companies: [],
    counts: { midOnly: 0, isccOnly: 0, both: 0 },
    backendRunId: undefined,
    criteriaMessageId,
  });
  for (const artifact of old.artifacts)
    if (artifact.type === "criteria" && artifact.decision === "pending")
      patchArtifact(sessionId, artifact.id, { decision: "declined" });
  mirrorWorkspace(next);
  return criteriaArtifact(sessionId);
}
export function approveCriteria(sessionId: string, artifactId?: string): void {
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
      recommended: recommendedStep(state.companies.length),
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
export function researchQuestions(definition: string): string[] {
  const business = definition.split(/\bexclude\b/i)[0].replace(/[.\s]+$/, "");
  return [
    `Does {company} provide ${business.toLowerCase()}? Website: {website}`,
    "Which products and customer workflows show that this is a core business for {company}? Website: {website}",
    "Does {company} sell a software product or mainly provide services? Website: {website}",
    "Which primary sources support or contradict the business fit for {company}? Website: {website}",
  ];
}
export function createFileAdapter(sessionId: string): AttachmentAdapter {
  return {
    accept: attachmentAccept,
    async add({ file }) {
      const error = attachmentError(file);
      if (error) throw new Error(error);
      return {
        id: crypto.randomUUID(),
        name: file.name,
        file,
        type: "document",
        contentType: file.type,
        status: { type: "requires-action", reason: "composer-send" },
      };
    },
    async remove() {},
    async send(attachment, { signal } = {}) {
      const [file] = await stageUploads([attachment.file], {
        sessionId,
        signal,
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
        kind: "message",
        role: "user",
        origin: "assistant",
        status: "success",
        title: "Your message",
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
        const submittedFiles = attachmentParts
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
          .map((a) => a.file);
        const tabular = submittedFiles.filter((f) => f.importable);
        if (tabular.length && state.backendRunId && approved(state)) {
          content.push({
            type: "text",
            text: "Importing the uploaded company data and reading the updated company context.",
          });
          const importPromise = tool("import_enrichment_files", {
            run_id: state.backendRunId,
            files: tabular.map((f) => f.id),
          });
          yield { content: [...content] };
          const result = await importPromise;
          const updated = [];
          for (const company of state.companies) {
            const read = tool("get_company", { company_id: company.pk });
            yield { content: [...content] };
            const detail = await read;
            const hydrated = companyFromRust(
              { company: detail, score: company.midScore },
              detail,
              company,
            );
            updated.push({
              ...company,
              ...hydrated,
              source: company.source,
              rawMid: company.rawMid,
              rawIscc: company.rawIscc,
              isccScore: company.isccScore,
            });
          }
          const next = updateChatState(sessionId, { companies: updated });
          mirrorWorkspace(next);
          for (const file of tabular) {
            const fileArtifact = state.artifacts.find(
              (a) => a.type === "file" && a.file.id === file.id,
            );
            if (fileArtifact)
              patchArtifact(sessionId, fileArtifact.id, {
                importStatus: "Imported",
              });
          }
          add(
            saveArtifact(
              sessionId,
              {
                ...artifactBase("Updated company data"),
                type: "companies",
                companies: updated,
                counts: state.counts,
                backendRunId: state.backendRunId,
                note: `${result.mapping_unique_companies ?? 0} PitchBook IDs, ${result.pb_unique_companies ?? 0} PitchBook records, ${result.rogo_unique_companies ?? 0} ROGO records. ${Number(result.pb_unmatched ?? 0) + Number(result.rogo_unmatched ?? 0)} rows could not be matched.`,
              },
              turnId,
            ),
          );
        } else if (
          action?.type === "approve-criteria" ||
          /^(?:approve(?: the)? criteria(?: and (?:find companies|search))?|approve and search)$/i.test(
            text,
          )
        ) {
          approveCriteria(sessionId, action?.artifactId);
          state = getChatState(sessionId);
          jobId = (
            await startDiscovery(
              sessionId,
              callbacks.title(),
              turnId,
              messageId,
            )
          ).id;
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
          content.push({
            type: "text",
            text: "This example uses fictional companies and working tools. Review the business criteria above, then approve the search. MID is available locally; ISCC and model services are not connected.",
          });
        } else if (
          /^\/export$|^(?:show|open)(?: the)? session log$/i.test(text)
        ) {
          callbacks.openLog();
          content.push({
            type: "text",
            text: "The session log has the complete tool history, timings, and download options. ZIP includes original uploaded files.",
          });
        } else if (
          /^\/criteria$|^(?:review|show)(?: the)? criteria$/i.test(text)
        ) {
          if (state.criteriaText) add(criteriaArtifact(sessionId, turnId));
          else
            content.push({
              type: "text",
              text: "Describe the company’s core products or services, or attach your DDI. I’ll show a draft for your review.",
            });
        } else if (
          /^\/companies$|^(?:show|review)(?: the)? companies$/i.test(text)
        ) {
          if (state.backendRunId)
            add(
              saveArtifact(
                sessionId,
                {
                  ...artifactBase("Company list"),
                  type: "companies",
                  companies: state.companies,
                  counts: state.counts,
                  backendRunId: state.backendRunId,
                },
                turnId,
              ),
            );
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
          const list =
            clicked?.type === "companies" ? clicked.companies : state.companies;
          const target =
            action?.type === "inspect-company"
              ? action.companyId
              : text.startsWith("@")
                ? text.slice(1).split(/\s/)[0]
                : undefined;
          const company = target ? list.find((c) => c.pk === target) : list[0];
          const runId =
            clicked?.type === "companies"
              ? clicked.backendRunId
              : state.backendRunId;
          if (
            !company ||
            !runId ||
            (action?.type === "inspect-company" &&
              clicked?.type !== "companies")
          )
            content.push({
              type: "text",
              text: target
                ? "That company is not in this saved company list. Choose a company from an artifact or the @ menu."
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
          /^\/(?:llm|copilot|screen)(?:\s|$)|\b(?:ask|screen|screening|question|evaluate|analyse|analyze)\b[\s\S]*\b(?:llmsuite|llm suite|llm|m365|copilot)\b|\b(?:llmsuite|llm suite|llm|m365|copilot)\b[\s\S]*\?/i.test(
            text,
          ) &&
          !/\b(?:populate|upload|add)\b[\s\S]{0,35}\b(?:pitch\s?book|rogo)\b|\b(?:run|do)\s+(?:a\s+)?(?:bing|web research)\b/i.test(
            text,
          )
        ) {
          const providers: ("copilot" | "llm_suite")[] = [];
          if (/\bllm(?:\s?suite)?\b|^\/screen/i.test(text))
            providers.push("llm_suite");
          if (/m365|copilot/i.test(text)) providers.push("copilot");
          if (!providers.length) providers.push("llm_suite");
          const mode = /^\/screen|\b(?:screen|screening|fit scores?)\b/i.test(
            text,
          )
            ? "screening"
            : "question";
          const request = text
            .replace(/^\/(?:llm|copilot|screen)\s*/i, "")
            .trim();
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
            text: "Review the inputs, prompt, and output columns in the setup. Saving it does not send a provider request.",
          });
        } else if (
          action?.type === "choose-option" ||
          (/\b(?:populate|add|run|research)\b/i.test(text) &&
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
                      step === "llm" ? "LLMSuite setup" : "M365 Copilot setup",
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
                    state: "unavailable",
                    companies: state.companies.slice(0, 5).map((c) => ({
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
                    type: "handoff",
                    service:
                      step === "pitchbook"
                        ? "PitchBook"
                        : step === "rogo"
                          ? "ROGO"
                          : step === "llm"
                            ? "LLMSuite"
                            : "M365 Copilot",
                    state:
                      step === "pitchbook" || step === "rogo"
                        ? "awaiting-files"
                        : "unavailable",
                    detail:
                      step === "pitchbook"
                        ? "Attach a mapping CSV and PitchBook data workbook(s). Headers identify the file roles; filenames do not."
                        : step === "rogo"
                          ? "Attach ROGO workbook(s) with a Website column. PitchBook website is preferred for matching."
                          : step === "llm"
                            ? "LLMSuite is not connected. Export the LLM workbook to continue in your screening system."
                            : "M365 is not connected. LinkedIn is optional when preparing a question or screening.",
                  },
                  turnId,
                ),
              );
          }
        } else if (
          /^\/plan$|next steps?|recommend|^continue$/i.test(text) &&
          state.companies.length
        ) {
          add(nextOptions(sessionId, turnId));
        } else if (
          /^(?:find companies|start search|search companies|search again|find more companies|broaden the search)$/i.test(
            text,
          )
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
            text: `Saved ${submittedFiles.length} file${submittedFiles.length === 1 ? "" : "s"} as chat artifacts. ${tabular.length ? "Run discovery before importing enrichment data." : "PDF and DOCX text extraction is not connected in this local example. Paste the business criteria or attach a UTF-8 TXT file to prepare a draft."}`,
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
            text: `Saved ${submittedFiles.length} supporting file${submittedFiles.length === 1 ? "" : "s"}. The current criteria and company list are unchanged. You can preview PDF files from their cards. To change the screening, use Edit criteria or describe the new business to find.`,
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
            content.push({
              type: "text",
              text:
                samePrompt && approved(state)
                  ? "The criteria are unchanged. Your previous approval still applies."
                  : draft.definition
                    ? "Here is a draft for review. Edit the core business definition if needed, then approve the search. Size, financials, geography, ownership, and industry codes are reference details; they do not filter discovery."
                    : "This text needs a clearer core business definition. Use Edit criteria to describe the products, services, and customer workflows to search for.",
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
