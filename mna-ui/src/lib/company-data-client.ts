import type { Company } from "./contracts";
import type { ScreeningSourceRow } from "./screening-contract";
import { callTool, type ToolResult } from "./tool-client";
import { getChatState, mirrorWorkspace, updateChatState } from "./chat-store";
import { sessionStore } from "./session-store";
import { projectIdentity, usableText } from "./screening-data";

export async function readCompanySources(sessionId: string, runId: string): Promise<ScreeningSourceRow[]> {
  const rows: ScreeningSourceRow[] = [];
  let cursor: string | undefined;
  let size = 100;
  let total: number | undefined;
  do {
    const args: ToolResult = { run_id: runId, include_hidden: true, limit: size, ...(cursor ? { after_company_id: cursor } : {}) };
    const receipt = sessionStore.startTool("get_candidate_source_data", args, { sessionId, title: "Read company sources" });
    let page: ToolResult;
    try {
      page = await callTool("get_candidate_source_data", args);
      sessionStore.finishTool(receipt, { rows_returned: (page.rows as unknown[])?.length, total: page.total, next_cursor: page.next_cursor });
    } catch (error) {
      sessionStore.finishTool(receipt, null, "error", String(error));
      if (size > 1 && /too large|exceeds|2 MB/i.test(String(error))) { size = Math.max(1, Math.floor(size / 2)); continue; }
      throw error;
    }
    if (!Array.isArray(page.rows) || typeof page.total !== "number") throw new Error("Company sources returned an invalid page.");
    if (total !== undefined && total !== page.total) throw new Error("The company list changed. Open the data again.");
    total = page.total;
    rows.push(...page.rows as ScreeningSourceRow[]);
    const next = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
    if (next && (next === cursor || !page.rows.length)) throw new Error("Company source paging did not advance.");
    cursor = next;
  } while (cursor);
  if (rows.length !== total) throw new Error("The company list changed while reading data. Try again.");
  return rows;
}

function refreshCompany(company: Company, row: ScreeningSourceRow): Company {
  const identity = projectIdentity(row), pb = row.sources.PB;
  const textRecord = (source: Record<string, unknown>) => Object.fromEntries(Object.entries(source).map(([key, value]) => [key, usableText(value)]));
  return { ...company, name: identity.name, website: identity.website, description: identity.description,
    rawMid: Object.keys(row.sources.MID).length ? textRecord(row.sources.MID) : undefined,
    rawIscc: Object.keys(row.sources.ISCC).length ? textRecord(row.sources.ISCC) : undefined,
    pbId: usableText(row.PBId) || undefined, pbWebsite: usableText(pb.PB_Website ?? pb.Website) || undefined,
    linkedin: usableText(pb["PB_LinkedIn URL"] ?? pb["LinkedIn URL"]) || undefined,
    enrichment: { ...company.enrichment, ...pb, ROGO: row.sources.ROGO, RESULTS: row.sources.RESULTS ?? {}, BING: row.sources.BING ?? {} } };
}

export async function refreshCompanyContext(sessionId: string, runId: string): Promise<ScreeningSourceRow[]> {
  const rows = await readCompanySources(sessionId, runId);
  const latest = getChatState(sessionId);
  if (latest.backendRunId !== runId) return rows;
  const byId = new Map(rows.map(row => [row.pk, row]));
  const next = updateChatState(sessionId, { companies: latest.companies.map(company => byId.has(company.pk) ? refreshCompany(company, byId.get(company.pk)!) : company) });
  mirrorWorkspace(next);
  return rows;
}

export function companyDataRows(rows: ScreeningSourceRow[]): Record<string, unknown>[] {
  return rows.map((row, index) => {
    const identity = projectIdentity(row);
    return { index: index + 1, pk: row.pk, PBId: row.PBId, "Company Name": identity.name, Website: identity.website, Description: identity.description,
      ...Object.fromEntries(Object.entries(row.sources).flatMap(([source, fields]) => Object.entries(fields).map(([key, value]) => [`${source}: ${key}`, value]))) };
  });
}
