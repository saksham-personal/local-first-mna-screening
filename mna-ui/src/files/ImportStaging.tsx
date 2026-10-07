import { CheckCircle2, CircleAlert, FileSpreadsheet, LoaderCircle, UploadCloud } from "lucide-react";
import type { StagedFile } from "../lib/chat-contract";
import "./import-staging.css";

export default function ImportStaging({ files, summary, onUpload, onRetry }: { files: StagedFile[]; summary?: string; onUpload: () => void; onRetry: () => void }) {
  const tabular = files.filter(file => file.purpose === "pitchbook" || file.purpose === "rogo");
  const pending = tabular.filter(file => file.stagingStatus !== "imported");
  const added = tabular.filter(file => file.stagingStatus === "imported");
  const pb = added.some(file => file.sourceKinds?.some(kind => kind === "mapping" || kind === "pitchbook"));
  const rogo = added.some(file => file.sourceKinds?.includes("rogo"));
  return <section className="import-staging" aria-label="Company data imports">
    <div className="import-staging-head"><div><h3>Company data</h3><p>Choose PitchBook or ROGO to import company data.</p></div><button type="button" onClick={onUpload} aria-label="Add company data"><UploadCloud size={16} /></button></div>
    {(pb || rogo) && <div className="import-added" role="status"><CheckCircle2 size={17} /><span>{[pb && "PitchBook", rogo && "ROGO"].filter(Boolean).join(" and ")} data added<small>Use /data to view the latest company table.</small></span></div>}
    {summary && <p className="import-empty">{summary.replace(/ Use \/data[\s\S]*$/, "")}</p>}
    {pending.map(file => <div className={`import-pending import-${file.stagingStatus}`} key={file.id}>
      {file.stagingStatus === "checking" || file.stagingStatus === "importing" ? <LoaderCircle className="ca-spin" size={16} /> : file.stagingStatus === "error" || file.stagingStatus === "unrecognized" ? <CircleAlert size={16} /> : <FileSpreadsheet size={16} />}
      <div><strong title={file.name}>{file.name}</strong><small>{file.stagingStatus === "waiting" ? "Detected. Add companies to this screening to hydrate them." : file.stagingMessage || "Staged for review"}</small></div>
    </div>)}
    {pending.some(file => file.stagingStatus === "error") && <button className="import-retry" type="button" onClick={onRetry}>Check files again</button>}
    {!tabular.length && <p className="import-empty">Add a PitchBook mapping list, a data workbook, or ROGO data. Use the matching upload zone. Importing does not hide companies.</p>}
  </section>;
}
