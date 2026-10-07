import { refreshCompanyContext } from "./company-data-client";
import { getChatState } from "./chat-store";
import { refreshShortlist } from "./review-client";
import { sessionStore } from "./session-store";
import { callTool, type ToolResult } from "./tool-client";

export const OPEN_WORKSPACE_EVENT = "screening:open-workspace";
export const ASK_ASSISTANT_EVENT = "screening:ask-assistant";

export type GridSource = "MID" | "ISCC" | "both";

export type GridCompany = {
  company_id: string;
  name: string;
  website: string | null;
  hq_city: string | null;
  hq_state: string | null;
  description: string | null;
  source: GridSource | null;
  considered: boolean;
  consideration_reason: string | null;
  pbid: string | null;
  mid_score: number | null;
  iscc_score: number | null;
  coverage: { pb: boolean; rogo: boolean; bing: boolean };
  pb: {
    name: string | null;
    website: string | null;
    description: string | null;
    hq_location: string | null;
    active_investors: string | null;
    universe: string | null;
    linkedin_url: string | null;
  };
  discovery_count: number;
};

export type CompanyDetail = {
  run_id: string;
  company_id: string;
  company: Record<string, unknown>;
  identifiers: { kind: string; identifier: string; first_seen_at: string }[];
  pbid: string | null;
  considered: boolean;
  consideration_reason: string | null;
  sources: Record<string, {
    fields: Record<string, unknown>;
    lineage: unknown;
    updated_at: string | null;
  }>;
  descriptions: { label: string; text: string }[];
  activity: { kind: string; at: string; summary: string }[];
};

export type ScreeningGrid = {
  rows: GridCompany[];
  total: number;
  consideredCount: number;
  hiddenCount: number;
  selectionRevision: number;
};

async function traced(
  sessionId: string,
  tool: string,
  args: ToolResult,
  analystApproved = false,
) {
  const receipt = sessionStore.startTool(tool, args, {
    sessionId,
    origin: "workspace",
    title: tool.replaceAll("_", " "),
  });
  try {
    const result = await callTool(tool, args, { analystApproved });
    sessionStore.finishTool(receipt, result);
    return result;
  } catch (error) {
    sessionStore.finishTool(receipt, null, "error", String(error));
    throw error;
  }
}

function asCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The company grid returned an invalid ${label}.`);
  }
  return value;
}

function asGridCompany(value: unknown): GridCompany {
  if (!value || typeof value !== "object") {
    throw new Error("The company grid returned an unreadable row.");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.company_id !== "string" || typeof row.name !== "string" || typeof row.considered !== "boolean") {
    throw new Error("The company grid is missing a company ID, name, or status.");
  }
  const coverage = row.coverage as Record<string, unknown> | undefined;
  const pb = row.pb as Record<string, unknown> | undefined;
  if (!coverage || !pb || ["pb", "rogo", "bing"].some((key) => typeof coverage[key] !== "boolean")) {
    throw new Error("The company grid is missing source coverage or PitchBook fields.");
  }
  const nullableString = (key: string) => typeof row[key] === "string" ? row[key] as string : null;
  const nullableNumber = (key: string) => typeof row[key] === "number" && Number.isFinite(row[key]) ? row[key] as number : null;
  const nullablePbString = (key: string) => typeof pb[key] === "string" ? pb[key] as string : null;
  const source = row.source === "MID" || row.source === "ISCC" || row.source === "both" ? row.source : null;
  return {
    company_id: row.company_id,
    name: row.name,
    website: nullableString("website"),
    hq_city: nullableString("hq_city"),
    hq_state: nullableString("hq_state"),
    description: nullableString("description"),
    source,
    considered: row.considered,
    consideration_reason: nullableString("consideration_reason"),
    pbid: nullableString("pbid"),
    mid_score: nullableNumber("mid_score"),
    iscc_score: nullableNumber("iscc_score"),
    coverage: { pb: coverage.pb as boolean, rogo: coverage.rogo as boolean, bing: coverage.bing as boolean },
    pb: {
      name: nullablePbString("name"),
      website: nullablePbString("website"),
      description: nullablePbString("description"),
      hq_location: nullablePbString("hq_location"),
      active_investors: nullablePbString("active_investors"),
      universe: nullablePbString("universe"),
      linkedin_url: nullablePbString("linkedin_url"),
    },
    discovery_count: asCount(row.discovery_count, "discovery count"),
  };
}

export async function fetchScreeningGrid(sessionId: string, runId: string): Promise<ScreeningGrid> {
  const rows: GridCompany[] = [];
  let cursor: string | undefined;
  let total: number | undefined;
  let consideredCount: number | undefined;
  let hiddenCount: number | undefined;
  let selectionRevision: number | undefined;
  let sourceHash: unknown;

  do {
    const page = await traced(sessionId, "get_screening_grid", {
      run_id: runId,
      include_hidden: true,
      limit: 2000,
      ...(cursor ? { after_company_id: cursor } : {}),
    });
    if (!Array.isArray(page.rows)) throw new Error("The company grid could not be read.");
    const pageTotal = asCount(page.total, "total count");
    const pageConsidered = asCount(page.considered_count, "considered count");
    const pageHidden = asCount(page.hidden_count, "hidden count");
    const pageRevision = asCount(page.selection_revision, "selection revision");
    if (typeof page.source_hash !== "string") throw new Error("The company grid is missing its source revision.");
    if (total !== undefined && (total !== pageTotal || consideredCount !== pageConsidered || hiddenCount !== pageHidden || selectionRevision !== pageRevision || sourceHash !== page.source_hash)) {
      throw new Error("The company list changed while it was being read. Please open it again.");
    }
    total = pageTotal;
    consideredCount = pageConsidered;
    hiddenCount = pageHidden;
    selectionRevision = pageRevision;
    sourceHash = page.source_hash;
    rows.push(...page.rows.map(asGridCompany));

    const next = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
    if (next && (next === cursor || page.rows.length === 0)) {
      throw new Error("Company grid paging did not advance.");
    }
    cursor = next;
  } while (cursor);

  if (rows.length !== total) throw new Error("The company list changed while it was being read. Please open it again.");
  return {
    rows,
    total: total ?? 0,
    consideredCount: consideredCount ?? 0,
    hiddenCount: hiddenCount ?? 0,
    selectionRevision: selectionRevision ?? 0,
  };
}

export async function fetchCompanyDetail(
  sessionId: string,
  runId: string,
  companyId: string,
): Promise<CompanyDetail> {
  const result = await traced(sessionId, "get_company_detail", {
    run_id: runId,
    company_id: companyId,
  });
  if (typeof result.company_id !== "string" || !result.company || typeof result.company !== "object") {
    throw new Error("Company details could not be read.");
  }
  return result as CompanyDetail;
}

export function hideIds(allRows: GridCompany[], selectedIds: string[]): string[] {
  const selected = new Set(selectedIds);
  return allRows.filter((row) => row.considered && !selected.has(row.company_id)).map((row) => row.company_id);
}

export function keepOnlyIds(allRows: GridCompany[], selectedIds: string[]): string[] {
  const available = new Set(allRows.map((row) => row.company_id));
  return [...new Set(selectedIds)].filter((id) => available.has(id));
}

export function restoreIds(allRows: GridCompany[], selectedIds: string[]): string[] {
  const keep = new Set(allRows.filter((row) => row.considered).map((row) => row.company_id));
  const available = new Set(allRows.map((row) => row.company_id));
  for (const id of selectedIds) {
    if (available.has(id)) keep.add(id);
  }
  return [...keep];
}

export function hiddenReasonLabel(reason: string | null | undefined): string {
  const normalized = reason?.trim().toLowerCase().replaceAll("-", "_") ?? "";
  if (normalized === "manual" || normalized === "analyst") return "Manual";
  if (normalized === "pitchbook_unmatched") return "No PitchBook match";
  if (normalized.startsWith("profile") || normalized.startsWith("pitchbook_")) return "PitchBook profile";
  if (normalized.includes("score") && normalized.includes("review")) return "Score review";
  return "Hidden";
}

export async function applyGridReview(
  sessionId: string,
  runId: string,
  keepCompanyIds: string[],
  expectedSelectionRevision: number,
  reason: string,
) {
  const state = getChatState(sessionId);
  if (state.backendRunId !== runId) throw new Error("The active screening changed. Refresh the company list and try again.");
  await traced(sessionId, "review_shortlist", {
    run_id: runId,
    keep_company_ids: keepCompanyIds,
    review_columns: state.selectedResults ?? {},
    expected_selection_revision: expectedSelectionRevision,
    reason,
  }, true);
  await refreshShortlist(sessionId, runId);
  await refreshCompanyContext(sessionId, runId);
}
