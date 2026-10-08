import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, Tabs } from "radix-ui";
import { ArrowLeft, ArrowRight, ExternalLink, MessageSquare, RotateCcw, X } from "lucide-react";
import Skeleton from "../ui/Skeleton";
import {
  ASK_ASSISTANT_EVENT,
  fetchCompanyDetail,
  hiddenReasonLabel,
  type CompanyDetail,
  type GridCompany,
} from "../lib/grid-client";
import "./company-drawer.css";
import { KeywordEvidence, ScorePill, SemanticBar } from "./score-cells";

type Props = {
  open: boolean;
  sessionId: string;
  runId: string;
  company: GridCompany | null;
  visibleRows: GridCompany[];
  refreshKey?: number;
  busy?: boolean;
  onClose: () => void;
  onNavigate: (company: GridCompany) => void;
  onReview: (company: GridCompany, action: "hide" | "restore") => void;
};

function websiteUrl(value: string | null): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function displayValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function Score({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="company-drawer-score">
      <span>{label}</span>
      <strong>{value == null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong>
    </div>
  );
}

export default function CompanyDrawer({
  open,
  sessionId,
  runId,
  company,
  visibleRows,
  refreshKey,
  busy = false,
  onClose,
  onNavigate,
  onReview,
}: Props) {
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("overview");
  const companyId = company?.company_id;
  const shownCompanyId = useRef<string | undefined>(undefined);
  const lastIndex = useRef(-1);

  useEffect(() => {
    if (!open || !companyId) return;
    let current = true;
    // A new company starts fresh; a refresh of the same company keeps the tab and current details.
    if (shownCompanyId.current !== companyId) {
      shownCompanyId.current = companyId;
      setLoading(true);
      setDetail(null);
      setTab("overview");
    }
    setError("");
    void fetchCompanyDetail(sessionId, runId, companyId)
      .then((value) => { if (current) setDetail(value); })
      .catch((caught) => { if (current) setError(caught instanceof Error ? caught.message : "Company details could not be loaded."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [companyId, open, refreshKey, runId, sessionId]);

  const currentIndex = useMemo(
    () => companyId ? visibleRows.findIndex((row) => row.company_id === companyId) : -1,
    [companyId, visibleRows],
  );
  // A company hidden from the drawer drops out of the visible list; navigate from where it was.
  if (currentIndex >= 0) lastIndex.current = currentIndex;
  const previous = currentIndex >= 0 ? visibleRows[currentIndex - 1] : lastIndex.current > 0 ? visibleRows[lastIndex.current - 1] : undefined;
  const next = currentIndex >= 0 ? visibleRows[currentIndex + 1] : lastIndex.current >= 0 ? visibleRows[lastIndex.current] : undefined;
  const href = websiteUrl(company?.website ?? null);
  const descriptions = detail?.descriptions.length
    ? detail.descriptions
    : company?.description
      ? [{ label: "Company description", text: company.description }]
      : [];

  return (
    <Dialog.Root modal={false} open={open && Boolean(company)} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <Dialog.Portal>
        {/* Non-blocking: the grid stays usable, and clicking another row switches the drawer. */}
        <Dialog.Content className="company-drawer" aria-label="Company details" onInteractOutside={(event) => event.preventDefault()}>
          {company && (
            <>
              <header className="company-drawer-header">
                <div className="company-drawer-heading">
                  <span className="company-drawer-eyebrow">Company details</span>
                  <Dialog.Title>{company.name}</Dialog.Title>
                  <Dialog.Description className="company-drawer-visually-hidden">Detailed information for {company.name}.</Dialog.Description>
                  {href ? <a href={href} target="_blank" rel="noreferrer">{company.website} <ExternalLink size={12} aria-hidden="true" /></a> : <p>{company.website || "No website"}</p>}
                  <div className="company-drawer-identifiers">
                    {(detail?.simulated || company.simulated) && <span className="ws-simulated-badge">Simulated</span>}
                    <span>{company.company_id}</span>
                    {company.pbid && <span>PBId {company.pbid}</span>}
                    <span className={`company-drawer-status ${company.considered ? "is-considered" : "is-hidden"}`}>
                      {company.considered ? "Considered" : "Hidden"}
                    </span>
                    {!company.considered && <span className="company-drawer-reason">{hiddenReasonLabel(company.consideration_reason)}</span>}
                  </div>
                </div>
                <div className="company-drawer-header-actions">
                  <button type="button" aria-label="Previous company" title="Previous company" disabled={!previous} onClick={() => previous && onNavigate(previous)}><ArrowLeft size={16} /></button>
                  <button type="button" aria-label="Next company" title="Next company" disabled={!next} onClick={() => next && onNavigate(next)}><ArrowRight size={16} /></button>
                  <Dialog.Close asChild><button type="button" aria-label="Close company details"><X size={17} /></button></Dialog.Close>
                </div>
              </header>

              <Tabs.Root className="company-drawer-tabs" value={tab} onValueChange={setTab}>
                <Tabs.List aria-label={`${company.name} details`}>
                  <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
                  <Tabs.Trigger value="details">Company details</Tabs.Trigger>
                  <Tabs.Trigger value="activity">Activity</Tabs.Trigger>
                </Tabs.List>
                <div className="company-drawer-scroll">
                  {loading ? (
                    <Skeleton variant="drawer" label={`Loading details for ${company.name}`} />
                  ) : error ? (
                    <p className="company-drawer-error" role="alert">{error}</p>
                  ) : (
                    <>
                      <Tabs.Content value="overview" className="company-drawer-tab-content">
                        <div className="company-drawer-scores">
                          <Score label="MID retrieval score" value={company.mid_score} />
                          <Score label="ISCC retrieval score" value={company.iscc_score} />
                        </div>
                        <section className="company-drawer-section">
                          <h3>Discovery scores</h3>
                          <div className="company-drawer-phase-scores"><span>MID semantic score</span><SemanticBar value={detail ? detail.mid_semantic?.score ?? null : company.mid_semantic_score} /><span>ISCC relevancy</span><strong>{(detail ? detail.iscc?.relevancy : company.iscc_relevancy)?.toFixed(2) ?? "—"}</strong></div>
                        </section>
                        <section className="company-drawer-section">
                          <h3>MID keyword evidence</h3>
                          {(detail?.mid_keyword ?? company.mid_keyword) ? <KeywordEvidence data={(detail?.mid_keyword ?? company.mid_keyword)!} /> : <p className="company-drawer-muted">No keyword matches are available.</p>}
                        </section>
                        {Object.entries(detail?.rounds ?? company.rounds).sort(([a], [b]) => Number(b.slice(1)) - Number(a.slice(1))).map(([key, round]) => <section className="company-drawer-section" key={key}>
                          <h3>{key} {round.provider_label}</h3>
                          <div className="company-drawer-round-scores">{round.score_columns.map((column) => <div key={column}><span>{column}</span><ScorePill value={round.scores[column]} /></div>)}</div>
                          {Object.entries(round.values).filter(([column]) => !round.score_columns.includes(column)).map(([column, value]) => <p className="company-drawer-round-output" key={column}><strong>{column}</strong> {displayValue(value)}</p>)}
                        </section>)}
                        <section className="company-drawer-section">
                          <h3>Coverage</h3>
                          <dl className="company-drawer-facts">{(detail?.columns ?? []).filter(column => column.group === "coverage").map(column => <div key={column.id}><dt>{column.label}</dt><dd>{displayValue(detail?.values?.[column.id])}</dd></div>)}</dl>
                          {!(detail?.columns ?? []).some(column => column.group === "coverage") && <p className="company-drawer-muted">No banker coverage fields available.</p>}
                        </section>
                        <section className="company-drawer-section">
                          <h3>Hydration</h3>
                          <div className="company-drawer-coverage">
                            {(["PB", "ROGO", "Bing"] as const).map((label) => {
                              const covered = label === "PB" ? company.coverage.pb : label === "ROGO" ? company.coverage.rogo : company.coverage.bing;
                              return <span className={covered ? "is-covered" : ""} key={label}>{label}: {covered ? "Available" : "Not available"}</span>;
                            })}
                          </div>
                          <dl className="company-drawer-facts">{(detail?.columns ?? []).filter(column => column.group === "hydration").map(column => <div key={column.id}><dt>{column.label}</dt><dd>{displayValue(detail?.values?.[column.id])}</dd></div>)}</dl>
                        </section>
                        <section className="company-drawer-section">
                          <h3>Descriptions</h3>
                          {descriptions.length ? descriptions.map((item, index) => (
                            <article className="company-drawer-description" key={`${item.label}-${index}`}>
                              <strong>{item.label}</strong>
                              <p>{item.text}</p>
                            </article>
                          )) : <p className="company-drawer-muted">No descriptions are available.</p>}
                        </section>
                      </Tabs.Content>

                      <Tabs.Content value="details" className="company-drawer-tab-content">
                        <section className="company-drawer-section">
                          <h3>Identifiers</h3>
                          {detail?.identifiers.length ? (
                            <dl className="company-drawer-facts">
                              {detail.identifiers.map((item) => <div key={`${item.kind}:${item.identifier}`}><dt>{item.kind}</dt><dd><code>{item.identifier}</code><small>First seen {item.first_seen_at}</small></dd></div>)}
                            </dl>
                          ) : <p className="company-drawer-muted">No identifiers are available.</p>}
                        </section>
                        {Object.entries(detail?.sources ?? {}).map(([source, sourceDetail]) => (
                          <section className="company-drawer-section" key={source}>
                            <div className="company-drawer-section-title"><h3>{source}</h3>{sourceDetail.updated_at && <time dateTime={sourceDetail.updated_at}>Updated {sourceDetail.updated_at}</time>}</div>
                            <dl className="company-drawer-facts">
                              {Object.entries(sourceDetail.fields).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{displayValue(value)}</dd></div>)}
                            </dl>
                            {sourceDetail.lineage != null && <p className="company-drawer-lineage">Source history: {displayValue(sourceDetail.lineage)}</p>}
                          </section>
                        ))}
                        {!Object.keys(detail?.sources ?? {}).length && <p className="company-drawer-muted">No source fields are available.</p>}
                      </Tabs.Content>

                      <Tabs.Content value="activity" className="company-drawer-tab-content">
                        {detail?.activity.length ? (
                          <ol className="company-drawer-activity">
                            {detail.activity.map((item, index) => <li key={`${item.at}-${item.kind}-${index}`}><span className="company-drawer-activity-kind">{item.kind}</span><time dateTime={item.at}>{item.at}</time><p>{item.summary}</p></li>)}
                          </ol>
                        ) : <p className="company-drawer-muted">No activity has been recorded.</p>}
                      </Tabs.Content>
                    </>
                  )}
                </div>
              </Tabs.Root>

              <footer className="company-drawer-footer">
                <button type="button" className="company-drawer-secondary" disabled={busy} onClick={() => onReview(company, company.considered ? "hide" : "restore")}>
                  {company.considered ? <X size={14} /> : <RotateCcw size={14} />}
                  {company.considered ? "Hide" : "Restore"}
                </button>
                <button type="button" className="company-drawer-ask" onClick={() => window.dispatchEvent(new CustomEvent(ASK_ASSISTANT_EVENT, { detail: { companyId: company.company_id, name: company.name } }))}>
                  <MessageSquare size={14} /> Ask assistant
                </button>
              </footer>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
