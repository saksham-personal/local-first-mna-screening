import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, RotateCcw, SlidersHorizontal } from "lucide-react";
import type { ChatState } from "../lib/chat-contract";
import DataTable from "./DataTable";
import SelectField from "../ui/SelectField";
import HelpTip from "../ui/HelpTip";
import { meetsScoreRule } from "../lib/shortlist-review";
import { plural } from "../lib/format";
import "./shortlist-review.css";

type Props = {
  rows: Record<string, unknown>[];
  columns: string[];
  context: ChatState;
  planId?: string;
  onOpenCompany?: (pk: string) => void;
  onApply: (keepCompanyIds: string[], outputColumns?: string[]) => Promise<void>;
};

const metadataColumns = new Set(["index", "pk", "company name", "website", "considered"]);
const retrievalScore = (column: string) => /^(?:mid|iscc)(?:[_\s-]*(?:score|rank|ranking))$/i.test(column) || /\b(?:mid|iscc)\b.*\b(?:score|rank|ranking)\b/i.test(column);
function companyId(row: Record<string, unknown>) {
  const id = row.pk ?? row.company_id ?? row.companyId;
  return id == null || id === "" ? undefined : String(id);
}
function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

export default function ShortlistReview({ rows, columns, context, planId, onOpenCompany, onApply }: Props) {
  const currentIds = useMemo(() => context.companies.filter((company) => company.considered !== false).map((company) => company.pk), [context.companies]);
  const currentSet = useMemo(() => new Set(currentIds), [currentIds]);
  const allIds = useMemo(() => context.companies.map((company) => company.pk), [context.companies]);
  const currentKey = currentIds.slice().sort().join("\u0000");
  const previousConsidered = useRef(currentKey);
  const resultIds = useMemo(() => [...new Set(rows.map(companyId).filter((id): id is string => Boolean(id)))], [rows]);
  const resultSet = useMemo(() => new Set(resultIds), [resultIds]);
  const requestedColumns = useMemo(() => columns.filter((column) => !metadataColumns.has(column.trim().toLocaleLowerCase())), [columns]);
  const [scoreColumn, setScoreColumn] = useState("");
  const [threshold, setThreshold] = useState(7);
  const [excludeUnscored, setExcludeUnscored] = useState(true);
  const [keepCheck, setKeepCheck] = useState(true);
  const [selectedRows, setSelectedRows] = useState<string[]>(() => resultIds.filter((id) => currentIds.includes(id)));
  const [selectedOutputColumns, setSelectedOutputColumns] = useState<string[]>(() => {
    const saved = planId ? context.selectedResults?.[planId] : undefined;
    return saved ? saved.filter((column) => requestedColumns.includes(column)) : requestedColumns.filter((column) => !retrievalScore(column));
  });
  const [previewMatches, setPreviewMatches] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const rowsById = useMemo(() => {
    const entries: [string, Record<string, unknown>][] = [];
    for (const row of rows) {
      const id = companyId(row);
      if (id) entries.push([id, row]);
    }
    return new Map(entries);
  }, [rows]);
  const numericScoreColumns = useMemo(() => requestedColumns.filter((column) => (!retrievalScore(column) || selectedOutputColumns.includes(column)) && rows.some((row) => numericValue(row[column]) !== undefined || String(row[column]).trim().toUpperCase() === "CHECK")), [requestedColumns, rows, selectedOutputColumns]);
  useEffect(() => {
    setSelectedRows((current) => {
      const available = new Set(resultIds);
      const existing = current.filter((id) => available.has(id));
      if (currentKey !== previousConsidered.current) {
        previousConsidered.current = currentKey;
        return resultIds.filter((id) => currentIds.includes(id));
      }
      return existing;
    });
  }, [currentIds, currentKey, resultIds]);
  useEffect(() => {
    const saved = planId ? context.selectedResults?.[planId] : undefined;
    setSelectedOutputColumns(saved ? saved.filter((column) => requestedColumns.includes(column)) : requestedColumns.filter((column) => !retrievalScore(column)));
  }, [context.selectedResults, planId, requestedColumns]);

  const scoredRows = useMemo(() => rows.map((row) => {
    const id = companyId(row);
    return { ...row, pk: id ?? row.pk, "Rule match": scoreColumn ? meetsScoreRule(row[scoreColumn], threshold, keepCheck, !excludeUnscored) : "", Considered: id ? currentSet.has(id) ? "Yes" : "Hidden" : "" };
  }), [currentSet, rows, scoreColumn, threshold, keepCheck, excludeUnscored]);
  const matchCount = useMemo(() => new Set(rows.flatMap((row) => {
    const id = companyId(row);
    if (!id || !currentSet.has(id) || !scoreColumn) return [];
    return meetsScoreRule(row[scoreColumn], threshold, keepCheck, !excludeUnscored) ? [id] : [];
  })).size, [currentSet, rows, scoreColumn, threshold, keepCheck, excludeUnscored]);

  const preview = () => { setPreviewMatches(matchCount); setNotice(""); setError(""); };
  const outputColumns = planId ? selectedOutputColumns : undefined;
  const apply = async (keepIds: string[], success: string) => {
    setBusy(true); setError(""); setNotice("");
    try { await onApply(keepIds, outputColumns); setNotice(success); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The shortlist could not be updated. Try again."); }
    finally { setBusy(false); }
  };
  const keepMatches = () => {
    const keep = currentIds.filter((id) => {
      const row = rowsById.get(id);
      if (!row) return true;
      return !!scoreColumn && meetsScoreRule(row[scoreColumn], threshold, keepCheck, !excludeUnscored);
    });
    void apply(keep, `${plural(keep.length, "company remains in the shortlist", "companies remain in the shortlist")}.`);
  };
  const keepSelected = () => {
    const keep = [...new Set([...currentIds.filter((id) => !resultSet.has(id)), ...selectedRows])];
    void apply(keep, `${plural(keep.length, "company remains in the shortlist", "companies remain in the shortlist")}.`);
  };
  const restoreAll = () => void apply(allIds, `${plural(allIds.length, "company", "companies")} restored to the shortlist.`);
  const toggleOutputColumn = (column: string) => setSelectedOutputColumns((current) => {
    if (current.includes(column)) {
      if (retrievalScore(column) && scoreColumn === column) setScoreColumn("");
      return current.filter((value) => value !== column);
    }
    return [...current, column];
  });

  return <section className="sr-review" aria-label="Review screening results">
    <div className="sr-review-head"><div><span className="sr-review-icon"><SlidersHorizontal size={15} /></span><span><strong>Review results</strong><small>Preview a score rule and choose which companies stay.</small></span></div><span className="sr-counts"><strong>{currentIds.length.toLocaleString()}</strong> considered · <strong>{allIds.length.toLocaleString()}</strong> total <HelpTip label="About considered companies">Considered companies stay in the active working set. Hidden companies remain saved and can be restored.</HelpTip></span></div>
    <p className="sr-hidden-note">Hidden companies are saved and can be restored.</p>
    <div className="sr-controls">
      <label><span>Score column <HelpTip label="About score columns">MID and ISCC scores measure retrieval, not screening fit. Screening scores range from 0 to 10; CHECK means evidence is incomplete or conflicting.</HelpTip></span><SelectField label="Score column" value={scoreColumn || "none"} onChange={value => { setScoreColumn(value === "none" ? "" : value); setPreviewMatches(null); }} options={[{ value: "none", label: "Choose a score" }, ...numericScoreColumns.map(column => ({ value: column, label: column }))]} /></label>
      <label><span>Minimum score</span><input type="number" min={0} max={10} step="any" value={threshold} onChange={(event) => { const value = Number(event.target.value); setThreshold(Math.max(0, Math.min(10, Number.isFinite(value) ? value : 0))); setPreviewMatches(null); }} /></label>
      <label className="sr-check-option"><input type="checkbox" checked={excludeUnscored} onChange={(event) => setExcludeUnscored(event.target.checked)} /><span>Exclude companies without a score</span></label>
      <div className="sr-check-option"><label><input type="checkbox" checked={keepCheck} onChange={event => { setKeepCheck(event.target.checked); setPreviewMatches(null); }} /><span>Keep CHECK results</span></label><HelpTip label="About CHECK results">CHECK means evidence is incomplete or conflicting. Keep it selected to retain those companies for review.</HelpTip></div>
      <button className="sr-secondary" type="button" onClick={preview} disabled={!scoreColumn}>Preview matches{previewMatches !== null ? ` · ${previewMatches.toLocaleString()}` : ""}</button>
    </div>
    {!scoreColumn && <p className="sr-hint" role="status">Choose a result column to preview matches.</p>}
    {previewMatches !== null && <p className="sr-preview-count" role="status"><Check size={13} /> {plural(previewMatches, "company", "companies")} {previewMatches === 1 ? "meets" : "meet"} this rule out of {plural(currentIds.length, "company", "companies")}.</p>}
    <DataTable rows={scoredRows} columns={[...columns, "Considered", ...(scoreColumn ? ["Rule match"] : [])]} label="Screening result rows" onOpenCompany={onOpenCompany} selectedCompanyIds={selectedRows} onSelectionChange={setSelectedRows} exportCompanyIds={currentIds} />
    {planId && <div className="sr-output-columns"><strong>Use results in next screening</strong><small>Choose which requested result fields to carry forward.</small><div>{requestedColumns.map((column) => <label key={column}><input type="checkbox" checked={selectedOutputColumns.includes(column)} onChange={() => toggleOutputColumn(column)} /><span>{column}</span></label>)}</div></div>}
    {error && <p className="sr-error" role="alert"><AlertCircle size={14} />{error}</p>}
    {notice && <p className="sr-success" role="status"><Check size={14} />{notice}</p>}
    <div className="sr-actions">
      <button className="sr-secondary" type="button" onClick={() => void restoreAll()} disabled={busy}><RotateCcw size={13} />Restore all ({allIds.length.toLocaleString()})</button>
      <button className="sr-secondary" type="button" onClick={keepSelected} disabled={busy}>Keep selected ({selectedRows.length.toLocaleString()})</button>
      <button className="sr-primary" type="button" onClick={keepMatches} disabled={busy || !scoreColumn}>{busy ? "Saving…" : `Keep matches (${matchCount.toLocaleString()})`}</button>
    </div>
    {busy && <span className="sr-busy" role="status">Saving shortlist changes…</span>}
  </section>;
}
