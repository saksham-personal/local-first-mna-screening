import { useId, useState } from "react";
import { Dialog } from "radix-ui";
import { LoaderCircle } from "lucide-react";
import { canForceLoopUndo } from "../lib/loop-client";
import type { LoopActivityJob } from "../lib/run-activity";
import "./loop-undo-dialog.css";

export default function LoopUndoDialog({ loop, onClose, onUndo }: { loop: LoopActivityJob; onClose: () => void; onUndo: (force: boolean) => Promise<void> }) {
  const titleId = useId();
  const [error, setError] = useState("");
  const [forceAvailable, setForceAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (force: boolean) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await onUndo(force); }
    catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setForceAvailable(canForceLoopUndo(caught));
      setBusy(false);
    }
  };
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="lud-overlay" />
      <Dialog.Content className="lud-dialog" aria-labelledby={titleId} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
        <Dialog.Title className="lud-title" id={titleId}>Undo {loop.title}?</Dialog.Title>
        <Dialog.Description className="lud-description">Restore the considered companies that were present before this loop. Search history remains saved.</Dialog.Description>
        {error && <p className="lud-error" role="alert">{error}</p>}
        <footer className="lud-actions">
          <button type="button" onClick={onClose} disabled={busy}>Back</button>
          {forceAvailable
            ? <button className="lud-confirm" type="button" onClick={() => void submit(true)} disabled={busy}>{busy && <LoaderCircle size={14} className="lud-spinner" aria-hidden="true" />}Undo anyway</button>
            : <button className="lud-confirm" type="button" onClick={() => void submit(false)} disabled={busy}>{busy && <LoaderCircle size={14} className="lud-spinner" aria-hidden="true" />}Undo loop</button>}
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
