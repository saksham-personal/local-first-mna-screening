import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, ChevronUp, Circle, CircleAlert, Clock3, ExternalLink, LoaderCircle, Pause, Play, RotateCcw, Square, Undo2, X } from "lucide-react";
import { formatDateTime, formatTime, plural } from "../lib/format";
import type { IndexBuild } from "../index/index-build-client";
import { buildEtaText, isActiveBuild, overallPercent, stepPresentation, buildStatusText } from "../index/index-build-state";
import { IndexProgressBar } from "../index/BuildIndexDialog";
import { exportActivity, exportJobsEvent, exportRunIds, listExports, type ExportJob } from "../lib/screening-client";
import { listSetupBuilds, type SetupBuild } from "../lib/screening-client";
import { startBackgroundScreening } from "../lib/background-client";
import type { BingActivityJob, ActivityAction, ActivitySource, LoopActivityJob, RunActivityRow, ScreeningActivityJob } from "../lib/run-activity";
import { formatElapsed, mapBingJobToActivity, mapLoopJobToActivity, mapScreeningJobToActivity, processedUnit } from "../lib/run-activity";
import CancelRunDialog from "./CancelRunDialog";
import SetupController from "./SetupController";
import "./background-runs.css";

export type BackgroundRunView = Omit<ScreeningActivityJob, "state"> & { title: string; state: "queued" | "running" | "paused" | "completed" | "error" | "blocked" };

/** A local discovery search (MID today), shown beside the provider screening runs. */
export type SearchRunView = {
  id: string;
  sessionId: string;
  title: string;
  state: "running" | "completed" | "cancelled" | "error";
  startedAt: string;
  finishedAt?: string;
  toolCalls: number;
  error?: string;
};

type Props = {
  indexBuilds?: IndexBuild[];
  onOpenIndex?: (id: string) => void;
  onDismissIndex?: (id: string) => void;
  jobs: BackgroundRunView[];
  researchJobs?: BingActivityJob[];
  loopJobs?: LoopActivityJob[];
  searches?: SearchRunView[];
  /** Whether the dock shows its run list. The header Activity button drives this. */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Changes whenever the surrounding layout changes without resizing, e.g. the chat dock collapsing. */
  layoutKey?: string;
  onAction: (id: string, action: "pause" | "resume" | "retry" | "stage") => void | Promise<void>;
  onResearchAction?: (id: string, action: "pause" | "resume") => void | Promise<void>;
  onLoopAction?: (id: string, action: "pause" | "resume") => void | Promise<void>;
  onDismissLoop?: (id: string) => void;
  onOpenLoopSummary?: (sessionId: string, id: string) => void;
  onUndoLoop?: (id: string) => void;
  onCancelRun?: (source: ActivitySource, id: string, keep: boolean) => Promise<void>;
  onDismiss?: (id: string) => void;
  onDismissResearch?: (id: string) => void;
  onOpenResearch?: (sessionId: string, id: string) => void;
  onOpenScreening?: (sessionId: string) => void;
  onOpenSearch?: (sessionId: string) => void;
  onStopSearch?: (jobId: string) => void;
  onDismissSearch?: (jobId: string) => void;
};

const ACTIVITY_KEY = "screening-activity-open-v1";
export function readActivityOpen(storage?: Pick<Storage, "getItem">): boolean {
  try { return (storage ?? window.localStorage).getItem(ACTIVITY_KEY) === "true"; } catch { return false; }
}
export function writeActivityOpen(open: boolean, storage?: Pick<Storage, "setItem">): void {
  try { (storage ?? window.localStorage).setItem(ACTIVITY_KEY, String(open)); } catch { /* Storage may be disabled. */ }
}

const providerNames = { llm_suite: "LLM Suite", copilot: "M365 Copilot" };
const searchStateNames = {
  running: "Running",
  completed: "Completed",
  cancelled: "Stopped",
  error: "Failed",
};

export default function BackgroundRuns({ indexBuilds = [], onOpenIndex, onDismissIndex, jobs, researchJobs = [], loopJobs = [], searches = [], expanded, onExpandedChange, layoutKey, onAction, onResearchAction, onLoopAction, onCancelRun, onDismiss, onDismissResearch, onDismissLoop, onOpenResearch, onOpenLoopSummary, onUndoLoop, onOpenScreening, onOpenSearch, onStopSearch, onDismissSearch }: Props) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { if (expanded) setDismissed(false); }, [expanded]);
  // The cancel dialog keeps only the run's identity; the run is read fresh on every render.
  const [cancelTarget, setCancelTarget] = useState<{ source: ActivitySource; id: string }>();
  const [pendingActions, setPendingActions] = useState<Set<string>>(new Set());
  const [runActionErrors, setRunActionErrors] = useState<Record<string, string>>({});
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [builds, setBuilds] = useState<SetupBuild[]>([]);
  const [reviewBuild, setReviewBuild] = useState<SetupBuild>();
  const [buildError, setBuildError] = useState("");
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const jobs = await listSetupBuilds(); if (active) setBuilds(jobs.filter(job => job.status !== "approved")); } catch { /* Retry at the next activity poll. */ }
      if (active) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, []);
  const hostRef = useRef<HTMLDivElement>(null);
  const [exports, setExports] = useState<ExportJob[]>([]);
  const [exportError, setExportError] = useState("");
  const expandRef = useRef(onExpandedChange);
  expandRef.current = onExpandedChange;
  useEffect(() => {
    let disposed = false, polling = false, refreshAgain = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      clearTimeout(timer);
      if (polling) { refreshAgain = true; return; }
      polling = true;
      let running = false;
      try {
        const results = await Promise.all(exportRunIds().map(listExports));
        const next = results.flat().sort((a, b) => b.started_at.localeCompare(a.started_at));
        running = next.some(job => job.state === "running");
        if (!disposed) { setExports(next); setExportError(""); }
      } catch (caught) {
        if (!disposed) setExportError(caught instanceof Error ? caught.message : "Export status could not be loaded.");
        running = true;
      } finally {
        polling = false;
        if (!disposed) {
          const delay = refreshAgain ? 0 : running ? 1000 : 10000;
          refreshAgain = false;
          timer = setTimeout(() => void refresh(), delay);
        }
      }
    };
    const started = () => { expandRef.current(true); void refresh(); };
    window.addEventListener(exportJobsEvent, started);
    void refresh();
    return () => { disposed = true; clearTimeout(timer); window.removeEventListener(exportJobsEvent, started); };
  }, []);
  const runRows = [
    ...jobs.map(job => mapScreeningJobToActivity(job, { now: clockNow })),
    ...researchJobs.map(job => mapBingJobToActivity(job, { now: clockNow })),
    ...loopJobs.map(job => mapLoopJobToActivity(job, { now: clockNow })),
  ];
  const hasActiveRun = runRows.some(row => ["queued", "running", "consolidating", "cancelling"].includes(row.state));
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActiveRun]);
  // Announce only runs whose state changed since the previous render. The first render just records them.
  const seenRunStates = useRef<Map<string, string> | undefined>(undefined);
  const [runAnnouncement, setRunAnnouncement] = useState("");
  useEffect(() => {
    const previous = seenRunStates.current;
    seenRunStates.current = new Map<string, string>(runRows.map(row => [`${row.source}:${row.id}`, row.state] as const));
    if (!previous) return;
    const changed = runRows.filter(row => previous.get(`${row.source}:${row.id}`) !== row.state);
    if (changed.length) setRunAnnouncement(changed.map(row => `${row.title}: ${row.stateLabel}`).join(". "));
  }, [runRows]);
  // The cancel dialog reads its run on every render, so its counts stay current. It closes if the run goes away.
  const cancelRow = cancelTarget ? runRows.find(row => row.source === cancelTarget.source && row.id === cancelTarget.id) : undefined;
  const cancelRowGone = !!cancelTarget && !cancelRow;
  useEffect(() => { if (cancelRowGone) setCancelTarget(undefined); }, [cancelRowGone]);
  const items = indexBuilds.length + searches.length + jobs.length + researchJobs.length + loopJobs.length + exports.length + builds.length;
  const visible = !dismissed && (items > 0 || expanded || !!exportError);
  useLayoutEffect(() => {
    const host = hostRef.current, main = host?.parentElement;
    if (!host || !main) return;
    const header = main.querySelector<HTMLElement>(":scope > .ct-header");
    const composer = main.querySelector<HTMLElement>(".ct-composer-wrap");
    const sideChatHeader = main.querySelector<HTMLElement>(".ct-docked-head");
    const toggle = host.querySelector<HTMLElement>(".br-dock-toggle");
    let previous = "", previousOffset = "";
    // A collapsed or clipped chat takes no room: only count parts that are really on screen.
    const shown = (element: HTMLElement | null) => !!element && !element.closest("[inert]") && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const measure = () => {
      const style = getComputedStyle(host);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth);
      const mainRect = main.getBoundingClientRect();
      const composerShown = shown(composer), headShown = shown(sideChatHeader);
      const room = Math.max(0, Math.floor(mainRect.height - (header?.getBoundingClientRect().height ?? 0) - (headShown ? sideChatHeader!.getBoundingClientRect().height : 0) - (composerShown ? composer!.getBoundingClientRect().height : 0) - (toggle?.getBoundingClientRect().height ?? 0) - padding - 20));
      const value = `${room}px`;
      if (value !== previous) { host.style.setProperty("--br-available-room", value); previous = value; }
      // On phones the closed dock is a pill that floats just above the composer.
      const offset = `${composerShown ? Math.max(0, Math.round(window.innerHeight - composer!.getBoundingClientRect().top)) : 0}px`;
      if (offset !== previousOffset) { host.style.setProperty("--br-composer-offset", offset); previousOffset = offset; }
    };
    measure();
    const observer = new ResizeObserver(measure);
    [main, header, sideChatHeader, composer, toggle].forEach(element => { if (element) observer.observe(element); });
    return () => observer.disconnect();
  }, [indexBuilds, jobs, researchJobs, loopJobs, searches, exports, builds, expanded, visible, layoutKey]);
  if (!visible) return null;
  const activeCount = exports.filter(job => job.state === "running").length + builds.filter(build => build.status === "building").length + indexBuilds.filter(isActiveBuild).length + jobs.filter((job) => job.state === "running" || job.state === "queued" || String(job.state) === "cancelling").length + researchJobs.filter(job => job.state === "running" || job.state === "queued" || job.state === "cancelling").length + loopJobs.filter(job => ["running", "queued", "consolidating", "cancelling"].includes(job.state)).length + searches.filter((search) => search.state === "running").length;
  const totalBatches = jobs.reduce((sum, job) => sum + Math.max(0, job.total), 0);
  const completedBatches = jobs.reduce((sum, job) => sum + Math.max(0, job.completed), 0);
  const aggregatePercent = totalBatches > 0 ? Math.min(100, (completedBatches / totalBatches) * 100) : 0;
  const summary = items === 0 ? "Nothing running" : [activeCount ? `${activeCount} active` : plural(items, "item"), totalBatches > 0 ? `${completedBatches} of ${plural(totalBatches, "batch", "batches")}` : ""].filter(Boolean).join(" · ");

  const handleRunAction = async (row: RunActivityRow, action: ActivityAction) => {
    const key = `${row.source}:${row.id}`;
    if (action === "cancel") { setCancelTarget({ source: row.source, id: row.id }); return; }
    if (action === "dismiss") {
      if (row.source === "bing") onDismissResearch?.(row.id);
      else if (row.source === "loop") onDismissLoop?.(row.id);
      else onDismiss?.(row.id);
      return;
    }
    if (action === "summary") { if (row.sessionId) onOpenLoopSummary?.(row.sessionId, row.id); return; }
    if (action === "undo") { onUndoLoop?.(row.id); return; }
    if (action === "open") {
      if (row.source === "bing" && row.sessionId) onOpenResearch?.(row.sessionId, row.id);
      else if (row.sessionId) onOpenScreening?.(row.sessionId);
      return;
    }
    setPendingActions(previous => new Set(previous).add(key));
    setRunActionErrors(previous => ({ ...previous, [key]: "" }));
    try {
      if (row.source === "bing") {
        if (action === "pause" || action === "resume") await onResearchAction?.(row.id, action);
      } else if (row.source === "loop") {
        if (action === "pause" || action === "resume") await onLoopAction?.(row.id, action);
      } else if (action === "pause" || action === "resume" || action === "retry" || action === "stage" || action === "check") {
        await onAction(row.id, action === "check" ? "resume" : action);
      }
    } catch (error) {
      setRunActionErrors(previous => ({ ...previous, [key]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setPendingActions(previous => { const next = new Set(previous); next.delete(key); return next; });
    }
  };
  const renderRunAction = (row: RunActivityRow, action: ActivityAction) => {
    const label = action === "stage" ? `Stage ${plural(row.stageCount ?? 0, "batch", "batches")}` : action === "open" ? "Open results" : action === "summary" ? "Open summary" : action === "undo" ? "Undo" : action === "retry" ? "Retry failed" : action === "check" ? "Check status" : action[0].toUpperCase() + action.slice(1);
    const subject = row.source === "loop" ? "loop" : row.source === "bing" ? "Bing research" : `${providerNames[row.provider ?? "llm_suite"]} screening`;
    const ariaLabel = row.source === "loop" && action === "pause" ? "Pause loop" : row.source === "loop" && action === "resume" ? "Resume loop" : row.source === "loop" && action === "cancel" ? "Cancel loop" : row.source === "loop" && action === "summary" ? "Open loop summary" : row.source === "loop" && action === "undo" ? "Undo loop" : action === "dismiss" ? `Dismiss ${row.title}` : action === "check" ? `Check status for ${subject}` : `${label} ${subject}`;
    const key = `${row.source}:${row.id}`;
    const screening = row.source === "screening" ? jobs.find(job => job.id === row.id) : undefined;
    const disabled = pendingActions.has(key) || screening?.busy === true || (row.source === "loop" && action === "undo" && !row.canUndo);
    const icon = action === "pause" ? <Pause size={13} aria-hidden="true" /> : action === "resume" || action === "check" ? <Play size={13} aria-hidden="true" /> : action === "retry" ? <RotateCcw size={13} aria-hidden="true" /> : action === "stage" ? <Check size={13} aria-hidden="true" /> : action === "open" || action === "summary" ? <ExternalLink size={13} aria-hidden="true" /> : action === "undo" ? <Undo2 size={13} aria-hidden="true" /> : action === "dismiss" ? <X size={13} aria-hidden="true" /> : <Square size={12} aria-hidden="true" />;
    return <button key={action} className={action === "stage" ? "br-stage" : undefined} type="button" aria-label={ariaLabel} onClick={() => void handleRunAction(row, action)} disabled={disabled}>{icon}{label}</button>;
  };

  return (
    <div className="br-host" ref={hostRef}>
    <aside className={`br-dock${expanded ? " is-expanded" : ""}`} aria-label="Activity">
      <div className="br-dock-heading"><button
        className="br-dock-toggle"
        type="button"
        aria-label={`Activity, ${plural(items, "item")}, ${summary}`}
        aria-expanded={expanded}
        aria-controls="activity-details"
        onClick={() => onExpandedChange(!expanded)}
      >
        <span className={`br-dock-mark${activeCount ? " is-running" : ""}`} aria-hidden="true" />
        <span className="br-dock-summary">
          <strong>Activity</strong>
          <small>{summary}</small>
          {totalBatches > 0 && <span className="br-dock-progress" role="progressbar" aria-label="All background screening progress" aria-valuemin={0} aria-valuemax={totalBatches} aria-valuenow={Math.min(completedBatches, totalBatches)}><i style={{ width: `${aggregatePercent}%` }} /></span>}
        </span>
        {items > 0 && <span className="br-dock-badge" aria-hidden="true">{items}</span>}
        {expanded ? <ChevronDown size={17} aria-hidden="true" /> : <ChevronUp size={17} aria-hidden="true" />}
      </button><button className="br-icon-button br-dismiss" type="button" aria-label="Dismiss Activity panel" onClick={() => { setDismissed(true); onExpandedChange(false); }}><X size={16} /></button></div>
      <div className="br-live-region" aria-live="polite" aria-atomic="true">{runAnnouncement}</div>
      {expanded && (
        <div className="br-dock-details" id="activity-details">
          {builds.length > 0 && <section className="br-group" aria-label="Input table preparation">
            <h3 className="br-group-title">Input tables<span>{builds.length}</span></h3>
            {buildError && <p className="br-message" role="alert">{buildError}</p>}
            {builds.map(build => <section className="br-run" key={build.id}>
              <div className="br-run-heading"><div className="br-run-copy"><strong>{build.status === "building" ? `Preparing input table · ${build.completed.toLocaleString()} of ${plural(build.total, "company", "companies")}` : build.status === "ready" ? "Input table ready for review" : "Input table needs attention"}</strong><span>{providerNames[build.provider]}</span></div></div>
              <div className="br-progress" role="progressbar" aria-label="Input table preparation" aria-valuemin={0} aria-valuemax={build.total} aria-valuenow={build.completed}><span style={{ width: `${build.total ? Math.min(100, build.completed / build.total * 100) : 0}%` }} /></div>
              {build.error && <p className="br-message">{build.error}</p>}
              {build.sessionId && <div className="br-actions"><button type="button" onClick={() => setReviewBuild(build)}>{build.status === "ready" ? "Review & approve" : "Open setup"}<ArrowRight size={13} /></button></div>}
            </section>)}
          </section>}
          {items === 0 && <p className="br-empty">Searches, research, loops, and screening runs show up here while they work.</p>}
          {exportError && <p className="br-message br-search-error" role="alert">{exportError}</p>}
          {exports.length > 0 && <section className="br-group" aria-label="Exports">
            <h3 className="br-group-title">Exports<span>{exports.length}</span></h3>
            {exports.map(job => {
              const item = exportActivity(job);
              return <section className={`br-run br-state-${item.state}`} key={job.export_id} aria-label={`${item.title}: ${item.label}`}>
                <div className="br-run-heading"><div className="br-run-copy"><strong>{item.title}</strong><span>{item.label}</span></div></div>
                <div className="br-progress-label"><span>{job.rows_done.toLocaleString()} of {plural(job.rows_total, "row")} written</span><span>{Math.round(item.percent)}%</span></div>
                <div className="br-progress" role="progressbar" aria-label={`${item.title} progress`} aria-valuemin={0} aria-valuemax={job.rows_total || 1} aria-valuenow={job.rows_total ? Math.min(job.rows_done, job.rows_total) : job.state === "done" ? 1 : 0}><span style={{ width: `${item.percent}%` }} /></div>
                {job.error && <p className="br-message br-search-error" role="alert">{job.error}</p>}
                {item.download && <div className="br-actions"><button type="button" onClick={() => { window.location.href = item.download!; }}>Download</button></div>}
                <time className="br-updated" dateTime={job.started_at}>Started {formatDateTime(job.started_at)}</time>
              </section>;
            })}
          </section>}
          {indexBuilds.length > 0 && <section className="br-group" aria-label="Index builds">
            <h3 className="br-group-title">Index builds<span>{indexBuilds.length}</span></h3>
            {indexBuilds.map(build => <section className="br-run br-index" key={build.build_id}>
              <div className="br-run-heading"><button type="button" className="br-index-open br-run-copy" onClick={() => onOpenIndex?.(build.build_id)}><strong>{build.bundle.name}</strong><span>Index build · {isActiveBuild(build) ? build.steps.find(step => step.id === build.current_step)?.label ?? "Starting" : buildStatusText(build.status)}</span></button>{!isActiveBuild(build) && <button type="button" className="br-icon-button" aria-label={`Dismiss ${build.bundle.name}`} onClick={() => onDismissIndex?.(build.build_id)}><X size={15} /></button>}</div>
              <div className="br-progress-label"><span>{isActiveBuild(build) ? buildEtaText(build) : build.status === "succeeded" ? plural(build.bundle.row_count, "company", "companies") : "Build stopped"}</span><span>{overallPercent(build.steps)}%</span></div>
              <IndexProgressBar value={overallPercent(build.steps)} label={`${build.bundle.name} progress`} />
              <ol className="br-index-steps" aria-label="Build steps">{build.steps.map(step => <li key={step.id} className={`br-index-step-${step.status}`} title={`${step.label}: ${stepPresentation(step.status).label}`} aria-label={`${step.label}: ${stepPresentation(step.status).label}`} />)}</ol>
            </section>)}
          </section>}
          {searches.length > 0 && (
            <section className="br-group" aria-label="Searches">
              <h3 className="br-group-title">Searches<span>{searches.length}</span></h3>
              {searches.map((search) => (
                <section className={`br-run br-search br-state-${search.state}`} key={search.id} aria-label={`${search.title}: ${searchStateNames[search.state]}`}>
                  <div className="br-run-heading">
                    <div className="br-run-copy">
                      <strong title={search.title}>{search.title}</strong>
                      <span>Local MID search <i aria-hidden="true">·</i> {searchStateNames[search.state]}</span>
                    </div>
                    {onDismissSearch && search.state !== "running" && (
                      <button className="br-icon-button" type="button" aria-label={`Dismiss ${search.title}`} onClick={() => onDismissSearch(search.id)}>
                        <X size={15} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  <div className="br-run-stats">
                    {search.state === "running" && <span className="br-stat-running"><i />Working</span>}
                    <span>{plural(search.toolCalls, "tool call")}</span>
                  </div>
                  {search.error && <p className="br-message br-search-error">{search.error}</p>}
                  <div className="br-actions">
                    {onOpenSearch && <button type="button" onClick={() => onOpenSearch(search.sessionId)}>Open screening<ArrowRight size={13} aria-hidden="true" /></button>}
                    {search.state === "running" && onStopSearch && <button type="button" onClick={() => onStopSearch(search.id)}><Square size={12} aria-hidden="true" />Stop</button>}
                  </div>
                  <time className="br-updated" dateTime={search.startedAt}>Started {formatDateTime(search.startedAt)}</time>
                </section>
              ))}
            </section>
          )}
          {runRows.length > 0 && <section className="br-group" aria-label="Provider runs and loops">
            <h3 className="br-group-title">Provider runs and loops<span>{runRows.length}</span></h3>
            {runRows.map(row => {
              const key = `${row.source}:${row.id}`;
              const screening = row.source === "screening" ? jobs.find(job => job.id === row.id) : undefined;
              const errors = screening?.errors ?? [];
              const actionError = runActionErrors[key];
              const valueMax = row.total || 1;
              const valueNow = row.total > 0 ? Math.min(row.processed, row.total) : row.state === "completed" ? 1 : 0;
              return <section className={`br-run br-controlled-run br-state-${row.state === "failed" ? "error" : row.state}`} key={key} aria-label={`${row.title}: ${row.stateLabel}`}>
                <div className="br-run-heading">
                  <div className="br-run-copy">
                    <strong title={row.title}>{row.title}</strong>
                    <span>{row.source === "loop" ? "LLM Suite discovery loop" : row.source === "bing" ? "Bing research" : `${providerNames[row.provider ?? "llm_suite"]} screening`} <i aria-hidden="true">·</i> <span className={`br-state-chip br-chip-${row.state === "failed" ? "error" : row.state}`}>{row.stateLabel}</span></span>
                  </div>
                </div>
                {row.secondaryText && <div className="br-run-stats"><span>{row.secondaryText}</span></div>}
                <div className="br-progress-label"><span>{row.source === "loop" ? `${row.processed.toLocaleString()} of ${row.total} turns` : `${row.processed.toLocaleString()} of ${processedUnit(row.source, row.total)} processed`}</span><span>{Math.round(row.percent)}%</span></div>
                <div className="br-progress" role="progressbar" aria-label={`${row.title} progress`} aria-valuemin={0} aria-valuemax={valueMax} aria-valuenow={valueNow} aria-valuetext={row.source === "loop" ? `${row.processed} of ${row.total} turns` : `${row.processed} of ${row.total} processed`}><span style={{ width: `${row.percent}%` }} /></div>
                <ol className="br-run-steps" aria-label={`${row.title} steps`}>
                  {row.steps.map(step => <li className={`br-run-step br-step-${step.state}`} key={step.id} aria-label={`${step.label}: ${step.state}`}>
                    {step.state === "done" ? <Check size={12} aria-hidden="true" /> : step.state === "running" ? <LoaderCircle size={12} aria-hidden="true" /> : step.state === "failed" ? <CircleAlert size={12} aria-hidden="true" /> : <Circle size={12} aria-hidden="true" />}
                    <span>{step.label}</span>
                  </li>)}
                </ol>
                {(row.message || (row.source === "screening" && row.state === "blocked")) && <p className={`br-message${row.state === "blocked" ? " br-blocked-message" : ""}`} role={row.state === "failed" || row.state === "error" ? "alert" : undefined}>{row.message ?? (screening?.executed === false ? "Provider unavailable. No request was sent." : "Run is unavailable; check its connection or saved setup.")}</p>}
                {errors.length > 0 && <ul className="br-errors" aria-label="Batch errors">{errors.slice(0, 2).map(error => <li key={`${error.batch}-${error.message}`}><strong>Batch {error.batch}:</strong> {error.message}</li>)}{errors.length > 2 && <li>And {errors.length - 2} more errors</li>}</ul>}
                {screening?.staged ? <div className="br-run-stats"><span className="br-stat-staged"><Check size={12} aria-hidden="true" />{screening.staged} staged</span></div> : null}
                {actionError && <p className="br-message br-search-error" role="alert">{actionError}</p>}
                <div className="br-actions">{row.actions.map(action => renderRunAction(row, action))}</div>
                <div className="br-run-times">
                  <time dateTime={row.startedAt} aria-label={row.startedAt ? `Started ${formatDateTime(row.startedAt)}` : "Start time unavailable"}>{formatElapsed(row.elapsedMs)}</time>
                  {row.updatedAt && <time dateTime={row.updatedAt}>Updated {formatTime(row.updatedAt, { seconds: true }) || row.updatedAt}</time>}
                </div>
              </section>;
            })}
          </section>}
        </div>
      )}
    </aside>
    {cancelTarget && cancelRow && <CancelRunDialog run={cancelRow} onBack={() => setCancelTarget(undefined)} onCancel={async keep => { if (!onCancelRun) throw new Error("Run cancellation is unavailable."); await onCancelRun(cancelTarget.source, cancelTarget.id, keep); setCancelTarget(undefined); }} />}
    {reviewBuild?.sessionId && <SetupController buildId={reviewBuild.id} sessionId={reviewBuild.sessionId} provider={reviewBuild.provider} mode={reviewBuild.config.mode} onClose={() => setReviewBuild(undefined)} onSaved={prepared => { setBuildError(""); const sessionId = reviewBuild.sessionId!; setReviewBuild(undefined); void startBackgroundScreening(sessionId, prepared).then(() => onExpandedChange(true)).catch(error => setBuildError(String(error.message ?? error))); }} />}
    </div>
  );
}
