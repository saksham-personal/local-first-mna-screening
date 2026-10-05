import { useState } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import type { ArtifactAction, ChatArtifact } from "../lib/chat-contract";
import "./shortlist-flow.css";

export default function FitExamples({ artifact, onAction }: { artifact: Extract<ChatArtifact, { type: "fit-examples" }>; onAction: (action: ArtifactAction) => void | Promise<void> }) {
  const [good, setGood] = useState(artifact.good), [bad, setBad] = useState(artifact.bad);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const save = async (skip = false) => {
    setBusy(true); setError("");
    try { await onAction({ type: "save-examples", artifactId: artifact.id, good: skip ? "" : good, bad: skip ? "" : bad }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  if (artifact.completed) return <p className="ca-note">{artifact.good || artifact.bad ? "Examples saved with this criteria revision." : "Examples skipped."}</p>;
  return <div className="fit-examples">
    <p>Examples help clarify the business you want. Names, websites, or a short description are enough.</p>
    <div className="fit-examples-fields">
      <label><span><i className="fit-good-dot" />Good fits <small>Optional</small></span><textarea aria-label="Good-fit examples" value={good} onChange={event => setGood(event.target.value)} placeholder="Companies or businesses you would include…" rows={4} disabled={busy} /></label>
      <label><span><i className="fit-bad-dot" />Bad fits <small>Optional</small></span><textarea aria-label="Bad-fit examples" value={bad} onChange={event => setBad(event.target.value)} placeholder="Companies or businesses you would leave out…" rows={4} disabled={busy} /></label>
    </div>
    {error && <p role="alert" className="ca-error-detail">{error}</p>}
    <div className="ca-action-row"><button className="ca-primary-action" type="button" disabled={busy} onClick={() => void save()}>{busy ? <LoaderCircle size={14} className="ca-spin" /> : <ArrowRight size={14} />}Continue to final review</button><button className="ca-text-action" type="button" disabled={busy} onClick={() => void save(true)}>Skip examples</button></div>
  </div>;
}
