import { useMemo, useState } from "react";
import { Dialog, Tabs } from "radix-ui";
import { Search, X } from "lucide-react";
import { applyEnrichmentReview, type EnrichmentCompany, type EnrichmentReport } from "../lib/enrichment-client";
import { getChatState } from "../lib/chat-store";
import "./enrichment.css";

const reasons = {
  not_in_mapping: "Not in mapping", profile_not_company: "Profile is not a company",
  blank_pbid: "No PBId", no_data_row: "No PitchBook data row", conflict: "Conflict",
};
export default function PitchBookReviewDialog({ sessionId, report, onClose }: { sessionId: string; report: EnrichmentReport; onClose: () => void }) {
  const [snapshot] = useState(() => {
    const state = getChatState(sessionId);
    return { revision: state.selectionRevision, flags: new Map(state.companies.map(company => [company.pk, company.considered !== false])) };
  });
  const all = useMemo(() => [...report.matched, ...(report.not_matched ?? [])], [report]);
  const [decisions, setDecisions] = useState<Record<string, boolean>>(() => Object.fromEntries(all.map(company => [company.company_id, true])));
  const [tab, setTab] = useState("matched");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rows = (tab === "matched" ? report.matched : report.not_matched ?? []).filter(company => `${company.name} ${company.website ?? ""} ${company.pbid ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const choose = (companies: EnrichmentCompany[], retain: boolean) => setDecisions(current => ({ ...current, ...Object.fromEntries(companies.map(company => [company.company_id, retain])) }));
  const apply = async () => {
    setBusy(true); setError("");
    const changes = all.filter(company => decisions[company.company_id] !== (snapshot.flags.get(company.company_id) ?? company.considered));
    try {
      await applyEnrichmentReview(sessionId, report, changes.filter(company => !decisions[company.company_id]).map(company => company.company_id), changes.filter(company => decisions[company.company_id]).map(company => company.company_id), snapshot.revision);
      onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The review could not be applied."); }
    finally { setBusy(false); }
  };
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="enrichment-overlay" />
    <Dialog.Content className="enrichment-dialog" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => { if (busy) event.preventDefault(); }}>
      <header><div><Dialog.Title>PitchBook match review</Dialog.Title><Dialog.Description>{report.summary.matched_count} matched · {report.summary.not_matched_count} not matched · 0 hidden by this import</Dialog.Description></div><Dialog.Close asChild><button disabled={busy} aria-label="Close match review"><X size={18} /></button></Dialog.Close></header>
      <Tabs.Root value={tab} onValueChange={value => { setTab(value); setPage(0); }}>
        <Tabs.List className="enrichment-tabs" aria-label="PitchBook matches"><Tabs.Trigger className="enrichment-matched" value="matched">PitchBook matched ({report.matched.length})</Tabs.Trigger><Tabs.Trigger className="enrichment-unmatched" value="not-matched">Not matched ({report.not_matched?.length ?? 0})</Tabs.Trigger></Tabs.List>
        <label className="enrichment-search"><Search size={16} /><input aria-label="Search companies" placeholder="Search companies" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></label>
        {tab === "not-matched" && <div className="enrichment-bulk" role="group" aria-label="Companies without PitchBook data"><button disabled={busy} onClick={() => choose(report.not_matched ?? [], true)}>Keep companies without PitchBook data</button><button disabled={busy} onClick={() => choose(report.not_matched ?? [], false)}>Hide companies without PitchBook data</button></div>}
        <Tabs.Content value={tab} className={`enrichment-rows ${tab === "matched" ? "enrichment-matched" : "enrichment-unmatched"}`}>
          {rows.slice(page * 100, (page + 1) * 100).map(company => <div className="enrichment-row" key={company.company_id}><div><strong>{company.name}</strong><small>{company.website ?? "No website"}</small><span className="enrichment-badge">{tab === "matched" ? `PBId: ${company.pbid ?? "—"}` : company.reason ? reasons[company.reason] : "Not matched"}</span></div><div className="enrichment-toggle" role="group" aria-label={`Selection for ${company.name}`}><button disabled={busy} aria-pressed={decisions[company.company_id]} onClick={() => choose([company], true)}>Retain</button><button disabled={busy} aria-pressed={!decisions[company.company_id]} onClick={() => choose([company], false)}>Hide</button></div></div>)}
          {!rows.length && <p>No companies match this search.</p>}
        </Tabs.Content>
      </Tabs.Root>
      {rows.length > 100 && <nav className="enrichment-pages" aria-label="Match pages"><button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>{page * 100 + 1}–{Math.min(rows.length, (page + 1) * 100)} of {rows.length}</span><button disabled={(page + 1) * 100 >= rows.length} onClick={() => setPage(page + 1)}>Next</button></nav>}
      {error && <p className="enrichment-error" role="alert">{error}</p>}
      <footer><p>Companies are retained unless you choose Hide.</p><button disabled={busy} onClick={onClose}>Cancel</button><button disabled={busy} onClick={() => void apply()}>{busy ? "Applying…" : "Apply"}</button></footer>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
