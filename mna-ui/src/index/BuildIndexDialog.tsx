import { useEffect, useRef, useState } from "react";
import { AlertDialog, Dialog } from "radix-ui";
import { Check, Circle, Database, LoaderCircle, Minus, Upload, X } from "lucide-react";
import HelpTip from "../ui/HelpTip";
import Skeleton from "../ui/Skeleton";
import { formatDateTime, formatTime, plural } from "../lib/format";
import { validateDropFiles } from "../ui/drop-zones";
import { activateMidBundle, cancelIndexBuild, deleteMidBundle, getIndexBuild, getMidIndexStatus, listIndexBuilds, startIndexBuild, uploadIndexWorkbook, type IndexBuild, type IndexStatus, type MidBundle } from "./index-build-client";
import { buildEtaText, defaultBundleName, elapsedText, etaText, isActiveBuild, overallPercent, stepPercent, stepPresentation } from "./index-build-state";
import "./build-index.css";

type Props = {
  open: boolean; onOpenChange: (open: boolean) => void;
  builds: IndexBuild[]; selectedBuildId?: string; initialFile?: File;
  onBuild: (build: IndexBuild) => void;
  onDeleteBundle: (bundleId: string) => void;
};
export function IndexProgressBar({ value, label, thin = false }: { value: number; label: string; thin?: boolean }) {
  return <div className={`index-progress${thin ? " is-thin" : ""}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}><i style={{ width: `${value}%` }} /></div>;
}
export default function BuildIndexDialog({ open, onOpenChange, builds, selectedBuildId, initialFile, onBuild, onDeleteBundle }: Props) {
  const [status, setStatus] = useState<IndexStatus>();
  const [recent, setRecent] = useState<MidBundle[]>([]);
  const [loading, setLoading] = useState(false);
  const [file, setFile] = useState<File>();
  const [name, setName] = useState("");
  const [activate, setActivate] = useState(true);
  const [currentId, setCurrentId] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState<{ bytes: number; total: number }>();
  const [confirm, setConfirm] = useState<{ kind: "cancel" | "delete"; id: string; name: string }>();
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const uploadTask = useRef<ReturnType<typeof uploadIndexWorkbook> | undefined>(undefined);
  const request = useRef(0);
  const build = builds.find(item => item.build_id === currentId);
  const running = isActiveBuild(build);
  const selectFile = (files: File[]) => {
    try {
      if (files.length !== 1) throw new Error("Choose one .xlsx workbook.");
      validateDropFiles(files, "mid_index");
      setFile(files[0]); setName(defaultBundleName(files[0].name)); setCurrentId(undefined); setError("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const overview = async () => {
    const [summary, history] = await Promise.allSettled([getMidIndexStatus(), listIndexBuilds()]);
    return { summary, history };
  };
  const refresh = async (buildId = currentId) => {
    const { summary, history } = await overview();
    if (summary.status === "fulfilled") setStatus(summary.value);
    if (history.status === "fulfilled") setRecent(history.value.bundles);
    const runningBuild = summary.status === "fulfilled" ? summary.value.running_build : history.status === "fulfilled" ? history.value.builds.find(isActiveBuild) : undefined;
    const recovered = runningBuild ?? (history.status === "fulfilled" ? history.value.builds.find(item => item.build_id === buildId) : undefined);
    if (recovered) { onBuild(recovered); setCurrentId(recovered.build_id); }
    if (summary.status === "rejected") throw summary.reason;
    if (history.status === "rejected") throw history.reason;
    setError("");
  };
  useEffect(() => {
    if (!open) return;
    const token = ++request.current;
    setLoading(true); setStatus(undefined); setError("");
    void overview().then(({ summary, history }) => {
      if (token !== request.current) return;
      if (summary.status === "fulfilled") setStatus(summary.value);
      if (history.status === "fulfilled") setRecent(history.value.bundles);
      const next = summary.status === "fulfilled" ? summary.value : undefined;
      const builds = history.status === "fulfilled" ? history.value.builds : [];
      const runningBuild = next?.running_build ?? builds.find(isActiveBuild);
      if (runningBuild) { onBuild(runningBuild); setCurrentId(runningBuild.build_id); }
      else if (selectedBuildId) {
        const selected = builds.find(item => item.build_id === selectedBuildId);
        if (selected) { onBuild(selected); setCurrentId(selectedBuildId); }
      } else if (initialFile) selectFile([initialFile]);
      if (summary.status === "rejected" || history.status === "rejected") setError("Some index details are unavailable. Close and reopen this window to retry.");
    }).catch(failure => { if (token === request.current) setError(String(failure.message ?? failure)); })
      .finally(() => { if (token === request.current) setLoading(false); });
    return () => { request.current++; };
  // File selection is driven by the open request, not every progress update.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedBuildId, initialFile, onBuild]);
  useEffect(() => {
    if (open && build && !isActiveBuild(build)) void refresh().catch(failure => setError(String(failure.message ?? failure)));
  // Refresh the active summary once when a build finishes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, build?.build_id, build?.status]);
  useEffect(() => () => uploadTask.current?.abort(), []);

  const start = async () => {
    if (!file || busy || running) return;
    setBusy(true); setError(""); setUpload({ bytes: 0, total: file.size });
    try {
      const task = uploadIndexWorkbook(file, (bytes, total) => setUpload({ bytes, total }));
      uploadTask.current = task;
      const staged = await task.promise;
      uploadTask.current = undefined; setUpload(undefined);
      const result = await startIndexBuild(staged.id, name.trim(), activate);
      setCurrentId(result.build_id);
      try { onBuild(await getIndexBuild(result.build_id)); }
      catch { await refresh(result.build_id); }
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === "AbortError")) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { uploadTask.current = undefined; setUpload(undefined); setBusy(false); }
  };
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const active = status?.active;
  return <>
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal><Dialog.Overlay className="index-overlay" /><Dialog.Content className="index-dialog" aria-describedby="index-description" onOpenAutoFocus={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={event => { event.preventDefault(); if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); }}>
        <header className="index-dialog-head"><div><Dialog.Title><Database size={20} aria-hidden="true" />Build Index</Dialog.Title><Dialog.Description id="index-description">Build the company index from a MID workbook.</Dialog.Description></div><Dialog.Close className="index-icon-button" aria-label="Close Build Index"><X size={20} /></Dialog.Close></header>
        <div className="index-dialog-body">
          {loading ? <Skeleton variant="card" label="Loading index status" /> : <section className="index-active" aria-label="Active index">
            {!status ? <><strong>Index status unavailable</strong><p>Close and reopen this window to retry.</p></> : active ? <><strong>Active index: {active.name}</strong><p>{plural(active.row_count, "company", "companies")} · activated {formatDateTime(active.activated_at)}</p><span>Semantic search: {active.semantic_status === "ready" ? "ready" : "not set up"}</span><HelpTip label="About semantic search" size="sm">Set MNA_EMBED_ENDPOINT to connect a local embedding model before building.</HelpTip></> : <><strong>No index yet</strong><p>Choose a MID workbook to build your first company index.</p></>}
          </section>}
          {error && <p className="index-error" role="alert">{error}</p>}
          {!build && !loading && <form className="index-start" onSubmit={event => { event.preventDefault(); void start(); }}>
            <div className="index-drop" data-file-drop-zone="true" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy) selectFile(Array.from(event.dataTransfer.files)); }}>
              <Upload size={25} aria-hidden="true" /><strong>{file?.name ?? "Drop a MID workbook here"}</strong><span>One .xlsx workbook</span><button type="button" disabled={busy} onClick={() => input.current?.click()}>Browse</button><input ref={input} type="file" accept=".xlsx" aria-label="MID workbook" hidden disabled={busy} onChange={event => { if (event.target.files?.length) selectFile(Array.from(event.target.files)); event.target.value = ""; }} />
            </div>
            <label className="index-name">Bundle name<input value={name} maxLength={120} disabled={busy} onChange={event => setName(event.target.value)} placeholder="MID 2026-10-07" /></label>
            <label className="index-checkbox"><input type="checkbox" checked={activate} disabled={busy} onChange={event => setActivate(event.target.checked)} />Activate when finished</label>
            {upload ? <div role="status"><div className="index-progress-copy"><span>Uploading workbook</span><span>{Math.round(100 * upload.bytes / Math.max(1, upload.total))}%</span></div><IndexProgressBar value={100 * upload.bytes / Math.max(1, upload.total)} label="Workbook upload" /><p className="index-muted">{upload.bytes.toLocaleString()} of {upload.total.toLocaleString()} bytes</p><button type="button" onClick={() => uploadTask.current?.abort()}>Cancel upload</button></div> : <button className="index-primary" type="submit" disabled={!file || !name.trim() || busy}>{busy ? "Starting build…" : "Start build"}</button>}
          </form>}
          {build && <section className="index-build" aria-label="Index build progress">
            <div className="index-progress-copy"><strong>{build.bundle.name}</strong><span>{overallPercent(build.steps)}%</span></div><IndexProgressBar value={overallPercent(build.steps)} label="Overall index build" />
            <p className="index-muted">{running ? buildEtaText(build) : build.status === "succeeded" ? "Completed" : build.status} · elapsed {elapsedText(build.started_at, build.finished_at)}</p>
            <ol className="index-steps">{build.steps.map(step => {
              const presentation = stepPresentation(step.status);
              const Icon = step.status === "running" ? LoaderCircle : step.status === "done" ? Check : step.status === "skipped" ? Minus : step.status === "failed" ? X : Circle;
              return <li key={step.id} className={`index-step index-step-${step.status}`}><Icon size={17} className={step.status === "running" ? "index-spinner" : ""} aria-hidden="true" /><div><div className="index-step-heading"><strong>{step.label}</strong><span>{presentation.label}</span></div>{step.rows_total != null && step.rows_total > 0 && <><IndexProgressBar value={stepPercent(step)} label={`${step.label} progress`} thin /><div className="index-step-meta"><span>{step.rows_done.toLocaleString()} of {step.rows_total.toLocaleString()} rows</span><span>{step.status === "running" ? etaText(step.eta_seconds) : ""}</span></div></>}{step.rows_total == null && step.rows_done > 0 && <div className="index-step-meta"><span>{plural(step.rows_done, "row")} processed</span><span>{step.status === "running" ? etaText(step.eta_seconds) : ""}</span></div>}{step.detail && <p>{step.detail}</p>}</div><time>{elapsedText(step.started_at, step.finished_at, Date.parse(running ? new Date().toISOString() : build.finished_at ?? build.updated_at))}</time></li>;
            })}</ol>
            {running ? <button type="button" disabled={busy || build.cancel_requested} onClick={() => setConfirm({ kind: "cancel", id: build.build_id, name: build.bundle.name })}>{build.cancel_requested ? "Stopping build…" : "Cancel build"}</button> : build.status === "succeeded" ? <div className="index-result"><strong>Index ready: {plural(build.bundle.row_count, "company", "companies")}</strong><div className="index-actions"><button type="button" onClick={() => { setCurrentId(undefined); setFile(undefined); setName(""); }}>Build another</button><button className="index-primary" type="button" onClick={() => onOpenChange(false)}>Done</button></div></div> : <div className="index-result"><p className="index-error" role="alert">{build.error ?? "The index build did not finish."}</p><button type="button" onClick={() => setCurrentId(undefined)}>Try again</button></div>}
            <details className="index-section"><summary>Log</summary><ul className="index-log">{[...build.log].reverse().map((entry, index) => <li key={`${entry.at}-${index}`} className={`index-log-${entry.level}`}><time>{formatTime(entry.at, { seconds: true })}</time><span><strong>{entry.level}</strong> {entry.message}</span></li>)}{!build.log.length && <li>No log entries yet.</li>}</ul></details>
          </section>}
          {status && <details className="index-section"><summary>Columns used</summary><p className="index-muted">The configuration file is mna-tools/config/mid-index.json.</p><h3>Search columns</h3><ul className="index-columns">{status.config.search_columns.map(column => { const fts = status.config.fts5_column_names[column]; return <li key={column}><strong>{column}</strong><span>{fts} · weight {status.config.source_weights[fts] ?? "—"}</span></li>; })}</ul><h3>Description columns</h3><ul className="index-descriptions">{status.config.llm_description_columns.map(column => <li key={column}>{column}</li>)}</ul></details>}
          <details className="index-section"><summary>Recent builds</summary>{recent.length ? <ul className="index-recent">{recent.map(bundle => <li key={bundle.bundle_id}><div><strong>{bundle.name}</strong><span className={`index-chip index-chip-${bundle.status}`}>{bundle.status}</span><p>{plural(bundle.row_count, "company", "companies")} · {formatDateTime(bundle.created_at)}</p></div><div className="index-actions">{["ready", "superseded"].includes(bundle.status) && <button disabled={busy} type="button" onClick={() => { void perform(() => activateMidBundle(bundle.bundle_id)); }}>Activate</button>}{!["active", "building"].includes(bundle.status) && <button disabled={busy} type="button" onClick={() => setConfirm({ kind: "delete", id: bundle.bundle_id, name: bundle.name })}>Delete</button>}</div></li>)}</ul> : <p className="index-muted">No builds yet.</p>}</details>
        </div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
    <AlertDialog.Root open={!!confirm} onOpenChange={value => { if (!value) setConfirm(undefined); }}><AlertDialog.Portal><AlertDialog.Overlay className="index-overlay index-confirm-overlay" /><AlertDialog.Content className="index-confirm"><AlertDialog.Title>{confirm?.kind === "cancel" ? "Cancel this build?" : "Delete this index?"}</AlertDialog.Title><AlertDialog.Description>{confirm?.kind === "cancel" ? "The unfinished index will be removed; imported company records remain." : `Delete “${confirm?.name}” and its index data.`}</AlertDialog.Description><div className="index-actions"><AlertDialog.Cancel asChild><button type="button">Keep {confirm?.kind === "cancel" ? "building" : "index"}</button></AlertDialog.Cancel><AlertDialog.Action asChild><button className="index-danger" type="button" onClick={() => { const action = confirm; if (action) void perform(async () => { if (action.kind === "delete") { await deleteMidBundle(action.id); onDeleteBundle(action.id); if (build?.bundle_id === action.id) setCurrentId(undefined); } else onBuild(await cancelIndexBuild(action.id)); }); }}>{confirm?.kind === "cancel" ? "Cancel build" : "Delete index"}</button></AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>
  </>;
}
