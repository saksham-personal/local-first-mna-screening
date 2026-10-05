export type ScreeningProvider = "llm_suite" | "copilot";
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
