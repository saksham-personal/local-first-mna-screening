import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { useAuiState } from "@assistant-ui/react";
import { LoaderCircle, Info } from "lucide-react";
import { formatTime } from "../lib/format";
import { shortResult, valueLines, type ControllerView } from "../lib/controller-client";
import "./controller.css";

export type ControllerData = { pending: true; startedAt: string } | { turn: ControllerView } | { error: string };
function ControllerMarkdown({ text }: { text: string }) {
  // The enclosing part is structured data; provide its Markdown field explicitly.
  return <MarkdownTextPrimitive className="ca-markdown" smooth={false} preprocess={() => text} />;
}
function Pending({ startedAt }: { startedAt: string }) {
  const running = useAuiState(s => s.message.status?.type === "running");
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000)));
    tick();
    if (!running) return;
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, running]);
  if (!running) return <p role="status">LLM Suite request stopped. Reopen the session to restore any saved work.</p>;
  return <div className="cc-pending" role="status"><LoaderCircle size={16} className="spin" /> LLM Suite is working… <span>{elapsed}s elapsed</span></div>;
}
export default function ControllerMessage({ data, openSetup }: { data: ControllerData; openSetup: () => void }) {
  if ("pending" in data) return <Pending startedAt={data.startedAt} />;
  if ("error" in data) return <article className="cc-turn"><header className="cc-header"><strong>LLM Suite</strong></header><p className="cc-reason" role="alert">{data.error}</p></article>;
  const turn = data.turn;
  return <article className={`cc-turn${turn.kind === "feedback" ? " cc-feedback" : ""}`} id={turn.turn_id}>
    {turn.divider && <div className="cc-divider" role="separator">{turn.divider}</div>}
    <header className="cc-header"><strong>LLM Suite</strong>
      {turn.kind !== "analyst" && <span className="cc-badge">{turn.kind === "feedback" ? "Feedback" : "Hand-off"}</span>}
      {turn.simulated && <span className="cc-badge">Simulated</span>}
      <time dateTime={turn.created_at}>{formatTime(turn.created_at)}</time>
      <Popover.Root><Popover.Trigger className="ct-icon-button" aria-label="Conversation details"><Info size={15} /></Popover.Trigger>
        <Popover.Portal><Popover.Content className="cc-popover" sideOffset={6} collisionPadding={12}>
          <strong>Conversation details</strong><dl><dt>Conversation id</dt><dd>{turn.conversation_id}</dd>
            <dt>Rotated from</dt><dd>{turn.rotatedFrom ?? "First conversation"}</dd>
            <dt>Estimated tokens</dt><dd>{turn.estimatedTokens.toLocaleString()}</dd>
            {turn.simulated && <><dt>Provider</dt><dd>Simulated · local stub</dd></>}</dl>
        </Popover.Content></Popover.Portal>
      </Popover.Root>
    </header>
    {turn.feedbackParent && <a className="cc-feedback-link" href={`#${turn.feedbackParent}`}>Corrected after feedback</a>}
    {turn.context && <ControllerMarkdown text={turn.context} />}
    {turn.kind === "handoff" && !turn.context && turn.reply_markdown && <ControllerMarkdown text={turn.reply_markdown} />}
    {turn.reasoning && <details className="cc-reasoning"><summary>Show reasoning</summary><ControllerMarkdown text={turn.reasoning} /></details>}
    {turn.instructions.length > 0 && <section aria-label="Instruction set"><h4>Instruction set</h4><ol className="cc-instructions">
      {turn.instructions.map(instruction => <li key={instruction.index} className={`cc-instruction cc-${instruction.status}`}>
        <span className="cc-status-icon" aria-hidden="true">{instruction.status === "executed" ? "✓" : instruction.status === "rejected" ? "⨯" : "!"}</span>
        <div><div className="cc-instruction-title"><code>{instruction.action}</code><span className="cc-status-label">{instruction.status}</span></div>
          {instruction.title && <p>{instruction.title}</p>}
          {instruction.action === "propose_prepared_plan" && instruction.status === "executed"
            ? <p>Proposed — review in <button type="button" className="ca-text-action" onClick={openSetup}>Screening setup</button></p>
            : instruction.result_summary != null && <p className="cc-result">{shortResult(instruction.result_summary)}</p>}
          {instruction.reason && <p className="cc-reason">{instruction.reason}</p>}
          {instruction.arguments && Object.keys(instruction.arguments).length > 0 && <details><summary>Details</summary><ul className="cc-arguments">{valueLines(instruction.arguments).map((line, index) => <li key={index}>{line}</li>)}</ul></details>}
        </div>
      </li>)}
    </ol></section>}
    {turn.notes && <aside className="cc-notes"><strong>Notes for the analyst</strong><ControllerMarkdown text={turn.notes} /></aside>}
    {!!turn.warnings?.length && <p className="cc-warnings">Some of the reply could not be read: {turn.warnings.join("; ")}</p>}
    {turn.feedback_sent && <p className="cc-warnings">Instruction feedback sent to LLM Suite.</p>}
    {turn.error && <p className="cc-reason" role="alert">{turn.error}</p>}
  </article>;
}
