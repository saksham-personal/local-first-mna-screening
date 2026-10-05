import { useMemo, useRef, useState } from "react";
import { Check, FileSpreadsheet, LoaderCircle, UploadCloud } from "lucide-react";
import type { ArtifactAction, ChatArtifact, ChatState, StagedFile } from "../lib/chat-contract";
import FileDropArea from "../ui/FileDropArea";
import Tooltip from "../Tooltip";
import "./shortlist-flow.css";

type Props = {
  artifact: Extract<ChatArtifact, { type: "enrichment-upload" }>;
  context?: ChatState;
  onAction: (action: ArtifactAction) => void | Promise<void>;
};

function formatBytes(bytes: number) {
  if (!bytes) return "0 KB";
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function statusCopy(file: StagedFile) {
  if (file.stagingMessage) return file.stagingMessage;
  switch (file.stagingStatus) {
    case "checking": return "Checking file";
    case "waiting": return "Waiting to import";
    case "importing": return "Importing data";
    case "imported": return "Added to company context";
    case "unrecognized": return "File format not recognized";
    case "error": return "Could not import";
    default: return "Ready";
  }
}

export default function EnrichmentUpload({ artifact, context, onAction }: Props) {
  const [source, setSource] = useState<"pitchbook" | "rogo">(artifact.source);
  const [fileError, setFileError] = useState("");
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const files = useMemo(() => {
    const current = context?.files.filter((file) => file.uploadArtifactId === artifact.id && (file.purpose === "pitchbook" || file.purpose === "rogo")) ?? [];
    return current.length ? current : artifact.files;
  }, [artifact.files, artifact.id, context?.files]);
  const imported = files.filter((file) => file.stagingStatus === "imported").length;
  const working = uploading || files.some((file) => ["checking", "waiting", "importing"].includes(file.stagingStatus ?? ""));
  const failed = files.some((file) => file.stagingStatus === "error" || file.stagingStatus === "unrecognized");
  const instructions = source === "pitchbook"
    ? "Add a PitchBook mapping CSV and data workbook. The mapping connects company IDs to PitchBook records."
    : "Add one or more ROGO workbooks with a Website column to match company records.";
  const receiveFiles = async (incoming: File[]) => {
    if (uploading) return;
    const accepted = incoming.filter((file) => /\.(csv|xlsx)$/i.test(file.name));
    setFileError(accepted.length === incoming.length ? "" : "Choose CSV or XLSX files.");
    if (!accepted.length) return;
    setUploading(true);
    try { await onAction({ type: "upload-source", artifactId: artifact.id, source, files: accepted }); }
    catch (error) { setFileError(error instanceof Error ? error.message : "The files could not be added. Try again."); }
    finally { setUploading(false); }
  };
  const inputId = `sf-upload-${artifact.id}`;

  return <section className="sf-upload-card" aria-label={`${source === "pitchbook" ? "PitchBook" : "ROGO"} enrichment upload`}>
    <div className="sf-source-tabs" role="group" aria-label="Enrichment source">
      <button type="button" aria-pressed={source === "pitchbook"} className={source === "pitchbook" ? "is-selected" : ""} onClick={() => { setSource("pitchbook"); setFileError(""); }}>PitchBook</button>
      <button type="button" aria-pressed={source === "rogo"} className={source === "rogo" ? "is-selected" : ""} onClick={() => { setSource("rogo"); setFileError(""); }}>ROGO</button>
    </div>
    <FileDropArea className="sf-drop-area" onFiles={receiveFiles}>
      <div className="sf-dropzone">
        <span className="sf-drop-icon"><UploadCloud size={18} /></span>
        <div className="sf-drop-copy"><strong>Drop files to add company data</strong><small>.csv and .xlsx · multiple files allowed</small></div>
        <label className="sf-browse" htmlFor={inputId}>Browse files</label>
        <input ref={inputRef} id={inputId} type="file" accept=".csv,.xlsx" multiple disabled={uploading} onChange={(event) => { void receiveFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      </div>
    </FileDropArea>
    <div className="sf-instructions"><span>{instructions}</span><Tooltip label="File matching details">PitchBook uses the mapping's company key and PBId. ROGO uses the PitchBook website first, then the source website. Headers identify the files. These uploads add company data and are not sent as chat attachments.</Tooltip></div>
    {fileError && <p className="sf-upload-error" role="alert">{fileError}</p>}
    {files.length > 0 && <section className="sf-staged" aria-label="Upload status" aria-live="polite">
      <div className="sf-staged-head"><strong>{imported ? `${imported} file${imported === 1 ? "" : "s"} added` : "File status"}</strong>{working && <span><LoaderCircle className="sf-spin" size={13} /> Processing</span>}{!working && imported > 0 && <span className="sf-imported"><Check size={13} /> Ready</span>}</div>
      {artifact.summary && imported > 0 && <p className="sf-success-summary">{artifact.summary}</p>}
      <ul>{files.map((file) => <li key={file.id}><FileSpreadsheet size={14} /><span><strong>{file.name}</strong><small>{formatBytes(file.bytes)} · {statusCopy(file)}</small></span></li>)}</ul>
      {failed && <button className="sf-retry" type="button" onClick={() => inputRef.current?.click()}>Choose files to retry</button>}
    </section>}
  </section>;
}
