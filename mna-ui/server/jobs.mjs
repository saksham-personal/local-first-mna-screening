import { randomUUID } from "node:crypto";
import { discoveryDefinition, discoveryQueries, midKeywordPlan } from '../src/lib/discovery-query.mjs';
export { qualitativeQuery } from '../src/lib/discovery-query.mjs';

const MAX_SESSION_ID = 128;
const MAX_TITLE = 500;
const MAX_CRITERIA = 120_000;
const MAX_DEFINITION = 20_000;
const MAX_RETAINED_JOBS = 200;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const INPUT_FIELDS = new Set([
  "sessionId",
  "criteriaApproved",
  "title",
  "criteriaText",
  "definition",
  "backendRunId",
]);

export class JobInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "JobInputError";
    this.status = 400;
  }
}

function requiredText(value, name, maxLength) {
  if (typeof value !== "string" || !value.trim())
    throw new JobInputError(`${name} is required.`);
  const text = value.trim();
  if (text.length > maxLength) throw new JobInputError(`${name} is too long.`);
  return text;
}

function validateInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new JobInputError("Use a JSON object to start a job.");
  const unknown = Object.keys(value).find((key) => !INPUT_FIELDS.has(key));
  if (unknown) throw new JobInputError(`Unsupported job field: ${unknown}.`);
  if (value.criteriaApproved !== true)
    throw new JobInputError(
      "Approve the current screening criteria before starting discovery.",
    );
  const sessionId = requiredText(value.sessionId, "sessionId", MAX_SESSION_ID);
  if (!SAFE_ID.test(sessionId))
    throw new JobInputError("sessionId contains unsupported characters.");
  const backendRunId =
    value.backendRunId == null || value.backendRunId === ""
      ? undefined
      : requiredText(value.backendRunId, "backendRunId", 128);
  if (backendRunId && !SAFE_ID.test(backendRunId))
    throw new JobInputError("backendRunId contains unsupported characters.");
  return {
    sessionId,
    title: requiredText(value.title, "title", MAX_TITLE),
    criteriaText: requiredText(
      value.criteriaText,
      "criteriaText",
      MAX_CRITERIA,
    ),
    definition: requiredText(value.definition, "definition", MAX_DEFINITION),
    backendRunId,
  };
}

function abortError() {
  return new DOMException("Screening job cancelled.", "AbortError");
}

function guard(signal) {
  if (signal.aborted) throw abortError();
}

function safeClone(value) {
  return structuredClone(value);
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbort(error, signal) {
  return (
    signal.aborted ||
    (error && typeof error === "object" && error.name === "AbortError")
  );
}

function activeDefinition(profile) {
  const content =
    profile &&
    typeof profile === "object" &&
    profile.content &&
    typeof profile.content === "object"
      ? profile.content
      : {};
  if (typeof content.business_definition === "string")
    return content.business_definition.trim();
  if (typeof content.core_business_query === "string")
    return content.core_business_query.trim();
  return "";
}

function searchRows(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.results))
    throw new Error("The Rust search did not return a company list.");
  return result.results.filter(
    (row) =>
      row &&
      typeof row === "object" &&
      row.company &&
      typeof row.company === "object" &&
      typeof row.company.company_id === "string",
  );
}

function candidateRow(candidate) {
  if (!candidate || typeof candidate !== "object") return undefined;
  const id =
    typeof candidate.company_id === "string"
      ? candidate.company_id
      : candidate.company && typeof candidate.company.company_id === "string"
        ? candidate.company.company_id
        : undefined;
  if (!id) return undefined;
  const observations = Array.isArray(candidate.discovery)
    ? candidate.discovery
    : [];
  const mid = observations.find(
    (item) =>
      item &&
      typeof item === "object" &&
      item.source === "MID" &&
      typeof item.retrieval_score === "number",
  );
  const company =
    candidate.company && typeof candidate.company === "object"
      ? candidate.company
      : { company_id: id };
  return {
    company,
    considered: candidate.considered !== false,
    ...(typeof mid?.retrieval_score === "number"
      ? { score: mid.retrieval_score }
      : {}),
    ...(Number.isSafeInteger(mid?.rank) ? { rank: mid.rank } : {}),
  };
}

function count(summary, key) {
  const value = summary?.[key];
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("The Rust discovery summary contains an invalid count.");
  return value;
}

export function companyEntryFromGridRow(candidate) {
  const companyId = candidate.company_id;
  const details = candidate.company_detail && typeof candidate.company_detail === "object"
    ? safeClone(candidate.company_detail)
    : {
        company_id: companyId,
        name: candidate.name,
        website: candidate.website,
        description: candidate.description,
        city: candidate.hq_city,
        metadata: { hq_state: candidate.hq_state },
        identifiers: candidate.identifiers ?? [],
        keywords: candidate.keywords ?? [],
      };
  return {
    row: {
      company: {
        company_id: companyId,
        ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
        ...(typeof candidate.website === "string" ? { website: candidate.website } : {}),
      },
      considered: candidate.considered,
      ...(typeof candidate.mid_score === "number" ? { score: candidate.mid_score } : {}),
    },
    detail: details,
    sourceRows:
      candidate.mid_source_row && typeof candidate.mid_source_row === "object"
        ? [{ source: "MID", row: safeClone(candidate.mid_source_row) }]
        : [],
  };
}

function publicJob(job) {
  const output = {
    id: job.id,
    sessionId: job.sessionId,
    state: job.state,
    startedAt: job.startedAt,
    events: job.events,
  };
  if (job.finishedAt) output.finishedAt = job.finishedAt;
  if (job.result) output.result = job.result;
  if (job.error) output.error = job.error;
  return safeClone(output);
}

/**
 * Process-local discovery scheduler. Jobs intentionally outlive HTTP requests,
 * while the Rust database remains the durable system of record for completed writes.
 */
export function createJobRegistry(options) {
  if (!options || typeof options.call !== "function")
    throw new TypeError("createJobRegistry requires a Rust call function.");
  const call = options.call;
  const seedFile = options.seedFile ?? "example-mid.csv";
  const now = options.now ?? (() => new Date().toISOString());
  const uuid = options.uuid ?? randomUUID;
  const jobs = new Map();

  async function execute(job) {
    const { input, controller } = job;
    const { signal } = controller;
    const business = discoveryDefinition(input.definition);

    async function tool(name, args, analystApproved = false) {
      guard(signal);
      const eventId = uuid();
      job.events.push({
        id: eventId,
        type: "tool-start",
        tool: name,
        args: safeClone(args),
        timestamp: now(),
      });
      let result;
      try {
        result = await call(name, args, analystApproved, signal);
      } catch (error) {
        job.events.push({
          id: eventId,
          type: "tool-error",
          tool: name,
          result: { error: errorMessage(error) },
          timestamp: now(),
        });
        throw error;
      }
      job.events.push({
        id: eventId,
        type: "tool-result",
        tool: name,
        result: safeClone(result),
        timestamp: now(),
      });
      guard(signal);
      return result;
    }

    let runId = input.backendRunId;
    if (!runId) {
      const created = await tool(
        "create_run",
        {
          objective: input.title,
          original_criteria: { text: input.criteriaText },
          initial_profile: {
            business_definition: input.definition,
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
      if (typeof created?.run_id !== "string" || !SAFE_ID.test(created.run_id))
        throw new Error("The Rust server did not return a valid screening ID.");
      runId = created.run_id;
      await tool(
        "approve_screening_profile",
        {
          run_id: runId,
          version: 1,
          approved_by: "Analyst approval in Screening UI",
        },
        true,
      );
    }

    const profile = await tool("get_active_screening_profile", {
      run_id: runId,
    });
    if (activeDefinition(profile) !== input.definition)
      throw new JobInputError(
        "This saved Rust run belongs to different approved screening criteria. Start a new run.",
      );

    const index = await tool("get_mid_index_status", {});
    const exclusions = Array.isArray(profile.content?.core_business_exclusions)
      ? profile.content.core_business_exclusions.filter(value => typeof value === 'string') : [];
    if (index.active != null) {
      for (const group of midKeywordPlan(input.definition, exclusions)) {
        await tool("search_mid", { run_id: runId, ...group, limit: 5000, add_to_run: true });
      }
      // The tool-result event preserves an honest skipped reason in the job ledger. A
      // configured but unreachable embedder must not discard the keyword results.
      try {
        await tool("score_mid_semantic", { run_id: runId });
      } catch (error) {
        console.warn(`MID semantic scoring skipped: ${errorMessage(error)}`);
      }
    } else {
      // Criteria may have been saved in this run before discovery started. The
      // fixture import is idempotent and does not replace the run or its reviews.
      await tool("import_company_files", { files: [seedFile], source: "MID" });

      for (const query of discoveryQueries(input.definition)) {
        const found = await tool("search_mid", {
          run_id: runId,
          query,
          mode: "lexical",
          limit: 1000,
          prefer_meilisearch: false,
          ...(exclusions.length ? { filters: { exclude_keywords: exclusions } } : {}),
        });
        const rows = searchRows(found);
        if (rows.length)
          await tool("add_candidates", {
            run_id: runId,
            companies: rows.map((row) => ({
              company_id: row.company.company_id,
              ...(Number.isSafeInteger(row.rank) ? { rank: row.rank } : {}),
              ...(typeof row.score === "number" && Number.isFinite(row.score)
                ? { retrieval_score: row.score }
                : {}),
            })),
            discovery_source: "MID",
            query_id: typeof found.query_id === "string" ? found.query_id : null,
          });
      }

    }

    const savedRows = new Map();
    let cursor, expectedTotal, consideredCount, sourceHash, selectionRevision, criteriaRevision;
    const pageSize = 2000;
    do {
      const page = await tool("get_screening_grid", {
        run_id: runId, include_hidden: true, limit: pageSize,
        ...(cursor ? { after_company_id: cursor } : {}),
      });
      if (!Array.isArray(page?.rows) || !Number.isSafeInteger(page.total) || page.total < 0 ||
          !Number.isSafeInteger(page.considered_count) || page.considered_count < 0 ||
          page.rows.length > pageSize || !(page.next_cursor === null || typeof page.next_cursor === "string") ||
          typeof page.source_hash !== "string" ||
          !(typeof page.selection_revision === "string" || Number.isSafeInteger(page.selection_revision)))
        throw new Error("The screening grid returned an invalid page.");
      const revision = JSON.stringify(page.criteria_revision ?? null);
      if (expectedTotal !== undefined && (expectedTotal !== page.total || consideredCount !== page.considered_count ||
          sourceHash !== page.source_hash || selectionRevision !== page.selection_revision ||
          criteriaRevision !== revision))
        throw new Error("The saved company list changed during discovery. Search again.");
      expectedTotal = page.total;
      consideredCount = page.considered_count;
      sourceHash = page.source_hash;
      selectionRevision = page.selection_revision;
      criteriaRevision = revision;
      let lastId = cursor;
      for (const candidate of page.rows) {
        const id = candidate?.company_id;
        if (typeof id !== "string" || !id || (lastId && id <= lastId) ||
            savedRows.has(id) || typeof candidate.considered !== "boolean")
          throw new Error("The screening grid returned an invalid or duplicate company.");
        savedRows.set(id, companyEntryFromGridRow(candidate));
        lastId = id;
      }
      const next = page.next_cursor;
      if (next != null && (!page.rows.length || next !== page.rows.at(-1).company_id ||
          (cursor && next <= cursor)))
        throw new Error("The screening grid did not advance its cursor.");
      cursor = next ?? undefined;
    } while (cursor);
    if (savedRows.size !== expectedTotal || [...savedRows.values()].filter((company) => company.row.considered).length !== consideredCount)
      throw new Error("The screening grid did not return the full company set.");

    // The legacy candidate reader supplies retrieval scores but caps at 1,000.
    // The paged shortlist above owns the complete membership and review flags.
    const candidateSet = await tool("get_candidate_set", {
      run_id: runId, include_hidden: true, limit: 1000,
    });
    if (!Array.isArray(candidateSet?.candidates))
      throw new Error("The Rust candidate set could not be read.");
    for (const candidate of candidateSet.candidates) {
      const row = candidateRow(candidate);
      const saved = row && savedRows.get(row.company.company_id);
      if (!saved || row.considered !== saved.row.considered)
        throw new Error("The saved company list changed during discovery. Search again.");
      if (typeof row.score === "number") saved.row.score = row.score;
      if (Number.isSafeInteger(row.rank)) saved.row.rank = row.rank;
    }
    const current = await tool("get_shortlist_context", { run_id: runId, include_hidden: true, limit: 1 });
    if (current.total !== expectedTotal || current.considered_count !== consideredCount ||
        current.source_hash !== sourceHash || current.selection_revision !== selectionRevision ||
        JSON.stringify(current.criteria_revision ?? null) !== criteriaRevision)
      throw new Error("The saved company list changed during discovery. Search again.");

    const companies = [...savedRows.values()].map(safeClone);

    const summary = await tool("get_discovery_summary", { run_id: runId });
    const counts = {
      midOnly: count(summary, "mid_only"),
      isccOnly: count(summary, "iscc_only"),
      both: count(summary, "both"),
    };
    const total = count(summary, "total_unique");
    const other = summary.other == null ? 0 : count(summary, "other");
    const consideredIds = [...savedRows].filter(([, company]) => company.row.considered).map(([id]) => id);
    if (
      total !== counts.midOnly + counts.isccOnly + counts.both + other ||
      total !== consideredIds.length
    ) {
      throw new Error(
        "The Rust discovery summary does not match the saved candidate set.",
      );
    }
    await tool("save_checkpoint", {
      run_id: runId,
      namespace: "screening-ui",
      state: {
        company_ids: consideredIds,
        counts,
        approved_definition: input.definition,
        step: "company-list-ready",
      },
    });
    return { backendRunId: runId, companies, counts };
  }

  function create(value) {
    const input = validateInput(value);
    const active = [...jobs.values()].find(
      (job) => job.sessionId === input.sessionId && job.state === "running",
    );
    if (active) {
      if (active.controller.signal.aborted)
        throw new JobInputError(
          "The previous search is still stopping. Wait before starting another search.",
        );
      if (
        active.input.criteriaText === input.criteriaText &&
        active.input.definition === input.definition &&
        active.input.backendRunId === input.backendRunId
      )
        return publicJob(active);
      throw new JobInputError(
        "Another search is running for this screening. Stop it before searching different criteria.",
      );
    }
    if (jobs.size >= MAX_RETAINED_JOBS) {
      const removable = [...jobs.values()]
        .filter((job) => job.state !== "running")
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      for (const job of removable) {
        jobs.delete(job.id);
        if (jobs.size < MAX_RETAINED_JOBS) break;
      }
    }
    if (jobs.size >= MAX_RETAINED_JOBS)
      throw new JobInputError("Too many screening jobs are still running.");
    const id = uuid();
    const job = {
      id,
      sessionId: input.sessionId,
      state: "running",
      startedAt: now(),
      events: [],
      input,
      controller: new AbortController(),
    };
    jobs.set(id, job);
    job.done = Promise.resolve()
      .then(() => execute(job))
      .then((result) => {
        job.result = result;
        job.state = "completed";
        job.finishedAt = now();
      })
      .catch((error) => {
        job.finishedAt = now();
        if (isAbort(error, job.controller.signal)) {
          job.state = "cancelled";
        } else {
          job.state = "error";
          job.error = errorMessage(error);
        }
      });
    return publicJob(job);
  }

  function get(id) {
    const job = jobs.get(id);
    return job ? publicJob(job) : undefined;
  }

  function list() {
    return [...jobs.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(publicJob);
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return undefined;
    if (job.state === "running") job.controller.abort();
    return publicJob(job);
  }

  async function wait(id) {
    const job = jobs.get(id);
    if (!job) return undefined;
    await job.done;
    return publicJob(job);
  }

  return { create, get, list, cancel, wait };
}
