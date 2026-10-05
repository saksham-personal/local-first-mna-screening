import { useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, CircleAlert, Clock3, Pause, Play, RotateCcw, X } from "lucide-react";
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

type Props = {
  jobs: BackgroundRunView[];
  onAction: (id: string, action: "pause" | "resume" | "retry" | "stage") => void;
  onDismiss?: (id: string) => void;
};

const providerNames = { llm_suite: "LLM Suite", copilot: "Copilot" };
const stateNames = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  error: "Needs attention",
  blocked: "Blocked",
};

function percent(job: BackgroundRunView) {
  return job.total > 0 ? Math.max(0, Math.min(100, (job.completed / job.total) * 100)) : 0;
}

export default function BackgroundRuns({ jobs, onAction, onDismiss }: Props) {
  const [expanded, setExpanded] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current, main = host?.parentElement;
    if (!host || !main) return;
    const header = main.querySelector<HTMLElement>(":scope > .ct-header");
    const composer = main.querySelector<HTMLElement>(".ct-composer-wrap");
    const sideChatHeader = main.querySelector<HTMLElement>(".ct-docked-head");
    const toggle = host.querySelector<HTMLElement>(".br-dock-toggle");
    let previous = "";
    const measure = () => {
      const style = getComputedStyle(host);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth);
      const room = Math.max(0, Math.floor(main.getBoundingClientRect().height - (header?.getBoundingClientRect().height ?? 0) - (sideChatHeader?.getBoundingClientRect().height ?? 0) - (composer?.getBoundingClientRect().height ?? 0) - (toggle?.getBoundingClientRect().height ?? 0) - padding - 20));
      const value = `${room}px`;
      if (value !== previous) { host.style.setProperty("--br-available-room", value); previous = value; }
    };
    measure();
    const observer = new ResizeObserver(measure);
    [main, header, sideChatHeader, composer, toggle].forEach(element => { if (element) observer.observe(element); });
    return () => observer.disconnect();
  }, [jobs, expanded]);
  if (!jobs.length) return null;
  const activeCount = jobs.filter((job) => job.state === "running" || job.state === "queued").length;
  const totalBatches = jobs.reduce((sum, job) => sum + Math.max(0, job.total), 0);
  const completedBatches = jobs.reduce((sum, job) => sum + Math.max(0, job.completed), 0);
  const aggregatePercent = totalBatches > 0 ? Math.min(100, (completedBatches / totalBatches) * 100) : 0;

  return (
    <div className="br-host" ref={hostRef}>
    <aside className={`br-dock${expanded ? " is-expanded" : ""}`} aria-label="Background screening runs">
      <button
        className="br-dock-toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls="background-run-details"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={`br-dock-mark${activeCount ? " is-running" : ""}`} aria-hidden="true" />
        <span className="br-dock-summary">
          <strong>Background screening</strong>
          <small>{activeCount ? `${activeCount} active · ${completedBatches} of ${totalBatches} batches` : `${jobs.length} ${jobs.length === 1 ? "run" : "runs"} · ${completedBatches} of ${totalBatches} batches`}</small>
          <span className="br-dock-progress" role="progressbar" aria-label="All background screening progress" aria-valuemin={0} aria-valuemax={totalBatches} aria-valuenow={Math.min(completedBatches, totalBatches)}><i style={{ width: `${aggregatePercent}%` }} /></span>
        </span>
        {expanded ? <ChevronDown size={17} aria-hidden="true" /> : <ChevronUp size={17} aria-hidden="true" />}
      </button>
      {expanded && (
        <div className="br-dock-details" id="background-run-details">
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
                      <span>{job.completed} of {job.total} batches completed</span>
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
                  {canStage && <button className="br-stage" type="button" onClick={() => onAction(job.id, "stage")} disabled={job.busy}><Check size={13} aria-hidden="true" />Stage {job.completed - job.staged} batches</button>}
                </div>
                {job.updatedAt && <time className="br-updated">Updated {(() => { const date = new Date(job.updatedAt!); return Number.isNaN(date.getTime()) ? job.updatedAt : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }); })()}</time>}
              </section>
            );
          })}
        </div>
      )}
    </aside>
    </div>
  );
}
