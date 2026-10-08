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
import { startExport, rememberExportRun } from "./lib/screening-client";
import type { ExportKind } from "./lib/contracts";
import { callTool } from "./lib/tool-client";
import { approved } from "./lib/chat-store";
import { consideredCompanies } from "./lib/chat-policy";
import {
  applyGridReview,
  fetchScreeningGrid,
  fetchScreeningGridPage,
  appendGridPage,
  fetchGridDescriptions,
  type GridDescription,
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
import { pageDescriptionColumn, readColumnChoice, requestedCatalogIds, visibleCatalogIds, type ColumnChoice } from "./workspace/company-catalog";
import { loadingProgress } from "./workspace/company-pager";
import { withDescriptionValues } from "./workspace/description-content";
import DescriptionTooltip from "./workspace/DescriptionTooltip";
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
  // Light reads only: the Overview needs counts and flags, not every grid row.
  const [simulatedMode, setSimulatedMode] = useState(false);
  const [summary, setSummary] = useState<{ total: number; mid: number; iscc: number; both: number } | null>(null);
  const shownRun = useRef<string | undefined>(undefined);
  useEffect(() => {
    void fetch("/api/health").then((response) => response.json()).then((data) => setSimulatedMode(data?.simulated === true)).catch(() => {});
  }, []);
  useEffect(() => {
    let current = true;
    // Keep the previous numbers while refreshing the same run; clear them only for another run.
    if (shownRun.current !== state.backendRunId) {
      shownRun.current = state.backendRunId;
      setRounds([]);
      setSummary(null);
    }
    if (!state.backendRunId) return;
    const runId = state.backendRunId;
    setRoundsError("");
    void callTool("get_discovery_summary", { run_id: runId }).then((result) => {
      const count = (key: string) => (typeof result[key] === "number" ? (result[key] as number) : 0);
      if (current) setSummary({ total: count("total_unique"), mid: count("mid_only"), iscc: count("iscc_only"), both: count("both") });
    }).catch(() => {});
    const load = () => fetchScreeningRounds(state.sessionId, runId).then((result) => {
      if (current) { setRounds(result); setRoundsError(""); }
    }).catch((error) => { if (current) setRoundsError(error instanceof Error ? error.message : "Screening rounds could not be loaded."); }).finally(() => { if (current) setRoundsLoading(false); });
    setRoundsLoading(true);
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
  const total = summary?.total ?? consideredCompanies(state).length;
  const sourceCount = (source: GridCompany["source"], fallback: number) => summary ? (source === "MID" ? summary.mid : source === "ISCC" ? summary.iscc : summary.both) : fallback;
  return (
    <div className="ws-overview">
      {(simulatedMode || rounds.some((round) => round.simulated)) && <SimulatedBanner />}
      {roundsLoading && !rounds.length && <Skeleton variant="card" rows={2} label="Loading screening rounds" />}
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
const emptyCatalog: ScreeningGrid["columns"] = [];

function SimulatedBanner() {
  return <p className="ws-simulated-banner" role="status">Simulated data — for development only. Exports are blocked unless allowed.</p>;
}

function Companies({ state }: { state: ChatState; onAction: Props["onAction"] }) {
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
  const catalog = gridData?.columns ?? emptyCatalog;
  const columns = useMemo(() => buildCompanyColumns(catalog), [catalog]);
  const [streaming, setStreaming] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [descriptions, setDescriptions] = useState(new Map<string, GridDescription>());
  const descriptionCache = useRef(new Map<string, GridDescription>());
  const descriptionPending = useRef(new Set<string>());
  const [descriptionError, setDescriptionError] = useState("");
  const descriptionBlocked = useRef(false);
  const descriptionSourceHash = useRef<string | undefined>(undefined);
  const filterState = filtersByTab[sourceTab];
  const changeFilters = useCallback((next: FilterState) => setFiltersByTab((current) => ({ ...current, [sourceTab]: next })), [sourceTab]);
  const [columnPreferences, setColumnPreferences] = useState<Partial<Record<CompanyTab, ColumnChoice>>>(() => {
    const saved: Partial<Record<CompanyTab, ColumnChoice>> = {};
    for (const tab of ["All", "MID", "ISCC"] as const) {
      try { saved[tab] = readColumnChoice(localStorage.getItem(`ws-company-columns-v3:${tab}`)); } catch { /* optional storage */ }
    }
    return saved;
  });
  const visibleColumnIds = useMemo(() => visibleCatalogIds(catalog, columnPreferences[sourceTab]), [catalog, columnPreferences, sourceTab]);
  const currentColumnChoice = columnPreferences[sourceTab];
  const changeVisibleColumns = useCallback((visible: string[]) => {
    const next = { visible, known: columns.map((column) => column.id) };
    setColumnPreferences((current) => ({ ...current, [sourceTab]: next }));
    try { localStorage.setItem(`ws-company-columns-v3:${sourceTab}`, JSON.stringify(next)); } catch { /* storage may be disabled */ }
  }, [columns, sourceTab]);
  const gridRequest = useRef(0);
  const hasGridData = useRef(false);
  const gridRun = useRef<string | undefined>(undefined);
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
    () => allRows.filter((row) => belongsToTab(row.source, sourceTab) && (showHidden || row.considered))
      .map(row => withDescriptionValues(row, catalog, descriptions.get(row.company_id))),
    [allRows, showHidden, sourceTab, catalog, descriptions],
  );
  const selected = allRows.find((row) => row.company_id === drawerId) ?? null;
  // Refetch when screening/enrichment jobs change state, not on every chat artifact update.
  const resultsKey = useMemo(
    () => state.artifacts
      .filter((artifact) => artifact.type === "job" || artifact.type === "enrichment-upload")
      .map((artifact) => `${artifact.id}:${JSON.stringify((artifact as { state?: unknown; status?: unknown }).state ?? (artifact as { status?: unknown }).status ?? "")}`)
      .join("|"),
    [state.artifacts],
  );
  const loadGrid = useCallback(async () => {
    const request = ++gridRequest.current;
    const runId = state.backendRunId;
    if (!runId) {
      setGridData(null);
      setGridError("");
      setLoading(false);
      return null;
    }
    // Refreshes keep the current rows on screen; a first load (or another run) shows the skeleton.
    if (gridRun.current !== `${runId}:${sourceTab}`) {
      gridRun.current = `${runId}:${sourceTab}`;
      hasGridData.current = false;
      setGridData(null);
      descriptionCache.current = new Map(); descriptionSourceHash.current = undefined;
      setDescriptions(new Map());
    }
    if (!hasGridData.current) setLoading(true);
    else setRefreshing(true);
    setStreaming(false);
    descriptionPending.current = new Set();
    descriptionBlocked.current = false;
    setDescriptionError("");
    setGridError("");
    try {
      // Read the current catalog without heavy values, including newly added sources/rounds.
      // Every data page, including page 1, then projects the picker choice.
      const known = (await fetchScreeningGridPage(state.sessionId, runId, {
        view: sourceTab.toLowerCase() as "all" | "mid" | "iscc", limit: 1, columns: [],
      })).columns;
      if (request !== gridRequest.current) return null;
      const saved = currentColumnChoice;
      let data = await fetchScreeningGridPage(state.sessionId, runId, {
        view: sourceTab.toLowerCase() as "all" | "mid" | "iscc", limit: 100,
        columns: requestedCatalogIds(known, saved),
      });
      if (request !== gridRequest.current) return null;
      if (descriptionSourceHash.current !== data.sourceHash) {
        descriptionSourceHash.current = data.sourceHash;
        descriptionCache.current = new Map(); setDescriptions(new Map());
      }
      hasGridData.current = true;
      setGridData(data); setLoading(false); setRefreshing(false);
      setStreaming(Boolean(data.nextCursor));
      while (data.nextCursor && request === gridRequest.current) {
        // Yield between bounded pages so typing and first-page rendering stay responsive.
        await new Promise(resolve => setTimeout(resolve, 16));
        const page = await fetchScreeningGridPage(state.sessionId, runId, {
          view: sourceTab.toLowerCase() as "all" | "mid" | "iscc", limit: 1000,
          columns: requestedCatalogIds(data.columns, saved), cursor: data.nextCursor,
        });
        if (request !== gridRequest.current) return null;
        data = appendGridPage(data, page); setGridData(data);
      }
      if (request === gridRequest.current && data.rows.length !== data.total) throw new Error("The company list changed while it was being read. Please open it again.");
      return data;
    } catch (caught) {
      if (request === gridRequest.current) setGridError(caught instanceof Error ? caught.message : "Companies could not be loaded.");
      throw caught;
    } finally {
      if (request === gridRequest.current) { setLoading(false); setRefreshing(false); setStreaming(false); }
    }
  }, [state.backendRunId, state.sessionId, sourceTab, currentColumnChoice]);
  useEffect(() => {
    void loadGrid().catch(() => {});
    return () => { ++gridRequest.current; };
  }, [loadGrid, state.selectionRevision, resultsKey]);
  const loadDescriptions = useCallback((page: GridCompany[]) => {
    if (!state.backendRunId || descriptionBlocked.current) return;
    const ids = page.map(row => row.company_id).filter(id => !descriptionCache.current.has(id) && !descriptionPending.current.has(id));
    if (!ids.length) return;
    const request = gridRequest.current;
    for (const id of ids) descriptionPending.current.add(id);
    void fetchGridDescriptions(state.sessionId, state.backendRunId, ids).then(items => {
      if (request !== gridRequest.current) return;
      for (const item of items) descriptionCache.current.set(item.company_id, item);
      for (const id of ids) if (!descriptionCache.current.has(id)) descriptionCache.current.set(id, { company_id: id, sources: [] });
      for (const id of ids) descriptionPending.current.delete(id);
      setDescriptions(new Map(descriptionCache.current));
    }).catch(error => {
      if (request !== gridRequest.current) return;
      descriptionBlocked.current = true; setDescriptionError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (request === gridRequest.current) for (const id of ids) descriptionPending.current.delete(id); });
  }, [state.backendRunId, state.sessionId]);
  const filteringDescriptions = Boolean(filterState.quick.trim()) || catalog.some(column => pageDescriptionColumn(column) && filterState.columns[column.id]);
  // A description filter needs more than the visible page. Read bounded batches
  // in the background; normal browsing only hydrates the page being viewed.
  useEffect(() => {
    if (!filteringDescriptions || loading || refreshing || descriptionBlocked.current || descriptionPending.current.size) return;
    loadDescriptions(allRows.filter(row => !descriptionCache.current.has(row.company_id)).slice(0, 500));
  }, [filteringDescriptions, allRows, descriptions, loading, refreshing, loadDescriptions]);
  useEffect(() => {
    const visibleIds = new Set(rows.map((row) => row.company_id));
    setSelectedIds((current) => current.filter((id) => visibleIds.has(id)));
  }, [rows]);
  const onVisibleRowsChange = useCallback((next: GridCompany[]) => setVisibleRows(next), []);
  const openRow = useCallback((row: GridCompany) => setDrawerId(row.company_id), []);
  const runReview = useCallback(async (selection: (all: GridCompany[]) => string[], reason: string) => {
    if (!state.backendRunId || !gridData) return;
    setBusy(true);
    setWriteError("");
    setNotice("");
    try {
      const complete = await fetchScreeningGrid(state.sessionId, state.backendRunId, { columns: [] });
      await applyGridReview(state.sessionId, state.backendRunId, selection(complete.rows), complete.selectionRevision, reason);
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
    void runReview(all => restoreIds(all, [row.company_id]), "Restored from Workspace");
  }, [allRows, runReview]);
  const restoreAll = useCallback(() => {
    void runReview(all => restoreIds(all, all.filter(row => !row.considered).map(row => row.company_id)), "Restored from Workspace");
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
  useEffect(() => {
    if (state.backendRunId) rememberExportRun(state.backendRunId);
  }, [state.backendRunId]);
  const exportResult = (format: ExportKind) => {
    if (!state.backendRunId) return;
    setWriteError("");
    void startExport(state.backendRunId, format).then(() => {
      setNotice("Export started. Activity shows progress and the download when ready.");
    }).catch((caught) => setWriteError(caught instanceof Error ? caught.message : "The export could not be started."));
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
            {tab} <span>{streaming ? "≥ " : ""}{allRows.filter((row) => belongsToTab(row.source, tab) && (showHidden || row.considered)).length.toLocaleString()}</span>
          </button>)}
        </div>
        {loadingProgress(allRows.length, gridData?.total ?? 0, streaming) && <p className="ws-grid-progress" role="status">{loadingProgress(allRows.length, gridData?.total ?? 0, streaming)}</p>}
        {descriptionError && <p className="ws-grid-progress" role="status">Descriptions unavailable: {descriptionError}</p>}
        {filteringDescriptions && !descriptionError && descriptions.size < allRows.length && <p className="ws-grid-progress" role="status">Loading descriptions · {descriptions.size.toLocaleString()} of {allRows.length.toLocaleString()}</p>}
        <ScoreDistribution key={sourceTab} rows={rows} columns={columns} rounds={rounds} tab={sourceTab} filterState={filterState} onFilterStateChange={changeFilters} loading={loading} />
        <Suspense fallback={<div className="ws-grid-loading"><Skeleton variant="table" rows={8} cols={6} label="Opening companies" /></div>}>
          <DescriptionTooltip cache={descriptions} error={descriptionError}><DataGrid
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
            updating={busy || refreshing}
            pagination
            groupHeaders
            onPageRowsChange={loadDescriptions}
            emptyText={state.backendRunId ? "No companies match the current filters." : "Approve criteria and run discovery to load companies."}
            storageKey={`ws-companies-v3:${sourceTab}`}
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
                <button type="button" className="ws-grid-action" disabled={busy || !ids.length} onClick={() => void runReview(all => hideIds(all, ids), "Hidden from Workspace")}>Hide selected</button>
                <button type="button" className="ws-grid-action" disabled={busy || !ids.length} onClick={() => void runReview(all => keepOnlyIds(all, ids), "Hidden from Workspace")}>Keep only selected</button>
                <button type="button" className="ws-grid-action" disabled={busy || !ids.some((id) => hiddenRows.some((row) => row.company_id === id))} onClick={() => void runReview(all => restoreIds(all, ids), "Restored from Workspace")}>Restore selected</button>
              </>
            )}
          /></DescriptionTooltip>
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
            all => action === "hide" ? hideIds(all, [company.company_id]) : restoreIds(all, [company.company_id]),
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
