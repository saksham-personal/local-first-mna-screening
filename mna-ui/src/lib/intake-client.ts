import type { IntakeForm } from "../intake/intake-model";

export type IntakeExtraction = {
  text: string;
  fields: Partial<IntakeForm>;
  matched: string[];
};

export async function extractIntake(fileId: string): Promise<IntakeExtraction> {
  const response = await fetch("/api/intake/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId }),
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : `Intake Form extraction failed (HTTP ${response.status}).`;
    throw new Error(error);
  }
  if (!payload || typeof payload !== "object") throw new Error("The Intake Form extraction response was invalid.");
  const result = payload as IntakeExtraction;
  if (typeof result.text !== "string" || !result.fields || typeof result.fields !== "object" || !Array.isArray(result.matched))
    throw new Error("The Intake Form extraction response was invalid.");
  return { text: result.text, fields: result.fields, matched: result.matched };
}
