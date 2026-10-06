import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  Command,
  FileText,
  FolderOpen,
  GripVertical,
  LayoutDashboard,
  List,
  Menu,
  MessageSquare,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  X,
} from "lucide-react";
import WorkspaceApp from "./WorkspaceApp";
import ChatThread from "./chat/ChatThread";
import { DockHead, DockRail, DockResizeHandle } from "./chat/DockRail";
import { useDock } from "./chat/useDock";
import ArtifactCard from "./chat/ArtifactCard";
import SessionLog from "./SessionLog";
import Tooltip from "./Tooltip";
import ThemeMenu from "./theme/ThemeMenu";
import FileDropArea from "./ui/FileDropArea";
import Skeleton from "./ui/Skeleton";
import { promptTemplates } from "./lib/prompt-library";
import type { ComposerControls } from "./chat/ChatThread";
import type { StagedFile } from "./lib/chat-contract";
const PdfPreview = lazy(() => import("./files/PdfPreview"));
import type { ArtifactAction } from "./lib/chat-contract";
import {
  approved,
  getChatState,
  patchArtifact,
  useChatState,
} from "./lib/chat-store";
import { reviseCriteria, completeFitExamples, addResearchToCriteria } from "./lib/chat-driver";
import {
  getJob,
  getJobsSnapshot,
  startJobPolling,
  stopJob,
  subscribeJobs,
} from "./lib/chat-jobs";
import { plural } from "./lib/format";
import { commandPrompts, consideredCompanies } from "./lib/chat-policy";
import { downloadWorkbook } from "./lib/exports";
import { downloadCompleteSession } from "./lib/session-export";
import { sessionStore, useSessionSnapshot } from "./lib/session-store";
import type { LogFormat } from "./lib/session-contract";
import type {
  ScreeningConfig,
  ScreeningMode,
  ScreeningProvider,
} from "./lib/screening-contract";
import PrepareMenu from "./screening/PrepareMenu";
const SetupController = lazy(() => import("./screening/SetupController"));
const BingResearchDialog = lazy(() => import("./screening/BingResearchDialog"));
import BackgroundRuns, { type SearchRunView } from "./screening/BackgroundRuns";
import ScreeningInspector from "./chat/ScreeningInspector";
import { stageUploads } from "./lib/tool-client";
import { reviewShortlist, flushCriteriaDraft } from "./lib/review-client";
import { generateDraft } from "./lib/conversation-client";
import { backgroundAction, dismissBackground, getBackgroundJobs, isBackgroundActive, startBackgroundPolling, startBackgroundScreening, subscribeBackground } from "./lib/background-client";
import { previewBingResearch, runBingResearch } from "./lib/research-client";
import { processStagedUploads } from "./lib/import-pipeline";
import { researchQuestions } from "./lib/chat-driver";
import { updateChatState } from "./lib/chat-store";

type Panel = "context" | null;
type Dialog = "commands" | "prompts" | "criteria" | null;
type ResizeSide = "navigation" | "inspector";
const interfaceKey = "screening-interface-v1";
const navigationWidthKey = "screening-navigation-width-v1";
const inspectorWidthKey = "screening-inspector-width-v1";
const navigationMinWidth = 220;
const inspectorMinWidth = 300;
function savedWidth(key: string, fallback: number, min: number, max: number) {
  try {
    const value = Number(localStorage.getItem(key));
    if (Number.isFinite(value) && value >= min && value <= max) return value;
  } catch {
    /* Local storage is optional. */
  }
  return fallback;
}
function boundedWidth(value: number, min: number, max: number) {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}
function initialInterface(): "chat" | "workspace" {
  try {
    return localStorage.getItem(interfaceKey) === "workspace"
      ? "workspace"
      : "chat";
  } catch {
    return "chat";
  }
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    (
      ref.current?.querySelector<HTMLElement>("input,textarea") ??
      ref.current?.querySelector<HTMLElement>("button")
    )?.focus({ preventScroll: true });
    const trap = (event: KeyboardEvent) => {
      if (document.querySelector(".ui-select-content")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      const controls = ref.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]),input,textarea,a[href]",
      );
      if (!controls?.length) return;
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      prior?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div
      className="ct-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="ct-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="ct-dialog-head">
          <h2>{title}</h2>
          <button
            className="ct-icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            title="Close"
          >
            <X size={17} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function CriteriaEditor({
  sessionId,
  close,
  send,
}: {
  sessionId: string;
  close: () => void;
  send: (text: string) => void;
}) {
  const state = useChatState(sessionId);
  const [original, setOriginal] = useState(state.criteriaText),
    [business, setBusiness] = useState(state.definition),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title="Edit screening criteria" onClose={close}>
      <form
        className="ct-criteria-editor"
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          void (async () => {
            try {
              const job = getJob(state.jobId);
              if (job?.state === "running") await stopJob(job.id);
              reviseCriteria(sessionId, original, business);
              await flushCriteriaDraft(sessionId);
              sessionStore.addEvent({
                sessionId,
                kind: "system",
                status: "success",
                origin: "workspace",
                title: "Criteria revised",
                text: "Previous approval no longer applies. The revised business definition needs approval.",
              });
              close();
              send("/criteria");
            } catch (caught) {
              setError(
                caught instanceof Error ? caught.message : String(caught),
              );
              setSaving(false);
            }
          })();
        }}
      >
        <label>
          Screening brief
          <textarea
            value={original}
            onChange={(event) => setOriginal(event.target.value)}
            rows={4}
            required
          />
        </label>
        <label>
          Core business definition
          <textarea
            value={business}
            onChange={(event) => setBusiness(event.target.value)}
            rows={5}
            required
            placeholder="Products, services, and customer workflows to search for"
          />
        </label>
        <p>
          Search uses this business definition. Financials, size, geography,
          ownership, and industry codes remain reference details. Editing clears
          the previous approval.
        </p>
        {error && (
          <p role="alert" className="ct-error-copy">
            {error}
          </p>
        )}
        <div className="ct-dialog-actions">
          <button className="ct-ghost-button" type="button" onClick={close}>
            Cancel
          </button>
          <button
            className="ct-solid-button"
            type="submit"
            disabled={saving || !business.trim()}
          >
            {saving ? "Saving…" : "Save draft"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Palette({
  prompts,
  close,
  send,
  setDraft,
}: {
  prompts: boolean;
  close: () => void;
  send: (text: string) => void;
  setDraft: (text: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [templateId, setTemplateId] = useState(promptTemplates[0].id);
  const [draft, setDraftText] = useState(promptTemplates[0].text);
  const filtered = commandPrompts.filter((c) =>
    `${c.title} ${c.description} ${c.command}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const templates = promptTemplates.filter((c) =>
    `${c.title} ${c.description} ${c.category}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <Modal title={prompts ? "Prompt library" : "Commands"} onClose={close}>
      <div className="ct-palette-search">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={prompts ? "Find a starting prompt…" : "Find an action…"}
          aria-label={prompts ? "Find a prompt" : "Find a command"}
        />
      </div>
      {prompts ? (
        <div className="ct-prompt-library">
          <p>
            Choose a starting point, edit the text, then add it to your message.
          </p>
          <div className="ct-template-list">
            {templates.map((template) => (
              <button
                type="button"
                key={template.id}
                aria-pressed={templateId === template.id}
                onClick={() => {
                  setTemplateId(template.id);
                  setDraftText(template.text);
                }}
              >
                <span>
                  <strong>{template.title}</strong>
                  <small>{template.description}</small>
                </span>
                <span className="ct-template-category">
                  {template.category}
                </span>
              </button>
            ))}
            {!templates.length && <p>No prompts match this search.</p>}
          </div>
          <label className="ct-template-editor">
            Your prompt
            <textarea
              value={draft}
              onChange={(event) => setDraftText(event.target.value)}
              rows={4}
            />
          </label>
          <div className="ct-dialog-actions">
            <span>You can edit it again before sending.</span>
            <button
              className="ct-solid-button"
              type="button"
              disabled={!draft.trim()}
              onClick={() => {
                close();
                setDraft(draft);
              }}
            >
              Use prompt
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      ) : (
        <div className="ct-palette-options">
          {filtered.map((c) => (
            <button
              type="button"
              key={c.command}
              onClick={() => {
                close();
                send(c.command);
              }}
            >
              <div>
                <strong>{c.title}</strong>
                <span>{c.description}</span>
              </div>
              <code>{c.command}</code>
            </button>
          ))}
          {!filtered.length && <p>No commands match this search.</p>}
          <div className="ct-command-note">
            Commands run an action immediately. Use the prompt library for
            editable text.
          </div>
        </div>
      )}
    </Modal>
  );
}
export default function App() {
  const snapshot = useSessionSnapshot();
  const session = snapshot.sessions.find((s) => s.id === snapshot.activeId)!;
  const state = useChatState(session.id);
  const [mode, setMode] = useState(initialInterface),
    [sidebar, setSidebar] = useState(true),
    [mobileNav, setMobileNav] = useState(false),
    [threadQuery, setThreadQuery] = useState("");
  const [navigationWidth, setNavigationWidth] = useState(() =>
    savedWidth(navigationWidthKey, 236, navigationMinWidth, 460),
  );
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    savedWidth(inspectorWidthKey, window.innerWidth <= 1150 ? 320 : 420, inspectorMinWidth, 900),
  );
  const [inspectorExpanded, setInspectorExpanded] = useState(false);
  const previousInspectorWidth = useRef(inspectorWidth);
  const activeResize = useRef<{
    side: ResizeSide;
    pointerId: number;
    startX: number;
    startWidth: number;
  } | undefined>(undefined);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(navigationWidthKey, String(navigationWidth));
        if (!inspectorExpanded)
          localStorage.setItem(inspectorWidthKey, String(inspectorWidth));
      } catch {
        /* Resizing still works without saved preferences. */
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [navigationWidth, inspectorWidth, inspectorExpanded]);
  const [compact, setCompact] = useState(
    () => window.matchMedia("(max-width: 1000px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1000px)");
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const changeMode = useCallback((value: "chat" | "workspace") => {
    setMode(value);
    setPanel(null);
    setPreview(undefined);
    try {
      localStorage.setItem(interfaceKey, value);
    } catch {
      /* The selected view remains usable. */
    }
  }, []);
  const [panel, setPanel] = useState<Panel>(null),
    [dialog, setDialog] = useState<Dialog>(null),
    [log, setLog] = useState(false),
    [logEventId, setLogEventId] = useState<string>(),
    [busy, setBusy] = useState(false),
    [toast, setToast] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const [dismissedSearches, setDismissedSearches] = useState<ReadonlySet<string>>(new Set());
  const dock = useDock(sidebar && window.innerWidth > 760 ? navigationWidth : 0);
  const dockRail = mode === "workspace" && !compact && dock.state.mode === "rail";
  const dockOpen = dock.open;
  const [preview, setPreview] = useState<{ file: StagedFile; url?: string }>();
  const [newName, setNewName] = useState<string>();
  const [rename, setRename] = useState<string>();
  const [screeningSetup, setScreeningSetup] = useState<{
    key: string;
    sessionId: string;
    provider: ScreeningProvider;
    mode: ScreeningMode;
    request?: string;
    initialConfig?: ScreeningConfig;
  }>();
  const [bingSetup, setBingSetup] = useState<{ sessionId: string; queries: string[] }>();
  const [bingConnected, setBingConnected] = useState(false);
  const backgroundJobs = useSyncExternalStore(subscribeBackground, getBackgroundJobs, getBackgroundJobs);
  const allJobs = useSyncExternalStore(subscribeJobs, getJobsSnapshot, getJobsSnapshot);
  useEffect(startBackgroundPolling, []);
  useEffect(() => { void fetch("/api/health").then(r => r.json()).then(data => setBingConnected(data.providers?.bing === true)).catch(() => {}); }, []);
  // Anything that needs the composer calls this first: the full chat opens when
  // the Workspace chat is hidden (narrow window) and the dock leaves its rail.
  const revealChat = useCallback(() => {
    if (mode !== "workspace") return;
    if (compact) changeMode("chat");
    else if (dock.state.mode === "rail") flushSync(dockOpen);
  }, [mode, compact, changeMode, dock.state.mode, dockOpen]);
  const openSetup = useCallback(
    (
      provider: ScreeningProvider,
      screeningMode: ScreeningMode,
      request?: string,
      initialConfig?: ScreeningConfig,
    ) => {
      setDialog(null);
      if (screeningMode === "question") {
        updateChatState(session.id, { model: provider });
        setPanel(null);
        revealChat();
        requestAnimationFrame(() => {
          if (request?.trim()) composerRef.current?.setText(request);
          document.querySelector<HTMLTextAreaElement>(".ct-composer textarea")?.focus({ preventScroll: true });
        });
        return;
      }
      setScreeningSetup({
        key: crypto.randomUUID(),
        sessionId: session.id,
        provider,
        mode: screeningMode,
        request,
        initialConfig,
      });
    },
    [session.id, revealChat],
  );
  useEffect(
    () => () => {
      if (preview?.url) URL.revokeObjectURL(preview.url);
    },
    [preview?.url],
  );
  const closePreview = useCallback(() => setPreview(undefined), []);
  const previewLocalFile = useCallback(
    (file: File) => {
      if (!/\.pdf$/i.test(file.name)) return;
      if (mode === "workspace") changeMode("chat");
      setPanel(null);
      setPreview({
        file: {
          id: crypto.randomUUID(),
          name: file.name,
          bytes: file.size,
          kind: "pdf",
        },
        url: URL.createObjectURL(file),
      });
    },
    [mode, changeMode],
  );
  const composerRef = useRef<ComposerControls | undefined>(undefined);
  const captureComposer = useCallback((controls: ComposerControls) => {
    composerRef.current = controls;
  }, []);
  const setDraft = useCallback(
    (text: string) => {
      setPanel(null);
      revealChat();
      composerRef.current?.setText(text);
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLTextAreaElement>(".ct-composer textarea")
          ?.focus({ preventScroll: true }),
      );
    },
    [revealChat],
  );
  const addDroppedFiles = useCallback(
    (files: File[]) => {
      if (!files.length) {
        setToast("Drop files rather than a folder.");
        return;
      }
      revealChat();
      setPanel(null);
      void composerRef.current?.addFiles(files).then((count) => {
        if (count) setToast(`${plural(count, "file")} attached to chat.`);
      });
    },
    [revealChat],
  );
  const sendRef = useRef<(text: string, action?: ArtifactAction) => void>(
    () => {},
  );
  const captureSend = useCallback(
    (send: (text: string, action?: ArtifactAction) => void) => {
      sendRef.current = send;
    },
    [],
  );
  const send = useCallback(
    (text: string, action?: ArtifactAction) => {
      revealChat();
      sendRef.current(text, action);
    },
    [revealChat],
  );
  const openLog = useCallback((eventId?: string) => {
      setLogEventId(eventId);
      setLog(true);
    }, []),
    closeDialog = useCallback(() => setDialog(null), []),
    openContext = useCallback(() => {
      setPreview(undefined);
      setPanel((p) => (p === "context" ? null : "context"));
    }, []),
    openPrompts = useCallback(() => setDialog("prompts"), []);
  const job = useSyncExternalStore(
    subscribeJobs,
    () => getJob(state.jobId),
    () => undefined,
  );
  useEffect(startJobPolling, []);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        document.querySelector(".ui-select-content")
      )
        return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setDialog("commands");
      }
      if (event.key === "Escape") {
        setPanel(null);
        setMobileNav(false);
      }
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);
  const exportLog = useCallback(
    async (format: LogFormat) => {
      const current = sessionStore
        .getSnapshot()
        .sessions.find((s) => s.id === snapshot.activeId);
      if (current) await downloadCompleteSession(current, format);
    },
    [snapshot.activeId],
  );
  const onAction = useCallback(
    async (action: ArtifactAction) => {
      const current = getChatState(session.id),
        artifact = current.artifacts.find((a) => a.id === action.artifactId);
      try {
        if (action.type === "save-examples") {
          await completeFitExamples(session.id, action.artifactId, action.good, action.bad);
        } else if (action.type === "upload-source") {
          if (artifact?.type !== "enrichment-upload") throw new Error("Use a company-data upload card.");
          await stageUploads(action.files, { sessionId: session.id, purpose: action.source, uploadArtifactId: artifact.id });
          await processStagedUploads(session.id);
        } else if (action.type === "toggle-file") {
          updateChatState(session.id, state => ({ ...state, files: state.files.map(file => file.id === action.fileId ? { ...file, passToProvider: action.passToProvider } : file), artifacts: state.artifacts.map(item => item.type === "file" && item.file.id === action.fileId ? { ...item, file: { ...item.file, passToProvider: action.passToProvider } } : item) }));
        } else if (action.type === "review-shortlist") {
          await reviewShortlist(session.id, action.keepCompanyIds, action.planId, action.outputColumns);
          setToast(`${plural(consideredCompanies(getChatState(session.id)).length, "company", "companies")} kept. Recommendations updated.`);
        } else if (action.type === "use-answer-in-criteria" && artifact?.type === "research-answer") {
          await addResearchToCriteria(session.id, artifact.answer, artifact.question);
          patchArtifact(session.id, artifact.id, { applied: true });
        } else if (action.type === "start-screening" && artifact?.type === "screening-setup") {
          const job = await startBackgroundScreening(session.id, artifact.prepared);
          setToast(job.state === "blocked" ? job.message ?? "Provider unavailable. Setup saved." : "Screening started in the background.");
        } else if (action.type === "run-research") {
          setBingSetup({ sessionId: session.id, queries: artifact?.type === "research" ? artifact.questions : researchQuestions(current.definition) });
        } else if (action.type === "configure-screening") {
          openSetup(
            action.provider,
            action.mode,
            action.request,
            artifact?.type === "screening-setup"
              ? artifact.prepared.config
              : undefined,
          );
        } else if (
          action.type === "choose-option" &&
          (action.option === "llm" || action.option === "copilot")
        ) {
          openSetup(
            action.option === "llm" ? "llm_suite" : "copilot",
            "screening",
          );
        } else if (action.type === "choose-option" && action.option === "bing") {
          setBingSetup({ sessionId: session.id, queries: researchQuestions(current.definition) });
        } else if (action.type === "export" && artifact?.type === "companies") {
          const companies = artifact.backendRunId === current.backendRunId ? consideredCompanies(current) : artifact.companies;
          downloadWorkbook(action.format, companies);
          sessionStore.addEvent({
            sessionId: session.id,
            kind: "artifact",
            status: "success",
            origin: "workspace",
            title: `${action.format === "pitchbook" ? "PitchBook" : action.format === "llm" ? "LLM Suite" : "Full data"} export`,
            result: {
              type: "generated-workbook",
              format: action.format,
              companyIds: companies.map((c) => c.pk),
              rows: companies.length,
              fromArtifact: artifact.id,
            },
          });
          setToast(
            "Workbook downloaded. The export is recorded in the session log.",
          );
        } else if (
          action.type === "preview-file" &&
          artifact?.type === "file"
        ) {
          if (mode === "workspace") changeMode("chat");
          setPanel(null);
          setPreview({ file: artifact.file });
        } else if (action.type === "open-log") openLog();
        else if (
          action.type === "dismiss-options" &&
          artifact?.type === "options"
        ) {
          patchArtifact(session.id, artifact.id, { dismissed: true });
          sessionStore.addEvent({
            sessionId: session.id,
            kind: "approval",
            status: "success",
            origin: "workspace",
            title: "Next steps deferred",
            result: { artifactId: artifact.id, proceed: false },
          });
        } else if (action.type === "edit-criteria") {
          setDialog("criteria");
        } else if (action.type === "decline-criteria") {
          if (
            artifact?.type !== "criteria" ||
            artifact.revision !== current.revision
          )
            throw new Error("This criteria card is out of date.");
          patchArtifact(session.id, artifact.id, { decision: "declined" });
          sessionStore.addEvent({
            sessionId: session.id,
            kind: "approval",
            status: "success",
            origin: "workspace",
            title: "Criteria draft declined",
            result: { artifactId: artifact.id, revision: current.revision },
          });
          setToast("Draft declined. Edit the criteria when you are ready.");
        } else if (action.type === "stop-job")
          void stopJob(action.jobId).catch((error) => setToast(String(error)));
        else if (action.type === "upload") {
          setPanel(null);
          revealChat();
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLButtonElement>(
                '.ct-composer [aria-label="Attach files"]',
              )
              ?.click(),
          );
        } else if (action.type === "approve-criteria")
          send(artifact?.type === "criteria" && artifact.phase === "business" ? "Approve business criteria" : "Approve final criteria and find companies", action);
        else if (action.type === "choose-option")
          send(
            `Choose ${action.option === "pitchbook" ? "PitchBook data" : action.option === "rogo" ? "ROGO data" : action.option === "bing" ? "Bing research" : action.option === "llm" ? "LLM Suite screening" : "M365 Copilot screening"}`,
            action,
          );
        else if (action.type === "inspect-company")
          send(`@${action.companyId} Show company context`, action);
        else if (action.type === "inspect-checkpoint")
          send("/checkpoint", action);
      } catch (error) {
        setToast(error instanceof Error ? error.message : String(error));
        if (["save-examples", "upload-source", "review-shortlist", "use-answer-in-criteria"].includes(action.type)) throw error;
      }
    },
    [session.id, send, openLog, revealChat, changeMode, mode, openSetup],
  );
  const selectSession = (id: string) => {
    sessionStore.selectSession(id);
    setMobileNav(false);
    setPanel(null);
    setPreview(undefined);
    setBusy(false);
    setScreeningSetup(undefined);
    setBingSetup(undefined);
  };
  const newSession = (title: string) => {
    sessionStore.createSession(title);
    setNewName(undefined);
    setMobileNav(false);
    setPanel(null);
    setPreview(undefined);
    setBusy(false);
    setScreeningSetup(undefined);
    setBingSetup(undefined);
  };
  const maximumWidth = (side: ResizeSide) => {
    if (side === "navigation") {
      const inspectorSpace =
        mode === "chat" && panel && window.innerWidth > 980
          ? inspectorMinWidth
          : 0;
      return Math.max(
        navigationMinWidth,
        Math.min(460, window.innerWidth - inspectorSpace - 320),
      );
    }
    const navigationSpace =
      sidebar && window.innerWidth > 760
        ? Math.min(
            navigationWidth,
            window.innerWidth <= 980 ? window.innerWidth * 0.32 : navigationWidth,
          )
        : 0;
    const chatSpace = mode === "chat" && window.innerWidth > 980 ? 320 : 16;
    return Math.min(900, window.innerWidth - navigationSpace - chatSpace);
  };
  const startResize = (
    side: ResizeSide,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    activeResize.current = {
      side,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth:
        event.currentTarget.parentElement?.getBoundingClientRect().width ??
        (side === "navigation" ? navigationWidth : inspectorWidth),
    };
    if (side === "inspector") setInspectorExpanded(false);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = activeResize.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const change = event.clientX - active.startX;
    const width = boundedWidth(
      active.startWidth + (active.side === "navigation" ? change : -change),
      active.side === "navigation" ? navigationMinWidth : inspectorMinWidth,
      maximumWidth(active.side),
    );
    if (active.side === "navigation") setNavigationWidth(width);
    else setInspectorWidth(width);
  };
  const stopResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (activeResize.current?.pointerId !== event.pointerId) return;
    activeResize.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resizeWithKeyboard = (
    side: ResizeSide,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const step = event.shiftKey ? 40 : 20;
    const direction = side === "navigation" ? 1 : -1;
    const current = side === "navigation" ? navigationWidth : inspectorWidth;
    let next = current;
    if (event.key === "Home") next = side === "navigation" ? navigationMinWidth : inspectorMinWidth;
    else if (event.key === "End") next = maximumWidth(side);
    else if (event.key === "ArrowRight") next += direction * step;
    else if (event.key === "ArrowLeft") next -= direction * step;
    else return;
    event.preventDefault();
    next = boundedWidth(
      next,
      side === "navigation" ? navigationMinWidth : inspectorMinWidth,
      maximumWidth(side),
    );
    if (side === "navigation") setNavigationWidth(next);
    else {
      setInspectorWidth(next);
      setInspectorExpanded(false);
    }
  };
  const toggleInspectorSize = () => {
    if (inspectorExpanded) {
      setInspectorWidth(previousInspectorWidth.current);
      setInspectorExpanded(false);
    } else {
      previousInspectorWidth.current = inspectorWidth;
      setInspectorWidth(
        boundedWidth(maximumWidth("inspector"), inspectorMinWidth, 900),
      );
      setInspectorExpanded(true);
    }
  };
  // One discovery search per screening (its latest), listed in the Activity dock.
  const searches = useMemo<SearchRunView[]>(
    () =>
      snapshot.sessions.flatMap((s) => {
        const job = getJob(getChatState(s.id).jobId);
        if (!job || dismissedSearches.has(job.id)) return [];
        return [
          {
            id: job.id,
            sessionId: s.id,
            title: s.title,
            state: job.state,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            toolCalls: job.events.filter((e) => e.type === "tool-start").length,
            error: job.error,
          },
        ];
      }),
    // allJobs changes whenever any job does; state.jobId covers a new search starting.
    [snapshot.sessions, allJobs, state.jobId, dismissedSearches],
  );
  const activityRunning =
    searches.some((search) => search.state === "running") ||
    isBackgroundActive(backgroundJobs);
  const chatBusy = busy || job?.state === "running";
  const appRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // overflow:clip already stops these boxes from scrolling. If anything still
    // manages to move them (older engines fall back to overflow:hidden), put the
    // header straight back.
    const app = appRef.current;
    if (!app) return;
    const guard = (event: Event) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target === app || target.matches(".ct-main, .ct-body")) &&
        (target.scrollTop !== 0 || target.scrollLeft !== 0)
      )
        target.scrollTo(0, 0);
    };
    app.addEventListener("scroll", guard, true);
    return () => app.removeEventListener("scroll", guard, true);
  }, []);
  return (
    <div
      ref={appRef}
      data-interface={mode}
      className={`ct-app ${sidebar ? "" : "ct-sidebar-collapsed"} ${mode === "workspace" ? "ct-workspace-mode" : ""}`}
      style={
        {
          "--ct-navigation-width": `${navigationWidth}px`,
          "--ct-inspector-width": `${inspectorWidth}px`,
          "--ct-dock-width": `${dock.columnWidth}px`,
          "--ct-dock-open-width": `${dock.openWidth}px`,
        } as CSSProperties
      }
    >
      {mobileNav && (
        <button
          className="ct-mobile-overlay"
          type="button"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside
        className={`ct-sidebar ${mobileNav ? "ct-mobile-open" : ""}`}
        aria-label="Screening navigation"
        inert={!sidebar && !mobileNav}
        aria-hidden={!sidebar && !mobileNav ? true : undefined}
      >
        <div className="ct-brand">
          <span className="ct-brand-mark">s.</span>
          <strong>Screening</strong>
          <button
            className="ct-icon-button"
            type="button"
            title="Collapse navigation"
            aria-label="Collapse navigation"
            onClick={() => {
              setSidebar(false);
              setMobileNav(false);
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLButtonElement>(".ct-nav-toggle")
                  ?.focus({ preventScroll: true }),
              );
            }}
          >
            <PanelLeftClose size={17} />
          </button>
        </div>
        <button
          className="ct-new-thread"
          type="button"
          onClick={() => setNewName("")}
        >
          <Plus size={16} />
          New screening
        </button>
        <div className="ct-thread-search">
          <Search size={14} />
          <input
            value={threadQuery}
            onChange={(event) => setThreadQuery(event.target.value)}
            placeholder="Find a screening"
            aria-label="Find a screening"
          />
        </div>
        <div className="ct-sidebar-section-label">Your screenings</div>
        <nav className="ct-thread-list">
          {snapshot.sessions
            .filter((s) =>
              s.title.toLowerCase().includes(threadQuery.toLowerCase()),
            )
            .slice()
            .reverse()
            .map((s) => (
              <button
                type="button"
                key={s.id}
                className={s.id === session.id ? "ct-thread-selected" : ""}
                aria-current={s.id === session.id ? "page" : undefined}
                onClick={() => selectSession(s.id)}
              >
                <MessageSquare size={14} />
                <span>{s.title}</span>
                {getJob(getChatState(s.id).jobId)?.state === "running" && (
                  <span
                    className="ct-status-pulse"
                    title="Background search running"
                  />
                )}
              </button>
            ))}
          {!snapshot.sessions.some((s) =>
            s.title.toLowerCase().includes(threadQuery.toLowerCase()),
          ) && <p>No screenings found.</p>}
        </nav>
        <div className="ct-sidebar-bottom">
          <button type="button" onClick={() => setDialog("commands")}>
            <Command size={15} />
            Commands<kbd>Ctrl K</kbd>
          </button>
          <button type="button" onClick={() => setDialog("prompts")}>
            <FileText size={15} />
            Prompt library
          </button>
          <div className="ct-local-connection">
            <span className="ct-status-dot ct-approved" />
            Local workspace
            <Tooltip label="About local storage">
              The browser stores conversations. The application stores company
              data and checkpoints. Running jobs and uploaded file references
              last while the local server runs.
            </Tooltip>
          </div>
        </div>
        <div
          className="ct-resize-handle ct-resize-navigation"
          role="separator"
          aria-label="Resize navigation"
          aria-orientation="vertical"
          aria-valuemin={navigationMinWidth}
          aria-valuemax={maximumWidth("navigation")}
          aria-valuenow={navigationWidth}
          tabIndex={0}
          title="Drag to resize navigation, or use the arrow keys"
          onPointerDown={(event) => startResize("navigation", event)}
          onPointerMove={moveResize}
          onPointerUp={stopResize}
          onPointerCancel={stopResize}
          onKeyDown={(event) => resizeWithKeyboard("navigation", event)}
        >
          <GripVertical size={14} />
        </div>
      </aside>
      <main className="ct-main">
        <header className="ct-header">
          <div className="ct-header-title">
            <button
              className="ct-icon-button ct-nav-toggle"
              type="button"
              onClick={() => {
                setSidebar(true);
                setMobileNav(true);
              }}
              aria-label="Open navigation"
              title="Open navigation"
            >
              <Menu size={18} />
            </button>
            <div>
              <button
                className="ct-session-title"
                type="button"
                onClick={() => setRename(session.title)}
                title="Rename screening"
              >
                <span className="ct-session-title-text">{session.title}</span>
                <ChevronDown size={12} />
              </button>
              <span>
                {job?.state === "running"
                  ? "Searching companies"
                  : approved(state)
                    ? `${plural(consideredCompanies(state).length, "company", "companies")} · criteria approved`
                    : state.criteriaText
                      ? "Review criteria before searching"
                      : "Ready when you are"}
              </span>
            </div>
          </div>
          <div className="ct-header-actions">
            <div className="ct-header-slot" title="Screen">
              <PrepareMenu
                hasCompanies={state.companies.length > 0}
                onResearch={() => setBingSetup({ sessionId: session.id, queries: researchQuestions(state.definition) })}
                onChoose={openSetup}
              />
            </div>
            <div className="ct-view-switch" aria-label="Choose interface">
              <button
                type="button"
                className={mode === "chat" ? "ct-view-active" : ""}
                aria-pressed={mode === "chat"}
                onClick={() => changeMode("chat")}
              >
                <MessageSquare size={13} />
                Chat
              </button>
              <button
                type="button"
                className={mode === "workspace" ? "ct-view-active" : ""}
                onClick={() => changeMode("workspace")}
                aria-pressed={mode === "workspace"}
                title="Review companies, files, and screening progress"
              >
                <LayoutDashboard size={13} />
                Workspace
              </button>
            </div>
            <ThemeMenu />
            <button
              className={`ct-icon-button ${panel === "context" ? "ct-control-active" : ""}`}
              type="button"
              onClick={openContext}
              aria-label="Context"
              aria-pressed={panel === "context"}
              title="Context"
            >
              <FolderOpen size={17} />
            </button>
            <button
              className={`ct-icon-button ${activityOpen ? "ct-control-active" : ""}`}
              type="button"
              onClick={() => setActivityOpen((open) => !open)}
              aria-label="Activity"
              aria-pressed={activityOpen}
              title="Activity"
            >
              <Clock3 size={17} />
              {activityRunning && <span className="ct-control-dot" />}
            </button>
            <button
              className="ct-log-button"
              type="button"
              onClick={() => openLog()}
              aria-label="Session log"
              title="Session log"
            >
              <List size={15} />
              <span>Session log</span>
            </button>
          </div>
        </header>
        <FileDropArea
          className={`ct-body ct-body-${mode}${preview ? " ct-preview-open" : ""}`}
          onFiles={addDroppedFiles}
        >
          {mode === "workspace" && (
            <section
              className="ct-workspace-surface"
              aria-label="Screening workspace"
            >
              <WorkspaceApp
                key={session.id}
                sessionTitle={session.title}
                state={state}
                job={job}
                busy={busy}
                onAction={onAction}
                send={send}
                openLog={openLog}
              />
            </section>
          )}
          <section
            className={`ct-chat-surface ${mode === "workspace" ? "ct-chat-docked" : ""}${dockRail ? " is-rail" : ""}`}
            aria-label="Screening assistant"
            inert={mode === "workspace" && (compact || dockRail)}
            aria-hidden={mode === "workspace" && (compact || dockRail) ? true : undefined}
          >
            {mode === "workspace" && !compact && !dockRail && (
              <DockResizeHandle
                width={dock.columnWidth}
                max={dock.maxWidth}
                onResize={dock.resize}
              />
            )}
            {mode === "workspace" && (
              <DockHead
                expanded={dock.state.mode === "expanded"}
                busy={chatBusy}
                onCollapse={dock.collapse}
                onToggleExpanded={dock.toggleExpanded}
                onOpenFullChat={() => changeMode("chat")}
              />
            )}
            <ChatThread
              key={session.id}
              sessionId={session.id}
              title={session.title}
              onAction={onAction}
              openLog={openLog}
              openContext={openContext}
              openPrompts={openPrompts}
              captureSend={captureSend}
              captureComposer={captureComposer}
              previewFile={previewLocalFile}
              onBusyChange={setBusy}
            />
          </section>
          {dockRail && <DockRail busy={chatBusy} onOpen={dock.open} />}
          {preview && (
            <aside className="ct-pdf-pane" aria-label="Document preview">
              <Suspense
                fallback={
                  <div className="ct-preview-loading">
                    <Skeleton variant="drawer" label="Opening PDF preview" />
                  </div>
                }
              >
                <PdfPreview
                  key={preview.file.id}
                  file={preview.file}
                  url={preview.url}
                  onClose={closePreview}
                />
              </Suspense>
            </aside>
          )}
          {panel && (
            <aside className="ct-inspector" aria-label="Context">
              <div
                className="ct-resize-handle ct-resize-inspector"
                role="separator"
                aria-label="Resize side panel"
                aria-orientation="vertical"
                aria-valuemin={inspectorMinWidth}
                aria-valuemax={maximumWidth("inspector")}
                aria-valuenow={inspectorWidth}
                tabIndex={0}
                title="Drag to resize the panel, or use the arrow keys"
                onPointerDown={(event) => startResize("inspector", event)}
                onPointerMove={moveResize}
                onPointerUp={stopResize}
                onPointerCancel={stopResize}
                onKeyDown={(event) => resizeWithKeyboard("inspector", event)}
              >
                <GripVertical size={14} />
              </div>
              <div className="ct-inspector-head">
                <h2>Context</h2>
                <div className="ct-inspector-actions">
                  <button
                    className="ct-icon-button"
                    type="button"
                    onClick={toggleInspectorSize}
                    aria-label={inspectorExpanded ? "Restore panel size" : "Expand panel"}
                    title={inspectorExpanded ? "Restore panel size" : "Expand panel"}
                  >
                    {inspectorExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                  </button>
                  <button
                    className="ct-icon-button"
                    type="button"
                    onClick={() => setPanel(null)}
                    aria-label="Close panel"
                    title="Close panel"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
              <ScreeningInspector state={state} criteriaFirst send={send} edit={() => setDialog("criteria")} preview={artifactId => { void onAction({ type: "preview-file", artifactId }); }} />
            </aside>
          )}
        </FileDropArea>
        <BackgroundRuns
          jobs={backgroundJobs.map(job => ({ ...job, title: `${snapshot.sessions.find(s => s.id === job.sessionId)?.title ?? job.title} · ${job.provider === "llm_suite" ? "LLM Suite" : "M365 Copilot"}` }))}
          searches={searches}
          expanded={activityOpen}
          onExpandedChange={setActivityOpen}
          layoutKey={`${mode}:${dockRail ? "rail" : "open"}`}
          onDismiss={dismissBackground}
          onAction={(id, action) => { void backgroundAction(id, action).then(() => setToast(action === "stage" ? "Accepted results staged in chat." : "Background screening updated.")).catch(error => setToast(String(error))); }}
          onOpenSearch={selectSession}
          onStopSearch={id => { void stopJob(id).catch(error => setToast(String(error))); }}
          onDismissSearch={id => setDismissedSearches(previous => new Set(previous).add(id))}
        />
      </main>
      <SessionLog
        open={log}
        sessionId={session.id}
        initialSelectedId={logEventId}
        onClose={() => setLog(false)}
        onExport={exportLog}
      />
      {newName !== undefined && (
        <Modal title="New screening" onClose={() => setNewName(undefined)}>
          <form
            className="ct-rename-form"
            onSubmit={(event) => {
              event.preventDefault();
              const title = newName.trim();
              if (title) newSession(title);
            }}
          >
            <label>
              Screening name
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="e.g. Insurance claims software"
                maxLength={160}
                required
              />
            </label>
            <div className="ct-dialog-actions">
              <button
                className="ct-ghost-button"
                type="button"
                onClick={() => setNewName(undefined)}
              >
                Cancel
              </button>
              <button
                className="ct-solid-button"
                type="submit"
                disabled={!newName.trim()}
              >
                Create screening
              </button>
            </div>
          </form>
        </Modal>
      )}
      {rename !== undefined && (
        <Modal title="Rename screening" onClose={() => setRename(undefined)}>
          <form
            className="ct-rename-form"
            onSubmit={(event) => {
              event.preventDefault();
              sessionStore.renameSession(session.id, rename);
              setRename(undefined);
            }}
          >
            <label>
              Screening name
              <input
                value={rename}
                onChange={(event) => setRename(event.target.value)}
                maxLength={160}
                required
              />
            </label>
            <div className="ct-dialog-actions">
              <button
                className="ct-ghost-button"
                type="button"
                onClick={() => setRename(undefined)}
              >
                Cancel
              </button>
              <button className="ct-solid-button" disabled={!rename.trim()}>
                Save name
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === "criteria" && (
        <CriteriaEditor
          key={session.id}
          sessionId={session.id}
          close={closeDialog}
          send={send}
        />
      )}
      {(dialog === "commands" || dialog === "prompts") && (
        <Palette
          key={dialog}
          prompts={dialog === "prompts"}
          setDraft={setDraft}
          close={closeDialog}
          send={send}
        />
      )}
      {screeningSetup && (
        <Suspense
          fallback={
            <div className="ct-toast ct-toast-skeleton">
              <Skeleton variant="line" lines={2} label="Opening setup" />
            </div>
          }
        >
          <SetupController
            {...screeningSetup}
            onClose={() => setScreeningSetup(undefined)}
            onSaved={(prepared) => {
              void startBackgroundScreening(screeningSetup.sessionId, prepared).then(job => setToast(job.state === "blocked" ? job.message ?? "Provider unavailable. Setup saved." : "Screening is running in the background.")).catch(error => setToast(String(error)));
            }}
          />
        </Suspense>
      )}
      {bingSetup && <Suspense fallback={<div className="ct-toast ct-toast-skeleton"><Skeleton variant="line" lines={2} label="Opening web research" /></div>}><BingResearchDialog key={bingSetup.sessionId} companies={consideredCompanies(getChatState(bingSetup.sessionId))} initialQueries={bingSetup.queries} connected={bingConnected} onClose={() => setBingSetup(undefined)} onPreview={input => previewBingResearch(bingSetup.sessionId, input)} onGenerateTemplates={() => generateDraft(bingSetup.sessionId, "bing-templates")} onRun={(token, options) => runBingResearch(bingSetup.sessionId, token, options)} /></Suspense>}
      {toast && (
        <div className="ct-toast" role="status">
          <Check size={15} />
          {toast}
          <button
            type="button"
            onClick={() => setToast("")}
            aria-label="Dismiss notification"
          >
            <X size={13} />
          </button>
        </div>
      )}
      {snapshot.storageError && (
        <div className="ct-storage-error" role="alert">
          {snapshot.storageError}
        </div>
      )}
    </div>
  );
}
