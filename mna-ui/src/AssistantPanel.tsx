import MarkdownMessage from "./chat/MarkdownMessage";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useLocalRuntime,
  type ThreadMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  LoaderCircle,
  Square,
  Sparkles,
  X,
} from "lucide-react";
import type {
  AssistantContext,
  ResearchAction,
  WorkspaceAction,
} from "./lib/assistant-contract";
import { prepareAssistantTurn, abortableDelay } from "./lib/assistant-driver";
import { runScreeningExample } from "./lib/tool-workflow";
import { sessionStore, useSessionSnapshot } from "./lib/session-store";
import type { ToolResult } from "./lib/tool-client";
import Tooltip from "./Tooltip";
import "./assistant.css";

type ToolPart = Extract<
  ThreadMessage["content"][number],
  { type: "tool-call" }
>;
type Props = {
  open: boolean;
  onClose: () => void;
  onAction: (action: WorkspaceAction) => void;
  context: AssistantContext;
  request?: { id: string; text: string };
  onBusyChange?: (busy: boolean) => void;
};
const Actions = createContext<{
  onAction: Props["onAction"];
  sessionId: string;
}>({ onAction: () => {}, sessionId: "" });
const labels: Record<string, string> = {
  get_source_rows: "Read source fields",
  create_run: "Create screening",
  import_company_files: "Read example companies",
  approve_screening_profile: "Apply criteria approval",
  get_active_screening_profile: "Read approved criteria",
  search_mid: "Search MID",
  add_candidates: "Save companies",
  get_company: "Read company data",
  get_company_context: "Build company context",
  get_discovery_summary: "Count companies",
  get_candidate_set: "Read saved companies",
  save_checkpoint: "Save progress",
  recommend_next_steps: "Suggest next steps",
  read_screening_criteria: "Review criteria",
  read_workspace_summary: "Read company list",
};
const actionLabels: Record<ResearchAction, string> = {
  pitchbook: "PitchBook",
  rogo: "ROGO",
  bing: "Bing research",
  llm: "LLM screening",
  copilot: "Copilot screening",
};

function Recommendation({ part }: { part: ToolPart }) {
  const { onAction, sessionId } = useContext(Actions);
  const snapshot = useSessionSnapshot();
  const result = part.result as ToolResult | undefined;
  const choices = Array.isArray(result?.ordered_actions)
    ? result.ordered_actions.filter(
        (value): value is ResearchAction =>
          typeof value === "string" && value in actionLabels,
      )
    : [];
  const decision = snapshot.sessions
    .find((s) => s.id === sessionId)
    ?.events.find(
      (e) =>
        e.kind === "approval" &&
        (e.result as { callId?: string })?.callId === part.toolCallId,
    );
  if (!choices.length) return null;
  const decide = (proceed: boolean) => {
    sessionStore.addEvent({
      sessionId,
      kind: "approval",
      status: "success",
      origin: "workspace",
      title: proceed ? "Suggestion accepted" : "Suggestion declined",
      result: { callId: part.toolCallId, proceed, actions: choices },
    });
    if (proceed) onAction({ type: "plan", actions: choices });
  };
  return (
    <div className="tool-recommendation">
      <strong>Suggested next step</strong>
      <p>{choices.map((choice) => actionLabels[choice]).join(" → ")}</p>
      {decision ? (
        <small>
          {(decision.result as { proceed: boolean }).proceed
            ? "Added to your plan"
            : "Skipped for now"}
        </small>
      ) : (
        <div className="decision-actions">
          <button
            className="primary-button"
            type="button"
            onClick={() => decide(true)}
          >
            Proceed <ArrowRight size={14} />
          </button>
          <button
            className="text-link"
            type="button"
            onClick={() => decide(false)}
          >
            Not now
          </button>
        </div>
      )}
    </div>
  );
}
function ToolTrace(part: ToolPart) {
  const snapshot = useSessionSnapshot();
  const receipt = snapshot.sessions
    .flatMap((s) => s.events)
    .find((e) => e.id === part.toolCallId);
  const status =
    receipt?.status ??
    (part.result === undefined
      ? "running"
      : part.isError
        ? "error"
        : "success");
  return (
    <>
      <details className={`tool-trace tool-trace-${status}`}>
        <summary>
          {status === "running" ? (
            <LoaderCircle className="spin" size={13} />
          ) : status === "success" ? (
            <Check size={13} />
          ) : (
            <Square size={11} />
          )}
          <span className="tool-trace-name">
            {labels[part.toolName] ?? part.toolName.replaceAll("_", " ")}
          </span>
          <span className="tool-trace-status">
            {status === "success"
              ? "Done"
              : status === "running"
                ? "Running"
                : status === "cancelled"
                  ? "Stopped"
                  : "Failed"}
          </span>
          <ChevronRight size={13} />
        </summary>
        <div className="tool-trace-body">
          <div className="tool-trace-meta">
            <code>{part.toolName}</code>
            <span>
              {receipt?.durationMs != null ? `${receipt.durationMs} ms` : ""}
            </span>
            <button
              type="button"
              title="Copy tool call"
              aria-label="Copy tool call"
              onClick={() =>
                void navigator.clipboard.writeText(
                  JSON.stringify(
                    {
                      tool: part.toolName,
                      arguments: part.args,
                      result: part.result,
                    },
                    null,
                    2,
                  ),
                )
              }
            >
              <Copy size={13} />
            </button>
          </div>
          <h4>Input</h4>
          <pre>{JSON.stringify(part.args, null, 2)}</pre>
          <h4>Result</h4>
          <pre>
            {part.result === undefined
              ? "Waiting for the tool…"
              : JSON.stringify(part.result, null, 2)}
          </pre>
        </div>
      </details>
      {part.toolName === "recommend_next_steps" && (
        <Recommendation part={part} />
      )}
    </>
  );
}
function ToolGroup({
  groupKey,
  indices,
  children,
}: {
  groupKey?: string;
  indices: number[];
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  if (groupKey !== "tools") return <>{children}</>;
  return (
    <div className="tool-group">
      <button
        className="tool-group-head"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>
          {indices.length} tool {indices.length === 1 ? "call" : "calls"}
        </span>
        <ChevronDown size={14} />
      </button>
      {open && children}
    </div>
  );
}
const groupingFunction = (parts: ThreadMessage["content"]) => {
  const groups: { groupKey: string; indices: number[] }[] = [];
  parts.forEach((part, index) => {
    const key = part.type === "tool-call" ? "tools" : `part-${index}`;
    const last = groups.at(-1);
    if (last?.groupKey === key) last.indices.push(index);
    else groups.push({ groupKey: key, indices: [index] });
  });
  return groups;
};
const partComponents = {
  Text: MarkdownMessage,
  tools: { Fallback: ToolTrace },
  Group: ToolGroup,
};
function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="chat-message assistant">
      <div className="chat-speaker">
        <Sparkles size={12} /> Assistant
      </div>
      <div className="chat-bubble">
        <MessagePrimitive.Unstable_PartsGrouped
          groupingFunction={groupingFunction}
          components={partComponents}
        />
      </div>
    </MessagePrimitive.Root>
  );
}
function UserMessage() {
  return (
    <MessagePrimitive.Root className="chat-message user">
      <div className="chat-speaker">You</div>
      <div className="chat-bubble">
        <MessagePrimitive.Parts components={{ Text: MarkdownMessage }} />
      </div>
    </MessagePrimitive.Root>
  );
}
const messageComponents = { AssistantMessage, UserMessage };
function Conversation({
  request,
  onBusyChange,
  approved,
}: {
  request: Props["request"];
  onBusyChange: Props["onBusyChange"];
  approved: boolean;
}) {
  const aui = useAui();
  const empty = useAuiState((s) => s.thread.isEmpty);
  const running = useAuiState((s) => s.thread.isRunning);
  const handled = useRef<string | undefined>(undefined);
  useEffect(() => {
    onBusyChange?.(running);
  }, [running, onBusyChange]);
  useEffect(() => {
    if (request && handled.current !== request.id && !running) {
      handled.current = request.id;
      aui.thread().append({
        role: "user",
        content: [{ type: "text", text: request.text }],
      });
    }
  }, [aui, request, running]);
  return (
    <ThreadPrimitive.Root className="assistant-thread">
      <ThreadPrimitive.Viewport className="assistant-viewport">
        {empty && (
          <div className="assistant-welcome">
            <div className="assistant-welcome-icon">
              <Sparkles size={20} />
            </div>
            <h3>What would you like to do?</h3>
            <p>
              I can review your criteria, find companies, or suggest a next
              step. You decide when to proceed.
            </p>
            <div className="assistant-chips">
              {[
                "Run the screening example",
                "Review criteria",
                "Suggest next steps",
              ].map((text) => (
                <button
                  type="button"
                  key={text}
                  onClick={() =>
                    aui.thread().append({
                      role: "user",
                      content: [{ type: "text", text }],
                    })
                  }
                >
                  {text}
                  <ArrowRight size={14} />
                </button>
              ))}
            </div>
            <p className="assistant-local-note">
              The example runs local tools on fictional companies. Each call
              appears here and in the session log.
            </p>
          </div>
        )}
        <ThreadPrimitive.Messages components={messageComponents} />
        {running && (
          <div className="assistant-running" role="status">
            <LoaderCircle size={13} className="spin" />
            Working…
          </div>
        )}
        <ThreadPrimitive.ScrollToBottom
          className="assistant-scroll-bottom"
          aria-label="Scroll to latest message"
        >
          <ArrowDown size={15} />
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.Viewport>
      <div className="assistant-compose-wrap">
        <div className="assistant-context-row">
          <span className={`approval-dot ${approved ? "is-approved" : ""}`} />
          {approved ? "Criteria approved" : "Criteria need approval"}
          <Tooltip label="About assistant actions">
            Suggestions wait for your choice. The running example uses local
            local tools. External research services are not connected.
          </Tooltip>
        </div>
        <ComposerPrimitive.Root className="assistant-composer">
          <ComposerPrimitive.Input
            placeholder="Ask about this screening…"
            aria-label="Message the screening assistant"
          />
          <div className="composer-controls">
            <span>/export opens the session log</span>
            {running ? (
              <ComposerPrimitive.Cancel
                className="composer-cancel"
                aria-label="Stop assistant"
                title="Stop assistant"
              >
                <Square size={12} />
              </ComposerPrimitive.Cancel>
            ) : (
              <ComposerPrimitive.Send
                className="composer-send"
                aria-label="Send message"
                title="Send message"
              >
                <ArrowUp size={17} />
              </ComposerPrimitive.Send>
            )}
          </div>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  );
}
function restoredMessages(sessionId: string): ThreadMessageLike[] {
  const session = sessionStore
    .getSnapshot()
    .sessions.find((s) => s.id === sessionId);
  return (session?.events ?? [])
    .filter((e) => e.kind === "message" && e.role && e.text)
    .map((e) => ({
      role: e.role!,
      content: Array.isArray(e.content)
        ? (e.content as ThreadMessageLike["content"])
        : [{ type: "text", text: e.text! }],
    }));
}
export default function AssistantPanel(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(true);
  const initialMessages = useMemo(
    () => restoredMessages(props.context.sessionId),
    [props.context.sessionId],
  );
  const runtime = useLocalRuntime(
    {
      async *run({ messages, abortSignal }) {
        const initial = latest.current.context;
        const sessionId = initial.sessionId,
          turnId = crypto.randomUUID();
        const text =
          messages
            .at(-1)
            ?.content.filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n") ?? "";
        const startedAt = new Date().toISOString();
        sessionStore.addEvent({
          sessionId,
          turnId,
          kind: "message",
          status: "success",
          origin: "assistant",
          role: "user",
          title: "User message",
          text,
        });
        const content: (ToolPart | { type: "text"; text: string })[] = [];
        const pending = new Set<string>();
        const refs = new Map<string, { id: string; index: number }>();
        const active = () => {
          if (
            abortSignal.aborted ||
            !mounted.current ||
            latest.current.context.sessionId !== sessionId
          )
            throw new DOMException("Stopped", "AbortError");
        };
        const start = (key: string, tool: string, args: ToolResult) => {
          const id = sessionStore.startTool(tool, args, {
            sessionId,
            turnId,
            origin: "assistant",
            title: labels[tool] ?? tool,
          });
          refs.set(key, { id, index: content.length });
          pending.add(id);
          content.push({
            type: "tool-call",
            toolCallId: id,
            toolName: tool,
            args: args as ToolPart["args"],
            argsText: JSON.stringify(args),
          });
        };
        const finish = (key: string, result: ToolResult) => {
          const ref = refs.get(key)!;
          sessionStore.finishTool(ref.id, result);
          pending.delete(ref.id);
          content[ref.index] = { ...(content[ref.index] as ToolPart), result };
        };
        let response = "";
        try {
          active();
          const runExample = /run.*example|start.*example/i.test(text);
          const broader =
            /\b(more|broaden|widen|expand)\b|additional targets/i.test(text);
          if (
            initial.criteriaApproved &&
            (runExample || (broader && initial.backendRunId))
          ) {
            let outcome: AssistantContext = initial;
            for await (const event of runScreeningExample(initial, {
              signal: abortSignal,
              current: () => latest.current.context,
              broader,
            })) {
              active();
              if (event.type === "start")
                start(event.id, event.tool, event.args);
              else if (event.type === "result") finish(event.id, event.result);
              else {
                latest.current.onAction(event.action);
                outcome = {
                  ...initial,
                  backendRunId: event.action.backendRunId,
                  companies: event.action.companies,
                  counts: event.action.counts,
                };
                response = event.message;
              }
              yield { content: [...content] };
            }
            if (outcome.companies?.length) {
              const plan = prepareAssistantTurn("Suggest next steps", outcome);
              start("recommend", plan.toolName, plan.args);
              yield { content: [...content] };
              finish("recommend", plan.execute(outcome).result);
              yield { content: [...content] };
            }
          } else {
            const plan = prepareAssistantTurn(text, initial);
            start("local", plan.toolName, plan.args);
            yield { content: [...content] };
            await abortableDelay(80, abortSignal);
            active();
            const outcome = plan.execute(latest.current.context);
            finish("local", outcome.result);
            if (outcome.action) latest.current.onAction(outcome.action);
            response = outcome.response;
            yield { content: [...content] };
          }
          const textIndex = content.length;
          for (let length = 0; length < response.length; length += 50) {
            active();
            content[textIndex] = {
              type: "text",
              text: response.slice(0, length + 50),
            };
            yield { content: [...content] };
            await abortableDelay(12, abortSignal);
          }
          active();
          sessionStore.addEvent({
            sessionId,
            turnId,
            kind: "message",
            status: "success",
            origin: "assistant",
            role: "assistant",
            title: "Assistant response",
            text: response,
            content,
            startedAt,
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - Date.parse(startedAt),
          });
        } catch (error) {
          const cancelled =
            abortSignal.aborted ||
            (error instanceof DOMException && error.name === "AbortError");
          const message = cancelled
            ? "Stopped. Completed tool calls remain saved."
            : error instanceof Error
              ? error.message
              : String(error);
          for (const id of pending) {
            sessionStore.finishTool(
              id,
              null,
              cancelled ? "cancelled" : "error",
              message,
            );
            const index = content.findIndex(
              (p) => p.type === "tool-call" && p.toolCallId === id,
            );
            if (index >= 0)
              content[index] = {
                ...(content[index] as ToolPart),
                result: { error: message },
                isError: true,
              };
          }
          content.push({ type: "text", text: message });
          sessionStore.addEvent({
            sessionId,
            turnId,
            kind: "message",
            status: cancelled ? "cancelled" : "error",
            origin: "assistant",
            role: "assistant",
            title: cancelled ? "Assistant stopped" : "Assistant error",
            text: message,
            content,
            error: message,
            startedAt,
            finishedAt: new Date().toISOString(),
          });
          if (!abortSignal.aborted) yield { content: [...content] };
        }
      },
    },
    { initialMessages },
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      runtime.thread.cancelRun();
    };
  }, [runtime]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Actions.Provider
        value={{ onAction: props.onAction, sessionId: props.context.sessionId }}
      >
        <aside
          className={`assistant-panel ${props.open ? "" : "is-hidden"}`}
          aria-label="Screening assistant"
        >
          <div className="assistant-top">
            <div className="assistant-title">
              <span className="assistant-icon">
                <Sparkles size={17} />
              </span>
              <div>
                <strong>Screening assistant</strong>
                <small>Suggestions and tool activity</small>
              </div>
            </div>
            <button
              className="icon-button"
              type="button"
              title="Close assistant"
              aria-label="Close assistant"
              onClick={props.onClose}
            >
              <X size={17} />
            </button>
          </div>
          <Conversation
            request={props.request}
            onBusyChange={props.onBusyChange}
            approved={props.context.criteriaApproved}
          />
        </aside>
      </Actions.Provider>
    </AssistantRuntimeProvider>
  );
}
