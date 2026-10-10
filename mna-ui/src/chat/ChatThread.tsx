import {
  Children,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  QueueItemPrimitive,
  ThreadPrimitive,
  fromThreadMessageLike,
  useAui,
  useAuiState,
  useAuiEvent,
  useLocalRuntime,
  type ThreadAssistantMessagePart,
} from "@assistant-ui/react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Download,
  FileText,
  Eye,
  List,
  LoaderCircle,
  Paperclip,
  Pencil,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import type {
  ArtifactAction,
  ChatArtifact,
  ChatState,
} from "../lib/chat-contract";
import { ChatScope, type Scope } from "./chat-scope";
import {
  approved,
  getChatState,
  updateChatState,
  useChatState,
  saveControllerTurns,
  controllerMessageIds,
  controllerPart,
} from "../lib/chat-store";
import { controllerAvailable, controllerHealth, getControllerPreferences, readControllerTurns, setControllerPreferences, subscribeControllerPreferences, type ControllerView } from "../lib/controller-client";
import { getLoopJobs, getLoopToggle, isLoopActiveForRun, setLoopToggle, subscribeLoopPreferences, subscribeLoops } from "../lib/loop-client";
import ControllerMessage, { type ControllerData } from "./ControllerMessage";
import { LoopSummaryCard, LoopTurnMessage } from "./LoopMessage";
import { appendWorkspaceMessages } from "../lib/workspace-message-sync";
import {
  createChatAdapter,
  hiddenActionMetadata,
  createFileAdapter,
  pendingWorkspaceMessages,
  transcriptFor,
} from "../lib/chat-driver";
import {
  getJob,
  getJobsConnectionError,
  jobContent,
  stopJob,
  subscribeJobs,
  toolLabels,
} from "../lib/chat-jobs";
import { commandPrompts, consideredCompanies } from "../lib/chat-policy";
import { resultOmitted, sessionStore, useSessionSnapshot } from "../lib/session-store";
import { formatDateTime, formatTime } from "../lib/format";
import ArtifactCard from "./ArtifactCard";
import MarkdownMessage from "./MarkdownMessage";
import Tooltip from "../Tooltip";
import HelpTip from "../ui/HelpTip";
import SelectField from "../ui/SelectField";
import { attachmentError } from "../lib/attachment-policy";
import "../chat-thread.css";

export type ComposerControls = {
  setText: (text: string) => void;
  addFiles: (files: File[]) => Promise<number>;
};
type ToolPart = Extract<ThreadAssistantMessagePart, { type: "tool-call" }>;
function ArtifactPart({ data }: { data: unknown }) {
  const scope = useContext(ChatScope);
  const state = useChatState(scope.sessionId);
  const id =
    data && typeof data === "object"
      ? (data as { artifactId?: string }).artifactId
      : undefined;
  const artifact = state.artifacts.find((a) => a.id === id);
  return artifact ? (
    <ArtifactCard artifact={artifact} onAction={scope.onAction} context={state} />
  ) : (
    <p className="ct-missing-artifact">
      This item is no longer available. The session log keeps the original entry.
    </p>
  );
}
function Timestamp() {
  const date = useAuiState((s) => s.message.createdAt);
  return (
    <time
      dateTime={date.toISOString()}
      title={formatDateTime(date, { seconds: true })}
    >
      {formatTime(date)}
    </time>
  );
}
function ToolCall(part: ToolPart) {
  const { sessionId, openLog } = useContext(ChatScope);
  const snapshot = useSessionSnapshot();
  const event = snapshot.sessions
    .find((s) => s.id === sessionId)
    ?.events.find((e) => e.id === part.toolCallId);
  const status =
    event?.status ??
    (part.result === undefined
      ? "running"
      : part.isError
        ? "error"
        : "success");
  const label =
    status === "success"
      ? "Done"
      : status === "running"
        ? "Running"
        : status === "cancelled"
          ? "Stopped"
          : "Failed";
  return (
    <details className={`ct-tool ct-tool-${status}`}>
      <summary>
        {status === "running" ? (
          <LoaderCircle size={13} className="spin" />
        ) : status === "success" ? (
          <Check size={13} />
        ) : (
          <X size={13} />
        )}
        <span>
          {toolLabels[part.toolName] ?? part.toolName.replaceAll("_", " ")}
        </span>
        <time title={event?.startedAt}>
          {event ? formatTime(event.startedAt, { seconds: true }) : ""}
        </time>
        <small>
          {event?.durationMs !== undefined ? `${event.durationMs} ms` : label}
        </small>
        <ChevronDown size={12} />
      </summary>
      <div className="ct-tool-detail">
        <div>
          <code>{part.toolName}</code>
          <button
            type="button"
            onClick={() => openLog(part.toolCallId)}
            title="Inspect this call in the session log"
          >
            Session log <ArrowRight size={12} />
          </button>
        </div>
        {event?.error && <p className="ct-error-copy">{event.error}</p>}
        <strong>Input</strong>
        <pre>{JSON.stringify(part.args, null, 2)}</pre>
        <strong>Output</strong>
        <pre>
          {part.result === undefined
            ? "Waiting for the tool…"
            : resultOmitted(part.result) ? "Result not saved (large)" : JSON.stringify(part.result, null, 2)}
        </pre>
      </div>
    </details>
  );
}
function ToolTimeline({
  children,
  startIndex,
  endIndex,
}: {
  children?: ReactNode;
  startIndex: number;
  endIndex: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const { openLog } = useContext(ChatScope);
  const items = Children.toArray(children);
  return (
    <div className="ct-tool-timeline">
      <div className="ct-tool-timeline-head">
        <span>
          <List size={14} />
          {endIndex - startIndex + 1} tool{" "}
          {startIndex === endIndex ? "call" : "calls"}
        </span>
        <button type="button" onClick={() => openLog()}>
          Inspect log <ArrowRight size={12} />
        </button>
      </div>
      {expanded ? items : items.slice(-4)}
      {items.length > 4 && (
        <button
          className="ct-more-tools"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show recent calls" : `Show all ${items.length} calls`}
          <ChevronDown size={12} />
        </button>
      )}
    </div>
  );
}
function LoadingPart() {
  const running = useAuiState((s) => s.message.status?.type === "running");
  return running ? (
    <div className="ct-thinking" role="status">
      <LoaderCircle size={14} className="spin" />
      <span>Preparing this step</span>
    </div>
  ) : null;
}
function ControllerPart({ data }: { data: unknown }) {
  const scope = useContext(ChatScope);
  if (!data || typeof data !== "object" || (!("pending" in data) && !("turn" in data) && !("error" in data))) return <p className="cc-warnings">Restoring LLM Suite reply from saved screening history…</p>;
  return <ControllerMessage data={data as ControllerData} openSetup={() => scope.onAction({ type: "configure-screening", artifactId: "", provider: "llm_suite", mode: "screening" })} />;
}
function LoopTurnPart({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return <p className="cc-warnings">Restoring discovery loop…</p>;
  return <LoopTurnMessage data={data as { loopId?: string; error?: string }} />;
}
function LoopSummaryPart({ data }: { data: unknown }) {
  if (!data || typeof data !== "object" || !("view" in data)) return <p className="cc-warnings">Restoring loop summary…</p>;
  return <LoopSummaryCard data={data as import("../lib/loop-client").LoopSummaryEventData} />;
}
const parts = {
  Text: MarkdownMessage,
  Empty: LoadingPart,
  tools: { Fallback: ToolCall },
  ToolGroup: ToolTimeline,
  data: { by_name: { "screening-artifact": ArtifactPart, "controller-turn": ControllerPart, "loop-turn": LoopTurnPart, "loop-summary": LoopSummaryPart } },
};
function MessageActions({ user = false }: { user?: boolean }) {
  const copied = useAuiState((s) => s.message.isCopied);
  return (
    <ActionBarPrimitive.Root
      className="ct-message-actions"
      hideWhenRunning
      autohide="never"
    >
      <ActionBarPrimitive.Copy
        copiedDuration={2000}
        aria-label={copied ? "Message copied" : "Copy message"}
        title={copied ? "Copied to clipboard" : "Copy message"}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </ActionBarPrimitive.Copy>
      {user ? (
        <ActionBarPrimitive.Edit
          aria-label="Edit sent message"
          title="Edit and submit a new revision"
        >
          <Pencil size={13} />
        </ActionBarPrimitive.Edit>
      ) : (
        <>
          <ActionBarPrimitive.Reload
            aria-label="Retry this step"
            title="Retry this step using current criteria"
          >
            <RotateCcw size={13} />
          </ActionBarPrimitive.Reload>
          <ActionBarPrimitive.ExportMarkdown
            aria-label="Export message as Markdown"
            title="Export this message"
          >
            <Download size={13} />
          </ActionBarPrimitive.ExportMarkdown>
        </>
      )}
      <BranchPickerPrimitive.Root
        className="ct-message-branches"
        hideWhenSingleBranch
      >
        <BranchPickerPrimitive.Previous aria-label="Previous message version">
          ‹
        </BranchPickerPrimitive.Previous>
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
        <BranchPickerPrimitive.Next aria-label="Next message version">
          ›
        </BranchPickerPrimitive.Next>
      </BranchPickerPrimitive.Root>
    </ActionBarPrimitive.Root>
  );
}
function MessageAttachment() {
  const attachment = useAuiState((s) => s.attachment);
  const attached = useAuiState(s => s.attachment);
  if (attached.content?.some(part => part.type === "data" && part.name === "staged-company-file")) return null;
  return (
    <AttachmentPrimitive.Root className="ct-sent-file">
      <AttachmentPrimitive.Name />
      <div>
        {attachment.content?.map((p, i) =>
          p.type === "data" ? <ArtifactPart key={i} data={p.data} /> : null,
        )}
      </div>
    </AttachmentPrimitive.Root>
  );
}
const attachmentComponents = { Attachment: MessageAttachment };
function AssistantMessage() {
  const controller = useAuiState(s => s.message.content.some(part => part.type === "data" && part.name === "controller-turn"));
  return (
    <MessagePrimitive.Root className="ct-message ct-assistant">
      {!controller && <div className="ct-message-meta">
        <span className="ct-assistant-mark">s</span>
        <strong>Screening assistant</strong>
        <Timestamp />
      </div>}
      <div className="ct-message-body">
        <MessagePrimitive.Parts components={parts} />
        <MessagePrimitive.Error>
          <div className="ct-message-error" role="alert">
            <X size={14} />
            <ErrorPrimitive.Message />
          </div>
        </MessagePrimitive.Error>
        {!controller && <MessageActions />}
      </div>
    </MessagePrimitive.Root>
  );
}
function UserMessage() {
  const editing = useAuiState((s) => s.message.composer.isEditing);
  const custom = useAuiState((s) => s.message.metadata.custom);
  const scope = useContext(ChatScope);
  const state = useChatState(scope.sessionId);
  const snapshot = useSessionSnapshot();
  if (custom.hidden === true) {
    const action = custom.artifactAction as ArtifactAction | undefined;
    let label = String(custom.label ?? "Screening action");
    if (action?.type === "approve-criteria") {
      const approval = snapshot.sessions.find(session => session.id === scope.sessionId)?.events.find(event => event.kind === "approval" && event.title === "Discovery criteria approved" && ((event.result as Record<string, unknown> | undefined)?.sourceArtifactId === action.artifactId || (event.result as Record<string, unknown> | undefined)?.artifactId === action.artifactId));
      label = approval ? `Approved criteria v${(approval.result as Record<string, unknown>)?.revision}` : "Approval requested";
    } else if (action?.type === "inspect-company") {
      label = `Opened ${state.companies.find(company => company.pk === action.companyId)?.name ?? action.companyId}`;
    }
    return <MessagePrimitive.Root className="ct-system-chip"><Check size={12} /><span>{label}</span><span>·</span><Timestamp /></MessagePrimitive.Root>;
  }
  return (
    <MessagePrimitive.Root className="ct-message ct-user">
      <div className="ct-message-meta">
        <strong>You</strong>
        <Timestamp />
      </div>
      {editing ? (
        <ComposerPrimitive.Root className="ct-edit-composer">
          <ComposerPrimitive.Input aria-label="Edit your sent message" />
          <div>
            <ComposerPrimitive.Cancel className="ct-ghost-button">
              Cancel
            </ComposerPrimitive.Cancel>
            <ComposerPrimitive.Send className="ct-solid-button">
              Save and send
            </ComposerPrimitive.Send>
          </div>
        </ComposerPrimitive.Root>
      ) : (
        <div className="ct-message-body">
          <MessagePrimitive.Parts components={parts} />
          <MessagePrimitive.Attachments components={attachmentComponents} />
          <MessageActions user />
        </div>
      )}
    </MessagePrimitive.Root>
  );
}
const messageComponents = { AssistantMessage, UserMessage };
function PendingAttachment() {
  const scope = useContext(ChatScope);
  const attachment = useAuiState((s) => s.attachment);
  const state = useChatState(scope.sessionId);
  const staged = state.files.find((file) => file.id === attachment.id);
  return (
    <AttachmentPrimitive.Root className="ct-attachment-chip">
      <FileText size={14} />
      <AttachmentPrimitive.Name />
      {attachment.status.type === "incomplete" && (
        <span className="ct-error-copy">
          {attachment.status.message ?? "Upload failed"}
        </span>
      )}
      {attachment.status.type === "running" && (
        <LoaderCircle size={12} className="spin" />
      )}
      {staged && (staged.purpose === "chat" || !staged.purpose) && (
        <label className="ct-pending-provider">
          <input
            type="checkbox"
            aria-label={`Include ${staged.name} when asking LLM Suite or M365 Copilot`}
            checked={staged.passToProvider !== false}
            onChange={(event) => {
              const fileArtifact = state.artifacts.find(
                (item) => item.type === "file" && item.file.id === staged.id,
              );
              if (fileArtifact)
                void Promise.resolve(
                  scope.onAction({
                    type: "toggle-file",
                    artifactId: fileArtifact.id,
                    fileId: staged.id,
                    passToProvider: event.target.checked,
                  }),
                );
            }}
          />
          <span>Include in provider questions</span>
        </label>
      )}
      {/\.pdf$/i.test(attachment.name) &&
        "file" in attachment &&
        attachment.file && (
          <button
            type="button"
            className="ct-pending-preview"
            aria-label={`Preview ${attachment.name}`}
            title="Preview PDF"
            onClick={() => scope.previewFile(attachment.file!)}
          >
            <Eye size={14} />
          </button>
        )}
      <AttachmentPrimitive.Remove
        title="Remove attachment"
        aria-label={`Remove ${attachment.name}`}
      >
        <X size={12} />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}
const pendingAttachmentComponents = { Attachment: PendingAttachment };
function Queue() {
  const count = useAuiState((s) => s.composer.queue.length);
  if (!count) return null;
  return (
    <div className="ct-queue">
      <span>{count} queued · sends when this step finishes</span>
      <ComposerPrimitive.Queue>
        {({ queueItem }) => (
          <div key={queueItem.id}>
            <ArrowUp size={12} />
            <QueueItemPrimitive.Text />
            <QueueItemPrimitive.Remove
              title="Remove queued message"
              aria-label="Remove queued message"
            >
              <X size={13} />
            </QueueItemPrimitive.Remove>
          </div>
        )}
      </ComposerPrimitive.Queue>
    </div>
  );
}
function ComposerMenus({ state }: { state: ChatState }) {
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const slash = /^\/\S*$/.test(text);
  const mention = /^@\S*$/.test(text);
  if (slash)
    return (
      <div className="ct-composer-menu" aria-label="Slash commands">
        {commandPrompts
          .filter((c) => c.command.startsWith(text))
          .map((c) => (
            <button
              type="button"
              key={c.command}
              onClick={() => {
                aui.composer().setText(c.command);
                aui.composer().send();
              }}
            >
              <code>{c.command}</code>
              <span>
                {c.title}
                <small>{c.description}</small>
              </span>
            </button>
          ))}
      </div>
    );
  if (mention)
    return (
      <div className="ct-composer-menu" aria-label="Company mentions">
        {state.companies
          .filter((c) =>
            `${c.name} ${c.pk}`
              .toLowerCase()
              .includes(text.slice(1).toLowerCase()),
          )
          .slice(0, 7)
          .map((c) => (
            <button
              type="button"
              key={c.pk}
              onClick={() => {
                aui.composer().setText(`@${c.pk} Show company context`);
                aui.composer().send();
              }}
            >
              <span>
                {c.name}
                <small>
                  {c.pk} · {c.source}
                </small>
              </span>
            </button>
          ))}
        {!state.companies.length && (
          <p>Company mentions are available after discovery.</p>
        )}
      </div>
    );
  return null;
}
function ModelMenu({ state }: { state: ChatState }) {
  return (
    <SelectField
      className={`ct-model-select${state.model === "local" ? "" : " is-provider"}`}
      label="Choose assistant"
      value={state.model}
      onChange={(model) =>
        updateChatState(state.sessionId, {
          model: model as ChatState["model"],
        })
      }
      icon={
        <span className="ct-model-logo">
          {state.model === "llm_suite" ? "L" : state.model === "copilot" ? "M" : "s"}
        </span>
      }
      options={[
        {
          value: "local",
          label: "Screening assistant",
          description: "Local tools and company data",
        },
        {
          value: "llm_suite",
          label: "LLM Suite",
          description: "Ask questions using your staged files",
        },
        {
          value: "copilot",
          label: "M365 Copilot",
          description: "Ask questions using your staged files",
        },
      ]}
    />
  );
}
function ControllerMode({ state }: { state: ChatState }) {
  const preferences = useSyncExternalStore(subscribeControllerPreferences, () => getControllerPreferences(state.sessionId));
  const loopEnabled = useSyncExternalStore(subscribeLoopPreferences, () => getLoopToggle(state.sessionId));
  const loopJobs = useSyncExternalStore(subscribeLoops, getLoopJobs, getLoopJobs);
  const [health, setHealth] = useState<Awaited<ReturnType<typeof controllerHealth>>>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () => controllerHealth().then(value => { if (active) { setHealth(value); setError(""); } }).catch(() => { if (active) { setHealth(undefined); setError("LLM Suite is disconnected."); } });
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [state.backendRunId]);
  const available = controllerAvailable(state.backendRunId, health);
  const loopActive = loopJobs.some(job => job.runId === state.backendRunId && ["queued", "running", "paused", "consolidating", "cancelling"].includes(job.state));
  if (!available && !preferences.mode) return null;
  return <div className="cc-mode" aria-label="Chat send mode">
    <button type="button" aria-pressed={!preferences.mode} onClick={() => setControllerPreferences(state.sessionId, { mode: false })}>Current assistant</button>
    <button type="button" aria-pressed={preferences.mode} disabled={!available} onClick={() => setControllerPreferences(state.sessionId, { mode: true })}>Send to LLM Suite</button>
    {preferences.mode && available && <><button className="cc-loop-switch" type="button" role="switch" aria-label="Loop" aria-checked={loopEnabled} onClick={() => setLoopToggle(state.sessionId, !loopEnabled)}><span className="cc-loop-track" aria-hidden="true"><i /></span><span>Loop</span></button><HelpTip label="About Loop" size="sm">LLM Suite runs up to 50 turns of searches, sets a keep threshold per query and applies the final list as your considered companies. You can pause, cancel, or undo.</HelpTip></>}
    {preferences.mode && <details className="cc-mode-menu"><summary>Conversation menu</summary><div><button type="button" onClick={event => {
      setControllerPreferences(state.sessionId, { newConversation: true });
      event.currentTarget.closest("details")?.removeAttribute("open");
    }}>New conversation</button></div></details>}
    {preferences.mode && preferences.newConversation && <span>Next message starts a new conversation</span>}
    {preferences.mode && loopEnabled && loopActive && <span className="cc-loop-note" role="status">A loop is already running for this screening</span>}
    {!available && <span role="status">{error || "LLM Suite controller is unavailable."}</span>}
  </div>;
}
function Conversation({
  state,
  onBusyChange,
  captureSend,
  captureComposer,
}: {
  state: ChatState;
  onBusyChange: (busy: boolean) => void;
  captureSend: (send: (text: string, action?: ArtifactAction) => void) => void;
  captureComposer: (controls: ComposerControls) => void;
}) {
  const aui = useAui();
  const scope = useContext(ChatScope);
  const empty = useAuiState((s) => s.thread.isEmpty);
  const running = useAuiState((s) => s.thread.isRunning);
  const draftText = useAuiState((s) => s.composer.text);
  const controllerPreferences = useSyncExternalStore(subscribeControllerPreferences, () => getControllerPreferences(state.sessionId));
  const loopEnabled = useSyncExternalStore(subscribeLoopPreferences, () => getLoopToggle(state.sessionId));
  const loopJobs = useSyncExternalStore(subscribeLoops, getLoopJobs, getLoopJobs);
  const loopOn = controllerPreferences.mode && loopEnabled;
  const loopBlocked = loopOn && loopJobs.some(job => job.runId === state.backendRunId && ["queued", "running", "paused", "consolidating", "cancelling"].includes(job.state));
  const [attachmentFailure, setAttachmentFailure] = useState("");
  useAuiEvent("composer.attachmentAddError", (event) => {
    setAttachmentFailure(event.message);
  });
  useEffect(() => {
    captureComposer({
      setText: (text) => aui.composer().setText(text),
      addFiles: async (files) => {
        setAttachmentFailure("");
        const errors = files
          .map(attachmentError)
          .filter((error) => error !== undefined);
        if (errors.length) setAttachmentFailure(errors.join(" "));
        const results = await Promise.allSettled(
          files
            .filter((file) => !attachmentError(file))
            .map((file) => aui.composer().addAttachment(file)),
        );
        return results.filter((result) => result.status === "fulfilled").length;
      },
    });
  }, [aui, captureComposer]);
  const [hydratedSession, setHydratedSession] = useState<string>();
  const threadElement = useRef<HTMLDivElement>(null);
  const composerElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const composer = composerElement.current;
    if (!composer) return;
    const measure = () =>
      threadElement.current?.style.setProperty(
        "--composer-height",
        `${Math.ceil(composer.getBoundingClientRect().height)}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);
  const job = useSyncExternalStore(
    subscribeJobs,
    () => getJob(state.jobId),
    () => undefined,
  );
  const connection = useSyncExternalStore(
    subscribeJobs,
    getJobsConnectionError,
    () => "",
  );
  useEffect(() => onBusyChange(running), [running, onBusyChange]);
  useEffect(() => {
    captureSend((text, action) =>
      aui.thread().append({
        role: "user",
        content: [{ type: "text", text }],
        metadata: { custom: hiddenActionMetadata(text, action) },
      }),
    );
  }, [aui, captureSend]);
  useEffect(() => {
    const key = `screening-draft:${state.sessionId}`;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(key);
    } catch {
      /* Session storage warning is handled by the store. */
    }
    // An empty string is a saved draft too: restore it to clear stale composer
    // text when switching between sessions in a reused chat shell.
    aui.composer().setText(saved ?? "");
    setHydratedSession(state.sessionId);
  }, [aui, state.sessionId]);
  useEffect(() => {
    // The hydration effect updates assistant-ui synchronously, but this
    // effect still closes over the previous render's draftText. Wait for the
    // hydration state update before persisting anything for this session.
    if (hydratedSession !== state.sessionId) return;
    try {
      localStorage.setItem(`screening-draft:${state.sessionId}`, draftText);
    } catch {
      /* Draft stays in the composer. */
    }
  }, [draftText, hydratedSession, state.sessionId]);
  const stop = () => {
    if (job?.state === "running") void stopJob(job.id).catch(() => {});
    aui.thread().cancelRun();
  };
  return (
    <ThreadPrimitive.Root className="ct-thread" ref={threadElement}>
      <ThreadPrimitive.Viewport className="ct-viewport">
        {empty && (
          <div className="ct-welcome">
            <h1>Start a screening</h1>
            <p>
              Describe the core business you want to find, or upload your
              criteria. You approve the search before it runs.
            </p>
            <div className="ct-welcome-prompts">
              <button
                type="button"
                onClick={() => aui.composer().setText("Find companies that ")}
              >
                <span>
                  <strong>Write criteria</strong>
                  <small>Products, services, and customers</small>
                </span>
                <ArrowRight size={16} />
              </button>
              <button type="button" onClick={() => scope.onAction({ type: "upload-intake", artifactId: "" })}><span><strong>Upload Intake Form</strong><small>PDF, DOCX, or TXT</small></span><ArrowRight size={16} /></button>
            </div>
            <button className="ca-text-action" type="button" onClick={() => aui.thread().append({ role: "user", content: [{ type: "text", text: "/example" }], metadata: { custom: hiddenActionMetadata("/example") } })}>Try the example</button>
            <div className="ct-welcome-hint">
              <Paperclip size={14} />
              Attach supporting files below.
            </div>
          </div>
        )}
        <div className="ct-messages">
          <ThreadPrimitive.Messages components={messageComponents} />
        </div>
        {running && (
          <div className="ct-live-status" role="status">
            <span className="ct-status-pulse" />
            {job?.state === "running"
              ? "Running tools · saved in the session log"
              : "Preparing your next step"}
          </div>
        )}
        <ThreadPrimitive.ScrollToBottom
          className="ct-scroll-bottom"
          aria-label="Scroll to latest message"
          title="Scroll to latest message"
        >
          <ArrowDown size={15} />
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.Viewport>
      <div className="ct-composer-wrap" ref={composerElement}>
        {connection && (
          <p className="ct-connection-error" role="status">
            {connection}
          </p>
        )}
        {attachmentFailure && (
          <div className="ct-attachment-error" role="alert">
            <span>{attachmentFailure}</span>
            <button
              className="ct-icon-button"
              type="button"
              aria-label="Dismiss attachment error"
              onClick={() => setAttachmentFailure("")}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <Queue />
        <ControllerMode state={state} />
        <div className="ct-composer-context">
          <button type="button" onClick={scope.openContext}>
            <span
              className={`ct-status-dot ${approved(state) ? "ct-approved" : ""}`}
            />
            {approved(state)
              ? "Criteria approved"
              : state.criteriaText
                ? "Criteria need review"
                : "No criteria yet"}
            <ChevronDown size={11} />
          </button>
          {state.companies.length > 0 && (
            <span>{consideredCompanies(state).length.toLocaleString()} in shortlist</span>
          )}
          <Tooltip label="What the assistant uses">
            Only the approved core business definition is used to search. MID
            and ISCC scores remain separate. This runtime uses local tools;
            external model and research services are off.
          </Tooltip>
        </div>
        <ComposerPrimitive.Root className="ct-composer">
          <ComposerMenus state={state} />
          <div className="ct-attachment-list">
            <ComposerPrimitive.Attachments
              components={pendingAttachmentComponents}
            />
          </div>
          <ComposerPrimitive.Input
            placeholder={loopOn ? "Describe what the loop should find…" : "Describe a business, ask for a next step, or type /…"}
            aria-label="Message the screening assistant"
          />
          <div className="ct-composer-footer">
            <div className="ct-composer-tools">
              <ComposerPrimitive.AddAttachment
                className="ct-icon-button"
                aria-label="Attach files"
                title="Attach Intake Form, PitchBook, or ROGO files"
              >
                <Paperclip size={17} />
              </ComposerPrimitive.AddAttachment>
              <button
                className="ct-icon-button"
                type="button"
                onClick={scope.openPrompts}
                aria-label="Open prompt library"
                title="Editable starting prompts"
              >
                <List size={17} />
              </button>
              <ModelMenu state={state} />
            </div>
            <div className="ct-composer-send-area">
              {running && (
                <button
                  className="ct-icon-button ct-stop"
                  type="button"
                  onClick={stop}
                  aria-label="Stop current step"
                  title="Stop tools; preserve completed work"
                >
                  <Square size={13} />
                </button>
              )}
              <ComposerPrimitive.Send
                className="ct-send"
                aria-label={running ? "Queue message" : "Send message"}
                title={running ? "Queue for after this step" : "Send message"}
                disabled={loopBlocked}
              >
                <ArrowUp size={17} />
              </ComposerPrimitive.Send>
            </div>
          </div>
        </ComposerPrimitive.Root>
        <p className="ct-composer-note">
          Drop files here to attach. You approve the search before it runs.
        </p>
      </div>
    </ThreadPrimitive.Root>
  );
}
function ChatRuntime({
  sessionId,
  title,
  onAction,
  openLog,
  openContext,
  openPrompts,
  onBusyChange,
  captureSend,
  captureComposer,
  previewFile,
}: {
  sessionId: string;
  title: string;
  onAction: Scope["onAction"];
  openLog: (eventId?: string) => void;
  openContext: () => void;
  openPrompts: () => void;
  onBusyChange: (busy: boolean) => void;
  captureSend: (send: (text: string, action?: ArtifactAction) => void) => void;
  captureComposer: (controls: ComposerControls) => void;
  previewFile: (file: File) => void;
}) {
  const state = useChatState(sessionId);
  const adapter = useMemo(
    () => createChatAdapter(sessionId, { openLog, title: () => title }),
    [sessionId, title, openLog],
  );
  const attachments = useMemo(() => createFileAdapter(sessionId), [sessionId]);
  const initialMessages = useMemo(() => transcriptFor(sessionId), [sessionId]);
  const runtime = useLocalRuntime(adapter, {
    initialMessages,
    adapters: { attachments },
    unstable_enableMessageQueue: true,
    unstable_queueClearOnCancel: false,
  });
  useEffect(() => {
    if (!state.backendRunId) return;
    let active = true;
    void readControllerTurns(state.backendRunId).then(response => {
      if (!active || runtime.thread.getState().isRunning) return;
      const views = saveControllerTurns(sessionId, response);
      const ids = controllerMessageIds(sessionId);
      const repository = runtime.thread.export();
      let changed = false;
      const messages = repository.messages.map(item => {
        const turn = views.find(view => ids.get(view.turn_id) === item.message.id);
        if (!turn) return item;
        const part = item.message.content.find(part => part.type === "data" && part.name === "controller-turn");
        const previous = part?.type === "data" ? (part.data as { turn?: ControllerView }).turn : undefined;
        const content = [controllerPart({ ...turn, divider: previous?.divider ?? turn.divider, rotatedFrom: previous?.rotatedFrom ?? turn.rotatedFrom })];
        if (JSON.stringify(item.message.content) === JSON.stringify(content)) return item;
        changed = true;
        return { ...item, message: fromThreadMessageLike({ id: item.message.id, role: "assistant", createdAt: new Date(turn.created_at), content }, item.message.id, { type: "complete", reason: "stop" }) };
      });
      if (changed) runtime.thread.import({ ...repository, messages });
    }).catch(error => {
      if (active) sessionStore.addEvent({ sessionId, kind: "system", origin: "workspace", status: "error", title: "LLM Suite history could not be restored", text: String(error.message ?? error) });
    });
    return () => { active = false; };
  }, [sessionId, state.backendRunId, runtime]);
  useEffect(
    () => () => {
      runtime.thread.cancelRun();
    },
    [runtime],
  );
  useEffect(() => {
    let importing = false;
    const syncWorkspaceMessages = () => {
      if (importing || runtime.thread.getState().isRunning) return;
      const repository = runtime.thread.export();
      const additions = pendingWorkspaceMessages(
        sessionId,
        repository.messages.map((item) => item.message.id),
      );
      if (!additions.length) return;
      const next = appendWorkspaceMessages(repository, additions);
      const activeIds = runtime.thread
        .getState()
        .messages.map((message) => message.id);
      importing = true;
      try {
        updateChatState(sessionId, {
          branchMessageIds: [
            ...activeIds,
            ...additions.map((message) => message.id!),
          ],
        });
        runtime.thread.import(next);
      } finally {
        importing = false;
      }
    };
    syncWorkspaceMessages();
    const offSession = sessionStore.subscribe(syncWorkspaceMessages);
    const offRuntime = runtime.thread.subscribe(syncWorkspaceMessages);
    return () => {
      offSession();
      offRuntime();
    };
  }, [runtime, sessionId]);
  useEffect(() => {
    let syncing = false;
    const syncBackground = () => {
      if (syncing || runtime.thread.getState().isRunning) return;
      const current = getChatState(sessionId),
        job = getJob(current.jobId),
        context = current.jobContext;
      if (!job || !context || context.id !== job.id) return;
      const repository = runtime.thread.export();
      const existing = repository.messages.find(
        (item) => item.message.id === context.messageId,
      );
      if (
        !current.branchMessageIds.includes(context.messageId) &&
        job.state !== "running"
      )
        return;
      const content = jobContent(job);
      if (
        existing &&
        JSON.stringify(existing.message.content) === JSON.stringify(content)
      )
        return;
      const message = fromThreadMessageLike(
        {
          id: context.messageId,
          role: "assistant",
          createdAt: new Date(job.startedAt),
          content,
          status:
            job.state === "error"
              ? {
                  type: "incomplete",
                  reason: "error",
                  error: job.error ?? "Search failed",
                }
              : { type: "complete", reason: "stop" },
        },
        context.messageId,
        { type: "complete", reason: "stop" },
      );
      const index = current.branchMessageIds.indexOf(context.messageId);
      const previous =
        index > 0 ? current.branchMessageIds[index - 1] : repository.headId;
      const parentId =
        existing?.parentId ??
        (repository.messages.some((item) => item.message.id === previous)
          ? previous!
          : (repository.headId ?? null));
      const messages = existing
        ? repository.messages.map((item) =>
            item.message.id === context.messageId ? { ...item, message } : item,
          )
        : [...repository.messages, { message, parentId }];
      syncing = true;
      try {
        runtime.thread.import({
          headId: existing ? repository.headId : context.messageId,
          messages,
        });
      } finally {
        syncing = false;
      }
    };
    syncBackground();
    const offJobs = subscribeJobs(syncBackground),
      offRuntime = runtime.thread.subscribe(syncBackground);
    return () => {
      offJobs();
      offRuntime();
    };
  }, [runtime, sessionId]);
  const scope = useMemo(
    () => ({
      sessionId,
      onAction,
      openLog,
      openContext,
      openPrompts,
      previewFile,
    }),
    [sessionId, onAction, openLog, openContext, openPrompts, previewFile],
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatScope.Provider value={scope}>
        <Conversation
          state={state}
          onBusyChange={onBusyChange}
          captureSend={captureSend}
          captureComposer={captureComposer}
        />
      </ChatScope.Provider>
    </AssistantRuntimeProvider>
  );
}

/** Keep one chat mounted across view switches while isolating each session's runtime. */
export default function ChatThread(props: ComponentProps<typeof ChatRuntime>) {
  return <ChatRuntime key={props.sessionId} {...props} />;
}
