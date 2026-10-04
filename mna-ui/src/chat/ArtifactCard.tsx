import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
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
} from "../lib/chat-contract";
import type { Company, ExportKind } from "../lib/contracts";
import { productCopy } from "../lib/product-copy";
import Tooltip from "../Tooltip";
import { useTheme } from "../lib/theme-store";
import { renderDiagram } from "../lib/mermaid-renderer";
import "./artifacts.css";

type Props = {
  artifact: ChatArtifact;
  onAction: (action: ArtifactAction) => void;
};

const exportNames: Record<ExportKind, string> = {
  pitchbook: "PitchBook",
  llm: "LLM",
  full: "Full data",
};
const stepNames: Record<ResearchStep, string> = {
  pitchbook: "PitchBook",
  rogo: "ROGO",
  bing: "Bing research",
  llm: "LLM screening",
  copilot: "Copilot screening",
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
          <strong>{number.format(artifact.companies.length)}</strong> companies
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
          <p className="ca-diagram-fallback">
            {error
              ? "Diagram preview unavailable. Mermaid source:"
              : "Loading diagram…"}
          </p>
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

function ArtifactBody({ artifact, onAction }: Props) {
  switch (artifact.type) {
    case "screening-request":
      return (
        <>
          <p className="ca-note">
            {artifact.provider === "llm_suite" ? "LLMSuite" : "M365 Copilot"} ·{" "}
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
            Approved setup · no provider request sent
          </div>
          <p className="ca-note">
            {saved.provider === "llm_suite" ? "LLMSuite" : "M365 Copilot"} ·{" "}
            {saved.model} ·{" "}
            {saved.mode === "screening" ? "Screening" : "Question"} ·{" "}
            {saved.companyCount.toLocaleString()} companies · {saved.batches}{" "}
            {saved.batches === 1 ? "batch" : "batches"}
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
            setup. Changes require a new preview and approval.
          </p>
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
        <div className="ca-file-line">
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
        </div>
      );
    }
    case "criteria":
      return (
        <>
          <div className="ca-criteria-decision" role="status">
            <span className={`ca-state-dot ca-state-${artifact.decision}`} />
            {artifact.decision === "approved"
              ? `Approved · revision ${artifact.revision}`
              : artifact.decision === "declined"
                ? `Declined · revision ${artifact.revision}`
                : `Awaiting approval · revision ${artifact.revision}`}
          </div>
          <p className="ca-criteria-definition">{artifact.definition}</p>
          {artifact.criteriaText && (
            <details className="ca-criteria-original">
              <summary>Original criteria</summary>
              <blockquote className="ca-criteria-text">
                {artifact.criteriaText}
              </blockquote>
            </details>
          )}
          {artifact.ignored.length > 0 && (
            <div className="ca-notice">
              <strong>Kept for reference</strong>
              <p>{artifact.ignored.join(" · ")}</p>
              <small>These details do not filter company discovery.</small>
            </div>
          )}
          <div className="ca-action-row">
            {artifact.decision === "pending" && (
              <>
                <button
                  className="ca-primary-action"
                  type="button"
                  onClick={() =>
                    onAction({
                      type: "approve-criteria",
                      artifactId: artifact.id,
                    })
                  }
                >
                  <Check size={14} />
                  Approve criteria
                </button>
                <button
                  className="ca-secondary-action"
                  type="button"
                  onClick={() =>
                    onAction({
                      type: "decline-criteria",
                      artifactId: artifact.id,
                    })
                  }
                >
                  <X size={14} />
                  Decline
                </button>
              </>
            )}
            <button
              className="ca-text-action"
              type="button"
              onClick={() =>
                onAction({ type: "edit-criteria", artifactId: artifact.id })
              }
            >
              Edit criteria
            </button>
          </div>
        </>
      );
    case "companies":
      return <Companies artifact={artifact} onAction={onAction} />;
    case "options": {
      const selected = new Set(artifact.selected ?? []);
      if (artifact.dismissed)
        return (
          <p className="ca-note">
            Next steps deferred. Ask for next steps whenever you are ready.
          </p>
        );
      return (
        <div className="ca-options">
          {artifact.options.map((option) => {
            const chosen = selected.has(option.id);
            return (
              <div
                className={`ca-option${option.id === artifact.recommended ? " is-recommended" : ""}`}
                key={option.id}
              >
                <span className="ca-option-copy">
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                  {option.id === artifact.recommended && <em>Recommended</em>}
                </span>
                {chosen ? (
                  <span className="ca-option-status">
                    <Check size={13} />
                    Added
                  </span>
                ) : option.available ? (
                  <button
                    type="button"
                    className="ca-secondary-action"
                    onClick={() =>
                      onAction({
                        type: "choose-option",
                        artifactId: artifact.id,
                        option: option.id,
                      })
                    }
                  >
                    {option.id === "bing"
                      ? "Draft questions"
                      : option.id === "llm" || option.id === "copilot"
                        ? "Configure"
                        : "Proceed"}
                  </button>
                ) : (
                  <span className="ca-option-status ca-muted">
                    Not connected
                  </span>
                )}
              </div>
            );
          })}
          <button
            className="ca-text-action"
            type="button"
            onClick={() =>
              onAction({ type: "dismiss-options", artifactId: artifact.id })
            }
          >
            Not now
          </button>
        </div>
      );
    }
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

export default function ArtifactCard({ artifact, onAction }: Props) {
  const createdAt = new Date(artifact.createdAt);
  const timeLabel = Number.isNaN(createdAt.getTime())
    ? ""
    : createdAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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
        <ArtifactBody artifact={artifact} onAction={onAction} />
      </div>
    </article>
  );
}
