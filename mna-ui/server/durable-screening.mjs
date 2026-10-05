import { randomUUID } from "node:crypto";
import { buildCatalog, validateConfig } from "../shared/screening.mjs";

const MAX_PREVIEWS = 4;
const PREVIEW_TTL = 15 * 60_000;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const SAFE_RUN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** UI adapter for Rust's immutable prepared-plan lifecycle. Rust owns source
 * freshness, snapshots, and approval digests; this module only holds short-lived
 * references needed to bind an approval to the exact preview shown in the UI. */
export function createDurableScreeningPreparation({ call, now = () => Date.now(), deployment = (provider) =>
  process.env[provider === "llm_suite" ? "MNA_LLMSUITE_DEPLOYMENT" : "MNA_M365_DEPLOYMENT"] ?? "" }) {
  const previews = new Map();
  const approvals = new Map();

  function runId(value) {
    if (value == null || value === "") return undefined;
    if (typeof value !== "string" || !SAFE_RUN.test(value))
      throw new Error("Use a valid screening run.");
    return value;
  }

  const traceCall = (traces, signal) => async (tool, args, approved = false) => {
    const startedAt = new Date(now()).toISOString();
    try {
      const result = await call(tool, args, approved, signal);
      let summary = result;
      if (tool === "get_candidate_source_data") summary = {
        run_id: result.run_id, total: result.total,
        rows_returned: result.rows?.length ?? 0,
        next_cursor: result.next_cursor ?? null,
      };
      else if (tool === "propose_prepared_plan") summary = {
        plan_id: result.plan_id, run_id: result.run_id,
        schema_version: result.schema_version, digest: result.digest,
        status: result.status, rows: result.snapshot?.rows?.length ?? 0,
        executed: result.executed,
      };
      else if (tool === "get_prepared_plan") summary = {
        plan_id: result.plan_id, run_id: result.run_id,
        schema_version: result.schema_version, digest: result.digest,
        status: result.status, executed: result.executed,
        jobs: result.jobs?.length ?? 0,
      };
      else if (tool === "approve_prepared_plan") summary = {
        plan_id: result.plan_id, digest: result.digest,
        approved: result.approved ?? result.status === "APPROVED",
        executed: result.executed,
      };
      traces.push({ tool, args, result: summary, startedAt,
        finishedAt: new Date(now()).toISOString(), status: "success" });
      return result;
    } catch (error) {
      traces.push({ tool, args, error: error instanceof Error ? error.message : String(error),
        startedAt, finishedAt: new Date(now()).toISOString(), status: "error" });
      throw error;
    }
  };

  async function sourceSnapshot(id, traced) {
    if (!id) return { rows: [], catalog: buildCatalog([]) };
    const rows = [];
    let cursor, total, size = 100, bytes = 0;
    do {
      let page;
      try {
        page = await traced("get_candidate_source_data", {
          run_id: id, limit: size, ...(cursor ? { after_company_id: cursor } : {}),
        });
      } catch (error) {
        if (size > 1 && /(?:too large|exceeds|2 MB|2MB|byte limit)/i.test(String(error))) {
          size = Math.max(1, Math.floor(size / 2));
          continue;
        }
        throw error;
      }
      if (!Array.isArray(page.rows) || !Number.isSafeInteger(page.total))
        throw new Error("The source reader returned an invalid page.");
      if (total !== undefined && total !== page.total)
        throw new Error("The company list changed during preparation. Refresh and try again.");
      total = page.total;
      for (const row of page.rows) {
        if (typeof row?.pk !== "string" || !row.sources ||
            (rows.length && row.pk <= rows[rows.length - 1].pk))
          throw new Error("The source reader returned unordered or duplicate companies.");
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (bytes > MAX_SNAPSHOT_BYTES)
          throw new Error("This local setup exceeds the 64 MB preparation limit. A streaming preparation service is needed for this scope; no companies were removed.");
        rows.push(row);
      }
      const next = page.next_cursor || undefined;
      if (next && (next === cursor || !page.rows.length))
        throw new Error("The source reader did not advance its cursor.");
      cursor = next;
    } while (cursor);
    if (rows.length !== (total ?? 0))
      throw new Error("The source reader did not return the full company set. Refresh and try again.");
    return { rows, catalog: buildCatalog(rows) };
  }

  function resolvedModel(config) {
    const configured = config.model && config.model !== "automatic" ? config.model : deployment(config.provider)?.trim();
    if (typeof configured !== "string" || configured.length > 160)
      throw new Error("The configured model name is invalid.");
    return configured || "automatic";
  }

  function rustArgs(config, run, sourceRows) {
    const selected = config.inputColumns.filter((column) => column !== "index");
    const source_columns = selected.flatMap((label) => {
      const separator = label.indexOf(":");
      return separator < 0 ? [] : [{ source: label.slice(0, separator), column: label.slice(separator + 1) }];
    });
    return {
      run_id: run,
      mode: config.mode,
      provider: config.provider,
      deployment: resolvedModel(config),
      prompt: config.prompt,
      ...(config.mode === "question" ? { question: config.prompt } : {}),
      company_ids: sourceRows.map((row) => row.pk),
      source_columns,
      identity_sources: config.identitySources,
      input_columns: config.inputColumns,
      output_columns: config.mode === "question" && !sourceRows.length
        ? [] : config.outputColumns.filter((column) => column !== "index"),
      score_columns: config.mode === "screening" && config.outputColumns.includes("Fit Score") ? ["Fit Score"] : [],
      batch_size: config.batchSize,
      provider_options: {},
      retrieval_configuration: {},
    };
  }

  async function catalog(input, signal) {
    const calls = [];
    try {
      const id = runId(input.runId);
      const data = await sourceSnapshot(id, traceCall(calls, signal));
      return { catalog: data.catalog, calls };
    } catch (error) { error.calls = calls; throw error; }
  }

  async function preview(input, signal) {
    const calls = [];
    try {
      const requestedRunId = runId(input.runId);
      let id = requestedRunId;
      let data = await sourceSnapshot(id, traceCall(calls, signal));
      const config = validateConfig(input.config, data.catalog);
      if (config.mode === "screening" && (!id || !data.rows.length))
        throw new Error("Choose an approved screening run with companies before preparing scored screening.");
      if (!id) {
        id = `QUESTION-${randomUUID()}`;
        await traceCall(calls, signal)("create_run", {
          run_id: id,
          objective: "Analyst-directed provider question setup",
          original_criteria: { question: config.prompt, mode: "question" },
        }, true);
      }
      const args = rustArgs(config, id, data.rows);
      const proposed = await traceCall(calls, signal)("propose_prepared_plan", args);
      if (!proposed || typeof proposed.plan_id !== "string" || typeof proposed.digest !== "string" ||
          proposed.status !== "PROPOSED" || proposed.executed !== false || !proposed.snapshot ||
          !Array.isArray(proposed.snapshot.rows))
        throw new Error("The screening service returned an invalid immutable prepared plan.");
      const frozenRows = proposed.snapshot.rows;
      const columns = ["index", ...config.inputColumns.filter((column) => column !== "index")];
      const rows = frozenRows.slice(0, 4).map((row, offset) => Object.fromEntries(
        columns.map((column) => [column, column === "index" ? (row.index ?? offset + 1) : row[column] ?? ""]),
      ));
      const batches = Math.max(1, Math.ceil(frozenRows.length / config.batchSize));
      const warnings = [];
      if (!frozenRows.length) warnings.push("No company list is selected. This will be a single general question, without company results.");
      const publicPreview = {
        columns, rows, prompt: proposed.snapshot.compiled_prompt ?? config.prompt, outputColumns: config.outputColumns,
        companyCount: frozenRows.length, batches,
        estimatedMinimumMinutes: config.provider === "llm_suite" ? Math.floor((batches - 1) / 7) : 0,
        fingerprint: proposed.digest, warnings,
      };
      for (const [key, value] of previews) if (value.expires <= now()) previews.delete(key);
      while (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value);
      previews.set(proposed.digest, { planId: proposed.plan_id, runId: id, requestedRunId, args, config, catalog: data.catalog,
        preview: publicPreview, expires: now() + PREVIEW_TTL });
      return { preview: publicPreview, calls };
    } catch (error) { error.calls = calls; throw error; }
  }

  async function approve(input, signal) {
    if (input.approved !== true) throw new Error("Approve the exact setup before saving it.");
    const calls = [];
    try {
      const cached = previews.get(input.fingerprint);
      if (!cached || cached.expires <= now()) throw new Error("This preview has expired. Preview the input data again.");
      const requestedRun = runId(input.runId);
      if (requestedRun !== cached.requestedRunId)
        throw new Error("The preview belongs to a different screening.");
      const config = validateConfig(input.config, cached.catalog);
      if (JSON.stringify(config) !== JSON.stringify(cached.config))
        throw new Error("The setup changed after preview. Preview it again before approving.");
      if (approvals.has(input.fingerprint)) return approvals.get(input.fingerprint);
      const pending = (async () => {
        const traced = traceCall(calls, signal);
        await traced("approve_prepared_plan", {
          plan_id: cached.planId, digest: cached.preview.fingerprint,
          approved_by: "Analyst approval in Screening UI",
          approval_key: cached.preview.fingerprint,
        }, true);
        const approved = await traced("get_prepared_plan", { plan_id: cached.planId });
        if (approved.digest !== cached.preview.fingerprint || approved.executed !== false || approved.status !== "APPROVED")
          throw new Error("The screening service returned a changed, unapproved, or executed prepared plan.");
        const prepared = {
          id: approved.plan_id,
          planId: approved.plan_id,
          schemaVersion: approved.schema_version,
          title: config.mode === "screening" ? "Screening setup" : "Question setup",
          provider: config.provider, mode: config.mode, model: cached.args.deployment,
          companyCount: approved.snapshot?.rows?.length ?? cached.preview.companyCount,
          batches: Math.max(1, Math.ceil((approved.snapshot?.rows?.length ?? cached.preview.companyCount) / config.batchSize)),
          status: "prepared", executed: false, config: { ...config, model: cached.args.deployment }, fingerprint: approved.digest,
          savedAt: new Date(now()).toISOString(), jobs: approved.jobs ?? [],
        };
        return { prepared, calls };
      })();
      approvals.set(input.fingerprint, pending);
      try { return await pending; } catch (error) { approvals.delete(input.fingerprint); throw error; }
    } catch (error) { error.calls = calls; throw error; }
  }
  return { catalog, preview, approve };
}
