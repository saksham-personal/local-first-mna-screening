import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { Download, Plus, Search, X } from "lucide-react";
import { DataGrid, type DataGridColumn } from "../grid/DataGrid";
import type { SortState } from "../grid/grid-types";
import { callTool } from "../lib/tool-client";
import { getChatState } from "../lib/chat-store";
import { useSessionSnapshot } from "../lib/session-store";
import type { IndexStatus } from "../index/index-build-client";
import Skeleton from "../ui/Skeleton";
import { appendKeywords, defaultDraft, draftKey, editKeyword, insertExpression, pager, restoreDraft, type Keyword, type SpaceDraft, type SpaceSearch } from "./space-model";
import { addToScreening, exportSpace, fetchSpace, recentSpace, type RecentSearch, type SpaceResult, type SpaceRow, type SyncStatus } from "./space-client";
import "./space.css";

const empty: SpaceResult = { results: [], total: 0 };
const rowId = (row: SpaceRow) => row.company_id;
const cellText = (value: unknown) => value == null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);
function initialDraft() {
  try { return restoreDraft(localStorage.getItem(draftKey)); } catch { return defaultDraft; }
}

export default function SearchSpace() {
  const [draft, setDraft] = useState(initialDraft);
  const [result, setResult] = useState<SpaceResult>(empty);
  const [isccResult, setIsccResult] = useState<SpaceResult>(empty);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [sync, setSync] = useState<SyncStatus>();
  const [index, setIndex] = useState<IndexStatus>();
  const [recent, setRecent] = useState<RecentSearch[]>([]);
  const [chipInput, setChipInput] = useState("");
  const [editing, setEditing] = useState<string>();
  const [editText, setEditText] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const [download, setDownload] = useState<{ file: string; rows: number }>();
  const [allowSimulated, setAllowSimulated] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [runId, setRunId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const [elapsed, setElapsed] = useState<number>();
  const expressionRef = useRef<HTMLInputElement>(null);
  const sessions = useSessionSnapshot();
  const runs = sessions.sessions.flatMap(s => {
    const id = getChatState(s.id).backendRunId;
    return id ? [{ id, title: s.title }] : [];
  });
  const update = (patch: Partial<SpaceDraft>) => setDraft(d => ({ ...d, ...patch }));
  useEffect(() => {
    try { localStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* Storage is optional. */ }
  }, [draft]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const refresh = async () => {
      const results = await Promise.allSettled([
        callTool("get_mid_index_status", {}, { signal: controller.signal }),
        callTool("space_sync_status", {}, { signal: controller.signal }),
        recentSpace(controller.signal),
      ]);
      if (!active) return;
      if (results[0].status === "fulfilled") setIndex(results[0].value as unknown as IndexStatus);
      if (results[1].status === "fulfilled") { setSync(results[1].value as unknown as SyncStatus); setStatusError(""); }
      else setStatusError(String(results[1].reason instanceof Error ? results[1].reason.message : results[1].reason));
      if (results[2].status === "fulfilled") setRecent(results[2].value);
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
  }, []);

  // Applied requests are independent of editable controls. Paging/export never
  // silently apply unfinished chip/expression edits.
  useEffect(() => {
    if (draft.source === "ISCC" && draft.search.kind !== "iscc") { setResult(empty); setLoading(false); return; }
    if (draft.source === "ISCC" && isccResult.query_id) {
      setResult(isccResult);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    const start = performance.now();
    setLoading(true); setError(""); setResult(empty); setDownload(undefined);
    void fetchSpace(draft.search, draft.offset, draft.limit, controller.signal).then(value => {
      if (!active) return;
      setResult(value); setElapsed(performance.now() - start);
      if (draft.search.kind === "iscc") setIsccResult(value);
      void recentSpace(controller.signal).then(setRecent).catch(() => { /* Status refresh retries history. */ });
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [draft.search, draft.offset, draft.limit, draft.source, isccResult, index?.active?.bundle_id]);

  useEffect(() => { setSelected([]); setDraft(d => ({ ...d, offset: 0 })); }, [index?.active?.bundle_id]);

  const apply = (search: SpaceSearch) => {
    setSelected([]); setNotice(""); setDownload(undefined); setError(""); setIsccResult(empty);
    update({ search, offset: 0 });
  };
  const switchSource = (source: "MID" | "ISCC") => {
    setSelected([]); setResult(empty); setIsccResult(empty); setDownload(undefined); setError(""); setNotice("");
    update({ source, search: { kind: "browse" }, offset: 0 });
  };
  const lexicalApply = () => {
    const keywords = appendKeywords(draft.keywords, chipInput);
    update({ keywords }); setChipInput("");
    apply(keywords.length || draft.expression.trim() ? { kind: "lexical", keywords, expression: draft.expression } : { kind: "browse" });
  };
  const restoreRecent = (id: string) => {
    const item = recent.find(r => r.query_id === id);
    if (!item) return;
    const p = item.parameters;
    if (item.source === "SPACE_LEXICAL") {
      const keywords = (p.keywords as Keyword[] | undefined)?.map((k, i) => ({ ...k, id: k.id || `k${i + 1}`, match: k.match || "stem" as const })) ?? [];
      const expression = String(p.expression ?? "");
      switchSource("MID"); update({ method: "lexical", keywords, expression }); apply({ kind: "lexical", keywords, expression });
    } else if (item.source === "SPACE_SEMANTIC") {
      const text = String(p.text ?? "");
      switchSource("MID"); update({ method: "semantic", text }); apply({ kind: "semantic", text });
    } else {
      const query = String(p.query ?? ""), count = Number(p.count ?? 100);
      switchSource("ISCC"); update({ query, count }); apply({ kind: "iscc", query, count });
    }
  };
  const insert = (token: string) => {
    const input = expressionRef.current;
    const next = insertExpression(draft.expression, token, input?.selectionStart ?? undefined, input?.selectionEnd ?? undefined);
    update({ expression: next.value });
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(next.cursor, next.cursor); });
  };
  const finishEdit = () => {
    if (editing) update({ keywords: editKeyword(draft.keywords, editing, editText) });
    setEditing(undefined);
  };
  const columns = useMemo<DataGridColumn<SpaceRow>[]>(() => {
    const sourceColumns = result.columns ?? [];
    const companyColumn = sourceColumns.find(c => /^(company|company name)$/i.test(c));
    const cols: DataGridColumn<SpaceRow>[] = [{ id: companyColumn ?? "__name", header: "Company", kind: "text", value: r => r.name, tooltip: r => r.name, pinned: "left", width: 240, sortable: draft.search.kind === "browse" && !!companyColumn }];
    if (draft.search.kind === "lexical") cols.push(
      { id: "__matched", header: "Matched keywords", kind: "text", value: r => r.matched_keywords?.map(k => k.text).join(", "), width: 240, sortable: false },
      { id: "__raw", header: "Raw score", kind: "number", value: r => r.raw_score, width: 110, sortable: false },
      { id: "__strength", header: "Match strength", kind: "number", value: r => r.match_strength, width: 130, render: r => <span className="space-score">{r.match_strength?.toFixed(0)}%</span>, sortable: false },
    );
    if (draft.search.kind === "semantic") cols.push({ id: "__semantic", header: "Semantic score (0–10)", kind: "number", value: r => r.score, width: 165, render: r => <span className="space-score">{r.score?.toFixed(1)}</span>, sortable: false });
    for (const c of sourceColumns.filter(c => c !== companyColumn && !/^iq\s*link$/i.test(c))) cols.push({
      id: c, header: c, kind: index?.config.column_types[c] ?? "text", value: r => r.values[c], tooltip: r => cellText(r.values[c]), width: /description/i.test(c) ? 340 : 170,
      hidden: draft.source === "MID" && !!index?.config.display_columns.length && !index.config.display_columns.includes(c), sortable: draft.search.kind === "browse",
    });
    return cols;
  }, [result.columns, draft.search.kind, draft.source, index]);
  const sort: SortState = draft.search.kind === "browse" && draft.search.sort ? { columnId: draft.search.sort.column, direction: draft.search.sort.direction } : null;
  const onSort = (sort: SortState) => {
    if (draft.search.kind === "browse") { setSelected([]); update({ search: { kind: "browse", ...(sort ? { sort: { column: sort.columnId, direction: sort.direction } } : {}) }, offset: 0 }); }
  };
  const pagedRows = draft.source === "ISCC" ? result.results.slice(draft.offset, draft.offset + draft.limit) : result.results;
  const accessibleTotal = draft.search.kind === "semantic" ? Math.min(5000, result.total) : result.total;
  const paging = pager(accessibleTotal, draft.offset, draft.limit);
  const simulated = !!result.simulated || result.results.some(r => r.simulated);
  const status = statusError || (sync?.meili === "down" ? "Meilisearch is not running" : sync?.task_status === "processing" ? "Indexing…" : sync?.task_status === "succeeded" && sync.documents > 0 ? `Lexical index ready · ${sync.documents.toLocaleString()} companies` : "Search Space index is not synced yet");
  const exportResults = async () => {
    setExporting(true); setError("");
    try { setDownload(await exportSpace(draft.search, simulated && allowSimulated)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setExporting(false); }
  };
  const add = async () => {
    setAdding(true); setError("");
    try {
      const response = await addToScreening(runId, selected, result.query_id);
      setNotice(`Added ${response.added.toLocaleString()} companies to ${runs.find(r => r.id === runId)?.title ?? runId}.`);
      setSelected([]); setAddOpen(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setAdding(false); }
  };

  return <section className="space-view" aria-label="Search Space">
    <div className="space-heading">
      <div><h1>Search Space</h1><p>Explore the population and choose companies for a screening.</p></div>
      <div className="space-segment" aria-label="Discovery source">{(["MID", "ISCC"] as const).map(source => <button type="button" key={source} aria-pressed={draft.source === source} onClick={() => switchSource(source)}>{source}</button>)}</div>
    </div>
    <div className="space-bundle"><strong>{index?.active?.name ?? "No active MID bundle"}</strong><span role="status">{status}</span></div>
    <div className="space-search-panel">
      <div className="space-search-head">
        {draft.source === "MID" ? <div className="space-segment" aria-label="Search method">{(["lexical", "semantic"] as const).map(method => <button type="button" key={method} aria-pressed={draft.method === method} onClick={() => { update({ method }); apply({ kind: "browse" }); }}>{method === "lexical" ? "Lexical" : "Semantic"}</button>)}</div> : <strong>ISCC discovery</strong>}
        <label className="space-recent">Recent searches<select aria-label="Recent searches" value="" onChange={e => restoreRecent(e.target.value)}><option value="">Choose a search</option>{recent.map(r => <option key={r.query_id} value={r.query_id}>{r.source.replace("SPACE_", "")} · {r.query === "keywords" ? (r.parameters.keywords as Keyword[] | undefined)?.map(k => k.text).join(", ") : r.query}</option>)}</select></label>
      </div>
      {draft.source === "MID" && draft.method === "lexical" && <>
        <div className="space-keywords"><span>Keywords ({draft.keywords.length})</span><div className="space-chips">{draft.keywords.map(k => <span className="space-chip" key={k.id}>
          {editing === k.id ? <input aria-label={`Edit ${k.id}`} value={editText} autoFocus onChange={e => setEditText(e.target.value)} onBlur={finishEdit} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); finishEdit(); } if (e.key === "Escape") setEditing(undefined); }} /> : <button type="button" title="Click to edit keyword" onClick={() => { setEditing(k.id); setEditText(k.text); }}><small>{k.id}</small>{k.text}</button>}
          <button type="button" aria-label={`Remove ${k.text}`} onClick={() => update({ keywords: draft.keywords.filter(item => item.id !== k.id) })}><X size={12} /></button>
        </span>)}<input aria-label="Add keywords" placeholder="Add keywords, then Enter or comma" value={chipInput} maxLength={2000} onChange={e => { if (e.target.value.includes(",")) { update({ keywords: appendKeywords(draft.keywords, e.target.value) }); setChipInput(""); } else setChipInput(e.target.value); }} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); update({ keywords: appendKeywords(draft.keywords, chipInput) }); setChipInput(""); } }} /></div></div>
        {draft.keywords.length === 50 && <p className="space-note">Maximum 50 keywords. Remove one to add another.</p>}
        <div className="space-expression"><label htmlFor="space-expression">Query Expression</label><input id="space-expression" ref={expressionRef} value={draft.expression} maxLength={2000} placeholder='e.g. (k1 OR k2) AND NOT k3' onChange={e => update({ expression: e.target.value })} onKeyDown={e => { if (e.key === "Enter") lexicalApply(); }} /><div className="space-operators">{["AND", "OR", "NOT", "(", ")"].map(token => <button key={token} type="button" onMouseDown={e => e.preventDefault()} onClick={() => insert(token)}>{token}</button>)}<button className="space-primary" type="button" disabled={loading} onClick={lexicalApply}>Apply</button></div></div>
        {draft.expression.trim() && <p className="space-note">The Query Expression overrides the keyword union. Use keyword text or chip ids (k1, k2…).</p>}
      </>}
      {draft.source === "MID" && draft.method === "semantic" && <form className="space-text-search" onSubmit={e => { e.preventDefault(); apply({ kind: "semantic", text: draft.text }); }}><label htmlFor="space-semantic">Describe the core business</label><textarea id="space-semantic" value={draft.text} maxLength={2000} required rows={3} placeholder="Companies that make software for insurance claims processing" onChange={e => update({ text: e.target.value })} /><button className="space-primary" disabled={loading || !draft.text.trim()}><Search size={14} />Search</button></form>}
      {draft.source === "ISCC" && <form className="space-text-search" onSubmit={e => { e.preventDefault(); apply({ kind: "iscc", query: draft.query, count: draft.count }); }}><label htmlFor="space-iscc">Query (up to 300 characters)</label><textarea id="space-iscc" value={draft.query} maxLength={300} required rows={2} placeholder="Describe the companies to discover" onChange={e => update({ query: e.target.value })} /><div className="space-iscc-actions"><label>Count<input type="number" min={1} max={1000} step={1} value={draft.count} onChange={e => update({ count: Number(e.target.value) })} /></label><button className="space-primary" disabled={loading || !draft.query.trim() || !Number.isInteger(draft.count) || draft.count < 1 || draft.count > 1000}><Search size={14} />Search</button></div></form>}
      {error && <p role="alert" className="space-error">{error}</p>}
    </div>
    {result.status === "skipped" && <p className="space-message" role="status">{result.reason}</p>}
    {notice && <p className="space-message" role="status">{notice}</p>}
    <div className="space-results-bar">
      <span aria-live="polite">Showing {paging.first.toLocaleString()}–{paging.last.toLocaleString()} of {result.total.toLocaleString()}{elapsed !== undefined && <small> · {(elapsed / 1000).toFixed(2)}s</small>}</span>
      {simulated && <span className="space-simulated">SIMULATED</span>}
      <div className="space-result-actions">
        {simulated && <label className="space-simulated-export"><input type="checkbox" checked={allowSimulated} onChange={e => setAllowSimulated(e.target.checked)} />Allow simulated export</label>}
        <button type="button" disabled={loading || exporting || !result.total || (simulated && !allowSimulated)} onClick={() => { void exportResults(); }}><Download size={14} />{exporting ? "Exporting…" : "Export"}</button>
        <button type="button" disabled={loading || !selected.length || selected.length > 5000} onClick={() => { setRunId(runs[0]?.id ?? ""); setConfirmed(false); setAddOpen(true); }}><Plus size={14} />Add to screening ({selected.length})</button>
      </div>
    </div>
    {exporting && <Skeleton variant="line" label="Exporting Search Space results" />}
    {download && <a className="space-download" href={`/api/exports/${encodeURIComponent(download.file)}`} download>Download XLSX · {download.rows.toLocaleString()} companies</a>}
    {draft.search.kind === "semantic" && result.total > 5000 && <p className="space-note">The table shows the top 5,000 semantic matches. Export includes all matching companies.</p>}
    <div className="space-table">{result.columns ? <DataGrid key={`${draft.source}:${draft.search.kind}:${result.bundle_id ?? ""}:${result.columns.join("|")}:${index?.config.display_columns.join("|") ?? ""}`} rows={pagedRows} columns={columns} getRowId={rowId} label="Search Space companies" height="fill" loading={loading} emptyText="No companies found." selectable selectedIds={selected} onSelectedIdsChange={setSelected} sort={sort} onSortChange={onSort} rowHeight={36} storageKey={`space-columns-${draft.source}-${draft.search.kind}`} toolbarExtra={<span className="space-note">Filters apply to this page</span>} /> : loading ? <Skeleton variant="table" rows={8} label="Loading Search Space companies" /> : <p className="space-note">{error ? "Search did not complete. Review the message above." : draft.source === "ISCC" ? "Enter a query to discover ISCC companies." : result.reason ?? "No companies found."}</p>}</div>
    <div className="space-pager"><button type="button" disabled={loading || !paging.canPrevious} onClick={() => update({ offset: paging.previous })}>Prev</button><span>Page {Math.floor(draft.offset / draft.limit) + 1} of {Math.max(1, Math.ceil(accessibleTotal / draft.limit))}</span><button type="button" disabled={loading || !paging.canNext} onClick={() => update({ offset: paging.next })}>Next</button><label>Rows per page<select aria-label="Rows per page" value={draft.limit} onChange={e => update({ limit: Number(e.target.value), offset: 0 })}><option value={100}>100</option><option value={200}>200</option></select></label></div>
    <Dialog.Root open={addOpen} onOpenChange={open => { if (!adding) setAddOpen(open); }}><Dialog.Portal><Dialog.Overlay className="space-dialog-overlay" /><Dialog.Content className="space-dialog" onEscapeKeyDown={e => { if (adding) e.preventDefault(); }} onInteractOutside={e => { if (adding) e.preventDefault(); }}>
      <Dialog.Title>Add to screening</Dialog.Title><Dialog.Description>{confirmed ? `Add ${selected.length.toLocaleString()} companies to ${runs.find(r => r.id === runId)?.title ?? runId} as ${draft.source} candidates?` : "Choose an existing screening run for the selected companies."}</Dialog.Description>
      {!confirmed && <label>Screening<select value={runId} onChange={e => setRunId(e.target.value)} aria-label="Screening run"><option value="">Choose a screening</option>{runs.map(run => <option key={run.id} value={run.id}>{run.title}</option>)}</select></label>}
      {!runs.length && <p>No screening runs yet. Create a screening and save criteria first.</p>}
      {simulated && <p className="space-note">These companies are simulated and will retain that label.</p>}
      {error && <p className="space-error" role="alert">{error}</p>}
      <div className="space-dialog-actions"><button type="button" disabled={adding} onClick={() => setAddOpen(false)}>Cancel</button><button type="button" className="space-primary" disabled={!runId || adding} onClick={() => { if (!confirmed) setConfirmed(true); else void add(); }}>{adding ? "Adding…" : confirmed ? "Confirm addition" : "Continue"}</button></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}
