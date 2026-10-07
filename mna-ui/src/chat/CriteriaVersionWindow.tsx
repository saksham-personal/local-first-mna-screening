import { useState } from "react";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { formatDateTime } from "../lib/format";
import { reviseCriteria } from "../lib/chat-driver";
import { flushCriteriaDraft } from "../lib/review-client";
import { getChatState, updateChatState } from "../lib/chat-store";
import { artifactPart, getJob, stopJob } from "../lib/chat-jobs";
import { sessionStore } from "../lib/session-store";
import { intakeFieldLabels, type CriteriaVersion } from "./criteria-versions";
import "./criteria.css";

export default function CriteriaVersionWindow({ version, sessionId, onClose }: { version: CriteriaVersion; sessionId: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const restore = async () => {
    setBusy(true); setError("");
    try {
      const job = getJob(getChatState(sessionId).jobId);
      if (job?.state === "running") await stopJob(job.id);
      const artifact = reviseCriteria(sessionId, version.criteriaText, version.definition, version.deferred, undefined, { intakeForm: version.intakeForm, goodFitExamples: version.good.join("\n"), badFitExamples: version.bad.join("\n") });
      await flushCriteriaDraft(sessionId);
      const messageId = crypto.randomUUID();
      updateChatState(sessionId, current => ({ ...current, branchMessageIds: [...current.branchMessageIds, messageId] }));
      sessionStore.addEvent({ sessionId, kind: "system", origin: "workspace", status: "success", title: `Restored criteria v${version.revision} as a draft` });
      sessionStore.addEvent({ sessionId, messageId, kind: "message", role: "assistant", origin: "workspace", status: "success", title: "Criteria draft", content: [artifactPart(artifact)], text: "Review and approve the restored draft before searching." });
      onClose();
    } catch (caught) { setError(String(caught)); }
    finally { setBusy(false); }
  };
  const details = [
    ["Status", version.status], ["Started", formatDateTime(version.createdAt)], ["Ended", version.endedAt ? formatDateTime(version.endedAt) : "current"],
    ["Approved by", version.approvedBy ?? "—"], ["Approved at", version.approvedAt ? formatDateTime(version.approvedAt) : "—"], ["Digest", version.digest],
  ];
  const copyText = [version.criteriaText, `Core business\n${version.definition}`, `Good fits\n${version.good.join("\n")}`, `Bad fits\n${version.bad.join("\n")}`, `Core-business exclusions\n${version.exclusions.join("\n")}`, `Recorded, not used for search\n${version.deferred.join("\n")}`, ...details.map(([label, value]) => `${label}: ${value}`), ...(version.intakeForm ? Object.entries(version.intakeForm).map(([key, value]) => `${intakeFieldLabels[key as keyof typeof intakeFieldLabels]}: ${Array.isArray(value) ? value.join(", ") : String(value)}`) : [])].join("\n\n");
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className="cv-overlay" /><Dialog.Content className="cv-window" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
      <header><div><Dialog.Title>Criteria v{version.revision}</Dialog.Title><Dialog.Description>Saved criteria and revision metadata</Dialog.Description></div><button type="button" aria-label="Close criteria version" onClick={onClose} disabled={busy}><X size={18} /></button></header>
      <div className="cv-window-body">
        <section><h3>Criteria</h3><p>{version.criteriaText}</p></section>
        <section><h3>Core business definition</h3><p>{version.definition}</p></section>
        {([["Good fits", version.good], ["Bad fits", version.bad], ["Core-business exclusions", version.exclusions], ["Recorded, not used for search", version.deferred]] as const).map(([label, values]) => <section key={label}><h3>{label}</h3><p>{values.join("\n") || "None recorded"}</p></section>)}
        {version.intakeForm && <section><h3>Intake Form</h3><dl>{Object.entries(version.intakeForm).map(([key, value]) => <div key={key}><dt>{intakeFieldLabels[key as keyof typeof intakeFieldLabels]}</dt><dd>{Array.isArray(value) ? value.join(", ") || "—" : typeof value === "boolean" ? value ? "Yes" : "No" : String(value) || "—"}</dd></div>)}</dl></section>}
        <section><h3>Revision metadata</h3><dl>{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
        {error && <p role="alert">{error}</p>}
      </div>
      <footer><button type="button" className="ct-ghost-button" onClick={() => { void navigator.clipboard.writeText(copyText).catch(caught => setError(String(caught))); }}>Copy</button><button type="button" className="ct-solid-button" disabled={busy} onClick={() => void restore()}>{busy ? "Restoring…" : "Restore as new version"}</button></footer>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
