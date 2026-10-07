export type DropPurpose = "chat" | "pitchbook" | "rogo" | "intake";
export const dropTargets = [
  { purpose: "chat", label: "Attach to chat", hint: "Questions only — not imported" },
  { purpose: "pitchbook", label: "PitchBook data", hint: "Mapping CSV + data workbooks" },
  { purpose: "rogo", label: "ROGO data", hint: "Workbooks with a Website column" },
  { purpose: "intake", label: "Intake Form", hint: "PDF, DOCX or TXT" },
] as const;
export function allowedExtensions(purpose: DropPurpose | "company-data") {
  return purpose === "pitchbook" || purpose === "rogo" || purpose === "company-data"
    ? [".csv", ".xlsx"] : purpose === "intake" ? [".pdf", ".docx", ".txt"] : [".pdf", ".docx", ".txt", ".csv", ".xlsx"];
}
export function routeDrop(purpose: string | null | undefined): DropPurpose | undefined {
  return dropTargets.find(target => target.purpose === purpose)?.purpose;
}
export function validateDropFiles(files: { name: string }[], purpose: DropPurpose | "company-data") {
  const extensions = allowedExtensions(purpose);
  const invalid = files.find(file => !extensions.some(extension => file.name.toLowerCase().endsWith(extension)));
  if (invalid) throw new Error(`${invalid.name}: ${dropTargets.find(target => target.purpose === purpose)?.label ?? "Company data"} accepts ${extensions.join(", ")} files.`);
}
export function dedupeKey(sessionId: string, purpose: string, sha256: string) {
  return JSON.stringify([sessionId, purpose, sha256]);
}
export const inPlaceDropSelector = "[data-file-drop-zone], .ct-composer-wrap";
