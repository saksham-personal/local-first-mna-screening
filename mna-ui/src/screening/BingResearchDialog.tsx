import { useId, useMemo, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { Check, Search, X } from "lucide-react";
import type { Company } from "../lib/contracts";
import "./bing-research.css";

type PreviewResult = {
  token: string;
  queries: { company_id?: string; query: string }[];
  executed: false;
};

type Props = {
  companies: Company[];
  initialQueries: string[];
  onClose: () => void;
  onPreview: (input: { queries: string[]; companyIds: string[] }) => Promise<PreviewResult>;
  onRun: (token: string) => Promise<{ executed: boolean; message: string }>;
  connected?: boolean;
};

type Mode = "company" | "general";
const COMPANY_TEMPLATES = [
  "{company} {website} core products and services",
  "{company} {website} customer workflows and product use cases",
  "{company} {website} primary sources describing its business",
];
const GENERAL_TEMPLATES = ["Company and industry market trends"];

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : "Research could not be prepared. Try again.";
}

function splitQueries(text: string) {
  return text.split(/\r?\n/).map((query) => query.trim()).filter(Boolean);
}

export default function BingResearchDialog({ companies, initialQueries, onClose, onPreview, onRun, connected = false }: Props) {
  const headingId = useId();
  const companyModeAvailable = companies.length > 0;
  const [mode, setMode] = useState<Mode>(companyModeAvailable ? "company" : "general");
  const queryDrafts = useRef<Record<Mode, string>>({
    company: (initialQueries.length ? initialQueries : COMPANY_TEMPLATES).join("\n"),
    general: (!companyModeAvailable && initialQueries.length && initialQueries.every((query) => !/(\{company\}|\{website\}|<company>)/i.test(query)) ? initialQueries : GENERAL_TEMPLATES).join("\n"),
  });
  const [queriesText, setQueriesText] = useState(() => queryDrafts.current[companyModeAvailable ? "company" : "general"]);
  const [selected, setSelected] = useState<string[]>(() => companies.slice(0, 100).map((company) => company.pk));
  const [filter, setFilter] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runNotice, setRunNotice] = useState<{ executed: boolean; message: string } | null>(null);
  const requestVersion = useRef(0);
  const queries = useMemo(() => splitQueries(queriesText), [queriesText]);
  const selectableCompanies = useMemo(() => companies.filter((company) => selected.includes(company.pk)), [companies, selected]);
  const visibleCompanies = useMemo(() => {
    const normalized = filter.trim().toLocaleLowerCase();
    return companies.filter((company) => !normalized || `${company.name} ${company.website}`.toLocaleLowerCase().includes(normalized));
  }, [companies, filter]);
  const validQueryCount = mode === "company" ? queries.length >= 3 && queries.length <= 5 : queries.length >= 1 && queries.length <= 5;
  const companyIds = mode === "company" ? selected : [];
  const expectedCount = mode === "company" ? queries.length * companyIds.length : queries.length;
  const validPreview = Boolean(preview && preview.executed === false && preview.queries.length === expectedCount && expectedCount > 0);
  const canPreview = !busy && validQueryCount && (mode === "general" || (companyIds.length > 0 && companyIds.length <= 100));

  const invalidate = () => {
    requestVersion.current += 1;
    setPreview(null);
    setRunNotice(null);
    setError("");
  };

  const updateMode = (next: Mode) => {
    if (next === mode) return;
    if (next === "company" && !companyModeAvailable) return;
    queryDrafts.current[mode] = queriesText;
    invalidate();
    setMode(next);
    setQueriesText(queryDrafts.current[next]);
  };

  const toggleCompany = (pk: string) => {
    invalidate();
    setSelected((current) => current.includes(pk) ? current.filter((id) => id !== pk) : current.length < 100 ? [...current, pk] : current);
  };

  const runPreview = async () => {
    if (!canPreview) return;
    const version = ++requestVersion.current;
    setBusy(true);
    setError("");
    setPreview(null);
    setRunNotice(null);
    try {
      const result = await onPreview({ queries: [...queries], companyIds: [...companyIds] });
      if (version !== requestVersion.current) return;
      if (result.executed !== false) throw new Error("Preview must not execute research or send queries.");
      if (result.queries.length !== expectedCount) throw new Error(`Preview returned ${result.queries.length} queries; expected ${expectedCount}.`);
      if (mode === "company") {
        const counts = new Map<string, number>();
        for (const item of result.queries) if (item.company_id) counts.set(item.company_id, (counts.get(item.company_id) ?? 0) + 1);
        if (companyIds.some((id) => counts.get(id) !== queries.length)) throw new Error("Preview did not include the expected query count for every selected company.");
      }
      setPreview(result);
    } catch (caught) {
      if (version === requestVersion.current) setError(messageFor(caught));
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  };

  const approve = async () => {
    if (!validPreview || busy || !preview) return;
    setBusy(true);
    setError("");
    setRunNotice(null);
    try {
      const result = await onRun(preview.token);
      setRunNotice(result);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const updateQueries = (value: string) => {
    invalidate();
    setQueriesText(value);
  };

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="brd-overlay" />
        <Dialog.Content className="brd-dialog" aria-labelledby={headingId}>
          <header className="brd-header">
            <div>
              <span className="brd-eyebrow">Web research</span>
              <Dialog.Title id={headingId}>Prepare Bing research</Dialog.Title>
              <Dialog.Description>Review the exact queries before approving a search.</Dialog.Description>
            </div>
            <Dialog.Close asChild><button className="brd-close" type="button" aria-label="Close research" disabled={busy}><X size={17} /></button></Dialog.Close>
          </header>

          <div className="brd-scroll">
            <div className="brd-mode" role="group" aria-label="Research type">
              <button type="button" className={mode === "company" ? "is-selected" : ""} aria-pressed={mode === "company"} disabled={!companyModeAvailable || busy} onClick={() => updateMode("company")}>Company research</button>
              <button type="button" className={mode === "general" ? "is-selected" : ""} aria-pressed={mode === "general"} disabled={busy} onClick={() => updateMode("general")}>General query</button>
            </div>

            {mode === "company" && (
              <section className="brd-companies" aria-label="Company shortlist">
                <div className="brd-section-head"><div><h3>Companies</h3><p>Select up to 100. {selected.length} selected.</p></div></div>
                {companies.length > 100 && <p className="brd-note">The first 100 companies are selected by default. Change the shortlist below.</p>}
                <label className="brd-search"><Search size={14} aria-hidden="true" /><span className="brd-visually-hidden">Filter companies</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Find a company" /></label>
                <div className="brd-company-list" role="group" aria-label="Select companies">
                  {visibleCompanies.map((company) => {
                    const checked = selected.includes(company.pk);
                    return <label className="brd-company-option" key={company.pk}><input type="checkbox" checked={checked} disabled={busy || (!checked && selected.length >= 100)} onChange={() => toggleCompany(company.pk)} /><span><strong>{company.name}</strong><small>{company.website || "Website not available"}</small></span></label>;
                  })}
                  {!visibleCompanies.length && <p className="brd-empty">No companies match this search.</p>}
                </div>
              </section>
            )}

            <section className="brd-queries">
              <div className="brd-section-head"><div><h3>{mode === "company" ? "Query templates" : "Search query"}</h3><p>{mode === "company" ? "One query per line · 3–5 templates" : "One literal search per line · 1–5 queries"}</p></div><span className="brd-count">{queries.length}</span></div>
              <label className="brd-visually-hidden" htmlFor={`${headingId}-queries`}>Enter queries, one per line</label>
              <textarea id={`${headingId}-queries`} value={queriesText} onChange={(event) => updateQueries(event.target.value)} disabled={busy} spellCheck={false} />
              {mode === "company" ? <p className="brd-note">Templates accept <code>{"{company}"}</code>, <code>{"{website}"}</code>, or <code>{"<company>"}</code>. A company name or website placeholder is needed for each template.</p> : <p className="brd-note">These queries are used exactly as written.</p>}
              {!validQueryCount && <p className="brd-validation" role="status">{mode === "company" ? "Enter 3 to 5 non-empty query templates." : "Enter 1 to 5 non-empty queries."}</p>}
              {mode === "company" && queries.some((query) => !/(\{company\}|\{website\}|<company>)/i.test(query)) && <p className="brd-validation" role="status">Every company template must include a company or website placeholder.</p>}
            </section>

            <aside className="brd-source-note"><strong>Source coverage</strong><span>Search results are external leads. Source coverage is unknown until results are reviewed and matched.</span></aside>

            {validPreview && preview && <section className="brd-preview" aria-label="Research preview"><div><Check size={15} aria-hidden="true" /><strong>Preview ready</strong><span>{preview.queries.length} exact query requests · executed: no</span></div><ul>{preview.queries.slice(0, 6).map((item, index) => <li key={`${item.company_id ?? "general"}-${index}`}><span>{item.company_id ? (companies.find((company) => company.pk === item.company_id)?.name ?? item.company_id) : "General"}</span><code>{item.query}</code></li>)}</ul>{preview.queries.length > 6 && <small>And {preview.queries.length - 6} more query requests</small>}</section>}
            {runNotice && <p className={`brd-result${runNotice.executed ? " is-executed" : ""}`} role="status"><strong>{runNotice.executed ? "Research started" : "Research saved"}</strong><span>{runNotice.message}</span><small>Executed: {runNotice.executed ? "yes" : "no"}</small></p>}
            {error && <p className="brd-error" role="alert">{error}</p>}
          </div>

          <footer className="brd-footer">
            <p>{connected ? "Search will start only after you approve this exact preview." : "Disconnected. Save the approved research for later; no search will execute now."}</p>
            <div>
              <button className="brd-secondary" type="button" onClick={onClose} disabled={busy}>Close</button>
              {!validPreview ? <button className="brd-primary" type="button" onClick={runPreview} disabled={!canPreview}>{busy ? "Preparing…" : "Preview queries"}</button> : <button className="brd-primary" type="button" onClick={approve} disabled={busy}>{busy ? "Saving…" : connected ? "Approve and search" : "Save approved research"}</button>}
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
