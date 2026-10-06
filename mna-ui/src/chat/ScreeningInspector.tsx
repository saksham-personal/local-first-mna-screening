import { ArrowRight, CheckCircle2, FileText, Globe, Layers3, Pencil, Table2 } from "lucide-react";
import type { ChatState } from "../lib/chat-contract";
import { approved } from "../lib/chat-store";
import { consideredCompanies, nextStepRecommendations } from "../lib/chat-policy";
import { plural } from "../lib/format";
import "./shortlist-flow.css";

export default function ScreeningInspector({ state, criteriaFirst, send, edit, preview }: {
  state: ChatState; criteriaFirst?: boolean; send: (text: string) => void;
  edit: () => void; preview: (artifactId: string) => void;
}) {
  const kept = consideredCompanies(state).length, hidden = state.companies.length - kept;
  const coverage = nextStepRecommendations(state);
  const sources = [
    { label: "PitchBook", key: "PB", hydrated: coverage.pb, command: "Add PitchBook data" },
    { label: "ROGO", key: "ROGO", hydrated: coverage.rogo, command: "Add ROGO data" },
    { label: "Bing research", key: "BING", hydrated: coverage.bing, command: "/bing" },
  ] as const;
  const attachments = state.files.filter(file => file.purpose === "chat" || !file.purpose).slice(-8);
  return <div className="si-content">
    {criteriaFirst && <section className="si-section">
      <div className="si-heading"><h3>Business criteria</h3><span className={approved(state) ? "si-status si-ready" : "si-status"}>{approved(state) ? "Approved" : "Review needed"}</span></div>
      <p className="si-definition">{state.definition || "Describe the business in chat to begin."}</p>
      <button type="button" className="ct-ghost-button" onClick={edit}><Pencil size={13} />Edit criteria</button>
      {state.lastCriteria && <details className="si-last"><summary>Last criteria · version {state.lastCriteria.revision}</summary><p>{state.lastCriteria.definition}</p></details>}
    </section>}
    <section className="si-section">
      <div className="si-heading"><h3>Your shortlist</h3><Table2 size={16} /></div>
      <div className="si-counts"><div><strong>{kept.toLocaleString()}</strong><span>considered</span></div><div><strong>{hidden.toLocaleString()}</strong><span>hidden, saved</span></div></div>
      <p>Review results, keep matches, and reuse the context you choose.</p>
      <button type="button" className="ct-panel-link" onClick={() => send("/review")}>Review company table<ArrowRight size={14} /></button>
      <button type="button" className="ct-panel-link" onClick={() => send("/plan")}>Choose a next step<ArrowRight size={14} /></button>
    </section>
    <section className="si-section">
      <div className="si-heading"><h3>Company context</h3><Layers3 size={16} /></div>
      <div className="si-sources">{sources.map(source => <div key={source.key}>
        <span>{source.hydrated ? <CheckCircle2 size={15} /> : source.key === "BING" ? <Globe size={15} /> : <Layers3 size={15} />}<strong>{source.label}</strong><small>{source.hydrated ? `${plural(state.coverage?.[source.key] ?? 0, "company", "companies")} updated` : "Not added yet"}</small></span>
        <button type="button" onClick={() => send(source.command)}>{source.hydrated ? "Add more" : source.key === "BING" ? "Research" : "Upload"}</button>
      </div>)}</div>
      <p>Source files are staged on their upload card. They are kept for joins and exports.</p>
    </section>
    {attachments.length > 0 && <section className="si-section">
      <div className="si-heading"><h3>Chat attachments</h3><FileText size={16} /></div>
      <ul className="si-attachments">{attachments.map(file => {
        const artifact = state.artifacts.find(item => item.type === "file" && item.file.id === file.id);
        return <li key={file.id}><FileText size={15} /><span><strong>{file.name}</strong><small>{file.passToProvider === false ? "Excluded from provider questions" : "Included in provider questions"}</small></span>{file.kind === "pdf" && artifact ? <button type="button" onClick={() => preview(artifact.id)}>Preview</button> : <a href={`/api/files/${encodeURIComponent(file.id)}`} download={file.name}>Download</a>}</li>;
      })}</ul>
    </section>}
    {!criteriaFirst && state.definition && <section className="si-section si-criteria-link"><div className="si-heading"><h3>Criteria · version {state.revision}</h3><span className={approved(state) ? "si-status si-ready" : "si-status"}>{approved(state) ? "Approved" : "Review needed"}</span></div><button type="button" className="ct-panel-link" onClick={edit}>Review or edit criteria<ArrowRight size={14} /></button></section>}
  </div>;
}
