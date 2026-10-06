import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Filter,
  FolderOpen,
  Link2,
  List,
  MessageSquare,
  Search,
  UploadCloud,
  X,
} from "lucide-react";
import SelectField from "./ui/SelectField";
import Skeleton from "./ui/Skeleton";
const CompanyGrid = lazy(() => import("./workspace/CompanyGrid"));
import ArtifactCard from "./chat/ArtifactCard";
import type {
  ArtifactAction,
  ChatArtifact,
  ChatState,
  JobSnapshot,
} from "./lib/chat-contract";
import type { Company, ExportKind, Source } from "./lib/contracts";
import { approved } from "./lib/chat-store";
import { consideredCompanies } from "./lib/chat-policy";
import "./workspace/workspace.css";
import ImportStaging from "./files/ImportStaging";
import { processStagedUploads, retryStagedUploads } from "./lib/import-pipeline";

type WorkspaceTab = "overview" | "companies" | "files";
type SourceFilter = Source | "all";

type Props = {
  sessionTitle: string;
  state: ChatState;
  job?: JobSnapshot;
  busy: boolean;
  onAction: (action: ArtifactAction) => void;
  send: (text: string, action?: ArtifactAction) => void;
  openLog: (eventId?: string) => void;
};

type LegacyAnnotations = {
  notes: Record<string, string>;
  linkedinOverrides: Record<string, string>;
};

const emptyAnnotations: LegacyAnnotations = {
  notes: {},
  linkedinOverrides: {},
};

function legacyKey(sessionId: string) {
  return `screening-workspace-v3:${sessionId}`;
}

function readAnnotations(sessionId: string): LegacyAnnotations {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(legacyKey(sessionId)) || "null",
    ) as Record<string, unknown> | null;
    const strings = (value: unknown): Record<string, string> =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).filter(
              ([, entry]) => typeof entry === "string",
            ),
          )
        : {};
    return {
      notes: strings(parsed?.notes),
      linkedinOverrides: strings(parsed?.linkedinOverrides),
    };
  } catch {
    return emptyAnnotations;
  }
}

function persistAnnotations(sessionId: string, value: LegacyAnnotations) {
  try {
    const existing = JSON.parse(
      localStorage.getItem(legacyKey(sessionId)) || "null",
    ) as Record<string, unknown> | null;
    localStorage.setItem(
      legacyKey(sessionId),
      JSON.stringify({
        ...(existing && typeof existing === "object" ? existing : {}),
        notes: value.notes,
        linkedinOverrides: value.linkedinOverrides,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function score(value?: number) {
  return value === undefined ? "—" : value.toFixed(2);
}

function sourceLabel(source: Source) {
  return source === "both" ? "MID + ISCC" : source;
}

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
}: {
  label: string;
  value: number | string;
  tone: "accent" | "success" | "info" | "warning";
  detail: string;
}) {
  return (
    <article className={`ws-stat ws-stat-${tone}`}>
      <span>{label}</span>
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
          ? "Running local tools"
          : job?.state === "error"
            ? "Failed — see the chat for details"
            : job?.state === "cancelled"
              ? "Stopped — completed work is saved"
              : searched
                ? `${state.companies.length} companies saved`
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
  const total = consideredCompanies(state).length;
  return (
    <div className="ws-overview">
      <section className="ws-summary-grid">
        <StatCard
          label="Shortlist"
          value={total}
          tone="accent"
          detail={
            total
              ? "Companies currently under consideration"
              : "Run search after approval"
          }
        />
        <StatCard
          label="MID only"
          value={state.counts.midOnly}
          tone="info"
          detail="Found in the internal company set"
        />
        <StatCard
          label="ISCC only"
          value={state.counts.isccOnly}
          tone="warning"
          detail="ISCC is not connected"
        />
        <StatCard
          label="Both sources"
          value={state.counts.both}
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
                  onClick={() => send("/criteria")}
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
            <h2>See the full workflow with fictional data</h2>
            <p>
              The example uses the local tools and waits for your approval
              before discovery.
            </p>
          </div>
          <button
            type="button"
            className="ws-primary"
            disabled={busy}
            onClick={() => send("/example")}
          >
            Run the example <ArrowRight size={14} />
          </button>
        </section>
      )}
    </div>
  );
}

function CompanyDetail({
  company,
  annotations,
  onSave,
  onClose,
  onInspect,
}: {
  company: Company;
  annotations: LegacyAnnotations;
  onSave: (note: string) => boolean;
  onClose: () => void;
  onInspect: () => void;
}) {
  const [note, setNote] = useState(annotations.notes[company.pk] || "");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    setNote(annotations.notes[company.pk] || "");
  }, [company.pk, annotations]);
  useEffect(() => setNotice(""), [company.pk]);
  return (
    <aside className="ws-company-detail" aria-label={`${company.name} details`}>
      <div className="ws-detail-head">
        <div>
          <span className={`ws-source ws-source-${company.source}`}>
            {sourceLabel(company.source)}
          </span>
          <h2>{company.name}</h2>
          <p>
            {[company.city, company.state].filter(Boolean).join(", ") ||
              "Location unavailable"}
          </p>
        </div>
        <button
          type="button"
          className="ws-icon"
          onClick={onClose}
          aria-label="Close company details"
        >
          <X size={17} />
        </button>
      </div>
      <div className="ws-detail-scroll">
        <div className="ws-score-row">
          <div>
            <span>MID score</span>
            <strong>{score(company.midScore)}</strong>
          </div>
          <div>
            <span>ISCC score</span>
            <strong>{score(company.isccScore)}</strong>
          </div>
        </div>
        <section>
          <h3>Business description</h3>
          <p>{company.description || "No description is available."}</p>
        </section>
        <section className="ws-detail-facts">
          <div>
            <span>Internal ID</span>
            <code>{company.pk}</code>
          </div>
          {company.pbId && (
            <div>
              <span>PitchBook ID</span>
              <code>{company.pbId}</code>
            </div>
          )}
          {company.website && (
            <a
              href={
                company.website.startsWith("http")
                  ? company.website
                  : `https://${company.website}`
              }
              target="_blank"
              rel="noreferrer"
            >
              <Link2 size={14} /> {company.website} <ExternalLink size={12} />
            </a>
          )}
        </section>
        {!!company.tags.length && (
          <div className="ws-tags">
            {company.tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        )}
        <label className="ws-field">
          Analyst notes
          <textarea
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              setNotice("");
            }}
            rows={4}
            placeholder="Add a note for your review…"
          />
        </label>
        {notice && (
          <p className="ws-save-notice" role="status">
            {notice}
          </p>
        )}
      </div>
      <div className="ws-detail-actions">
        <button
          type="button"
          className="ws-secondary"
          onClick={() =>
            setNotice(
              onSave(note)
                ? "Notes saved in this browser."
                : "Browser storage is unavailable. Notes are kept until this page closes.",
            )
          }
        >
          <Check size={14} /> Save notes
        </button>
        <button type="button" className="ws-primary" onClick={onInspect}>
          Ask agent <MessageSquare size={14} />
        </button>
      </div>
    </aside>
  );
}

function Companies({
  state,
  annotations,
  setAnnotations,
  onAction,
}: {
  state: ChatState;
  annotations: LegacyAnnotations;
  setAnnotations: (value: LegacyAnnotations) => boolean;
  onAction: Props["onAction"];
}) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [selectedId, setSelectedId] = useState<string>();
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
  const rows = useMemo(
    () =>
      state.companies.filter((company) => {
        if (company.considered === false) return false;
        const matchesSource =
          source === "all" ||
          company.source === source ||
          (company.source === "both" && source !== "both");
        const haystack =
          `${company.name} ${company.website} ${company.description} ${company.city} ${company.state} ${company.tags.join(" ")}`.toLowerCase();
        return matchesSource && haystack.includes(query.trim().toLowerCase());
      }),
    [query, source, state.companies],
  );
  const [gridCount, setGridCount] = useState<{
    rows: Company[];
    count: number;
  }>();
  const reportGridCount = useCallback(
    (count: number) =>
      setGridCount((previous) =>
        previous?.rows === rows && previous.count === count
          ? previous
          : { rows, count },
      ),
    [rows],
  );
  const selectCompany = useCallback(
    (company: Company) => setSelectedId(company.pk),
    [],
  );
  const displayedCount =
    gridCount?.rows === rows ? gridCount.count : rows.length;
  const selected = state.companies.find((company) => company.pk === selectedId);
  const exportResult = (format: ExportKind) => {
    if (result) onAction({ type: "export", artifactId: result.id, format });
  };
  return (
    <div className={`ws-company-layout ${selected ? "ws-detail-open" : ""}`}>
      <section className="ws-company-main">
        <div className="ws-company-toolbar">
          <div className="ws-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search companies"
              aria-label="Search companies"
            />
          </div>
          <SelectField
            className="ws-filter"
            label="Filter by source"
            value={source}
            onChange={(value) => setSource(value as SourceFilter)}
            icon={<Filter size={14} />}
            options={[
              { value: "all", label: "All sources" },
              { value: "MID", label: "MID" },
              { value: "ISCC", label: "ISCC" },
              { value: "both", label: "Both sources" },
            ]}
          />
          <div className="ws-export-actions">
            <button
              type="button"
              title="Export the current shortlist for PitchBook"
              disabled={!result || !consideredCompanies(state).length}
              onClick={() => exportResult("pitchbook")}
            >
              <Download size={14} /> PitchBook
            </button>
            <button
              type="button"
              title="Export the current shortlist for LLM Suite screening"
              disabled={!result || !consideredCompanies(state).length}
              onClick={() => exportResult("llm")}
            >
              <Download size={14} /> LLM Suite
            </button>
            <button
              type="button"
              title="Export the current shortlist with original source columns"
              disabled={!result || !consideredCompanies(state).length}
              onClick={() => exportResult("full")}
            >
              <Download size={14} /> Full data
            </button>
          </div>
        </div>
        <div className="ws-table-summary">
          <span>
            <strong>{displayedCount}</strong> of {consideredCompanies(state).length}{" "}
            in shortlist{state.companies.length > consideredCompanies(state).length ? ` · ${state.companies.length - consideredCompanies(state).length} hidden` : ""}
          </span>
          <span>
            MID and ISCC scores use different methods and stay separate.
          </span>
        </div>
        {state.companies.length ? (
          <Suspense
            fallback={
              <div className="ws-grid-loading">
                <Skeleton
                  variant="table"
                  rows={9}
                  cols={6}
                  label="Loading company table"
                />
              </div>
            }
          >
            <CompanyGrid
              companies={rows}
              selectedId={selectedId}
              onFilteredCount={reportGridCount}
              onSelect={selectCompany}
            />
          </Suspense>
        ) : (
          <EmptyState
            icon={<Building2 size={24} />}
            title={
              state.companies.length ? "No companies match" : "No companies yet"
            }
            detail={
              state.companies.length
                ? "Try a different search or source filter."
                : "Approve the criteria, then run discovery from the chat."
            }
          />
        )}
      </section>
      {selected && (
        <CompanyDetail
          company={selected}
          annotations={annotations}
          onClose={() => setSelectedId(undefined)}
          onSave={(note) =>
            setAnnotations({
              ...annotations,
              notes: { ...annotations.notes, [selected.pk]: note },
            })
          }
          onInspect={() =>
            result &&
            onAction({
              type: "inspect-company",
              artifactId: result.id,
              companyId: selected.pk,
            })
          }
        />
      )}
    </div>
  );
}

function Files({
  state,
  onAction,
  send,
}: Pick<Props, "state" | "onAction" | "send">) {
  const files = state.artifacts.filter((artifact) => artifact.type === "file" && !artifact.file.importable);
  const latestHandoff = latestArtifact(state.artifacts, "handoff");
  return (
    <div className="ws-files-grid">
      <section className="ws-card ws-upload-panel">
        <span className="ws-upload-icon">
          <UploadCloud size={24} />
        </span>
        <div>
          <h2>Upload screening or enrichment files</h2>
          <p>
            Add criteria documents or spreadsheets. PitchBook and ROGO files are detected and added to company context automatically.
          </p>
        </div>
        <button
          type="button"
          className="ws-primary"
          onClick={() =>
            onAction({
              type: "upload",
              artifactId: latestHandoff?.id ?? "workspace-upload",
            })
          }
        >
          <UploadCloud size={15} /> Choose files
        </button>
      </section>
      <ImportStaging files={state.files} onUpload={() => onAction({ type: "upload", artifactId: "workspace-upload" })} onRetry={() => { void retryStagedUploads(state.sessionId); }} />
      <section className="ws-card ws-file-list-card">
        <div className="ws-section-head">
          <div>
            <h2>Files and imports</h2>
          </div>
          <span className="ws-count-badge">{files.length}</span>
        </div>
        {files.length ? (
          <div className="ws-artifact-stack">
            {files
              .slice()
              .reverse()
              .map((artifact) => (
                <ArtifactCard
                  key={artifact.id}
                  artifact={artifact}
                  onAction={onAction}
                />
              ))}
          </div>
        ) : (
          <EmptyState
            icon={<FolderOpen size={24} />}
            title="No files attached"
            detail="Uploads remain available as artifacts throughout this screening."
          />
        )}
      </section>
      <section className="ws-card ws-file-guide">
        <div className="ws-section-head">
          <div>
            <h2>What the agent can use</h2>
          </div>
        </div>
        <ul>
          <li>
            <FileText size={17} />
            <div>
              <strong>Screening criteria</strong>
              <span>
                TXT or pasted criteria; PDF/DOCX originals are saved without
                extraction
              </span>
            </div>
          </li>
          <li>
            <FileSpreadsheet size={17} />
            <div>
              <strong>PitchBook</strong>
              <span>Mapping CSV plus the PitchBook XLSX export</span>
            </div>
          </li>
          <li>
            <FileSpreadsheet size={17} />
            <div>
              <strong>ROGO</strong>
              <span>CSV or XLSX with a Website column</span>
            </div>
          </li>
        </ul>
        <button type="button" className="ws-link" onClick={() => send("/plan")}>
          Review next steps <ArrowRight size={13} />
        </button>
      </section>
    </div>
  );
}

export default function WorkspaceApp(props: Props) {
  const { state } = props;
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [annotations, setAnnotationsState] = useState<LegacyAnnotations>(() =>
    readAnnotations(state.sessionId),
  );
  useEffect(() => {
    setAnnotationsState(readAnnotations(state.sessionId));
    setTab("overview");
  }, [state.sessionId]);
  const setAnnotations = (value: LegacyAnnotations) => {
    setAnnotationsState(value);
    return persistAnnotations(state.sessionId, value);
  };
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
            annotations={annotations}
            setAnnotations={setAnnotations}
            onAction={props.onAction}
          />
        )}
        {tab === "files" && (
          <Files state={state} onAction={props.onAction} send={props.send} />
        )}
      </div>
    </div>
  );
}
