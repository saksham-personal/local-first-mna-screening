import { useId, useState } from "react";
import { Dialog } from "radix-ui";
import { LoaderCircle } from "lucide-react";
import type { RunActivityRow } from "../lib/run-activity";
import "./cancel-run-dialog.css";

type Props = {
  run: RunActivityRow;
  busy?: boolean;
  onBack: () => void;
  onCancel: (keep: boolean) => Promise<void>;
};

export default function CancelRunDialog({ run, busy = false, onBack, onCancel }: Props) {
  const headingId = useId();
  const keepId = useId();
  const discardId = useId();
  const [keep, setKeep] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const locked = busy || submitting;

  const cancel = async () => {
    if (locked) return;
    setSubmitting(true);
    setError("");
    try { await onCancel(keep); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setSubmitting(false); }
  };

  return <Dialog.Root open onOpenChange={open => { if (!open && !locked) onBack(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="crd-overlay" />
      <Dialog.Content className="crd-dialog" aria-labelledby={headingId} onEscapeKeyDown={event => { if (locked) event.preventDefault(); }}>
        <header className="crd-header">
          <Dialog.Title className="crd-title" id={headingId}>Cancel {run.title}?</Dialog.Title>
          <Dialog.Description className="crd-progress">{run.source === "loop" ? run.secondaryText : `${run.processed} of ${run.total} processed.`}</Dialog.Description>
        </header>
        <fieldset className="crd-options" disabled={locked}>
          <legend>What should happen to processed results?</legend>
          <label htmlFor={keepId}>
            <input id={keepId} type="radio" name="run-cancel-choice" checked={keep} onChange={() => setKeep(true)} />
            <span>{run.source === "loop" ? `Keep — apply the companies kept so far (${run.keptCount ?? 0})` : `Keep the ${run.processed} results processed so far`}</span>
          </label>
          <label htmlFor={discardId}>
            <input id={discardId} type="radio" name="run-cancel-choice" checked={!keep} onChange={() => setKeep(false)} />
            <span>{run.source === "loop" ? "Discard — change nothing; searches stay in history" : "Discard all results from this run (they stay in the audit history but won’t appear in companies, context, or exports)"}</span>
          </label>
        </fieldset>
        {error && <p className="crd-error" role="alert">{error}</p>}
        <footer className="crd-actions">
          <button type="button" onClick={onBack} disabled={locked}>Back</button>
          <button className="crd-confirm" type="button" onClick={() => void cancel()} disabled={locked}>
            {locked && <LoaderCircle size={14} aria-hidden="true" className="crd-spinner" />}
            {run.source === "loop" ? "Cancel loop" : "Cancel run"}
          </button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
