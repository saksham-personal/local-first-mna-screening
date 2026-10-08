import { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { bucketOf, filterRows, rowPassesColumn, scoreBuckets } from "../grid/grid-filter";
import type { FilterState, GridColumnSpec } from "../grid/grid-types";
import type { GridCompany, RoundColumns } from "../lib/grid-client";
import { plural } from "../lib/format";
import HelpTip from "../ui/HelpTip";
import SelectField from "../ui/SelectField";
import Skeleton from "../ui/Skeleton";
import { defaultMetric, toggleScoreBucket, type CompanyTab } from "./score-distribution-state";
import "./score-distribution.css";

export default function ScoreDistribution({ rows, columns, rounds, tab, filterState, onFilterStateChange, loading }: {
  rows: GridCompany[]; columns: GridColumnSpec<GridCompany>[]; rounds: RoundColumns[]; tab: CompanyTab;
  filterState: FilterState; onFilterStateChange: (state: FilterState) => void; loading: boolean;
}) {
  const contentId = useId();
  const storageKey = `ws-score-distribution:${tab}:minimised`;
  const [minimised, setMinimised] = useState(() => { try { return localStorage.getItem(storageKey) === "true"; } catch { return false; } });
  const [chosen, setChosen] = useState<string>();
  const metrics = useMemo(() => columns.filter((column) => column.kind === "score"), [columns]);
  const metricId = chosen && metrics.some((column) => column.id === chosen) ? chosen : defaultMetric(tab, metrics, rounds, { has_semantic: rows.some((row) => row.mid_semantic_score !== null), has_iscc: rows.some((row) => row.iscc_relevancy !== null) });
  const column = metrics.find((metric) => metric.id === metricId);
  const scheme = column?.bucketScheme ?? { type: "integer" as const, min: 0, max: 10 };
  const counts = useMemo(() => column ? scoreBuckets(filterRows(rows, columns, filterState, { ignoreColumnId: column.id }), column, column.bucketScheme ?? { type: "integer", min: 0, max: 10 }, column.bucketScheme?.type !== "bins") : [], [rows, columns, column, filterState]);
  const maximum = Math.max(1, ...counts.map((bucket) => bucket.count));
  const hasScores = column && rows.some((row) => bucketOf(column.value(row), scheme) !== null);
  const filter = column ? filterState.columns[column.id] : undefined;
  const emptyText = /semantic/i.test(column?.id ?? "") ? "No semantic scores yet — semantic search isn't set up." : /iscc/i.test(column?.id ?? "") ? "No ISCC relevancy scores yet." : /MID/.test(column?.id ?? "") ? "No MID keyword scores yet." : rounds.length ? "No scores from this screening round yet." : "No screening rounds yet.";
  return <section className="ws-distribution" aria-label="Score distribution">
    <div className="ws-distribution-head">
      <div className="ws-distribution-title"><strong>Score distribution</strong><HelpTip size="sm" label="About score distribution">Counts follow the other column filters. Select a bar to change this score's bucket filter. CHECK stays included until you deselect it.</HelpTip></div>
      {metrics.length > 1 ? <SelectField label="Distribution metric" value={metricId ?? ""} onChange={setChosen} options={metrics.map((metric) => ({ value: metric.id, label: metric.header }))} /> : <span>{column?.header ?? "Screening score"}</span>}
      <button type="button" className="ws-distribution-minimise" aria-expanded={!minimised} aria-controls={contentId} onClick={() => { const next = !minimised; setMinimised(next); try { localStorage.setItem(storageKey, String(next)); } catch { /* storage may be disabled */ } }}>{minimised ? <ChevronDown size={14} /> : <ChevronUp size={14} />}{minimised ? "Expand" : "Minimise"}</button>
    </div>
    {!minimised && <div id={contentId}>
      {loading ? <Skeleton variant="card" rows={3} label="Loading score distribution" /> : !hasScores ? <p className="ws-distribution-empty">{emptyText}</p> : <div className="ws-distribution-scroll"><div className="ws-distribution-bars" style={{ gridTemplateColumns: `repeat(${counts.length}, minmax(35px, 1fr))` }}>
        {counts.map((bucket) => {
          const value = bucket.key === "CHECK" ? "CHECK" : scheme.type === "integer" ? bucket.key : scheme.min + (bucket.key + 0.5) * (scheme.max - scheme.min) / scheme.count;
          const selected = column ? rowPassesColumn({} as GridCompany, { ...column, value: () => value }, filter) : false;
          return <button type="button" key={bucket.key} className={`ws-distribution-bar ${selected ? "is-selected" : ""}`} aria-pressed={selected} aria-label={`Score ${bucket.label}: ${plural(bucket.count, "company", "companies")}, ${selected ? "selected" : "not selected"}`} onClick={() => column && onFilterStateChange({ ...filterState, columns: { ...filterState.columns, [column.id]: toggleScoreBucket(filter, bucket.key, scheme) } })}>
            <span className="ws-distribution-count">{bucket.count.toLocaleString()}</span>
            <span className="ws-distribution-track" aria-hidden="true"><span style={{ height: `${bucket.count / maximum * 100}%` }} /></span>
            <span className="ws-distribution-label">{bucket.label}</span>
          </button>;
        })}
      </div></div>}
    </div>}
  </section>;
}
