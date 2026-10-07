export type DropPurpose = "chat" | "pitchbook" | "rogo" | "intake";
export type DropDestination = DropPurpose | "mid_index";
export const dropTargets = [
  { purpose: "mid_index", label: "MID workbook", hint: "Build the company index (.xlsx)" },
  { purpose: "chat", label: "Attach to chat", hint: "Questions only — not imported" },
  { purpose: "pitchbook", label: "PitchBook data", hint: "Mapping CSV + data workbooks" },
  { purpose: "rogo", label: "ROGO data", hint: "Workbooks with a Website column" },
  { purpose: "intake", label: "Intake Form", hint: "PDF, DOCX or TXT" },
] as const;
export function allowedExtensions(purpose: DropDestination | "company-data") {
  return purpose === "mid_index" ? [".xlsx"] : purpose === "pitchbook" || purpose === "rogo" || purpose === "company-data"
    ? [".csv", ".xlsx"] : purpose === "intake" ? [".pdf", ".docx", ".txt"] : [".pdf", ".docx", ".txt", ".csv", ".xlsx"];
}
export function routeDrop(purpose: string | null | undefined): DropDestination | undefined {
  return dropTargets.find(target => target.purpose === purpose)?.purpose;
}
export function validateDropFiles(files: { name: string }[], purpose: DropDestination | "company-data") {
  if (purpose === "mid_index" && files.length !== 1) throw new Error("Choose one .xlsx workbook.");
  const extensions = allowedExtensions(purpose);
  const invalid = files.find(file => !extensions.some(extension => file.name.toLowerCase().endsWith(extension)));
  if (invalid) throw new Error(`${invalid.name}: ${dropTargets.find(target => target.purpose === purpose)?.label ?? "Company data"} accepts ${extensions.join(", ")} files.`);
}
export function dedupeKey(sessionId: string, purpose: string, sha256: string) {
  return JSON.stringify([sessionId, purpose, sha256]);
}
export const inPlaceDropSelector = "[data-file-drop-zone], .ct-composer-wrap";
