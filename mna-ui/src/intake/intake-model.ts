import { INDUSTRY_SECTORS } from "./intake-options";
import {
  extractIntakeFieldsFromText as extractFields,
  type ExtractedIntakeFields,
} from "../../shared/intake-extract.mjs";

export type IntakeForm = {
  submitterName: string;
  dueDate: string;
  seniorClientExecs: string;
  sameAsSubmitter: boolean;
  requestType: string;
  industry: string;
  sector: string;
  subSector: string;
  investmentThesis: string;
  productsServices: string;
  endMarkets: string;
  sizeParameters: string[];
  ownershipPreference: string[];
  geographyFocus: string[];
  sourceFileId?: string;
  sourceFileName?: string;
  extracted?: boolean;
};

export function emptyIntake(): IntakeForm {
  return {
    submitterName: "",
    dueDate: "",
    seniorClientExecs: "",
    sameAsSubmitter: false,
    requestType: "",
    industry: "",
    sector: "",
    subSector: "",
    investmentThesis: "",
    productsServices: "",
    endMarkets: "",
    sizeParameters: [],
    ownershipPreference: [],
    geographyFocus: [],
  };
}

export function sectorsFor(industry: string): string[] {
  return INDUSTRY_SECTORS[industry] ? [...INDUSTRY_SECTORS[industry]] : [];
}

const scalarFields = [
  "submitterName",
  "dueDate",
  "seniorClientExecs",
  "requestType",
  "industry",
  "sector",
  "subSector",
  "investmentThesis",
  "productsServices",
  "endMarkets",
] as const;
const arrayFields = ["sizeParameters", "ownershipPreference", "geographyFocus"] as const;
const optionalStringFields = ["sourceFileId", "sourceFileName"] as const;

export function normalizeIntake(input: unknown): IntakeForm {
  const source = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const form = emptyIntake();
  for (const key of scalarFields) {
    const value = source[key];
    if (typeof value === "string") form[key] = value.trim();
  }
  for (const key of arrayFields) {
    const value = source[key];
    if (Array.isArray(value)) {
      form[key] = [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
    }
  }
  form.sameAsSubmitter = source.sameAsSubmitter === true;
  if (form.sameAsSubmitter) form.seniorClientExecs = form.submitterName;
  if (!sectorsFor(form.industry).includes(form.sector)) form.sector = "";
  for (const key of optionalStringFields) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) form[key] = value.trim();
  }
  if (typeof source.extracted === "boolean") form.extracted = source.extracted;
  return form;
}

const seeAbove = (value: string) => value.trim().toLocaleLowerCase() === "see above";
const nonempty = (value: string) => value.trim() !== "";

export function intakeToCriteria(formInput: IntakeForm): {
  criteriaText: string;
  definition: string;
  deferred: string[];
  metadata: Record<string, string>;
} {
  const form = normalizeIntake(formInput);
  const products = nonempty(form.productsServices) && !seeAbove(form.productsServices) ? form.productsServices : "";
  const markets = nonempty(form.endMarkets) && !seeAbove(form.endMarkets) ? form.endMarkets : "";
  const definition = [
    form.investmentThesis,
    products ? `Products/services: ${products}` : "",
    markets ? `End markets: ${markets}` : "",
  ].filter(nonempty).join("\n\n");

  const execs = form.sameAsSubmitter ? form.submitterName : form.seniorClientExecs;
  const values: [string, string][] = [
    ["Submitter name", form.submitterName],
    ["Due date", form.dueDate],
    ["Senior client exec(s)", execs],
    ["Request type", form.requestType],
    ["Industry", form.industry],
    ["Sector", form.sector],
    ["Sub-sector", form.subSector],
    ["Investment thesis", form.investmentThesis],
    ["Relevant products/services", form.productsServices],
    ["Focus on any specific end-markets", form.endMarkets],
    ["General size parameters", form.sizeParameters.join(", ")],
    ["Ownership preference", form.ownershipPreference.join(", ")],
    ["Geography focus", form.geographyFocus.join(", ")],
  ];
  const criteriaText = values.filter(([, value]) => nonempty(value)).map(([label, value]) => `${label}: ${value}`).join("\n");
  const deferred: string[] = [];
  const industryPath = [form.industry, form.sector, form.subSector].filter(nonempty);
  if (industryPath.length) deferred.push(`Industry: ${industryPath.join(" › ")}`);
  if (form.sizeParameters.length) deferred.push(`Size: ${form.sizeParameters.join(", ")}`);
  if (form.ownershipPreference.length) deferred.push(`Ownership: ${form.ownershipPreference.join(", ")}`);
  if (form.geographyFocus.length) deferred.push(`Geography: ${form.geographyFocus.join(", ")}`);
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    submitterName: form.submitterName,
    dueDate: form.dueDate,
    seniorClientExecs: execs,
    requestType: form.requestType,
  })) {
    if (nonempty(value)) metadata[key] = value;
  }
  return { criteriaText, definition, deferred, metadata };
}

export function extractIntakeFieldsFromText(text: string): {
  fields: Partial<IntakeForm>;
  matched: string[];
} {
  const result = extractFields(text);
  return { fields: result.fields as ExtractedIntakeFields as Partial<IntakeForm>, matched: result.matched };
}

export function characterCount(value: string): number {
  return value.length;
}
