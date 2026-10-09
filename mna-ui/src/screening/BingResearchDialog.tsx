import { useEffect, useId, useRef, useState } from "react";
import type { ClipboardEvent } from "react";
import { Dialog } from "radix-ui";
import { Check, LoaderCircle, Plus, Sparkles, X } from "lucide-react";
import type { Company } from "../lib/contracts";
import HelpTip from "../ui/HelpTip";
import { plural } from "../lib/format";
import { cancelBingResearch, getResearchProgress, subscribeResearch } from "../lib/research-client";
import "./bing-research.css";

type PreviewResult = {
  token: string;
  queries: { company_id?: string; query: string }[];
  queryCount?: number;
  companyCount?: number;
  executed: false;
};
type Mode = "company" | "general";
type Props = {
  companies: Company[];
  initialQueries: string[];
  onClose: () => void;
  onPreview: (input: { mode: Mode; queries: string[]; companyIds: string[] }) => Promise<PreviewResult>;
  onRun: (token: string, options?: { includeInCriteria: boolean }) => Promise<{ executed: boolean; message: string }>;
  onGenerateTemplates?: () => Promise<{ executed: boolean; templates?: string[]; message?: string }>;
  connected?: boolean;
};

const COMPANY_TEMPLATES = [
  "{company} {website} core products and services",
  "{company} {website} customer workflows and product use cases",
  "{company} {website} primary sources describing its business",
];
const GENERAL_TEMPLATES = ["Company and industry market trends"];
const clean = (items: string[]) => [...new Set(items.map((item) => item.trim()).filter(Boolean))];
function messageFor(error: unknown) { return error instanceof Error ? error.message : "Research could not be prepared. Try again."; }
function splitQueries(text: string) { return clean(text.split(/\r?\n|\u2028|\u2029/)); }

export default function BingResearchDialog({ companies, initialQueries, onClose, onPreview, onRun, onGenerateTemplates, connected = false }: Props) {
  const headingId = useId();
  const companyModeAvailable = companies.length > 0;
  const initialMode: Mode = companyModeAvailable ? "company" : "general";
  const initialCompany = initialQueries.length ? splitQueries(initialQueries.join("\n")) : COMPANY_TEMPLATES;
  const initialGeneral = initialQueries.length && initialQueries.every((query) => !/(\{company\}|\{website\}|<company>)/i.test(query)) ? splitQueries(initialQueries.join("\n")) : GENERAL_TEMPLATES;
  const drafts = useRef<Record<Mode, string[]>>({ company: initialCompany, general: initialGeneral });
  const [mode, setMode] = useState<Mode>(initialMode);
  const [queries, setQueries] = useState<string[]>(drafts.current[initialMode]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [includeInCriteria, setIncludeInCriteria] = useState(false);
  const [runNotice, setRunNotice] = useState<{ executed: boolean; message: string } | null>(null);
  const requestVersion = useRef(0);
  const [progress, setProgress] = useState<{ processed: number; total: number }>();
  const [stopping, setStopping] = useState(false);
  useEffect(() => subscribeResearch(() => { if (preview) setProgress(getResearchProgress(preview.token)); }), [preview]);
  const validQueryCount = queries.length >= 1 && queries.length <= 5 && queries.every((query) => query.trim());
  const validTemplates = mode !== "company" || queries.every((query) => /(\{company\}|\{website\}|<company>)/i.test(query));
  const previewCount = preview?.queryCount ?? preview?.queries.length ?? 0;
  const validPreview = Boolean(preview && preview.executed === false && previewCount > 0 && preview.queries.length === queries.length);
  const canPreview = !busy && validQueryCount && validTemplates && (mode === "general" || companies.length > 0);

  const invalidate = () => { requestVersion.current += 1; setPreview(null); setRunNotice(null); setError(""); setNotice(""); };
  const updateQueries = (next: string[]) => { invalidate(); const normalized = next.map((query) => query.trim()); drafts.current[mode] = normalized; setQueries(normalized); };
  const updateMode = (next: Mode) => {
    if (next === mode || (next === "company" && !companyModeAvailable)) return;
    drafts.current[mode] = queries;
    invalidate(); setMode(next); setQueries(drafts.current[next]);
  };
  const runPreview = async () => {
    if (!canPreview) return;
    const current = ++requestVersion.current;
    setBusy(true); setError(""); setPreview(null); setRunNotice(null);
    try {
      const result = await onPreview({ mode, queries: [...queries], companyIds: [] });
      if (current !== requestVersion.current) return;
      if (result.executed !== false) throw new Error("Preview must not execute research or send queries.");
      if (result.queries.length !== queries.length || result.queries.some((item, index) => item.query !== queries[index])) throw new Error("Preview returned changed query templates.");
      setPreview(result);
    } catch (caught) { if (current === requestVersion.current) setError(messageFor(caught)); }
    finally { if (current === requestVersion.current) setBusy(false); }
  };
  const generateTemplates = async () => {
    if (!onGenerateTemplates || generating) return;
    const current = requestVersion.current;
    setGenerating(true); setNotice("");
    try {
      const result = await onGenerateTemplates();
      if (current !== requestVersion.current) return;
      if (!result.executed || !result.templates?.length) { setNotice(result.message || "Template generation is unavailable right now."); return; }
      updateQueries(result.templates.slice(0, 5)); setNotice("AI suggestions added. Edit them before previewing.");
    } catch (caught) { if (current === requestVersion.current) setNotice(messageFor(caught)); }
    finally { setGenerating(false); }
  };
  const approve = async () => {
    if (!validPreview || busy || !preview) return;
    setBusy(true); setError(""); setRunNotice(null);
    setStopping(false);
    try { setRunNotice(await onRun(preview.token, { includeInCriteria: mode === "general" && includeInCriteria })); }
    catch (caught) { setError(messageFor(caught)); }
    finally { setBusy(false); }
  };
  const pasteQuery = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text");
    if (!/[\r\n\u2028\u2029]/.test(pasted)) return;
    event.preventDefault();
    const lines = splitQueries(pasted);
    const next = [...queries];
    next.splice(index, 1, ...lines);
    updateQueries(next.slice(0, 5));
  };

  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy && !generating) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="brd-overlay" />
      <Dialog.Content className="brd-dialog" aria-labelledby={headingId}>
        <header className="brd-header"><div><span className="brd-eyebrow">Web research</span><Dialog.Title id={headingId}>Prepare Bing research</Dialog.Title><Dialog.Description>Review query templates and the company count before approval.</Dialog.Description></div><Dialog.Close asChild><button className="brd-close" type="button" aria-label="Close research" disabled={busy || generating}><X size={17} /></button></Dialog.Close></header>
        <div className="brd-scroll">
          <div className="brd-mode" role="group" aria-label="Research type"><button type="button" className={mode === "company" ? "is-selected" : ""} aria-pressed={mode === "company"} disabled={!companyModeAvailable || busy} onClick={() => updateMode("company")}>Company research</button><button type="button" className={mode === "general" ? "is-selected" : ""} aria-pressed={mode === "general"} disabled={busy} onClick={() => updateMode("general")}>General query</button></div>
          {mode === "company" && <p className="brd-company-count">{plural(companies.length, "company", "companies")} will be included. <HelpTip label="About company research">Only companies still marked considered are included.</HelpTip></p>}
          <section className="brd-queries">
            <div className="brd-section-head"><div><h3>{mode === "company" ? "Query templates" : "Search queries"}</h3><p>{mode === "company" ? "Edit 1–5 templates" : "Used as written · 1–5 queries"}</p></div><span className="brd-count">{queries.length}/5</span></div>
            <div className="brd-template-list" role="group" aria-label={mode === "company" ? "Query templates" : "Search queries"}>
              {queries.map((query, index) => <div className="brd-template-row" key={`${mode}-${index}`}><span className="brd-template-index">{index + 1}</span><input aria-label={`${mode === "company" ? "Template" : "Query"} ${index + 1}`} value={query} onChange={(event) => { const next = [...queries]; next[index] = event.target.value; updateQueries(next); }} onPaste={(event) => pasteQuery(index, event)} disabled={busy || generating} /><button type="button" className="brd-remove" aria-label={`Remove ${mode === "company" ? "template" : "query"} ${index + 1}`} onClick={() => updateQueries(queries.filter((_, item) => item !== index))} disabled={busy || generating || queries.length <= 1}><X size={14} /></button></div>)}
            </div>
            <div className="brd-query-actions"><button type="button" className="brd-add" onClick={() => updateQueries([...queries, ""])} disabled={busy || generating || queries.length >= 5}><Plus size={14} /> Add {mode === "company" ? "template" : "query"}</button>{onGenerateTemplates && <button type="button" className="brd-generate" onClick={() => void generateTemplates()} disabled={busy || generating}><Sparkles size={14} />{generating ? <LoaderCircle className="brd-spin" size={13} /> : "Generate with AI"}</button>}</div>
            {notice && <p className="brd-notice" role="status">{notice}</p>}
            {mode === "company" && <p className="brd-note">Use <code>{"{company}"}</code>, <code>{"{website}"}</code>, or <code>{"<company>"}</code> in each template. Paste multiple lines to split them.</p>}
            {!validQueryCount && <p className="brd-validation" role="status">Enter 1 to 5 non-empty {mode === "company" ? "templates" : "queries"}.</p>}
            {!validTemplates && <p className="brd-validation" role="status">Add a company or website placeholder to each template.</p>}
          </section>
          {mode === "general" && <label className="brd-criteria-toggle"><input type="checkbox" checked={includeInCriteria} onChange={(event) => { invalidate(); setIncludeInCriteria(event.target.checked); }} disabled={busy} /><span><strong>Include findings in screening criteria</strong><small>Adds approved research findings to this screening's criteria.</small></span></label>}
          <aside className="brd-source-note"><strong>Source coverage</strong><span>Search results are external leads; coverage is unknown until they are reviewed and matched.</span> <HelpTip label="About source coverage">Research leads need analyst review before they are treated as evidence.</HelpTip></aside>
          {validPreview && preview && <section className="brd-preview" aria-label="Research preview"><div><Check size={15} aria-hidden="true" /><strong>Templates ready</strong><span>{mode === "company" ? `${plural(preview.companyCount ?? companies.length, "company", "companies")} · ` : ""}{plural(queries.length, "query template")} · No queries sent</span></div><small>Approval includes the considered companies at that moment. Queries are built when each batch is sent.</small></section>}
          {busy && preview && <p role="status">{progress ? `${progress.processed.toLocaleString()} of ${progress.total.toLocaleString()} queries processed` : "Approved · sending the first batch…"}{stopping ? " · Stopping after this batch" : connected && <button type="button" className="brd-secondary" onClick={() => { setStopping(true); void cancelBingResearch(preview.token).catch(error => { setStopping(false); setError(messageFor(error)); }); }}>Stop research</button>}</p>}
          {runNotice && <p className={`brd-result${runNotice.executed ? " is-executed" : ""}`} role="status"><strong>{runNotice.executed ? "Research started" : "Research saved"}</strong><span>{runNotice.message}</span></p>}
          {error && <p className="brd-error" role="alert">{error}</p>}
        </div>
        <footer className="brd-footer"><p>{connected ? "Search starts after approval." : "Disconnected; approval saves this research for later."}</p><div><button className="brd-secondary" type="button" onClick={onClose} disabled={busy || generating}>Close</button>{!validPreview ? <button className="brd-primary" type="button" onClick={() => void runPreview()} disabled={!canPreview}>{busy ? "Preparing…" : "Preview queries"}</button> : <button className="brd-primary" type="button" onClick={() => void approve()} disabled={busy}>{busy ? "Saving…" : connected ? "Approve and search" : "Save approved research"}</button>}</div></footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
