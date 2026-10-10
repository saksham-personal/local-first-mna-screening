import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { ExternalLink, LoaderCircle, Undo2 } from "lucide-react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { OPEN_WORKSPACE_EVENT } from "../lib/grid-client";
import { getLoopById, getLoopJobs, loadControllerLoopDetail, LOOP_UNDO_EVENT, subscribeLoops, type ControllerLoopDetail, type ControllerLoopTurn, type LoopSummaryEventData } from "../lib/loop-client";
import { buildCollapsedTurnLine } from "../lib/loop-client";
import type { LoopActivityJob } from "../lib/run-activity";
import { ControllerInstructionList, ControllerMarkdown } from "./ControllerMessage";
import { ChatScope } from "./chat-scope";
import "./loop.css";

type LoopTurnPartData = { loopId?: string; error?: string };
function Markdown({ text }: { text: string }) {
  return <MarkdownTextPrimitive className="ca-markdown" smooth={false} preprocess={() => text} />;
}
function latestTurn(detail: ControllerLoopDetail | undefined): ControllerLoopTurn | undefined {
  if (!detail?.turns.length) return undefined;
  return [...detail.turns].reverse().find(turn => turn.kind === "analyst") ?? detail.turns.at(-1);
}
function TurnContent({ turn, openSetup }: { turn: ControllerLoopTurn; openSetup: () => void }) {
  return <div className="ll-turn-content">
    {turn.reply_markdown && <><h4>Context</h4><ControllerMarkdown text={turn.reply_markdown} /></>}
    <ControllerInstructionList instructions={turn.instructions} openSetup={openSetup} />
    {turn.error && <p className="cc-reason" role="alert">{turn.error}</p>}
  </div>;
}
export function LoopTurnMessage({ data }: { data: LoopTurnPartData }) {
  const scope = useContext(ChatScope);
  const loopJobs = useSyncExternalStore(subscribeLoops, getLoopJobs, getLoopJobs);
  const loop = loopJobs.find(job => job.id === data.loopId) ?? (data.loopId ? getLoopById(data.loopId) : undefined);
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<ControllerLoopDetail>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const state = loop?.state ?? "running";
  const turns = detail?.turns ?? [];
  useEffect(() => {
    if (!expanded || !data.loopId) return;
    let active = true;
    setLoading(true);
    setError("");
    void loadControllerLoopDetail(data.loopId).then(value => { if (active) setDetail(value); })
      .catch(caught => { if (active) setError(caught instanceof Error ? caught.message : String(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [expanded, data.loopId, loop?.turn]);
  const latest = latestTurn(detail);
  if (data.error) return <article className="cc-turn ll-turn-card"><header className="cc-header"><strong>LLM Suite loop</strong></header><p className="cc-reason" role="alert">{data.error}</p></article>;
  return <article className="cc-turn ll-turn-card" id={data.loopId ? `loop-live-${data.loopId}` : undefined}>
    <header className="cc-header"><strong>{`Loop · turn ${loop?.turn ?? 0} of ${loop?.maxTurns ?? 50}`}</strong>
      {loop?.simulated && <span className="cc-badge">Simulated</span>}
      <span className={`br-state-chip br-chip-${state === "failed" ? "error" : state}`}>{state}</span>
    </header>
    {latest ? <TurnContent turn={latest} openSetup={() => scope.onAction({ type: "configure-screening", artifactId: "", provider: "llm_suite", mode: "screening" })} />
      : <p className="ll-turn-wait" role="status">{loading ? <><LoaderCircle size={13} className="spin" /> Loading the latest turn…</> : loop?.message ?? "Waiting for the first turn."}</p>}
    {!!loop?.message && loop.state !== "running" && <p className="ll-loop-message">{loop.message}</p>}
    {loop && <button className="ca-text-action ll-turn-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "Hide all turns" : "Show all turns"}</button>}
    {expanded && <div className="ll-turn-history" aria-label="Loop turns">
      {error && <p className="cc-reason" role="alert">{error}</p>}
      {loading && <p className="ll-turn-wait" role="status"><LoaderCircle size={13} className="spin" /> Loading turns…</p>}
      {!loading && turns.map(turn => <details className="ll-history-turn" key={`${turn.turn_id}:${turn.kind}`}>
        <summary>{buildCollapsedTurnLine(turn, detail?.queries ?? loop?.queries ?? [])}</summary>
        <TurnContent turn={turn} openSetup={() => scope.onAction({ type: "configure-screening", artifactId: "", provider: "llm_suite", mode: "screening" })} />
      </details>)}
      {!loading && !error && !turns.length && <p className="ll-turn-wait">No turns have been saved yet.</p>}
    </div>}
  </article>;
}

function sourceLabel(source: string) {
  return source.replaceAll("_", " ").replace(/\bmid\b/i, "MID").replace(/\biscc\b/i, "ISCC");
}
export function LoopSummaryCard({ data }: { data: LoopSummaryEventData }) {
  const loopJobs = useSyncExternalStore(subscribeLoops, getLoopJobs, getLoopJobs);
  const loop: LoopActivityJob | undefined = loopJobs.find(job => job.id === data.loopId) ?? getLoopById(data.loopId);
  const view = data.view;
  const undone = !!(loop?.undoneReviewId ?? data.undoneReviewId);
  const canUndo = !!(loop?.appliedReviewId ?? data.appliedReviewId) && !undone;
  return <article className="ll-summary-card" id={`loop-summary-${data.loopId}`} aria-label="LLM Suite loop summary">
    <header className="ll-summary-header"><h3>{view.heading}</h3>{view.simulated && <span className="cc-badge">Simulated</span>}</header>
    {view.summary && <Markdown text={view.summary} />}
    <div className="ll-query-table-wrap">
      <table className="ll-query-table">
        <thead><tr><th>Query</th><th>Source</th><th>Label</th><th>Hits</th><th>Threshold</th><th>Kept</th><th>Scores</th></tr></thead>
        <tbody>{view.queries.map(query => {
          const max = Math.max(1, ...query.histogram);
          return <tr key={query.id}>
            <th scope="row">{query.id}</th>
            <td><span className="ll-source-chip">{sourceLabel(query.source)}</span></td>
            <td className="ll-query-label" title={query.labelTitle}>{query.label}</td>
            <td>{query.hits.toLocaleString()}</td>
            <td>{query.threshold === null ? "—" : query.threshold.toFixed(2)}</td>
            <td>{query.kept.toLocaleString()}</td>
            <td><div className="ll-histogram" role="img" aria-label={`${query.id} score distribution${query.threshold === null ? "" : `, keep threshold ${query.threshold.toFixed(2)}`}`}>
              {query.histogram.map((bin, index) => <span key={index} className={index === query.thresholdBinIndex ? "is-threshold" : undefined} title={`Bin ${index + 1}: ${bin}`} style={{ height: `${Math.max(2, (bin / max) * 24)}px` }} />)}
            </div></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {!view.queries.length && <p className="ll-no-queries">No search queries were recorded.</p>}
    <p className="ll-applied-counts">{view.appliedText}</p>
    <footer className="ll-summary-actions">
      <button type="button" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_EVENT, { detail: { tab: "companies" } }))}><ExternalLink size={14} aria-hidden="true" />Open in Workspace</button>
      {undone ? <span className="ll-undone" role="status">Undone</span>
        : <button type="button" onClick={() => window.dispatchEvent(new CustomEvent(LOOP_UNDO_EVENT, { detail: { id: data.loopId } }))} disabled={!canUndo} title={!canUndo ? "No shortlist change is available to undo" : undefined}><Undo2 size={14} aria-hidden="true" />Undo</button>}
    </footer>
  </article>;
}
