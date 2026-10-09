export type ScreeningProvider = "llm_suite" | "copilot";
export type ScreeningModel = { id: string; label: string };
export type ScreeningModels = Record<ScreeningProvider, ScreeningModel[]>;
export async function loadScreeningModels(): Promise<ScreeningModels> {
  const response = await fetch("/api/screening/models");
  const models = await response.json();
  if (!response.ok) throw new Error(models.error ?? "Could not load models.");
  for (const provider of ["llm_suite", "copilot"] as const) {
    if (!Array.isArray(models[provider]) || !models[provider].length || models[provider].some((model: ScreeningModel) =>
      typeof model.id !== "string" || !model.id.trim() || model.id.length > 160 || typeof model.label !== "string" || !model.label.trim()) ||
      new Set(models[provider].map((model: ScreeningModel) => model.id)).size !== models[provider].length)
      throw new Error("The model list is invalid. Check server/llm-models.json.");
  }
  return models;
}
export function selectedModel(models: ScreeningModel[], current = "") { return models.find(model => model.id === current)?.id ?? models[0]?.id ?? ""; }
// Keep in step with shared/screening.mjs (validateConfig enforces batchLimit, defaultScreeningConfig uses
// defaultBatchSize). The numbers are duplicated because the shared module has no declared exports for them;
// tests/setup-batch-limit.test.ts checks that both sides agree.
export function batchLimit(provider: ScreeningProvider) { return provider === "copilot" ? 50 : 200; }
export function defaultBatchSize(provider: ScreeningProvider) { return provider === "copilot" ? 10 : 25; }
export function syncBatchSize(provider: ScreeningProvider, value: number | string) { return Math.max(1, Math.min(batchLimit(provider), Math.round(Number(value) || 1))); }
export function batchWarning(provider: ScreeningProvider, size: number) { return provider === "copilot" && size > 20 ? "Large M365 batches can lose web context; 10–20 is recommended." : ""; }
export type ScreeningSourceRow = {
  pk: string;
  PBId: string | null;
  sources: Record<Exclude<DataSource, "RESULTS" | "BING">, Record<string, unknown>> & Partial<Record<"RESULTS" | "BING", Record<string, unknown>>>;
  provenance: Record<string, unknown>;
};
export type ScreeningMode = "screening" | "question";
export type DataSource = "MID" | "ISCC" | "PB" | "ROGO" | "RESULTS" | "BING";
export type IdentitySources = {
  name: DataSource[];
  website: DataSource[];
  description: DataSource[];
};
export type ScreeningConfig = {
  provider: ScreeningProvider;
  mode: ScreeningMode;
  model: string;
  batchSize: number;
  prompt: string;
  /** The analyst's own request, kept apart from the generated prompt text. */
  request?: string;
  inputColumns: string[];
  outputColumns: string[];
  identitySources: IdentitySources;
};
export type ScreeningCatalog = {
  total: number;
  sources: {
    source: DataSource;
    label: string;
    hydrated: boolean;
    companyCount: number;
    fields: { id: string; label: string; count: number; example: string }[];
  }[];
};
export type ScreeningPreview = {
  columns: string[];
  rows: Record<string, string | number>[];
  prompt: string;
  outputColumns: string[];
  companyCount: number;
  batches: number;
  estimatedMinimumMinutes: number;
  fingerprint: string;
  warnings: string[];
};
export type PreparedScreening = {
  id: string;
  planId?: string;
  schemaVersion?: number;
  title: string;
  provider: ScreeningProvider;
  mode: ScreeningMode;
  model: string;
  companyCount: number;
  batches: number;
  status: "prepared";
  executed: false;
  config: ScreeningConfig;
  fingerprint: string;
  savedAt: string;
  checkpoint?: { runId: string; namespace: string; sequence: number };
  jobs?: { job_id: string; ordinal: number; state: string; input_hash: string }[];
};
