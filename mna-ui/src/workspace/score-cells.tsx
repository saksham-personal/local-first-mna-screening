import type { ReactNode } from "react";
import { Tooltip } from "radix-ui";
import { parseScore } from "../grid/grid-filter";
import type { MidKeyword } from "../lib/grid-client";
import "./score-cells.css";

export function ScorePill({ value }: { value: unknown }) {
  const score = parseScore(value);
  if (score === null) return <span className="ws-score-missing">—</span>;
  const tone = score === "CHECK" ? "neutral" : score < 4 ? "danger" : score < 7 ? "warning" : "success";
  return <span role="img" className={`ws-score-pill ws-score-${tone}`} aria-label={score === "CHECK" ? "CHECK" : `Score ${score} out of 10`}>{score}</span>;
}

export function SemanticBar({ value }: { value: number | null }) {
  if (value === null) return <span className="ws-score-missing">—</span>;
  return <span role="img" className="ws-semantic" aria-label={`MID semantic score ${value.toFixed(1)} out of 10`}>
    <span className="ws-semantic-track" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(10, value)) * 10}%` }} /></span>
    <span>{value.toFixed(1)}</span>
  </span>;
}

export function KeywordEvidence({ data }: { data: MidKeyword }) {
  return <div className="ws-keyword-evidence">
    <div className="ws-keyword-chips">{data.matched.length ? data.matched.map((item, index) => <span key={`${item.text}-${index}`}>{item.text}</span>) : <span>No matched keywords</span>}</div>
    {data.queries.map((query, index) => <div className="ws-keyword-query" key={`${query.query_id}-${index}`}><p>{query.rationale}</p><code>{query.display_query.startsWith(`${query.rationale} (`) && query.display_query.endsWith(")") ? query.display_query.slice(query.rationale.length + 2, -1) : query.display_query}</code></div>)}
  </div>;
}

export function KeywordTooltip({ data, children }: { data: MidKeyword | null; children: ReactNode }) {
  if (!data) return <span className="ws-score-missing">—</span>;
  return <Tooltip.Provider delayDuration={200}>
    <Tooltip.Root>
      <Tooltip.Trigger asChild><button type="button" className="ws-keyword-trigger" aria-label={`MID keyword match ${data.best_match_pct ?? "unavailable"} percent; show matched keywords and queries`} onClick={(event) => event.stopPropagation()}>{children}</button></Tooltip.Trigger>
      <Tooltip.Portal><Tooltip.Content className="ws-keyword-tooltip" side="top" sideOffset={6} collisionPadding={12}><strong>Matched keywords</strong><KeywordEvidence data={data} /></Tooltip.Content></Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>;
}
