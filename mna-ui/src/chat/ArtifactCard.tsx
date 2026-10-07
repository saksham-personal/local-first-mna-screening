import { lazy, Suspense, useEffect, useState, type ReactElement } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Eye,
  FileText,
  LoaderCircle,
  Search,
  Square,
  X,
} from "lucide-react";
import type {
  ArtifactAction,
  ChatArtifact,
  ResearchStep,
  ChatState,
} from "../lib/chat-contract";
import type { Company, ExportKind } from "../lib/contracts";
import { productCopy } from "../lib/product-copy";
import { formatTime, plural, pluralWord } from "../lib/format";
import Tooltip from "../Tooltip";
import Skeleton from "../ui/Skeleton";
import { useTheme } from "../lib/theme-store";
import type { DataGridColumn, DataGridProps } from "../grid/DataGrid";
import { OPEN_WORKSPACE_EVENT } from "../lib/grid-client";
import { renderDiagram } from "../lib/mermaid-renderer";
import "./artifacts.css";
import FitExamples, { InlineFitExamples } from "./FitExamples";
import CriteriaVersionMenu from "./CriteriaVersionMenu";
import "./criteria.css";
import NextStepsCard from "./NextStepsCard";
import EnrichmentUpload from "./EnrichmentUpload";
import StartInBackground from "./StartInBackground";
import { consideredCompanies } from "../lib/chat-policy";

const ShortlistReview = lazy(() => import("./ShortlistReview"));
type GenericDataGrid = <Row>(props: DataGridProps<Row>) => ReactElement;
const DataGrid = lazy(() => import("../grid/DataGrid").then((module) => ({ default: module.DataGrid }))) as unknown as GenericDataGrid;

type Props = {
  artifact: ChatArtifact;
  onAction: (action: ArtifactAction) => void | Promise<void>;
  context?: ChatState;
};

function artifactGridColumns(
  rows: Record<string, unknown>[],
  requestedColumns: string[],
): DataGridColumn<Record<string, unknown>>[] {
  const columns = requestedColumns.length
    ? [...new Set(requestedColumns)]
    : [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return columns.map((column) => ({
    id: column,
    header: column,
    group: "Results",
    kind: rows.some((row) => typeof row[column] === "number") ? "number" : "text",
    value: (row) => row[column],
  }));
}

function artifactGridRows(rows: Record<string, unknown>[]) {
  const seen = new Map<string, number>();
  return rows.map((row, index) => {
    const value = row.pk ?? row.company_id ?? row.companyId ?? row.id;
    const base = value == null || value === "" ? `row-${index}` : String(value);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { ...row, __artifactGridId: occurrence ? `${base}:${occurrence}` : base };
  });
}

function openWorkspaceCompanies() {
  window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_EVENT, { detail: { tab: "companies" } }));
}

const exportNames: Record<ExportKind, string> = {
  pitchbook: "PitchBook",
  llm: "LLM Suite",
  full: "Full data",
};
const stepNames: Record<ResearchStep, string> = {
  pitchbook: "PitchBook",
  rogo: "ROGO",
  bing: "Bing research",
  llm: "LLM Suite screening",
  copilot: "M365 Copilot screening",
};
const number = new Intl.NumberFormat();

function score(value: number | undefined) {
  return value === undefined || !Number.isFinite(value)
    ? "—"
    : Number(value.toFixed(3)).toString();
}

function CompanyRow({
  company,
  artifactId,
  onAction,
}: {
  company: Company;
  artifactId: string;
  onAction: Props["onAction"];
}) {
  return (
    <tr>
      <th scope="row">
        <button
          className="ca-company-link"
          type="button"
          onClick={() =>
            onAction({
              type: "inspect-company",
              artifactId,
              companyId: company.pk,
            })
          }
        >
          {company.name}
        </button>
        <span className="ca-company-description" title={company.description}>
          {company.description}
        </span>
        <small>
          {company.source} · {company.pbWebsite || company.website}
        </small>
      </th>
      <td>{score(company.midScore)}</td>
      <td>{score(company.isccScore)}</td>
    </tr>
  );
}

function Companies({
  artifact,
  onAction,
}: {
  artifact: Extract<ChatArtifact, { type: "companies" }>;
  onAction: Props["onAction"];
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded
    ? artifact.companies
    : artifact.companies.slice(0, 5);
  return (
    <>
      <div className="ca-counts" aria-label="Company source counts">
        <span>
          <strong>{number.format(artifact.companies.length)}</strong>{" "}
          {pluralWord(artifact.companies.length, "company", "companies")}
        </span>
        <span>
          <strong>{number.format(artifact.counts.midOnly)}</strong> MID only
        </span>
        <span>
          <strong>{number.format(artifact.counts.isccOnly)}</strong> ISCC only
        </span>
        <span>
          <strong>{number.format(artifact.counts.both)}</strong> both
        </span>
        <Tooltip label="About source scores">
          MID and ISCC use different scoring methods. Their scores stay separate
          and are not company fit scores.
        </Tooltip>
      </div>
      {artifact.note && <p className="ca-note">{productCopy(artifact.note)}</p>}
      {artifact.companies.length ? (
        <div className="ca-table-wrap">
          <table className="ca-company-table">
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col">MID score</th>
                <th scope="col">ISCC score</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((company) => (
                <CompanyRow
                  key={company.pk}
                  company={company}
                  artifactId={artifact.id}
                  onAction={onAction}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="ca-empty">
          No companies were returned for this screening.
        </p>
      )}
      {artifact.companies.length > 5 && (
        <button
          type="button"
          className="ca-inline-action"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDown size={14} className={expanded ? "ca-rotated" : ""} />
          {expanded
            ? "Show fewer"
            : `Show all ${number.format(artifact.companies.length)}`}
        </button>
      )}
      <div className="ca-export-row" aria-label="Export company list">
        {(Object.keys(exportNames) as ExportKind[]).map((format) => (
          <button
            type="button"
            key={format}
            onClick={() =>
              onAction({ type: "export", artifactId: artifact.id, format })
            }
          >
            <ArrowDownToLine size={13} />
            {exportNames[format]}
          </button>
        ))}
      </div>
    </>
  );
}

function PlanDiagram({ source }: { source: string }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { resolved: theme } = useTheme();
  useEffect(() => {
    let active = true;
    setSvg("");
    setError(false);
    void renderDiagram(`ca-diagram-${crypto.randomUUID()}`, source, theme)
      .then((rendered) => {
        if (active) setSvg(rendered);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [source, theme]);
  return (
    <div className="ca-diagram">
      {svg && !error ? (
        <div
          className="ca-diagram-svg"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <>
          {error ? (
            <p className="ca-diagram-fallback">
              Diagram preview unavailable. Mermaid source:
            </p>
          ) : (
            <Skeleton variant="block" height={150} label="Loading diagram" />
          )}
          {error && <pre>{source}</pre>}
        </>
      )}
      {svg && (
        <button
          type="button"
          className="ca-inline-action"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <CircleHelp size={13} />
          {expanded ? "Hide diagram source" : "View diagram source"}
        </button>
      )}
      {expanded && <pre>{source}</pre>}
    </div>
  );
}

function ResearchAnswer({ artifact, onAction }: { artifact: Extract<ChatArtifact, { type: "research-answer" }>; onAction: Props["onAction"] }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <><p className="ca-note">{artifact.applied ? "Added to a new criteria draft for your approval." : "This answer is saved in chat. Add it to the criteria only if it changes what you want to find."}</p>{!artifact.applied && <button type="button" className="ca-secondary-action" disabled={busy} onClick={() => { setBusy(true); setError(""); void Promise.resolve(onAction({ type: "use-answer-in-criteria", artifactId: artifact.id })).catch(caught => setError(String(caught.message ?? caught))).finally(() => setBusy(false)); }}>{busy ? "Preparing criteria…" : "Use answer in criteria"}</button>}{error && <p role="alert" className="ca-error-detail">{error}</p>}</>;
}
function ArtifactBody({ artifact, onAction, context }: Props) {
  switch (artifact.type) {
    case "screening-request":
      return (
        <>
          <p className="ca-note">
            {artifact.provider === "llm_suite" ? "LLM Suite" : "M365 Copilot"} ·{" "}
            {artifact.mode === "screening"
              ? "Scored screening"
              : "General question"}
          </p>
          {artifact.request && (
            <p className="ca-criteria-definition">{artifact.request}</p>
          )}
          <p className="ca-note">
            Choose company inputs, edit the prompt, and review the results you
            want. Provider execution is not connected.
          </p>
          <button
            type="button"
            className="ca-primary-action"
            onClick={() =>
              onAction({
                type: "configure-screening",
                artifactId: artifact.id,
                provider: artifact.provider,
                mode: artifact.mode,
                request: artifact.request,
              })
            }
          >
            Review setup
          </button>
        </>
      );
    case "screening-setup": {
      const saved = artifact.prepared;
      return (
        <>
          <div className="ca-criteria-decision">
            <span className="ca-state-dot ca-state-approved" />
            Approved input snapshot · executed: false
          </div>
          <p className="ca-note">
            {saved.provider === "llm_suite" ? "LLM Suite" : "M365 Copilot"} ·{" "}
            {saved.model} ·{" "}
            {saved.mode === "screening" ? "Screening" : "Question"} ·{" "}
            {plural(saved.companyCount, "company", "companies")} ·{" "}
            {plural(saved.batches, "batch", "batches")}
          </p>
          <details className="ca-criteria-original">
            <summary>Inputs, prompt, and outputs</summary>
            <p>
              <strong>Inputs:</strong> {saved.config.inputColumns.join(", ")}
            </p>
            <p>
              <strong>Outputs:</strong> {saved.config.outputColumns.join(", ")}
            </p>
            <pre className="ca-setup-prompt">{saved.config.prompt}</pre>
          </details>
          <p className="ca-note">
            Input data and the index-to-company mapping are saved with this
            setup. Changes require a new preview and approval. Provider execution is tracked separately in Background screening.
          </p>
          <StartInBackground artifactId={artifact.id} prepared={saved} onAction={onAction} />
          <button
            type="button"
            className="ca-secondary-action"
            onClick={() =>
              onAction({
                type: "configure-screening",
                artifactId: artifact.id,
                provider: saved.provider,
                mode: saved.mode,
              })
            }
          >
            Edit a new version
          </button>
        </>
      );
    }
    case "data-table": {
      const rows = artifactGridRows(artifact.rows);
      const columns = artifactGridColumns(artifact.rows, artifact.columns);
      return <>{artifact.note && <p className="ca-note">{artifact.note}</p>}{artifact.reviewable && context ? <Suspense fallback={<Skeleton variant="table" rows={5} cols={4} label="Opening table" />}><ShortlistReview rows={artifact.rows} columns={artifact.columns} context={context} planId={artifact.planId} onOpenCompany={pk => onAction({ type: "inspect-company", artifactId: artifact.id, companyId: pk })} onApply={async (keepCompanyIds, outputColumns) => { await onAction({ type: "review-shortlist", artifactId: artifact.id, keepCompanyIds, outputColumns, planId: artifact.planId }); }} /></Suspense> : <Suspense fallback={<Skeleton variant="table" rows={5} cols={4} label="Opening table" />}><DataGrid rows={rows} columns={columns} getRowId={row => String(row.__artifactGridId)} label={artifact.title} height={420} toolbarExtra={<button type="button" className="ca-secondary-action" onClick={openWorkspaceCompanies}>Open in Workspace <ArrowRight size={13} /></button>} /></Suspense>}</>;
    }
    case "fit-examples":
      return <FitExamples artifact={artifact} />;
    case "research-answer":
      return <ResearchAnswer artifact={artifact} onAction={onAction} />;
    case "enrichment-upload":
      return <EnrichmentUpload artifact={artifact} context={context} onAction={onAction} />;
    case "file": {
      const file = artifact.file;
      const href = `/api/files/${encodeURIComponent(file.id)}`;
      const size =
        file.bytes < 1024
          ? `${file.bytes} B`
          : file.bytes < 1024 * 1024
            ? `${(file.bytes / 1024).toFixed(1)} KB`
            : `${(file.bytes / (1024 * 1024)).toFixed(1)} MB`;
      return (
        <><div className="ca-file-line">
          <span className="ca-type-icon">
            <FileText size={18} />
          </span>
          <div className="ca-file-copy">
            <strong>{file.name}</strong>
            <small>
              {size}
              {file.kind ? ` · ${file.kind}` : ""}
              {artifact.importStatus ? ` · ${artifact.importStatus}` : ""}
            </small>
          </div>
          {file.kind.toLowerCase() === "pdf" && (
            <button
              className="ca-file-preview"
              type="button"
              onClick={() =>
                onAction({ type: "preview-file", artifactId: artifact.id })
              }
              aria-label={`Preview ${file.name}`}
              title="Preview PDF"
            >
              <Eye size={15} />
              <span>Preview</span>
            </button>
          )}
          <a
            className="ca-icon-action"
            href={href}
            download={file.name}
            aria-label={`Download ${file.name}`}
            title={`Download ${file.name}`}
          >
            <ArrowDownToLine size={16} />
          </a>
        </div>{(file.purpose === "chat" || !file.purpose) && <label className="ca-file-provider"><input type="checkbox" role="switch" checked={file.passToProvider !== false} onChange={event => onAction({ type: "toggle-file", artifactId: artifact.id, fileId: file.id, passToProvider: event.target.checked })} /><span>Include when asking LLM Suite or M365 Copilot</span></label>}</>
      );
    }
    case "criteria":
      return <CriteriaContent key={artifact.id} artifact={artifact} context={context} onAction={onAction} />;
    case "companies":
      return <Companies artifact={artifact} onAction={onAction} />;
    case "options":
      return <NextStepsCard artifact={artifact} context={context} onAction={onAction} />;
    case "plan":
      return (
        <>
          <ol className="ca-plan-list">
            {artifact.steps.map((step, index) => (
              <li
                key={step.id}
                className={`ca-plan-step ca-plan-${step.status}`}
              >
                <span className="ca-plan-marker">
                  {step.status === "done" ? (
                    <Check size={12} />
                  ) : step.status === "running" ? (
                    <LoaderCircle size={12} className="ca-spin" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span>
                  <strong>{step.label}</strong>
                  {step.detail && <small>{step.detail}</small>}
                </span>
                <span className="ca-plan-status">
                  {step.status === "done"
                    ? "Done"
                    : step.status === "running"
                      ? "In progress"
                      : step.status === "error"
                        ? "Needs attention"
                        : "Queued"}
                </span>
              </li>
            ))}
          </ol>
          {artifact.diagram.trim() && <PlanDiagram source={artifact.diagram} />}
        </>
      );
    case "research":
      return (
        <>
          {artifact.state === "unavailable" && (
            <div className="ca-provider-off">
              <span className="ca-state-dot ca-state-declined" />
              <span>
                <strong>Provider unavailable</strong>
                <small>
                  These questions are a draft. No external research was run.
                </small>
              </span>
            </div>
          )}
          {artifact.companies?.length ? (
            <p className="ca-note">
              For {artifact.companies.map((company) => company.name).join(", ")}
            </p>
          ) : null}
          <ol className="ca-question-list">
            {artifact.questions.map((question, index) => (
              <li key={`${index}-${question}`}>{question}</li>
            ))}
          </ol>
          <button type="button" className="ca-primary-action" onClick={() => onAction({ type: "run-research", artifactId: artifact.id })}><Search size={14} />Review queries and companies</button>
        </>
      );
    case "memory":
      return (
        <div className="ca-memory-list">
          {artifact.entries.map((entry, index) => (
            <article
              className="ca-memory-entry"
              key={`${productCopy(entry.source)}-${index}`}
            >
              <strong>{entry.title}</strong>
              {entry.text.trim().startsWith("{") ? (
                <details className="ca-memory-details">
                  <summary>View saved context</summary>
                  <pre>{entry.text}</pre>
                </details>
              ) : (
                <p>{entry.text}</p>
              )}
              <small>{productCopy(entry.source)}</small>
              {entry.companyId && (
                <small className="ca-memory-id">
                  Company {entry.companyId}
                </small>
              )}
            </article>
          ))}
        </div>
      );
    case "job":
      return (
        <>
          <div
            className={`ca-job-status ca-job-${artifact.state}`}
            role="status"
          >
            {artifact.state === "running" ? (
              <LoaderCircle size={15} className="ca-spin" />
            ) : artifact.state === "completed" ? (
              <Check size={15} />
            ) : artifact.state === "cancelled" ? (
              <Square size={12} />
            ) : (
              <X size={15} />
            )}
            <span>
              {artifact.state === "running"
                ? "In progress"
                : artifact.state === "completed"
                  ? "Completed"
                  : artifact.state === "cancelled"
                    ? "Stopped"
                    : "Failed"}
            </span>
          </div>
          {artifact.detail && (
            <p className="ca-note">{productCopy(artifact.detail)}</p>
          )}
          {artifact.state === "running" && (
            <button
              className="ca-secondary-action"
              type="button"
              onClick={() =>
                onAction({
                  type: "stop-job",
                  artifactId: artifact.id,
                  jobId: artifact.jobId,
                })
              }
            >
              <Square size={12} />
              Stop job
            </button>
          )}
        </>
      );
    case "checkpoint":
      return (
        <>
          <p className="ca-checkpoint-summary">
            {productCopy(artifact.summary)}
          </p>
          <div className="ca-checkpoint-meta">
            <Clock3 size={13} />
            Saved checkpoint <span>· Run {artifact.backendRunId}</span>
          </div>
          <button
            className="ca-secondary-action"
            type="button"
            onClick={() =>
              onAction({ type: "inspect-checkpoint", artifactId: artifact.id })
            }
          >
            <Search size={13} />
            Inspect checkpoint
          </button>
        </>
      );
    case "handoff":
      return (
        <>
          <div className={`ca-provider-off ca-handoff-${artifact.state}`}>
            <span
              className={`ca-state-dot ca-state-${artifact.state === "complete" ? "approved" : artifact.state === "awaiting-files" ? "pending" : "declined"}`}
            />
            <span>
              <strong>{artifact.service}</strong>
              <small>{productCopy(artifact.detail)}</small>
            </span>
          </div>
          {artifact.state === "awaiting-files" && (
            <button
              className="ca-secondary-action"
              type="button"
              onClick={() =>
                onAction({ type: "upload", artifactId: artifact.id })
              }
            >
              <ArrowUpFromLine size={14} />
              Add files
            </button>
          )}
          {artifact.state === "awaiting-files" && (
            <div className="ca-sample-links">
              <span>Try fictional example files:</span>
              {artifact.service === "PitchBook" ? (
                <>
                  <a href="/examples/pitchbook-mapping.csv" download>
                    Mapping CSV
                  </a>
                  <a href="/examples/pitchbook-data.xlsx" download>
                    PitchBook workbook
                  </a>
                </>
              ) : (
                <a href="/examples/rogo-data.xlsx" download>
                  ROGO workbook
                </a>
              )}
            </div>
          )}
        </>
      );
  }
}

export default function ArtifactCard({ artifact, onAction, context }: Props) {
  if (artifact.type === "companies" && context?.backendRunId === artifact.backendRunId) {
    const companies = consideredCompanies(context);
    artifact = { ...artifact, title: `${plural(companies.length, "company", "companies")} considered`, companies, counts: context.counts };
  }
  const timeLabel = formatTime(artifact.createdAt);
  return (
    <article
      className={`ca-artifact ca-artifact-${artifact.type}`}
      aria-label={`${artifact.title} ${artifact.type} artifact`}
    >
      <header className="ca-artifact-head">
        <div>
          <span className="ca-artifact-kind">
            {artifact.type === "screening-setup"
              ? "Saved setup"
              : artifact.type === "screening-request"
                ? "Request"
                : artifact.type}
          </span>
          <h3>{artifact.title}</h3>
        </div>
        {timeLabel && (
          <time className="ca-artifact-time" dateTime={artifact.createdAt}>
            {timeLabel}
          </time>
        )}
      </header>
      <div className="ca-artifact-body">
        <ArtifactBody artifact={artifact} onAction={onAction} context={context} />
      </div>
    </article>
  );
}

function CriteriaContent({ artifact, context, onAction }: Props & { artifact: Extract<ChatArtifact, { type: "criteria" }> }) {
  const [good, setGood] = useState(artifact.goodFitExamples ?? ""), [bad, setBad] = useState(artifact.badFitExamples ?? "");
  const current = !context || artifact.revision === context.revision && (!artifact.draftToken || artifact.draftToken === context.criteriaSaveToken);
  const editable = current && artifact.decision === "pending";
  const saved = !context || !current || context.durableCriteria?.revision === context.revision;
  return <>
    <div className="criteria-version-heading"><div className="ca-criteria-decision" role="status"><span className={`ca-state-dot ca-state-${artifact.decision}`} />{artifact.decision === "approved" ? "Approved" : artifact.decision === "declined" ? "Superseded" : "Awaiting approval"} · {saved ? `v${artifact.revision}` : "Saving draft…"}</div>{context && <CriteriaVersionMenu state={context} />}</div>
    {artifact.intakeForm && <span className="criteria-intake-tag">From Intake Form</span>}
    <p className="ca-criteria-definition">{artifact.definition}</p>
    {context?.criteriaSaveError && current && <p className="sf-upload-error" role="alert">The criteria could not be saved: {context.criteriaSaveError}. Try approval again.</p>}
    <InlineFitExamples good={editable ? good : artifact.goodFitExamples ?? ""} bad={editable ? bad : artifact.badFitExamples ?? ""} readOnly={!editable} onChange={(nextGood, nextBad) => { setGood(nextGood); setBad(nextBad); }} />
    {artifact.ignored.length > 0 && <div className="ca-notice"><strong>Recorded, not used for search</strong><p>{artifact.ignored.join(" · ")}</p></div>}
    <div className="ca-action-row">
      {editable && <button className="ca-primary-action" type="button" disabled={!saved && !context?.criteriaSaveError} onClick={() => onAction({ type: "approve-criteria", artifactId: artifact.id, good, bad })}><Check size={14} />Approve &amp; search</button>}
      {current && <button className="ca-text-action" type="button" onClick={() => onAction({ type: "edit-criteria", artifactId: artifact.id })}>Edit criteria</button>}
      {artifact.intakeForm && <button className="ca-text-action" type="button" onClick={() => onAction({ type: "view-intake", artifactId: artifact.id })}>View Intake Form</button>}
    </div>
  </>;
}
