import type { ChatArtifact } from "../lib/chat-contract";
import "./shortlist-flow.css";

export function InlineFitExamples({ good, bad, readOnly, onChange }: { good: string; bad: string; readOnly?: boolean; onChange: (good: string, bad: string) => void }) {
  return <details className="criteria-inline-examples">
    <summary>Good fits / Bad fits (optional)</summary>
    <div className="fit-examples-fields">
      <label><span><i className="fit-good-dot" />Good fits</span><textarea aria-label="Good-fit examples" value={good} onChange={event => onChange(event.target.value, bad)} rows={4} readOnly={readOnly} /></label>
      <label><span><i className="fit-bad-dot" />Bad fits</span><textarea aria-label="Bad-fit examples" value={bad} onChange={event => onChange(good, event.target.value)} rows={4} readOnly={readOnly} /></label>
    </div>
  </details>;
}
/** Historical two-stage cards remain readable; new revisions use inline examples. */
export default function FitExamples({ artifact }: { artifact: Extract<ChatArtifact, { type: "fit-examples" }> }) {
  return <InlineFitExamples good={artifact.good} bad={artifact.bad} readOnly onChange={() => {}} />;
}
