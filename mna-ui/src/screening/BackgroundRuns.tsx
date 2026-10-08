import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, ChevronUp, CircleAlert, Clock3, Pause, Play, RotateCcw, Square, X } from "lucide-react";
import { formatDateTime, formatTime, plural } from "../lib/format";
import type { IndexBuild } from "../index/index-build-client";
import { buildEtaText, isActiveBuild, overallPercent, stepPresentation, buildStatusText } from "../index/index-build-state";
import { IndexProgressBar } from "../index/BuildIndexDialog";
import { listSetupBuilds, type SetupBuild } from "../lib/screening-client";
import { startBackgroundScreening } from "../lib/background-client";
import SetupController from "./SetupController";
import "./background-runs.css";

export type BackgroundRunView = {
  id: string;
  title: string;
  provider: "llm_suite" | "copilot";
  state: "queued" | "running" | "paused" | "completed" | "error" | "blocked";
  total: number;
  completed: number;
  failed: number;
  running: number;
  staged: number;
  executed?: boolean;
  current: boolean;
  message?: string;
  errors?: { batch: number; message: string; retryable: boolean }[];
  updatedAt?: string;
  busy?: boolean;
};

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
  searches?: SearchRunView[];
  /** Whether the dock shows its run list. The header Activity button drives this. */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Changes whenever the surrounding layout changes without resizing, e.g. the chat dock collapsing. */
  layoutKey?: string;
  onAction: (id: string, action: "pause" | "resume" | "retry" | "stage") => void;
  onDismiss?: (id: string) => void;
  onOpenSearch?: (sessionId: string) => void;
  onStopSearch?: (jobId: string) => void;
  onDismissSearch?: (jobId: string) => void;
};

const providerNames = { llm_suite: "LLM Suite", copilot: "M365 Copilot" };
const stateNames = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  error: "Needs attention",
  blocked: "Blocked",
};
const searchStateNames = {
  running: "Running",
  completed: "Completed",
  cancelled: "Stopped",
  error: "Failed",
};

function percent(job: BackgroundRunView) {
  return job.total > 0 ? Math.max(0, Math.min(100, (job.completed / job.total) * 100)) : 0;
}

export default function BackgroundRuns({ indexBuilds = [], onOpenIndex, onDismissIndex, jobs, searches = [], expanded, onExpandedChange, layoutKey, onAction, onDismiss, onOpenSearch, onStopSearch, onDismissSearch }: Props) {
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
  const items = indexBuilds.length + searches.length + jobs.length + builds.length;
  const visible = items > 0 || expanded;
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
      const offset = `${composerShown ? Math.max(0, Math.round(mainRect.bottom - composer!.getBoundingClientRect().top)) : 0}px`;
      if (offset !== previousOffset) { host.style.setProperty("--br-composer-offset", offset); previousOffset = offset; }
    };
    measure();
    const observer = new ResizeObserver(measure);
    [main, header, sideChatHeader, composer, toggle].forEach(element => { if (element) observer.observe(element); });
    return () => observer.disconnect();
  }, [indexBuilds, jobs, searches, builds, expanded, visible, layoutKey]);
  if (!visible) return null;
  const activeCount = builds.filter(build => build.status === "building").length + indexBuilds.filter(isActiveBuild).length + jobs.filter((job) => job.state === "running" || job.state === "queued").length + searches.filter((search) => search.state === "running").length;
  const totalBatches = jobs.reduce((sum, job) => sum + Math.max(0, job.total), 0);
  const completedBatches = jobs.reduce((sum, job) => sum + Math.max(0, job.completed), 0);
  const aggregatePercent = totalBatches > 0 ? Math.min(100, (completedBatches / totalBatches) * 100) : 0;
  const summary = items === 0 ? "Nothing running" : [activeCount ? `${activeCount} active` : plural(items, "item"), totalBatches > 0 ? `${completedBatches} of ${plural(totalBatches, "batch", "batches")}` : ""].filter(Boolean).join(" · ");

  return (
    <div className="br-host" ref={hostRef}>
    <aside className={`br-dock${expanded ? " is-expanded" : ""}`} aria-label="Activity">
      <button
        className="br-dock-toggle"
        type="button"
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
        {items > 0 && <span className="br-dock-badge" aria-hidden="true">{activeCount || items}</span>}
        {expanded ? <ChevronDown size={17} aria-hidden="true" /> : <ChevronUp size={17} aria-hidden="true" />}
      </button>
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
          {items === 0 && <p className="br-empty">Searches and screening runs show up here while they work.</p>}
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
          {jobs.length > 0 && (
            <section className="br-group" aria-label="Screening">
              <h3 className="br-group-title">Screening<span>{jobs.length}</span></h3>
              {jobs.map((job) => {
                const retryable = job.current === true && (job.errors?.some((error) => error.retryable) ?? false);
                const canStage = job.current === true && job.completed > job.staged;
                return (
                  <section className={`br-run br-state-${job.state}`} key={job.id} aria-label={`${job.title}: ${stateNames[job.state]}`}>
                    <div className="br-run-heading">
                      <div className="br-run-copy">
                        <strong title={job.title}>{job.title}</strong>
                        <span>{providerNames[job.provider]} <i aria-hidden="true">·</i> {stateNames[job.state]}</span>
                      </div>
                      {onDismiss && (job.state === "completed" || job.state === "error" || job.state === "blocked") && (
                        <button className="br-icon-button" type="button" aria-label={`Dismiss ${job.title}`} onClick={() => onDismiss(job.id)}>
                          <X size={15} aria-hidden="true" />
                        </button>
                      )}
                    </div>

                    {job.state === "blocked" ? (
                      <div className="br-blocked" role="status">
                        <CircleAlert size={15} aria-hidden="true" />
                        <span>{job.message || "Connection interrupted; this run is unavailable."}{job.executed === false && <small>Executed: no · Information sent: none</small>}{job.executed === true && <small>Execution started · information may have been sent</small>}</span>
                      </div>
                    ) : (
                      <>
                        <div className="br-progress-label">
                          <span>{job.completed} of {plural(job.total, "batch", "batches")} completed</span>
                          <span>{Math.round(percent(job))}%</span>
                        </div>
                        <div className="br-progress" role="progressbar" aria-label={`${job.title} progress`} aria-valuemin={0} aria-valuemax={job.total} aria-valuenow={Math.min(job.completed, job.total)}>
                          <span style={{ width: `${percent(job)}%` }} />
                        </div>
                        <div className="br-run-stats">
                          {job.running > 0 && <span className="br-stat-running"><i />{job.running} running</span>}
                          {job.failed > 0 && <span className="br-stat-error">{job.failed} failed</span>}
                          {job.staged > 0 && <span className="br-stat-staged"><Check size={12} aria-hidden="true" />{job.staged} staged</span>}
                          {job.state === "queued" && <span><Clock3 size={12} aria-hidden="true" />Waiting to start</span>}
                        </div>
                      </>
                    )}

                    {job.message && job.state !== "blocked" && <p className="br-message">{job.message}</p>}
                    {job.errors?.length ? (
                      <ul className="br-errors" aria-label="Batch errors">
                        {job.errors.slice(0, 2).map((error) => <li key={`${error.batch}-${error.message}`}><strong>Batch {error.batch}:</strong> {error.message}</li>)}
                        {job.errors.length > 2 && <li>And {job.errors.length - 2} more errors</li>}
                      </ul>
                    ) : null}
                    <div className="br-actions">
                      {job.state === "running" && <button type="button" onClick={() => onAction(job.id, "pause")} disabled={job.busy}><Pause size={13} aria-hidden="true" />Pause</button>}
                      {(job.state === "paused" || job.state === "queued" || job.state === "blocked") && <button type="button" onClick={() => onAction(job.id, "resume")} disabled={job.busy}><Play size={13} aria-hidden="true" />{job.state === "blocked" ? "Check status" : "Resume"}</button>}
                      {retryable && <button type="button" onClick={() => onAction(job.id, "retry")} disabled={job.busy}><RotateCcw size={13} aria-hidden="true" />Retry failed</button>}
                      {canStage && <button className="br-stage" type="button" onClick={() => onAction(job.id, "stage")} disabled={job.busy}><Check size={13} aria-hidden="true" />Stage {plural(job.completed - job.staged, "batch", "batches")}</button>}
                    </div>
                    {job.updatedAt && <time className="br-updated" dateTime={job.updatedAt}>Updated {formatTime(job.updatedAt, { seconds: true }) || job.updatedAt}</time>}
                  </section>
                );
              })}
            </section>
          )}
        </div>
      )}
    </aside>
    {reviewBuild?.sessionId && <SetupController buildId={reviewBuild.id} sessionId={reviewBuild.sessionId} provider={reviewBuild.provider} mode={reviewBuild.config.mode} onClose={() => setReviewBuild(undefined)} onSaved={prepared => { setBuildError(""); void startBackgroundScreening(reviewBuild.sessionId!, prepared).catch(error => setBuildError(String(error.message ?? error))); setReviewBuild(undefined); }} />}
    </div>
  );
}
