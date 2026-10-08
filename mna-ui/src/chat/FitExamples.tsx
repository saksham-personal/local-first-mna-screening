import type { ChatArtifact } from "../lib/chat-contract";
import "./shortlist-flow.css";

export function examplesVisible(good: string, bad: string, readOnly = false) {
  return !readOnly || Boolean(good.trim() || bad.trim());
}

export function InlineFitExamples({ good, bad, readOnly, onChange }: { good: string; bad: string; readOnly?: boolean; onChange: (good: string, bad: string) => void }) {
  if (!examplesVisible(good, bad, readOnly)) return null;
  return <details className="criteria-inline-examples">
    <summary>Good fits / Bad fits (optional)</summary>
    <div className="fit-examples-fields">
      {(!readOnly || good.trim()) && <label><span><i className="fit-good-dot" />Good fits</span>{readOnly ? <p className="criteria-example-copy">{good}</p> : <textarea aria-label="Good-fit examples" value={good} onChange={event => onChange(event.target.value, bad)} rows={4} />}</label>}
      {(!readOnly || bad.trim()) && <label><span><i className="fit-bad-dot" />Bad fits</span>{readOnly ? <p className="criteria-example-copy">{bad}</p> : <textarea aria-label="Bad-fit examples" value={bad} onChange={event => onChange(good, event.target.value)} rows={4} />}</label>}
    </div>
  </details>;
}
/** Historical two-stage cards remain readable; new revisions use inline examples. */
export default function FitExamples({ artifact }: { artifact: Extract<ChatArtifact, { type: "fit-examples" }> }) {
  return <InlineFitExamples good={artifact.good} bad={artifact.bad} readOnly onChange={() => {}} />;
}
