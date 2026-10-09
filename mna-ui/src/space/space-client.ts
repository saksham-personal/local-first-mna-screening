import { callTool } from "../lib/tool-client";
import { searchRequest, type SpaceResult, type SpaceSearch } from "./space-model";
export type { SpaceResult, SpaceRow } from "./space-model";
export type RecentSearch = { query_id: string; source: string; query: string; parameters: Record<string, unknown>; created_at: string };
export type SyncStatus = { meili: string; task_status: string; documents: number; bundle_id: string };
export async function fetchSpace(search: SpaceSearch, offset: number, limit: number, signal: AbortSignal): Promise<SpaceResult> {
  const request = searchRequest(search, offset, limit);
  return await callTool(request.tool, request.args, { signal }) as unknown as SpaceResult;
}
export async function recentSpace(signal?: AbortSignal): Promise<RecentSearch[]> {
  const result = await callTool("space_recent", { limit: 20 }, { signal });
  return result.queries as RecentSearch[];
}
export async function exportSpace(search: SpaceSearch, allowSimulated: boolean) {
  const { args } = searchRequest(search, 0, 100);
  return await callTool("space_export", { search: args, format: "xlsx", allow_simulated: allowSimulated }) as unknown as { file: string; rows: number };
}
export async function addToScreening(run_id: string, company_ids: string[], query_id?: string) {
  return await callTool("space_add_to_run", { run_id, company_ids, ...(query_id ? { query_id } : {}) }, { analystApproved: true }) as unknown as { added: number };
}
