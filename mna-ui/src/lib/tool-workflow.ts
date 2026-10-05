import type { AssistantContext, WorkspaceAction } from "./assistant-contract";
import { discoveryDefinition, discoveryQueries } from './discovery-query.mjs';
export { qualitativeQuery } from './discovery-query.mjs';
import {
  callTool,
  companyFromRust,
  searchRows,
  type ToolResult,
  type SearchRow,
} from "./tool-client";

export type WorkflowEvent =
  | { type: "start"; id: string; tool: string; args: ToolResult }
  | { type: "result"; id: string; result: ToolResult }
  | {
      type: "complete";
      action: Extract<WorkspaceAction, { type: "example-results" }>;
      message: string;
    };

/** Real Rust calls over a local bridge. The dataset is fictional; the results are not simulated. */
export async function* runScreeningExample(
  initial: AssistantContext,
  options: {
    signal: AbortSignal;
    current: () => AssistantContext;
    call?: typeof callTool;
    broader?: boolean;
  },
): AsyncGenerator<WorkflowEvent, void, void> {
  const call = options.call ?? callTool;
  const business = discoveryDefinition(initial.definition);
  const guard = () => {
    const current = options.current();
    if (
      options.signal.aborted ||
      current.sessionId !== initial.sessionId ||
      !current.criteriaApproved ||
      current.definition !== initial.definition ||
      current.mandate !== initial.mandate
    )
      throw new DOMException(
        "Screening stopped because the criteria or session changed.",
        "AbortError",
      );
  };
  async function* step(
    tool: string,
    args: ToolResult,
    analystApproved = false,
  ): AsyncGenerator<WorkflowEvent, ToolResult, void> {
    guard();
    const id = crypto.randomUUID();
    yield { type: "start", id, tool, args };
    guard();
    const result = await call(tool, args, {
      signal: options.signal,
      analystApproved,
    });
    yield { type: "result", id, result };
    guard();
    return result;
  }
  let runId = options.broader ? initial.backendRunId : undefined;
  if (!runId) {
    const created = yield* step(
      "create_run",
      {
        objective: initial.title,
        original_criteria: { text: initial.mandate },
        initial_profile: {
          business_definition: initial.definition,
          core_business_query: business.positive,
          core_business_criteria: [business.positive],
          core_business_exclusions: business.exclusions,
          search_policy: "qualitative core business only",
          unused_search_dimensions: [
            "financial / size",
            "geography",
            "ownership",
            "industry codes",
          ],
        },
      },
      true,
    );
    if (typeof created.run_id !== "string")
      throw new Error("The local server did not return a screening ID.");
    runId = created.run_id;
    yield* step("import_company_files", {
      files: ["example-mid.csv"],
      source: "MID",
    });
    yield* step(
      "approve_screening_profile",
      {
        run_id: runId,
        version: 1,
        approved_by: "Analyst approval in Screening UI",
      },
      true,
    );
  }
  const profile = yield* step("get_active_screening_profile", { run_id: runId });
  const content = profile.content && typeof profile.content === 'object' ? profile.content as ToolResult : {};
  const exclusions = Array.isArray(content.core_business_exclusions)
    ? content.core_business_exclusions.filter((value: unknown) => typeof value === 'string') : [];
  const matches = new Map<string, SearchRow>();
  for (const query of discoveryQueries(initial.definition)) {
    const found = yield* step("search_mid", {
      run_id: runId,
      query,
      mode: "lexical",
      limit: 1000,
      prefer_meilisearch: false,
      ...(exclusions.length ? { filters: { exclude_keywords: exclusions } } : {}),
    });
    const rows = searchRows(found);
    for (const row of rows)
      if (!matches.has(String(row.company.company_id)))
        matches.set(String(row.company.company_id), row);
    if (rows.length)
      yield* step("add_candidates", {
        run_id: runId,
        companies: rows.map((row) => ({
          company_id: row.company.company_id,
          rank: row.rank,
          retrieval_score: row.score,
        })),
        discovery_source: "MID",
        query_id: found.query_id,
      });
  }
  // A broader pass includes the existing set; it never replaces it with only new hits.
  if (options.broader) {
    const prior = yield* step("get_candidate_set", { run_id: runId });
    if (Array.isArray(prior.candidates))
      for (const candidate of prior.candidates) {
        const id = candidate.company_id ?? candidate.company?.company_id;
        const history = Array.isArray(candidate.discovery)
          ? candidate.discovery.find(
              (item: ToolResult) =>
                item.source === "MID" &&
                typeof item.retrieval_score === "number",
            )
          : undefined;
        if (typeof id === "string" && !matches.has(id))
          matches.set(id, {
            company: { company_id: id },
            score:
              history?.retrieval_score ??
              initial.companies?.find((company) => company.pk === id)?.midScore,
          });
      }
  }
  const companies = [];
  for (const [id, row] of matches) {
    const detail = yield* step("get_company", { company_id: id });
    const company = companyFromRust(row, detail);
    const sources = yield* step("get_source_rows", {
      company_id: id,
      source: "MID",
      limit: 1,
    });
    const original = Array.isArray(sources.rows)
      ? sources.rows[0]?.row
      : undefined;
    if (original && typeof original === "object") company.rawMid = original;
    companies.push(company);
  }
  if (companies[0])
    yield* step("get_company_context", {
      run_id: runId,
      company_id: companies[0].pk,
      sections: ["core", "description", "identifiers", "enrichment"],
      max_chars: 12000,
    });
  const summary = yield* step("get_discovery_summary", { run_id: runId });
  const count = (name: string) => {
    const value = summary[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error("The source count could not be read.");
    return value;
  };
  const counts = {
    midOnly: count("mid_only"),
    isccOnly: count("iscc_only"),
    both: count("both"),
  };
  if (count("total_unique") !== companies.length)
    throw new Error(
      "The displayed companies do not match the saved set. Open the session log to inspect the results.",
    );
  yield* step("save_checkpoint", {
    run_id: runId,
    namespace: "screening-ui",
    state: {
      company_ids: companies.map((c) => c.pk),
      counts,
      step: "company-list-ready",
    },
  });
  guard();
  yield {
    type: "complete",
    action: { type: "example-results", backendRunId: runId, companies, counts },
    message: `Found ${companies.length} unique companies using the local tools. ${counts.midOnly} are from MID, ${counts.isccOnly} from ISCC, and ${counts.both} from both.\n\nThis example uses fictional MID records. ISCC is not connected, so it was not searched. The tool calls, saved companies, and checkpoint are real. You can add data next or ask for another search.`,
  };
}
