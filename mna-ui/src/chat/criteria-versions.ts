import { intakeToCriteria, normalizeIntake } from "../intake/intake-model";
import type { IntakeForm } from "../intake/intake-model";
import { draftCriteria } from "../lib/chat-policy";

export type CriteriaVersion = {
  revision: number;
  digest: string;
  criteriaText: string;
  definition: string;
  good: string[];
  bad: string[];
  exclusions: string[];
  intakeForm?: IntakeForm;
  deferred: string[];
  createdAt: string;
  endedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  status: "Approved" | "Draft" | "Superseded";
};
const lines = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const optionalText = (value: unknown) => typeof value === "string" && value ? value : undefined;

export function mapCriteriaVersions(rows: Record<string, unknown>[]): CriteriaVersion[] {
  const sorted = [...rows].sort((a, b) => Number(a.revision) - Number(b.revision));
  return sorted.map((row, index) => {
    const intakeForm = row.intake_form && typeof row.intake_form === "object" ? normalizeIntake(row.intake_form) : undefined;
    const endedAt = optionalText(row.superseded_at) ?? optionalText(sorted[index + 1]?.created_at);
    return {
      revision: Number(row.revision), digest: String(row.digest ?? ""),
      criteriaText: String(row.criteria_text ?? ""), definition: String(row.business_definition ?? ""),
      good: lines(row.good_fit_examples), bad: lines(row.bad_fit_examples), exclusions: lines(row.core_business_exclusions),
      intakeForm, deferred: intakeForm ? intakeToCriteria(intakeForm).deferred : draftCriteria(String(row.criteria_text ?? "")).ignored,
      createdAt: String(row.created_at ?? ""), endedAt,
      approvedAt: optionalText(row.approved_at), approvedBy: optionalText(row.approved_by),
      status: endedAt ? "Superseded" : row.approved === true ? "Approved" : "Draft",
    };
  });
}

export const intakeFieldLabels: Record<keyof IntakeForm, string> = {
  submitterName: "Submitter name", dueDate: "Due date", seniorClientExecs: "Senior client exec(s)",
  sameAsSubmitter: "Same as submitter", requestType: "Request type", industry: "Industry", sector: "Sector",
  subSector: "Sub-sector", investmentThesis: "Investment thesis", productsServices: "Relevant products/services",
  endMarkets: "Focus end-markets", sizeParameters: "Size parameters", ownershipPreference: "Ownership preference",
  geographyFocus: "Geography focus", sourceFileId: "Source file ID", sourceFileName: "Source file", extracted: "Extracted",
};
