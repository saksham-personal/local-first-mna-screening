import { refreshCompanyContext } from "./company-data-client";
import { getChatState } from "./chat-store";
import { refreshShortlist } from "./review-client";
import { sessionStore } from "./session-store";
import { callTool, type ToolResult } from "./tool-client";

export const OPEN_WORKSPACE_EVENT = "screening:open-workspace";
export const ASK_ASSISTANT_EVENT = "screening:ask-assistant";

export type GridSource = "MID" | "ISCC" | "both";

export type MidKeyword = {
  best_match_pct: number | null;
  hit_count: number;
  matched: { id: unknown; text: string }[];
  queries: { query_id: string; rationale: string; display_query: string; match_pct: number | null }[];
};
export type RoundColumns = {
  key: string;
  round_no: number;
  provider: string;
  provider_label: string;
  score_columns: string[];
  output_columns: string[];
};
export type CompanyRound = {
  provider: string;
  provider_label: string;
  score_columns: string[];
  values: Record<string, unknown>;
  scores: Record<string, number | "CHECK" | null>;
};
export type ScreeningRound = Omit<RoundColumns, "key"> & {
  plan_id: string;
  created_at: string;
  jobs: { total: number; ready: number; running: number; done: number; failed: number; other: number };
  assessed_companies: number;
  score_distribution: Record<string, Record<string, number>>;
  simulated: boolean;
};

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
  mid_keyword: MidKeyword | null;
  mid_semantic_score: number | null;
  iscc_relevancy: number | null;
  simulated: boolean;
  rounds: Record<string, CompanyRound>;
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
  mid_keyword: MidKeyword | null;
  mid_semantic: { score: number | null } | null;
  iscc: { relevancy: number | null } | null;
  rounds: Record<string, CompanyRound>;
  simulated: boolean;
};

export type ScreeningGrid = {
  rows: GridCompany[];
  total: number;
  consideredCount: number;
  hiddenCount: number;
  selectionRevision: number;
  rounds: RoundColumns[];
  has_mid_keyword: boolean;
  has_semantic: boolean;
  has_iscc: boolean;
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

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function scoreNumber(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function keyword(value: unknown): MidKeyword | null {
  if (value == null) return null;
  const data = object(value);
  return {
    best_match_pct: scoreNumber(data.best_match_pct, 100),
    hit_count: asCount(data.hit_count, "keyword hit count"),
    matched: (Array.isArray(data.matched) ? data.matched : []).map(object).filter((item) => typeof item.text === "string").map((item) => ({ id: item.id, text: item.text as string })),
    queries: (Array.isArray(data.queries) ? data.queries : []).map(object).map((item) => ({
      query_id: String(item.query_id ?? ""), rationale: String(item.rationale ?? ""),
      display_query: String(item.display_query ?? ""), match_pct: scoreNumber(item.match_pct, 100),
    })),
  };
}
function companyRounds(value: unknown): Record<string, CompanyRound> {
  return Object.fromEntries(Object.entries(object(value)).map(([key, raw]) => {
    const data = object(raw);
    return [key, {
      provider: String(data.provider ?? ""), provider_label: String(data.provider_label ?? ""),
      score_columns: strings(data.score_columns), values: object(data.values),
      scores: Object.fromEntries(Object.entries(object(data.scores)).map(([column, score]) => [column, score === "CHECK" ? "CHECK" : scoreNumber(score, 10)])),
    }];
  }));
}
function roundColumns(value: unknown): RoundColumns[] {
  if (!Array.isArray(value)) return [];
  return value.map(object).map((data) => ({
    key: String(data.key ?? `R${data.round_no}`), round_no: asCount(data.round_no, "round number"),
    provider: String(data.provider ?? ""), provider_label: String(data.provider_label ?? ""),
    score_columns: strings(data.score_columns), output_columns: strings(data.output_columns),
  }));
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
    mid_keyword: keyword(row.mid_keyword),
    mid_semantic_score: scoreNumber(row.mid_semantic_score, 10),
    iscc_relevancy: scoreNumber(row.iscc_relevancy, 1),
    simulated: row.simulated === true,
    rounds: companyRounds(row.rounds),
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
  let rounds: RoundColumns[] = [];
  let flags = { has_mid_keyword: false, has_semantic: false, has_iscc: false };

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
    const pageRounds = roundColumns(page.rounds);
    const pageFlags = { has_mid_keyword: page.has_mid_keyword === true, has_semantic: page.has_semantic === true, has_iscc: page.has_iscc === true };
    if (typeof page.source_hash !== "string") throw new Error("The company grid is missing its source revision.");
    if (total !== undefined && (total !== pageTotal || consideredCount !== pageConsidered || hiddenCount !== pageHidden || selectionRevision !== pageRevision || sourceHash !== page.source_hash || JSON.stringify(rounds) !== JSON.stringify(pageRounds) || JSON.stringify(flags) !== JSON.stringify(pageFlags))) {
      throw new Error("The company list changed while it was being read. Please open it again.");
    }
    total = pageTotal;
    consideredCount = pageConsidered;
    hiddenCount = pageHidden;
    selectionRevision = pageRevision;
    sourceHash = page.source_hash;
    rounds = pageRounds;
    flags = pageFlags;
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
    rounds,
    ...flags,
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
  return {
    ...result as CompanyDetail,
    mid_keyword: keyword(result.mid_keyword),
    mid_semantic: result.mid_semantic == null ? null : { score: scoreNumber(object(result.mid_semantic).score, 10) },
    iscc: result.iscc == null ? null : { relevancy: scoreNumber(object(result.iscc).relevancy, 1) },
    rounds: companyRounds(result.rounds),
    simulated: result.simulated === true,
  };
}

export async function fetchScreeningRounds(sessionId: string, runId: string): Promise<ScreeningRound[]> {
  const result = await traced(sessionId, "get_screening_rounds", { run_id: runId });
  if (!Array.isArray(result.rounds)) throw new Error("Screening rounds could not be read.");
  return result.rounds.map((raw) => {
    const data = object(raw);
    const jobs = object(data.jobs);
    const counts = Object.fromEntries(["total", "ready", "running", "done", "failed", "other"].map((key) => [key, asCount(jobs[key], "round job count")])) as ScreeningRound["jobs"];
    return {
      ...roundColumns([data])[0], plan_id: String(data.plan_id ?? ""), created_at: String(data.created_at ?? ""),
      jobs: counts, assessed_companies: asCount(data.assessed_companies, "assessed company count"),
      score_distribution: Object.fromEntries(Object.entries(object(data.score_distribution)).map(([column, distribution]) => [column, Object.fromEntries(Object.entries(object(distribution)).map(([bucket, count]) => [bucket, asCount(count, "score bucket count")]))])),
      simulated: data.simulated === true,
    };
  });
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
