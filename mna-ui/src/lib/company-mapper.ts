import type { Company } from "./contracts";
import type { JobSnapshot } from "./chat-contract";
import { callTool, companyFromRust, type SearchRow, type ToolResult } from "./tool-client";

type Entry = NonNullable<JobSnapshot["result"]>["companies"][number];
export function companyFromEntry({ row, detail, sourceRows }: Entry, original?: Company): Company {
  const company = companyFromRust(row as SearchRow, detail, original);
  const source = sourceRows.find(row => row.source === "MID");
  if (source?.row && typeof source.row === "object") company.rawMid = source.row as Record<string, string | number>;
  return company;
}

/** Match server/jobs.mjs companyEntryFromGridRow, including the original MID row. */
export function companyFromGridRow(candidate: ToolResult): Company {
  const payload = candidate.company_payload as ToolResult | undefined;
  if (!payload || typeof candidate.company_id !== "string" || typeof candidate.considered !== "boolean")
    throw new Error("The company grid is missing its company payload.");
  const pb = (candidate.pb ?? {}) as ToolResult;
  const detail: ToolResult = {
    company_id: candidate.company_id, name: typeof payload.name === "string" ? payload.name : candidate.name,
    website: payload.website ?? null, description: payload.description ?? null,
    city: candidate.hq_city, metadata: { hq_state: candidate.hq_state },
    identifiers: Array.isArray(payload.identifiers) ? payload.identifiers : [],
    keywords: Array.isArray(payload.keywords) ? payload.keywords : [],
    PB_Website: pb.website ?? null, PB_Name: pb.name ?? null, PB_Description: pb.description ?? null,
    "PB_LinkedIn URL": pb.linkedin_url ?? null, "PB_HQ Location": pb.hq_location ?? null,
    "PB_Active Investors": pb.active_investors ?? null, PB_Universe: pb.universe ?? null,
    ...(payload.has_enrichment === true ? { ROGO: payload.rogo ?? {} } : {}),
  };
  return companyFromEntry({
    row: { company: { company_id: candidate.company_id }, considered: candidate.considered,
      ...(typeof candidate.mid_score === "number" ? { score: candidate.mid_score } : {}) } as SearchRow,
    detail, sourceRows: payload.mid_source_row ? [{ source: "MID", row: payload.mid_source_row }] : [],
  });
}

export async function readRunCompanies(runId: string): Promise<Company[]> {
  const companies: Company[] = [];
  let cursor: string | undefined, signature: string | undefined, total: number | undefined;
  let limit = 2000;
  do {
    let page: ToolResult;
    try {
      page = await callTool("get_screening_grid", { run_id: runId, include_hidden: true, include_company_payload: true, limit, ...(cursor ? { after_company_id: cursor } : {}) });
    } catch (error) {
      if (limit > 1 && /too large|exceeds|2 MB/i.test(String(error))) { limit = Math.max(1, Math.floor(limit / 2)); continue; }
      throw error;
    }
    if (!Array.isArray(page.rows) || !Number.isSafeInteger(page.total)) throw new Error("The company grid returned an invalid page.");
    const revision = JSON.stringify([page.total, page.considered_count, page.source_hash, page.selection_revision, page.criteria_revision]);
    if (signature !== undefined && signature !== revision) throw new Error("The company list changed while loading. Try again.");
    signature = revision; total = Number(page.total);
    for (const row of page.rows as ToolResult[]) {
      const last = companies.at(-1)?.pk;
      if (typeof row.company_id !== "string" || (last && row.company_id <= last)) throw new Error("Company grid paging did not advance.");
      companies.push(companyFromGridRow(row));
    }
    const next = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
    if (next && (!page.rows.length || next !== companies.at(-1)?.pk || next === cursor)) throw new Error("Company grid paging did not advance.");
    cursor = next;
  } while (cursor);
  if (companies.length !== total) throw new Error("The company list changed while loading. Try again.");
  return companies;
}
