import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type TouchEvent,
  type WheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, Clipboard, Download, File, Search, X } from "lucide-react";
import type {
  LogFormat,
  ResearchSession,
  SessionEvent,
} from "./lib/session-contract";
import { resultOmitted, useSessionSnapshot } from "./lib/session-store";
import { downloadCompleteSession } from "./lib/session-export";
import {
  filterTrajectoryEvents,
  formatDuration,
  groupTrajectoryEvents,
  recordedSpan,
} from "./lib/session-trajectory";
import { formatDateTime, plural } from "./lib/format";
import SelectField from "./ui/SelectField";
import SessionTiming from "./chat/SessionTiming";
import "./session-log.css";

type SessionLogProps = {
  open: boolean;
  onClose: () => void;
  sessionId?: string;
  initialSelectedId?: string;
  onExport?: (format: LogFormat) => Promise<void>;
};
type KindFilter = "all" | SessionEvent["kind"];
type StatusFilter = "all" | SessionEvent["status"] | "completed" | "errors";
type InspectorTab = "Summary" | "Input" | "Output" | "Raw" | "Timing";
const PAGE_SIZE = 100;
const TABS: InspectorTab[] = ["Summary", "Input", "Output", "Raw", "Timing"];
const statusText = (status: SessionEvent["status"]) =>
  status === "success"
    ? "Completed"
    : status === "error"
      ? "Error"
      : status === "cancelled"
        ? "Cancelled"
        : status === "running"
          ? "Running"
          : "Pending";
const readableTime = (value: string) =>
  formatDateTime(value, { seconds: true }) || value;
const jsonText = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
const objectRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

type DeclaredFile = {
  id: string;
  name: string;
  bytes: number;
  kind: string;
  href: string;
};
function declaredFiles(event: SessionEvent): DeclaredFile[] {
  const candidates: unknown[] = [event.result, event.content];
  for (const candidate of candidates) {
    const values = Array.isArray(candidate) ? candidate : [candidate];
    for (const value of values) {
      const artifact = objectRecord(value);
      if (artifact?.type !== "file") continue;
      const file = objectRecord(artifact.file);
      if (
        !file ||
        typeof file.id !== "string" ||
        !file.id ||
        typeof file.name !== "string" ||
        typeof file.kind !== "string" ||
        typeof file.bytes !== "number" ||
        !Number.isFinite(file.bytes) ||
        file.bytes < 0
      )
        continue;
      const href = safeFileHref(`/api/files/${encodeURIComponent(file.id)}`);
      if (href)
        return [
          {
            id: file.id,
            name: file.name,
            kind: file.kind,
            bytes: file.bytes,
            href,
          },
        ];
    }
  }
  return [];
}

function safeFileHref(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    typeof window === "undefined"
  )
    return undefined;
  try {
    const url = new URL(value, window.location.origin);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== window.location.origin ||
      url.username ||
      url.password
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function CopyButton({
  value,
  label = "Copy JSON",
}: {
  value: unknown;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const timeout = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timeout.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        typeof value === "string" ? value : jsonText(value),
      );
      setCopied(true);
      setError("");
      window.clearTimeout(timeout.current);
      timeout.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
      setError("Could not copy to clipboard.");
    }
  };
  return (
    <span className="sl-copy-wrap">
      <button
        type="button"
        className="sl-copy"
        onClick={copy}
        aria-label={label}
      >
        {copied ? <Check size={15} /> : <Clipboard size={15} />}
        <span>{copied ? "Copied" : label}</span>
      </button>
      {error && (
        <span role="status" className="sl-copy-error">
          {error}
        </span>
      )}
    </span>
  );
}

function DataBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <section className="sl-inspector-block">
      <div className="sl-block-heading">
        <strong>{label}</strong>
        <CopyButton value={value} />
      </div>
      <pre>{resultOmitted(value) ? "Result not saved (large)" : jsonText(value)}</pre>
    </section>
  );
}

function ArtifactFiles({ files }: { files: DeclaredFile[] }) {
  if (!files.length) return null;
  return (
    <section className="sl-inspector-block">
      <div className="sl-block-heading">
        <strong>Files</strong>
        <span>{files.length} declared</span>
      </div>
      <div className="sl-files">
        {files.map((file, index) => (
          <div className="sl-file" key={`${file.name}-${index}`}>
            <File size={17} aria-hidden="true" />
            <span className="sl-file-name" title={file.name}>
              {file.href ? (
                <a href={file.href} target="_blank" rel="noreferrer">
                  {file.name}
                </a>
              ) : (
                file.name
              )}
            </span>
            <span>{file.kind}</span>
            <span>{file.bytes.toLocaleString()} bytes</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Inspector({
  event,
  tab,
  onTab,
}: {
  event: SessionEvent;
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
}) {
  const span = recordedSpan(event);
  const files = declaredFiles(event);
  return (
    <aside
      className="sl-inspector"
      aria-label={`Event inspector: ${event.title}`}
    >
      <div className="sl-inspector-head">
        <div>
          <span className="sl-inspector-eyebrow">
            Selected record · {event.sequence}
          </span>
          <h3>{event.title}</h3>
          <span className="sl-inspector-meta">
            {event.toolName || event.kind} · {event.origin} ·{" "}
            {statusText(event.status)}
          </span>
        </div>
        <CopyButton value={event} label="Copy event" />
      </div>
      <div
        className="sl-inspector-tabs"
        role="tablist"
        aria-label="Record details"
      >
        {TABS.map((name) => (
          <button
            key={name}
            id={`sl-tab-${name.toLowerCase()}`}
            type="button"
            role="tab"
            aria-controls="sl-record-panel"
            aria-selected={tab === name}
            tabIndex={tab === name ? 0 : -1}
            className={tab === name ? "is-active" : ""}
            onClick={() => onTab(name)}
            onKeyDown={(event) => {
              const current = TABS.indexOf(name);
              const index =
                event.key === "ArrowRight"
                  ? (current + 1) % TABS.length
                  : event.key === "ArrowLeft"
                    ? (current + TABS.length - 1) % TABS.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? TABS.length - 1
                        : -1;
              if (index >= 0) {
                event.preventDefault();
                onTab(TABS[index]);
                document
                  .getElementById(`sl-tab-${TABS[index].toLowerCase()}`)
                  ?.focus({ preventScroll: true });
              }
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        className="sl-inspector-body"
        id="sl-record-panel"
        role="tabpanel"
        aria-labelledby={`sl-tab-${tab.toLowerCase()}`}
        tabIndex={0}
      >
        {tab === "Summary" && (
          <>
            <dl className="sl-summary-grid">
              <div>
                <dt>Started</dt>
                <dd>{readableTime(event.startedAt)}</dd>
              </div>
              <div>
                <dt>Finished</dt>
                <dd>
                  {event.finishedAt
                    ? readableTime(event.finishedAt)
                    : event.status === "running"
                      ? "In progress"
                      : "Not recorded"}
                </dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>
                  {span?.durationMs === undefined
                    ? event.status === "running"
                      ? "In progress"
                      : "Not recorded"
                    : formatDuration(span.durationMs)}
                </dd>
              </div>
              <div>
                <dt>Turn</dt>
                <dd>{event.turnId || "Between turns"}</dd>
              </div>
            </dl>
            {event.text !== undefined && (
              <section className="sl-inspector-block">
                <strong className="sl-block-label">Message</strong>
                <p className="sl-inspector-text">
                  {event.text || "(empty message)"}
                </p>
              </section>
            )}
            {event.error && (
              <section className="sl-inspector-block sl-inspector-error">
                <strong>Error</strong>
                <p>{event.error}</p>
              </section>
            )}
            <ArtifactFiles files={files} />
          </>
        )}
        {tab === "Input" && (
          <>
            {event.args !== undefined ? (
              <DataBlock label="Arguments" value={event.args} />
            ) : event.text !== undefined ? (
              <section className="sl-inspector-block">
                <div className="sl-block-heading">
                  <strong>Message input</strong>
                  <CopyButton value={event.text} label="Copy text" />
                </div>
                <pre className="sl-text-pre">{event.text}</pre>
              </section>
            ) : (
              <p className="sl-inspector-empty">
                No input was recorded for this event.
              </p>
            )}
            <ArtifactFiles files={files} />
          </>
        )}
        {tab === "Output" && (
          <>
            {event.result !== undefined ? (
              <DataBlock label="Result" value={event.result} />
            ) : event.content !== undefined ? (
              <DataBlock label="Content" value={event.content} />
            ) : event.text !== undefined && event.role === "assistant" ? (
              <section className="sl-inspector-block">
                <div className="sl-block-heading">
                  <strong>Assistant output</strong>
                  <CopyButton value={event.text} label="Copy text" />
                </div>
                <pre className="sl-text-pre">{event.text}</pre>
              </section>
            ) : (
              <p className="sl-inspector-empty">
                No output was recorded for this event.
              </p>
            )}
            {event.error && (
              <section className="sl-inspector-block sl-inspector-error">
                <strong>Error</strong>
                <p>{event.error}</p>
              </section>
            )}
            <ArtifactFiles files={files} />
          </>
        )}
        {tab === "Raw" && <DataBlock label="Raw event JSON" value={event} />}
        {tab === "Timing" && (
          <>
            <dl className="sl-summary-grid">
              <div>
                <dt>Recorded start</dt>
                <dd>{readableTime(event.startedAt)}</dd>
              </div>
              <div>
                <dt>Recorded finish</dt>
                <dd>
                  {event.finishedAt
                    ? readableTime(event.finishedAt)
                    : "Not recorded"}
                </dd>
              </div>
              <div>
                <dt>Recorded duration</dt>
                <dd>
                  {span?.durationMs === undefined
                    ? "Not available"
                    : `${formatDuration(span.durationMs)} (${span.durationMs} ms)`}
                </dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>
                  {event.status === "running"
                    ? "Started · still running"
                    : statusText(event.status)}
                </dd>
              </div>
            </dl>
            <p className="sl-timing-note">
              Duration is calculated from the recorded start and finish
              timestamps.
            </p>
          </>
        )}
      </div>
    </aside>
  );
}

export default function SessionLog({
  open,
  onClose,
  sessionId,
  initialSelectedId,
  onExport,
}: SessionLogProps) {
  const snapshot = useSessionSnapshot();
  const activeSessionId = sessionId ?? snapshot.activeId;
  const session: ResearchSession | undefined = snapshot.sessions.find(
    (candidate) => candidate.id === activeSessionId,
  );
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [autoFollow, setAutoFollow] = useState(true);
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [exportStatus, setExportStatus] = useState("");
  const [exporting, setExporting] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("Summary");
  const [mobileView, setMobileView] = useState<"activity" | "details">(
    "activity",
  );
  const drawerRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const ledgerRef = useRef<HTMLDivElement>(null);
  const lastTouchY = useRef<number | null>(null);
  const pointerScrolling = useRef(false);
  const lastScrollTop = useRef(0);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() =>
      drawerRef.current
        ?.querySelector<HTMLElement>("[data-autofocus]")
        ?.focus({ preventScroll: true }),
    );
    const onKey = (event: KeyboardEvent) => {
      // Portaled selects own their focus and first Escape. Keep the log open
      // until the user has dismissed the nested menu.
      if (document.querySelector(".ui-select-content")) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
      }
      if (event.key !== "Tab" || !drawerRef.current) return;
      const controls = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((item) => item.offsetParent !== null);
      if (!controls.length) {
        event.preventDefault();
        return;
      }
      const first = controls[0],
        last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey, true);
      opener.current?.focus({ preventScroll: true });
    };
  }, [open]);

  const events = useMemo(
    () =>
      session
        ? filterTrajectoryEvents(session.events, { kind, status, query })
        : [],
    [session, kind, status, query],
  );
  const visibleEvents = useMemo(
    () => events.slice(Math.max(0, events.length - visibleLimit)),
    [events, visibleLimit],
  );
  const groups = useMemo(
    () => groupTrajectoryEvents(visibleEvents, session?.events ?? []),
    [visibleEvents, session],
  );
  const selected =
    visibleEvents.find((event) => event.id === selectedId) ??
    visibleEvents.at(-1);
  const previousTail = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    if (!selectedId && visibleEvents.length)
      setSelectedId(visibleEvents.at(-1)?.id);
    const tail = events.at(-1)?.id;
    if (tail !== previousTail.current && autoFollow) {
      setSelectedId(tail);
      ledgerRef.current?.scrollTo({
        top: ledgerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
    previousTail.current = tail;
  }, [open, activeSessionId, events, visibleEvents, selectedId, autoFollow]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setKind("all");
    setStatus("all");
    setExportStatus("");
    setVisibleLimit(PAGE_SIZE);
    setAutoFollow(true);
    setInspectorTab("Summary");
    setSelectedId(initialSelectedId ?? session?.events.at(-1)?.id);
    previousTail.current = session?.events.at(-1)?.id;
    setMobileView(initialSelectedId ? "details" : "activity");
    if (initialSelectedId) {
      setAutoFollow(false);
      const index =
        session?.events.findIndex((e) => e.id === initialSelectedId) ?? -1;
      if (index >= 0)
        setVisibleLimit(Math.max(PAGE_SIZE, session!.events.length - index));
    }
    requestAnimationFrame(() => {
      if (initialSelectedId)
        document
          .getElementById(`sl-event-${initialSelectedId}`)
          ?.scrollIntoView({ block: "nearest" });
      else ledgerRef.current?.scrollTo({ top: ledgerRef.current.scrollHeight });
    });
  }, [open, activeSessionId, initialSelectedId]);

  if (!open) return null;
  const exportFile = async (format: LogFormat) => {
    if (!session || exporting) return;
    setExporting(true);
    setExportStatus("Preparing export…");
    try {
      if (onExport) await onExport(format);
      else await downloadCompleteSession(session, format);
      setExportStatus("Download started.");
    } catch (error) {
      setExportStatus(
        `Download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setExporting(false);
    }
  };
  const loadEarlier = () => {
    setAutoFollow(false);
    setVisibleLimit((limit) => limit + PAGE_SIZE);
  };
  const followLatest = (enabled: boolean) => {
    setAutoFollow(enabled);
    if (enabled) {
      setVisibleLimit(PAGE_SIZE);
      requestAnimationFrame(() =>
        ledgerRef.current?.scrollTo({
          top: ledgerRef.current.scrollHeight,
          behavior: "smooth",
        }),
      );
    }
  };
  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (
      event.deltaY < 0 &&
      ledgerRef.current &&
      ledgerRef.current.scrollTop > 0
    )
      setAutoFollow(false);
  };
  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    lastTouchY.current = event.touches[0]?.clientY ?? null;
  };
  const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const y = event.touches[0]?.clientY;
    if (
      y !== undefined &&
      lastTouchY.current !== null &&
      y > lastTouchY.current &&
      (ledgerRef.current?.scrollTop ?? 0) > 0
    )
      setAutoFollow(false);
    if (y !== undefined) lastTouchY.current = y;
  };
  const handleScroll = () => {
    const top = ledgerRef.current?.scrollTop ?? 0;
    if (pointerScrolling.current && top < lastScrollTop.current)
      setAutoFollow(false);
    lastScrollTop.current = top;
  };
  const clearFilters = () => {
    setQuery("");
    setKind("all");
    setStatus("all");
    setVisibleLimit(PAGE_SIZE);
  };
  const filtered = (session?.events.length ?? 0) !== events.length;

  return createPortal(
    <div
      className="sl-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="sl-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sl-heading"
        ref={drawerRef}
      >
        <header className="sl-header">
          <div className="sl-heading-wrap">
            <div className="sl-heading-line">
              <h2 id="sl-heading">Session log</h2>
              <span className="sl-local-badge">Local session</span>
            </div>
            <p>
              {session?.title ?? "Session unavailable"}
              {session ? ` · ${plural(session.events.length, "event")}` : ""}
            </p>
          </div>
          <button
            className="sl-icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close session log"
            data-autofocus
          >
            <X size={19} />
          </button>
        </header>
        {snapshot.storageError && (
          <div className="sl-storage-error" role="alert">
            <strong>Local storage notice</strong>
            <span>{snapshot.storageError}</span>
          </div>
        )}
        {session && (
          <>
            <div className="sl-tools">
              <label className="sl-search">
                <Search size={17} />
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setVisibleLimit(PAGE_SIZE);
                  }}
                  placeholder="Search all event details"
                  aria-label="Search this session"
                />
              </label>
              <div className="sl-filter-row">
                <label>
                  <span>Kind</span>
                  <SelectField
                    value={kind}
                    label="Filter by event kind"
                    onChange={(value) => {
                      setKind(value as KindFilter);
                      setVisibleLimit(PAGE_SIZE);
                    }}
                    options={[
                      ["all", "All kinds"],
                      ["message", "Messages"],
                      ["tool", "Tools"],
                      ["approval", "Approvals"],
                      ["system", "System"],
                      ["artifact", "Artifacts"],
                    ].map(([value, label]) => ({ value, label }))}
                  />
                </label>
                <label>
                  <span>Status</span>
                  <SelectField
                    value={status}
                    label="Filter by status"
                    onChange={(value) => {
                      setStatus(value as StatusFilter);
                      setVisibleLimit(PAGE_SIZE);
                    }}
                    options={[
                      ["all", "All statuses"],
                      ["running", "Running"],
                      ["completed", "Completed"],
                      ["errors", "Errors"],
                      ["cancelled", "Cancelled"],
                      ["pending", "Pending"],
                    ].map(([value, label]) => ({ value, label }))}
                  />
                </label>
                <label className="sl-follow">
                  <input
                    type="checkbox"
                    checked={autoFollow}
                    onChange={(event) => followLatest(event.target.checked)}
                  />
                  <span>Follow latest</span>
                </label>
              </div>
            </div>
            <div className="sl-mobile-switch" aria-label="Session log view">
              <button
                type="button"
                aria-pressed={mobileView === "activity"}
                onClick={() => setMobileView("activity")}
              >
                Activity <span>{events.length}</span>
              </button>
              <button
                type="button"
                disabled={!selected}
                aria-pressed={mobileView === "details"}
                onClick={() => setMobileView("details")}
              >
                Record details
              </button>
            </div>
            <div className={`sl-main sl-mobile-${mobileView}`}>
              <div className="sl-ledger-column">
                <SessionTiming
                  events={visibleEvents}
                  selectedId={selected?.id}
                  onSelect={(event) => {
                    setSelectedId(event.id);
                    setInspectorTab("Timing");
                    setMobileView("details");
                    setAutoFollow(false);
                    document
                      .getElementById(`sl-event-${CSS.escape(event.id)}`)
                      ?.scrollIntoView({
                        block: "nearest",
                        behavior: "smooth",
                      });
                  }}
                />
                <div
                  className="sl-timeline-scroll"
                  ref={ledgerRef}
                  onWheel={handleWheel}
                  onTouchStart={handleTouchStart}
                  onTouchMove={handleTouchMove}
                  onPointerDown={() => {
                    pointerScrolling.current = true;
                  }}
                  onPointerUp={() => {
                    pointerScrolling.current = false;
                  }}
                  onPointerCancel={() => {
                    pointerScrolling.current = false;
                  }}
                  onScroll={handleScroll}
                >
                  {visibleEvents.length ? (
                    <div
                      className="sl-timeline"
                      aria-label="Session event ledger"
                    >
                      {events.length > visibleEvents.length && (
                        <button
                          className="sl-load-earlier"
                          type="button"
                          onClick={loadEarlier}
                        >
                          Load earlier events ·{" "}
                          {events.length - visibleEvents.length} remaining
                        </button>
                      )}
                      {groups.map((group) => (
                        <section
                          className="sl-turn-group"
                          key={`${group.key}-${group.events[0].id}`}
                          aria-label={group.label}
                        >
                          <div className="sl-turn-boundary">
                            {group.label}
                            <span>
                              {plural(group.events.length, "record")}
                            </span>
                          </div>
                          {group.events.map((event) => {
                            const span = recordedSpan(event);
                            const preview =
                              event.text ??
                              (event.error
                                ? `Error: ${event.error}`
                                : event.args !== undefined
                                  ? "Tool input recorded"
                                  : event.result !== undefined
                                    ? "Tool output recorded"
                                    : event.content !== undefined
                                      ? "Content recorded"
                                      : "");
                            return (
                              <button
                                id={`sl-event-${event.id}`}
                                key={event.id}
                                type="button"
                                className={`sl-event sl-kind-${event.kind}${selected?.id === event.id ? " is-selected" : ""}`}
                                onClick={() => {
                                  setSelectedId(event.id);
                                  setInspectorTab("Summary");
                                  setMobileView("details");
                                  setAutoFollow(false);
                                }}
                                aria-pressed={selected?.id === event.id}
                              >
                                <span className="sl-event-top">
                                  <span
                                    className={`sl-kind-pill sl-pill-${event.kind}`}
                                  >
                                    {event.kind}
                                  </span>
                                  <span
                                    className={`sl-status sl-status-${event.status}`}
                                  >
                                    <i aria-hidden="true" />
                                    {statusText(event.status)}
                                  </span>
                                  <span className="sl-sequence">
                                    #{event.sequence}
                                  </span>
                                </span>
                                <strong className="sl-event-title">
                                  {event.toolName || event.title}
                                </strong>
                                {preview && (
                                  <span className="sl-event-preview">
                                    {preview}
                                  </span>
                                )}
                                <span className="sl-event-meta">
                                  <time dateTime={event.startedAt}>
                                    {readableTime(event.startedAt)}
                                  </time>
                                  {span?.durationMs !== undefined ? (
                                    <span>
                                      {formatDuration(span.durationMs)}
                                    </span>
                                  ) : event.status === "running" ? (
                                    <span className="sl-start-marker">
                                      Started · running
                                    </span>
                                  ) : null}
                                  {event.role && (
                                    <span>
                                      {event.role === "user"
                                        ? "User"
                                        : "Assistant"}
                                    </span>
                                  )}
                                </span>
                              </button>
                            );
                          })}
                        </section>
                      ))}
                    </div>
                  ) : (
                    <div className="sl-empty">
                      <span className="sl-empty-icon">
                        <Search size={20} />
                      </span>
                      <strong>
                        {session.events.length === 0
                          ? "No activity yet"
                          : filtered
                            ? "No matching events"
                            : "This session is empty"}
                      </strong>
                      <p>
                        {filtered
                          ? "Try another search or clear the active filters."
                          : "Events from this session will appear here as work is recorded."}
                      </p>
                      {filtered && (
                        <button type="button" onClick={clearFilters}>
                          Clear filters
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {selected ? (
                <Inspector
                  event={selected}
                  tab={inspectorTab}
                  onTab={setInspectorTab}
                />
              ) : (
                <aside className="sl-inspector sl-inspector-empty">
                  <div className="sl-empty">
                    <strong>Select an event</strong>
                    <p>
                      Choose a ledger record to inspect its input, output, and
                      timing.
                    </p>
                  </div>
                </aside>
              )}
            </div>
            <footer className="sl-footer">
              <span className="sl-export-note">
                {filtered
                  ? `${events.length} of ${session.events.length} shown · exports include all events`
                  : `${session.events.length} events · complete session`}
              </span>
              <div className="sl-export-actions">
                <button
                  type="button"
                  disabled={exporting}
                  onClick={() => void exportFile("markdown")}
                >
                  <Download size={15} />
                  Markdown
                </button>
                <button
                  type="button"
                  disabled={exporting}
                  onClick={() => void exportFile("jsonl")}
                >
                  JSONL
                </button>
                <button
                  className="sl-primary-export"
                  type="button"
                  disabled={exporting}
                  onClick={() => void exportFile("zip")}
                >
                  Full ZIP <Download size={14} />
                </button>
              </div>
              <span
                className="sl-export-status"
                role="status"
                aria-live="polite"
              >
                {exportStatus}
              </span>
            </footer>
          </>
        )}
        {!session && (
          <div className="sl-empty">
            <strong>Session unavailable</strong>
            <p>This session is no longer in local history.</p>
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}
