import { useState } from "react";
import type { ArtifactAction, ChatState, StagedFile } from "../lib/chat-contract";
import { stageUploads } from "../lib/tool-client";
import { processStagedUploads } from "../lib/import-pipeline";
import { requestPitchBookReview } from "../lib/enrichment-client";
import { allowedExtensions, dedupeKey, dropTargets, type DropPurpose } from "../ui/drop-zones";
import FileDropArea from "../ui/FileDropArea";
import ArtifactCard from "../chat/ArtifactCard";
import "../enrichment/enrichment.css";
import "../chat/shortlist-flow.css";

const bytesLabel = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
function statusLabel(file: StagedFile) {
  if (file.stagingStatus === "checking" || file.stagingStatus === "importing") return "Checking";
  if (file.stagingStatus === "imported") return "Imported";
  if (file.stagingStatus === "error" || file.stagingStatus === "unrecognized") return "Error";
  return "Ready";
}
type Props = { state: ChatState; onAction: (action: ArtifactAction) => void; onIntakeFiles?: (files: File[]) => void | Promise<void> };
function FileZone({ purpose, state, onIntakeFiles }: { purpose: Exclude<DropPurpose, "chat"> } & Pick<Props, "state" | "onIntakeFiles">) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [localFiles, setLocalFiles] = useState<StagedFile[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState<StagedFile[]>([]);
  const target = dropTargets.find(target => target.purpose === purpose)!;
  const stagedFiles = state.files.filter(file => String(file.purpose) === purpose);
  const files = [...stagedFiles, ...localFiles, ...uploadingFiles.filter(file => !stagedFiles.some(staged => staged.name === file.name && staged.bytes === file.bytes))];
  const receive = async (incoming: File[]) => {
    if (busy || !incoming.length) return;
    const invalid = incoming.find(file => !allowedExtensions(purpose).some(extension => file.name.toLowerCase().endsWith(extension)));
    if (invalid) {
      const message = `${invalid.name}: ${target.label} accepts ${allowedExtensions(purpose).join(", ")} files.`;
      setError(message);
      setLocalFiles(current => [...current, { id: crypto.randomUUID(), name: invalid.name, bytes: invalid.size, kind: "", stagingStatus: "error", stagingMessage: message }]);
      return;
    }
    setBusy(true); setError("");
    const pending = incoming.map(file => ({ id: crypto.randomUUID(), name: file.name, bytes: file.size, kind: file.name.split(".").pop() ?? "", stagingStatus: "checking" as const }));
    setUploadingFiles(pending);
    try {
      if (purpose === "intake") {
        if (onIntakeFiles) await onIntakeFiles(incoming);
        else await stageUploads(incoming, { sessionId: state.sessionId, purpose: "chat" });
        const ready: StagedFile[] = [];
        for (let index = 0; index < incoming.length; index++) {
          const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await incoming[index].arrayBuffer()))].map(byte => byte.toString(16).padStart(2, "0")).join("");
          ready.push({ ...pending[index], id: dedupeKey(state.sessionId, purpose, hash), stagingStatus: "waiting", stagingMessage: "Ready" });
        }
        setLocalFiles(current => [...new Map([...current, ...ready].map(file => [file.id, file])).values()]);
      } else {
        await stageUploads(incoming, { sessionId: state.sessionId, purpose });
        await processStagedUploads(state.sessionId);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Files could not be added.";
      setError(message);
      setLocalFiles(current => [...current, ...pending.map(file => ({ ...file, stagingStatus: "error" as const, stagingMessage: message }))]);
    } finally { setBusy(false); setUploadingFiles([]); }
  };
  return <section className="ws-card files-tab-zone" aria-label={target.label}>
    <h2>{target.label}</h2><p>{target.hint}</p>
    <FileDropArea className="sf-drop-area" onFiles={incoming => void receive(incoming)}><div className="sf-dropzone"><strong>Drop {target.label} files here</strong><label className="sf-browse">Browse<input type="file" multiple disabled={busy} accept={allowedExtensions(purpose).join(",")} onChange={event => { void receive(Array.from(event.target.files ?? [])); event.target.value = ""; }} /></label></div></FileDropArea>
    {error && <p className="files-tab-error" role="alert">{error}</p>}
    <ul aria-live="polite">{files.map(file => <li key={file.id}><strong>{file.name}</strong><small className={statusLabel(file) === "Error" ? "files-tab-error" : ""}>{bytesLabel(file.bytes)} · {statusLabel(file)}{file.stagingMessage ? ` — ${file.stagingMessage}` : ""}</small></li>)}</ul>
    {purpose === "pitchbook" && files.some(file => file.stagingStatus === "imported") && <button type="button" className="ws-link" onClick={() => void requestPitchBookReview(state.sessionId).catch(caught => setError(String(caught)))}>Review matches</button>}
  </section>;
}
export default function FilesTab({ state, onAction, onIntakeFiles }: Props) {
  const attachments = state.artifacts.filter(artifact => artifact.type === "file" && (artifact.file.purpose === "chat" || !artifact.file.purpose));
  return <div className="ws-files-grid">
    {(["pitchbook", "rogo", "intake"] as const).map(purpose => <FileZone key={purpose} purpose={purpose} state={state} onIntakeFiles={onIntakeFiles} />)}
    <section className="ws-card ws-file-list-card"><h2>Chat attachments</h2><p>Attachments are used for questions and are not imported.</p><div className="ws-artifact-stack">{attachments.slice().reverse().map(artifact => <ArtifactCard key={artifact.id} artifact={artifact} onAction={onAction} />)}</div>{!attachments.length && <p>No chat attachments yet.</p>}</section>
  </div>;
}
