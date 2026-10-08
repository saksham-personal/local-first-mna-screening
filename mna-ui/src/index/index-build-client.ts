import { callTool } from "../lib/tool-client";

export type StepStatus = "pending" | "running" | "done" | "skipped" | "failed";
export type BuildStep = {
  id: string; label: string; status: StepStatus; rows_done: number; rows_total: number | null;
  started_at: string | null; finished_at: string | null; rate_per_sec: number | null;
  eta_seconds: number | null; detail: string | null;
};
export type IndexBuild = {
  build_id: string; bundle_id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  current_step: string | null; steps: BuildStep[]; rows_total: number | null; rows_done: number;
  activate_on_success: boolean; cancel_requested: boolean;
  log: { at: string; level: string; message: string }[];
  started_at: string; updated_at: string; finished_at: string | null; error: string | null;
  bundle: { name: string; source_file: string; status: string; row_count: number; semantic_status: string };
};
export type MidBundle = {
  bundle_id: string; name: string; status: string; row_count: number;
  created_at: string; activated_at: string | null; semantic_status: string;
};
export type IndexStatus = {
  active: (Omit<MidBundle, "status" | "created_at"> & { semantic_model: string | null; config_hash: string; fts_id: number }) | null;
  running_build: IndexBuild | null;
  config: {
    search_columns: string[]; description_columns: string[]; display_columns: string[];
    column_types: Record<string, "text" | "number" | "date" | "category">;
    coverage_columns: string[]; identifier_columns: Record<string, string[]>;
    workbook_columns: string[];
  };
};
async function read<T>(tool: string, args = {}): Promise<T> {
  return await callTool(tool, args) as unknown as T;
}
async function admin<T>(tool: string, args: Record<string, unknown>): Promise<T> {
  return await callTool(tool, args, { analystApproved: true }) as unknown as T;
}
export const getMidIndexStatus = () => read<IndexStatus>("get_mid_index_status");
export const getIndexBuild = (build_id: string) => read<IndexBuild>("get_index_build", { build_id });
export const listIndexBuilds = (limit = 20) => read<{ builds: IndexBuild[]; bundles: MidBundle[] }>("list_index_builds", { limit });
export const startIndexBuild = (file: string, name: string, activate_on_success: boolean) => admin<{ build_id: string; bundle_id: string; status: string }>("start_index_build", { file, name, activate_on_success });
export const cancelIndexBuild = (build_id: string) => admin<IndexBuild>("cancel_index_build", { build_id });
export const activateMidBundle = (bundle_id: string) => admin<{ bundle_id: string; status: string }>("activate_mid_bundle", { bundle_id });
export const deleteMidBundle = (bundle_id: string) => admin<{ bundle_id: string; deleted: boolean }>("delete_mid_bundle", { bundle_id });

export function uploadIndexWorkbook(file: File, onProgress: (bytes: number, total: number) => void) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ id: string; name: string; bytes: number }>((resolve, reject) => {
    xhr.open("PUT", `/api/index-files?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = event => onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(xhr.responseText || "Workbook upload failed.")); return; }
      try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("The upload returned an unreadable result.")); }
    };
    xhr.onerror = () => reject(new Error("Workbook upload failed. Check the local connection."));
    xhr.onabort = () => reject(new DOMException("Upload cancelled.", "AbortError"));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
