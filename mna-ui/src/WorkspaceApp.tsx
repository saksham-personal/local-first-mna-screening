import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  List,
  MessageSquare,
  UploadCloud,
} from "lucide-react";
import HelpTip from "./ui/HelpTip";
import Skeleton from "./ui/Skeleton";
import ArtifactCard from "./chat/ArtifactCard";
import type {
  ArtifactAction,
  ChatArtifact,
  ChatState,
  JobSnapshot,
} from "./lib/chat-contract";
import type { ExportKind } from "./lib/contracts";
import { approved } from "./lib/chat-store";
import { consideredCompanies } from "./lib/chat-policy";
import {
  applyGridReview,
  fetchScreeningGrid,
  fetchScreeningRounds,
  hideIds,
  hiddenReasonLabel,
  keepOnlyIds,
  restoreIds,
  type GridCompany,
  type ScreeningGrid,
  type ScreeningRound,
} from "./lib/grid-client";
import type { DataGridProps } from "./grid/DataGrid";
import { buildCompanyColumns } from "./workspace/company-columns";
import { formatTime, plural } from "./lib/format";
import { emptyFilterState } from "./grid/grid-filter";
import type { FilterState } from "./grid/grid-types";
import ScoreDistribution from "./workspace/ScoreDistribution";
import { belongsToTab, type CompanyTab } from "./workspace/score-distribution-state";
import "./workspace/workspace.css";
import FilesTab from "./workspace/FilesTab";
import { processStagedUploads } from "./lib/import-pipeline";

type GenericDataGrid = <Row>(props: DataGridProps<Row>) => ReactElement;
const DataGrid = lazy(() => import("./grid/DataGrid").then((module) => ({ default: module.DataGrid }))) as unknown as GenericDataGrid;
const CompanyDrawer = lazy(() => import("./workspace/CompanyDrawer"));

type WorkspaceTab = "overview" | "companies" | "files";

type Props = {
  sessionTitle: string;
  state: ChatState;
  job?: JobSnapshot;
  busy: boolean;
  onAction: (action: ArtifactAction) => void;
  send: (text: string, action?: ArtifactAction) => void;
  openLog: (eventId?: string) => void;
  onIntakeFiles?: (files: File[]) => void | Promise<void>;
  /** A tab asked for from outside (e.g. "Open in Workspace" on a chat card); `n` makes repeats count. */
  requestedTab?: { tab: WorkspaceTab; n: number };
};

function latestArtifact<T extends ChatArtifact["type"]>(
  artifacts: ChatArtifact[],
  type: T,
) {
  return artifacts
    .slice()
    .reverse()
    .find((artifact) => artifact.type === type) as
    | Extract<ChatArtifact, { type: T }>
    | undefined;
}

function StatCard({
  label,
  value,
  tone,
  detail,
  help,
}: {
  label: string;
  value: number | string;
  tone: "accent" | "success" | "info" | "warning";
  detail: string;
  help?: string;
}) {
  return (
    <article className={`ws-stat ws-stat-${tone}`}>
      <span>{label}{help && <HelpTip label={`About ${label.toLowerCase()}`}>{help}</HelpTip>}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function WorkspaceStatus({
  state,
  job,
}: {
  state: ChatState;
  job?: JobSnapshot;
}) {
  const isApproved = approved(state);
  const searched = job?.state === "completed" || state.companies.length > 0;
  const steps = [
    {
      label: "Criteria",
      detail: state.criteriaText ? "Draft ready" : "Waiting for criteria",
      done: !!state.criteriaText,
      active: !state.criteriaText,
    },
    {
      label: "Approval",
      detail: isApproved ? "Approved" : "Needs your review",
      done: isApproved,
      active: !!state.criteriaText && !isApproved,
    },
    {
      label: "Company search",
      detail:
        job?.state === "running"
          ? "Searching"
          : job?.state === "error"
            ? "Failed — see the chat for details"
            : job?.state === "cancelled"
              ? "Stopped; completed work is saved"
              : searched
                ? `${plural(state.companies.length, "company", "companies")} saved`
                : "Not started",
      done: searched,
      active: job?.state === "running" || (isApproved && !job && !searched),
      failed: job?.state === "error",
    },
    {
      label: "Next step",
      detail: state.companies.length
        ? "Choose research or enrichment"
        : "After search",
      done: false,
      active: state.companies.length > 0,
    },
  ];
  return (
    <ol className="ws-progress" aria-label="Screening progress">
      {steps.map((step, index) => (
        <li
          key={step.label}
          className={`${step.done ? "ws-step-done" : ""} ${step.active ? "ws-step-active" : ""} ${"failed" in step && step.failed ? "ws-step-failed" : ""}`}
        >
          <span className="ws-step-marker">
            {step.done ? <Check size={13} /> : index + 1}
          </span>
          <div>
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
          </div>
        </li>
      ))}
    </ol>
  );
}

function EmptyState({
  icon,
  title,
  detail,
  action,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="ws-empty">
      <span>{icon}</span>
      <h3>{title}</h3>
      <p>{detail}</p>
      {action}
    </div>
  );
}

function Overview({
  state,
  job,
  busy,
  onAction,
  send,
  openLog,
  onOpenCompanies,
  onOpenFiles,
}: Omit<Props, "sessionTitle"> & {
  onOpenCompanies: () => void;
  onOpenFiles: () => void;
}) {
  const [rounds, setRounds] = useState<ScreeningRound[]>([]);
  const [roundsLoading, setRoundsLoading] = useState(false);
  const [roundsError, setRoundsError] = useState("");
  const [simulated, setSimulated] = useState(false);
  const [summaryGrid, setSummaryGrid] = useState<ScreeningGrid | null>(null);
  useEffect(() => {
    let current = true;
    setRounds([]);
    setSimulated(false);
    setSummaryGrid(null);
    if (!state.backendRunId) return;
    setRoundsLoading(true);
    setRoundsError("");
    void fetchScreeningGrid(state.sessionId, state.backendRunId).then((grid) => { if (current) { setSimulated(grid.rows.some((row) => row.simulated)); setSummaryGrid(grid); } }).catch(() => {});
    const load = () => fetchScreeningRounds(state.sessionId, state.backendRunId!).then((result) => {
      if (current) { setRounds(result); setRoundsError(""); }
    }).catch((error) => { if (current) setRoundsError(error instanceof Error ? error.message : "Screening rounds could not be loaded."); }).finally(() => { if (current) setRoundsLoading(false); });
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => { current = false; window.clearInterval(timer); };
  }, [state.backendRunId, state.sessionId, state.selectionRevision]);
  const criteria = latestArtifact(state.artifacts, "criteria");
  const options =
    approved(state) && state.companies.length
      ? latestArtifact(state.artifacts, "options")
      : undefined;
  const runningArtifact =
    job?.state === "running"
      ? state.artifacts
          .slice()
          .reverse()
          .find(
            (artifact) => artifact.type === "job" && artifact.jobId === job.id,
          )
      : undefined;
  const total = summaryGrid?.consideredCount ?? consideredCompanies(state).length;
  const sourceCount = (source: GridCompany["source"], fallback: number) => summaryGrid ? summaryGrid.rows.filter((row) => row.considered && row.source === source).length : fallback;
  return (
    <div className="ws-overview">
      {(simulated || rounds.some((round) => round.simulated)) && <SimulatedBanner />}
      {roundsLoading && <Skeleton variant="card" rows={2} label="Loading screening rounds" />}
      {roundsError && <p className="ws-grid-error" role="alert">{roundsError}</p>}
      {rounds.length > 0 && <section className="ws-card ws-rounds-card">
        <div className="ws-section-head"><h2>Screening rounds</h2><HelpTip label="About screening rounds">Each round keeps its own provider scores and outputs. Counts describe the saved round results, including companies later hidden.</HelpTip></div>
        <ol className="ws-rounds-timeline">{[...rounds].sort((a, b) => b.round_no - a.round_no).map((round) => {
          const distribution = round.score_distribution[round.score_columns[0]];
          const high = distribution ? [7, 8, 9, 10].reduce((sum, score) => sum + (distribution[String(score)] ?? 0), 0) : undefined;
          return <li key={round.plan_id}>
            <div><strong>R{round.round_no} {round.provider_label}</strong>{round.simulated && <span className="ws-simulated-badge">Simulated</span>}</div>
            <p>{round.assessed_companies.toLocaleString()} companies · 7–10: {high?.toLocaleString() ?? "—"} · CHECK: {distribution?.CHECK?.toLocaleString() ?? "—"} · started <time dateTime={round.created_at}>{formatTime(round.created_at)}</time></p>
            <span className="ws-round-progress">{round.jobs.running || round.jobs.ready ? "In progress" : round.jobs.failed || round.jobs.other ? "Needs review" : round.jobs.total && round.jobs.done === round.jobs.total ? "Complete" : "Approved"} · {round.jobs.done.toLocaleString()}/{round.jobs.total.toLocaleString()} jobs complete{round.jobs.failed ? ` · ${round.jobs.failed} failed` : ""}</span>
          </li>;
        })}</ol>
      </section>}
      <section className="ws-summary-grid">
        <StatCard
          label="Shortlist"
          value={total}
          tone="accent"
          detail={total ? "Currently considered" : "Search after approval"}
          help="Considered companies stay in the active working set. Hidden companies remain saved and can be restored."
        />
        <StatCard
          label="MID only"
          value={sourceCount("MID", state.counts.midOnly)}
          tone="info"
          detail="Found in the internal company set"
        />
        <StatCard
          label="ISCC only"
          value={sourceCount("ISCC", state.counts.isccOnly)}
          tone="warning"
          detail="Found in the ISCC company set"
        />
        <StatCard
          label="Both sources"
          value={sourceCount("both", state.counts.both)}
          tone="success"
          detail="Matched across MID and ISCC"
        />
      </section>

      <div className="ws-two-column">
        <section className="ws-card ws-criteria-panel">
          <div className="ws-section-head">
            <div>
              <h2>Business criteria</h2>
            </div>
            {approved(state) ? (
              <span className="ws-status ws-status-success">
                <CheckCircle2 size={14} /> Approved
              </span>
            ) : state.criteriaText ? (
              <span className="ws-status ws-status-warning">Needs review</span>
            ) : (
              <span className="ws-status ws-status-neutral">Not started</span>
            )}
          </div>
          {criteria ? (
            <ArtifactCard artifact={criteria} onAction={onAction} />
          ) : (
            <EmptyState
              icon={<FileText size={23} />}
              title="Describe the companies you want"
              detail="Use the chat to define the core business, products, services, and customers."
              action={
                <button
                  type="button"
                  className="ws-primary"
                  onClick={() => send("/criteria", { type: "command", artifactId: "", label: "Opened criteria" })}
                >
                  Start in chat <MessageSquare size={14} />
                </button>
              }
            />
          )}
        </section>

        <section className="ws-card ws-progress-card">
          <div className="ws-section-head">
            <div>
              <h2>What happens next</h2>
            </div>
            <button type="button" className="ws-link" onClick={() => openLog()}>
              <List size={14} /> Session log
            </button>
          </div>
          <WorkspaceStatus state={state} job={job} />
        </section>
      </div>

      {(runningArtifact || options || total > 0) && (
        <section className="ws-card ws-next-panel">
          <div className="ws-section-head">
            <div>
              <h2>
                {job?.state === "running"
                  ? "Search in progress"
                  : "Choose your next step"}
              </h2>
            </div>
            {job?.state === "running" && (
              <span className="ws-status ws-status-info">
                <Clock3 size={14} /> Running
              </span>
            )}
          </div>
          {runningArtifact && (
            <ArtifactCard artifact={runningArtifact} onAction={onAction} />
          )}
          {!runningArtifact && options && !options.dismissed && (
            <ArtifactCard artifact={options} onAction={onAction} />
          )}
          {!runningArtifact && (!options || options.dismissed) && total > 0 && (
            <div className="ws-inline-actions">
              <button
                type="button"
                className="ws-primary"
                onClick={onOpenCompanies}
              >
                Review companies <ArrowRight size={14} />
              </button>
              <button
                type="button"
                className="ws-secondary"
                onClick={onOpenFiles}
              >
                Add enrichment files <UploadCloud size={14} />
              </button>
            </div>
          )}
        </section>
      )}

      {!state.criteriaText && (
        <section className="ws-starter">
          <div>
            <h2>Try a screening with fictional data</h2>
            <p>Review and approve the criteria before discovery.</p>
          </div>
          <button
            type="button"
            className="ws-primary"
            disabled={busy}
            onClick={() => send("/example", { type: "command", artifactId: "", label: "Tried the example" })}
          >
            Run the example <ArrowRight size={14} />
          </button>
        </section>
      )}
    </div>
  );
}

const emptyGridRows: GridCompany[] = [];
const emptyRounds: ScreeningGrid["rounds"] = [];

function SimulatedBanner() {
  return <p className="ws-simulated-banner" role="status">Simulated data — for development only. Exports are blocked unless allowed.</p>;
}

function Companies({ state, onAction }: { state: ChatState; onAction: Props["onAction"] }) {
  const [gridData, setGridData] = useState<ScreeningGrid | null>(null);
  const [loading, setLoading] = useState(Boolean(state.backendRunId));
  const [gridError, setGridError] = useState("");
  const [writeError, setWriteError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [visibleRows, setVisibleRows] = useState<GridCompany[]>(emptyGridRows);
  const [sourceTab, setSourceTab] = useState<CompanyTab>("All");
  const [filtersByTab, setFiltersByTab] = useState<Record<CompanyTab, FilterState>>(() => ({ All: emptyFilterState(), MID: emptyFilterState(), ISCC: emptyFilterState() }));
  const rounds = gridData?.rounds ?? emptyRounds;
  const columns = useMemo(() => buildCompanyColumns(rounds), [rounds]);
  const filterState = filtersByTab[sourceTab];
  const changeFilters = useCallback((next: FilterState) => setFiltersByTab((current) => ({ ...current, [sourceTab]: next })), [sourceTab]);
  const [columnPreferences, setColumnPreferences] = useState<Partial<Record<CompanyTab, { visible: string[]; known: string[] }>>>(() => {
    const saved: Partial<Record<CompanyTab, { visible: string[]; known: string[] }>> = {};
    for (const tab of ["All", "MID", "ISCC"] as const) {
      try {
        const value = JSON.parse(localStorage.getItem(`ws-company-columns:${tab}`) ?? "null");
        if (value && Array.isArray(value.visible) && Array.isArray(value.known) && [...value.visible, ...value.known].every((id) => typeof id === "string")) saved[tab] = value;
      } catch { /* use default visibility */ }
    }
    return saved;
  });
  const visibleColumnIds = useMemo(() => {
    const saved = columnPreferences[sourceTab];
    return saved ? columns.filter((column) => saved.visible.includes(column.id) || (!saved.known.includes(column.id) && !column.hidden)).map((column) => column.id) : columns.filter((column) => !column.hidden).map((column) => column.id);
  }, [columns, columnPreferences, sourceTab]);
  const changeVisibleColumns = useCallback((visible: string[]) => {
    const next = { visible, known: columns.map((column) => column.id) };
    setColumnPreferences((current) => ({ ...current, [sourceTab]: next }));
    try { localStorage.setItem(`ws-company-columns:${sourceTab}`, JSON.stringify(next)); } catch { /* storage may be disabled */ }
  }, [columns, sourceTab]);
  const gridRequest = useRef(0);
  const result = state.artifacts
    .slice()
    .reverse()
    .find(
      (artifact) =>
        artifact.type === "companies" &&
        artifact.backendRunId === state.backendRunId &&
        artifact.companies.length === state.companies.length &&
        artifact.companies.every(
          (company, index) => company.pk === state.companies[index]?.pk,
        ),
    ) as Extract<ChatArtifact, { type: "companies" }> | undefined;
  const allRows = gridData?.rows ?? emptyGridRows;
  const hiddenRows = useMemo(() => allRows.filter((row) => !row.considered), [allRows]);
  const rows = useMemo(
    () => allRows.filter((row) => belongsToTab(row.source, sourceTab) && (showHidden || row.considered)),
    [allRows, showHidden, sourceTab],
  );
  const selected = allRows.find((row) => row.company_id === drawerId) ?? null;
  const loadGrid = useCallback(async () => {
    const request = ++gridRequest.current;
    const runId = state.backendRunId;
    if (!runId) {
      setGridData(null);
      setGridError("");
      setLoading(false);
      return null;
    }
    setLoading(true);
    setGridError("");
    try {
      const data = await fetchScreeningGrid(state.sessionId, runId);
      if (request === gridRequest.current) setGridData(data);
      return data;
    } catch (caught) {
      if (request === gridRequest.current) setGridError(caught instanceof Error ? caught.message : "Companies could not be loaded.");
      throw caught;
    } finally {
      if (request === gridRequest.current) setLoading(false);
    }
  }, [state.backendRunId, state.sessionId]);
  useEffect(() => {
    void loadGrid().catch(() => {});
  }, [loadGrid, state.selectionRevision, state.artifacts]);
  useEffect(() => {
    const visibleIds = new Set(rows.map((row) => row.company_id));
    setSelectedIds((current) => current.filter((id) => visibleIds.has(id)));
  }, [rows]);
  const onVisibleRowsChange = useCallback((next: GridCompany[]) => setVisibleRows(next), []);
  const openRow = useCallback((row: GridCompany) => setDrawerId(row.company_id), []);
  const runReview = useCallback(async (keepCompanyIds: string[], reason: string) => {
    if (!state.backendRunId || !gridData) return;
    setBusy(true);
    setWriteError("");
    setNotice("");
    try {
      // The new selection revision triggers the grid reload effect.
      await applyGridReview(state.sessionId, state.backendRunId, keepCompanyIds, gridData.selectionRevision, reason);
      setSelectedIds([]);
      setNotice("Company review saved.");
    } catch (caught) {
      setWriteError(caught instanceof Error ? caught.message : "The shortlist could not be updated.");
      await loadGrid().catch(() => {});
    } finally {
      setBusy(false);
    }
  }, [gridData, loadGrid, state.backendRunId, state.sessionId]);
  const restoreOne = useCallback((row: GridCompany) => {
    void runReview(restoreIds(allRows, [row.company_id]), "Restored from Workspace");
  }, [allRows, runReview]);
  const restoreAll = useCallback(() => {
    void runReview(restoreIds(allRows, hiddenRows.map((row) => row.company_id)), "Restored from Workspace");
  }, [allRows, hiddenRows, runReview]);
  const hiddenPanel = useMemo(() => [{
    id: "hidden-companies",
    label: "Hidden companies",
    count: gridData?.hiddenCount ?? 0,
    render: () => (
      <div className="ws-hidden-panel">
        <button type="button" className="ws-grid-restore-all" disabled={busy || hiddenRows.length === 0} onClick={restoreAll}>Restore all</button>
        {hiddenRows.length ? hiddenRows.map((row) => (
          <article className="ws-hidden-row" key={row.company_id}>
            <div><strong>{row.name}</strong><span className="ws-grid-badge ws-grid-hidden">{hiddenReasonLabel(row.consideration_reason)}</span></div>
            <button type="button" disabled={busy} onClick={() => restoreOne(row)}>Restore</button>
          </article>
        )) : <p className="ws-hidden-empty">No hidden companies.</p>}
      </div>
    ),
  }], [busy, gridData?.hiddenCount, hiddenRows, restoreAll, restoreOne]);
  const exportResult = (format: ExportKind) => {
    if (result) onAction({ type: "export", artifactId: result.id, format });
  };
  return (
    <div className="ws-company-layout">
      <section className="ws-company-main">
        {allRows.some((row) => row.simulated) && <SimulatedBanner />}
        <div className="ws-table-summary">
          <span>
            {loading && !gridData ? "Loading companies…" : <><strong>{(gridData?.consideredCount ?? 0).toLocaleString()}</strong> considered · <strong>{(gridData?.hiddenCount ?? 0).toLocaleString()}</strong> hidden</>}
          </span>
          <span>
            Source scores <HelpTip label="About source scores">MID and ISCC scores use different retrieval methods and stay separate from each other and from screening scores.</HelpTip>
          </span>
        </div>
        {gridError && <p className="ws-grid-error" role="alert">{gridError}</p>}
        {writeError && <p className="ws-grid-error" role="alert">{writeError}</p>}
        {notice && <p className="ws-grid-notice" role="status">{notice}</p>}
        <div className="ws-source-tabs" role="group" aria-label="Company sources">
          {(["All", "MID", "ISCC"] as const).map((tab) => <button type="button" key={tab} aria-pressed={sourceTab === tab} className={sourceTab === tab ? "is-active" : ""} onClick={() => { setSourceTab(tab); setSelectedIds([]); }}>
            {tab} <span>{allRows.filter((row) => belongsToTab(row.source, tab) && (showHidden || row.considered)).length.toLocaleString()}</span>
          </button>)}
        </div>
        <ScoreDistribution key={sourceTab} rows={rows} columns={columns} rounds={rounds} tab={sourceTab} filterState={filterState} onFilterStateChange={changeFilters} loading={loading} />
        <Suspense fallback={<div className="ws-grid-loading"><Skeleton variant="table" rows={8} cols={6} label="Opening companies" /></div>}>
          <DataGrid
            key={sourceTab}
            rows={rows}
            columns={columns}
            filterState={filterState}
            onFilterStateChange={changeFilters}
            visibleColumnIds={visibleColumnIds}
            onVisibleColumnIdsChange={changeVisibleColumns}
            getRowId={(row) => row.company_id}
            label="Companies in the current screening"
            loading={loading}
            emptyText={state.backendRunId ? "No companies match the current filters." : "Approve criteria and run discovery to load companies."}
            storageKey={`ws-companies-v2:${sourceTab}`}
            rowHeight={62}
            selectable
            selectedIds={selectedIds}
            onSelectedIdsChange={setSelectedIds}
            isRowMuted={isHiddenRow}
            onOpenRow={openRow}
            onVisibleRowsChange={onVisibleRowsChange}
            sidePanelTabs={hiddenPanel}
            toolbarExtra={(
              <div className="ws-company-grid-toolbar">
                <label className="ws-show-hidden"><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} /><span>Show hidden</span></label>
                <div className="ws-export-actions">
                  <button type="button" title="Export the current shortlist for PitchBook" disabled={!result || !consideredCompanies(state).length} onClick={() => exportResult("pitchbook")}><Download size={14} /> PitchBook</button>
                  <button type="button" title="Export the current shortlist for LLM Suite screening" disabled={!result || !consideredCompanies(state).length} onClick={() => exportResult("llm")}><Download size={14} /> LLM Suite</button>
                  <button type="button" title="Export the current shortlist with original source columns" disabled={!result || !consideredCompanies(state).length} onClick={() => exportResult("full")}><Download size={14} /> Full data</button>
                </div>
              </div>
            )}
            actionBar={(ids) => (
              <>
                <button type="button" className="ws-grid-action" disabled={busy || !ids.length} onClick={() => void runReview(hideIds(allRows, ids), "Hidden from Workspace")}>Hide selected</button>
                <button type="button" className="ws-grid-action" disabled={busy || !ids.length} onClick={() => void runReview(keepOnlyIds(allRows, ids), "Hidden from Workspace")}>Keep only selected</button>
                <button type="button" className="ws-grid-action" disabled={busy || !ids.some((id) => hiddenRows.some((row) => row.company_id === id))} onClick={() => void runReview(restoreIds(allRows, ids), "Restored from Workspace")}>Restore selected</button>
              </>
            )}
          />
        </Suspense>
      </section>
      {selected && <Suspense fallback={null}>
        <CompanyDrawer
          open
          sessionId={state.sessionId}
          runId={state.backendRunId ?? ""}
          company={selected}
          visibleRows={visibleRows}
          refreshKey={gridData?.selectionRevision}
          busy={busy}
          onClose={() => setDrawerId(null)}
          onNavigate={(row) => setDrawerId(row.company_id)}
          onReview={(company, action) => void runReview(
            action === "hide" ? hideIds(allRows, [company.company_id]) : restoreIds(allRows, [company.company_id]),
            action === "hide" ? "Hidden from Workspace" : "Restored from Workspace",
          )}
        />
      </Suspense>}
    </div>
  );
}

const isHiddenRow = (row: GridCompany) => !row.considered;


export default function WorkspaceApp(props: Props) {
  const { state } = props;
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  useEffect(() => {
    setTab("overview");
  }, [state.sessionId]);
  // Runs after the reset above, so a request made before this view mounted still wins.
  useEffect(() => {
    if (props.requestedTab) setTab(props.requestedTab.tab);
  }, [props.requestedTab]);
  return (
    <div className="ws-root">
      <header className="ws-header">
        <div>
          <h1>
            {tab === "companies"
              ? "Review companies"
              : tab === "files"
                ? "Files and data"
                : "Screening overview"}
          </h1>
          <p>Criteria, companies, and supporting files.</p>
        </div>
        <div className="ws-header-status">
          <span
            className={`ws-status ${props.job?.state === "error" ? "ws-status-error" : props.job?.state === "running" ? "ws-status-info" : approved(state) ? "ws-status-success" : "ws-status-warning"}`}
          >
            {props.job?.state === "error" ? (
              "Search failed"
            ) : props.job?.state === "running" ? (
              <>
                <Clock3 size={14} /> Search running
              </>
            ) : approved(state) ? (
              <>
                <CheckCircle2 size={14} /> Criteria approved
              </>
            ) : state.criteriaText ? (
              "Needs review"
            ) : (
              "Ready to start"
            )}
          </span>
        </div>
      </header>
      <nav className="ws-tabs" aria-label="Workspace sections">
        {(
          [
            ["overview", "Overview"],
            [
              "companies",
              `Companies${state.companies.length ? ` · ${consideredCompanies(state).length}` : ""}`,
            ],
            [
              "files",
              `Files${state.files.length ? ` · ${state.files.length}` : ""}`,
            ],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? "ws-tab-active" : ""}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="ws-content">
        {tab === "overview" && (
          <Overview
            {...props}
            onOpenCompanies={() => setTab("companies")}
            onOpenFiles={() => setTab("files")}
          />
        )}
        {tab === "companies" && (
          <Companies
            state={state}
            onAction={props.onAction}
          />
        )}
        {tab === "files" && (
          <FilesTab state={state} onAction={props.onAction} onIntakeFiles={props.onIntakeFiles} />
        )}
      </div>
    </div>
  );
}
