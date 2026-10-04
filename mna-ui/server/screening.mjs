import { createHash } from "node:crypto";
import {
  buildCatalog,
  projectRows,
  validateConfig,
} from "../shared/screening.mjs";

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 850_000;
const MAX_PREVIEWS = 4;
const PREVIEW_TTL = 15 * 60_000;
const SAFE_RUN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Preparation only. Rust owns the saved immutable records; this controller
 * has no provider adapter and cannot dispatch external work. */
export function createScreeningPreparation({ call, now = () => Date.now() }) {
  const previews = new Map();
  const approvals = new Map();
  const clean = () => {
    for (const [id, value] of previews)
      if (value.expires <= now()) previews.delete(id);
    while (previews.size >= MAX_PREVIEWS)
      previews.delete(previews.keys().next().value);
  };
  function runId(value) {
    if (value == null || value === "") return undefined;
    if (typeof value !== "string" || !SAFE_RUN.test(value))
      throw new Error("Use a valid screening run.");
    return value;
  }
  function traceCall(traces, signal) {
    return async (tool, args, approved = false) => {
      const startedAt = new Date(now()).toISOString();
      try {
        const result = await call(tool, args, approved, signal);
        // Full input rows live in the server-side snapshot, not a second copy in
        // every UI log event. These are summaries of actual completed calls.
        const summary =
          tool === "get_candidate_source_data"
            ? {
                run_id: result.run_id,
                total: result.total,
                rows_returned: result.rows?.length ?? 0,
                next_cursor: result.next_cursor ?? null,
              }
            : tool === "save_checkpoint"
              ? {
                  checkpoint_id: result.checkpoint_id,
                  run_id: result.run_id,
                  namespace: result.namespace,
                  sequence: result.sequence,
                  created_at: result.created_at,
                }
              : tool === "get_run_context"
                ? {
                    run_id: result.run_id,
                    active_profile_version: result.active_profile_version,
                    active_criteria_version: result.active_criteria_version,
                  }
                : tool === "get_checkpoint"
                  ? {
                      checkpoint_id: result.checkpoint_id,
                      namespace: result.namespace,
                      sequence: result.sequence,
                    }
                  : result;
        traces.push({
          tool,
          args:
            tool === "save_checkpoint"
              ? {
                  run_id: args.run_id,
                  namespace: args.namespace,
                  expected_sequence: args.expected_sequence,
                  snapshot_hash:
                    args.state?.fingerprint ?? args.state?.batchHash,
                }
              : args,
          result: summary,
          startedAt,
          finishedAt: new Date(now()).toISOString(),
          status: "success",
        });
        return result;
      } catch (error) {
        traces.push({
          tool,
          args,
          error: error instanceof Error ? error.message : String(error),
          startedAt,
          finishedAt: new Date(now()).toISOString(),
          status: "error",
        });
        throw error;
      }
    };
  }
  async function snapshot(id, traced) {
    if (!id)
      return {
        runId: undefined,
        lineage: null,
        rows: [],
        catalog: buildCatalog([]),
      };
    const context = await traced("get_run_context", { run_id: id });
    const lineage = {
      profileVersion: context.active_profile_version ?? 0,
      criteriaVersion: context.active_criteria_version ?? 0,
    };
    const rows = [];
    let cursor;
    let total;
    let bytes = 0;
    let size = 100;
    do {
      let page;
      try {
        page = await traced("get_candidate_source_data", {
          run_id: id,
          limit: size,
          ...(cursor ? { after_company_id: cursor } : {}),
        });
      } catch (error) {
        if (
          size > 1 &&
          /(?:too large|exceeds|2 MB|2MB|byte limit)/i.test(String(error))
        ) {
          size = Math.max(1, Math.floor(size / 2));
          continue;
        }
        throw error;
      }
      if (!Array.isArray(page.rows) || !Number.isSafeInteger(page.total))
        throw new Error("The source reader returned an invalid page.");
      if (total !== undefined && total !== page.total)
        throw new Error(
          "The company list changed during preparation. Refresh and try again.",
        );
      total = page.total;
      for (const row of page.rows) {
        if (
          typeof row?.pk !== "string" ||
          !row.sources ||
          (rows.length && row.pk <= rows[rows.length - 1].pk)
        )
          throw new Error(
            "The source reader returned unordered or duplicate companies.",
          );
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (bytes > MAX_SNAPSHOT_BYTES)
          throw new Error(
            "This local setup exceeds the 64 MB preparation limit. A streaming preparation service is needed for this scope; no companies were removed.",
          );
        rows.push(row);
      }
      const next = page.next_cursor || undefined;
      if (next && (next === cursor || !page.rows.length))
        throw new Error("The source reader did not advance its cursor.");
      cursor = next;
    } while (cursor);
    if (rows.length !== (total ?? 0))
      throw new Error(
        "The source reader did not return the full company set. Refresh and try again.",
      );
    const end = await traced("get_run_context", { run_id: id });
    if (
      lineage.profileVersion !== (end.active_profile_version ?? 0) ||
      lineage.criteriaVersion !== (end.active_criteria_version ?? 0)
    )
      throw new Error(
        "The screening criteria changed during preparation. Refresh and try again.",
      );
    return { runId: id, lineage, rows, catalog: buildCatalog(rows) };
  }
  async function catalog(input, signal) {
    const calls = [];
    try {
      const data = await snapshot(runId(input.runId), traceCall(calls, signal));
      return { catalog: data.catalog, calls };
    } catch (error) {
      error.calls = calls;
      throw error;
    }
  }
  async function preview(input, signal) {
    const calls = [];
    try {
      const data = await snapshot(runId(input.runId), traceCall(calls, signal));
      const config = validateConfig(input.config, data.catalog);
      if (
        config.mode === "screening" &&
        (!data.rows.length || !data.lineage?.profileVersion)
      )
        throw new Error(
          "Approve screening criteria and find companies before preparing scored screening.",
        );
      const rows = projectRows(data.rows, config);
      const batches = Math.max(1, Math.ceil(rows.length / config.batchSize));
      const fingerprint = digest({
        runId: data.runId ?? null,
        lineage: data.lineage,
        config,
        sourceData: data.rows,
      });
      const warnings = [
        "This saves a setup only. No information will be sent to a provider.",
      ];
      if (!config.model)
        warnings.push(
          "Deployment names are not configured. Enter one before approving.",
        );
      if (config.provider === "llm_suite")
        warnings.push(
          "The shared seven-message limit includes reasoning, subagents, questions, retries, and screening. Other work and provider response time can add delays.",
        );
      if (config.provider === "copilot")
        warnings.push(
          "LinkedIn is optional. M365 capacity and model choices will be configured separately.",
        );
      if (!rows.length)
        warnings.push(
          "No company list is selected. This will be a single general question, without company results.",
        );
      for (const column of config.inputColumns.filter(
        (column) => column !== "index",
      )) {
        const blank = rows.filter(
          (row) => !String(row[column] ?? "").trim(),
        ).length;
        if (blank)
          warnings.push(
            `${column} is blank for ${blank} of ${rows.length} companies.`,
          );
      }
      const publicPreview = {
        columns: config.inputColumns,
        rows: rows.slice(0, 4),
        prompt: config.prompt,
        outputColumns: config.outputColumns,
        companyCount: rows.length,
        batches,
        estimatedMinimumMinutes:
          config.provider === "llm_suite" ? Math.floor((batches - 1) / 7) : 0,
        fingerprint,
        warnings,
      };
      clean();
      previews.set(fingerprint, {
        data,
        config,
        rows,
        publicPreview,
        expires: now() + PREVIEW_TTL,
      });
      return { preview: publicPreview, calls };
    } catch (error) {
      error.calls = calls;
      throw error;
    }
  }
  async function approve(input, signal) {
    if (input.approved !== true)
      throw new Error("Approve the exact setup before saving it.");
    const calls = [];
    try {
      const id = runId(input.runId);
      const cached = previews.get(input.fingerprint);
      if (!cached || cached.expires <= now())
        throw new Error(
          "This preview has expired. Preview the input data again.",
        );
      if (cached.data.runId !== id)
        throw new Error("The preview belongs to a different screening.");
      const normalized = validateConfig(
        input.config,
        cached.data.catalog,
        true,
      );
      if (JSON.stringify(normalized) !== JSON.stringify(cached.config))
        throw new Error(
          "The setup changed after preview. Preview it again before approving.",
        );
      if (approvals.has(input.fingerprint))
        return approvals.get(input.fingerprint);
      const pending = save(cached, normalized, calls, signal);
      approvals.set(input.fingerprint, pending);
      try {
        return await pending;
      } catch (error) {
        approvals.delete(input.fingerprint);
        throw error;
      }
    } catch (error) {
      error.calls = calls;
      throw error;
    }
  }
  async function save(cached, config, calls, signal) {
    const traced = traceCall(calls, signal);
    const fresh = await snapshot(cached.data.runId, traced);
    const currentHash = digest({
      runId: fresh.runId ?? null,
      lineage: fresh.lineage,
      config,
      sourceData: fresh.rows,
    });
    if (currentHash !== cached.publicPreview.fingerprint)
      throw new Error(
        "Company data or screening criteria changed after preview. Refresh the preview before approving.",
      );
    const fingerprint = currentHash;
    let id = fresh.runId;
    if (!id) {
      id = `QUESTION-${fingerprint.slice(0, 32)}`;
      try {
        await traced(
          "create_run",
          {
            run_id: id,
            objective: "Analyst-directed provider question setup",
            original_criteria: { question: config.prompt, mode: "question" },
          },
          true,
        );
      } catch (error) {
        if (!/already exists/i.test(String(error))) throw error;
      }
    }
    const namespace = `screening-setup:${fingerprint}`;
    try {
      const prior = await traced("get_checkpoint", { run_id: id, namespace });
      if (prior.state?.prepared?.fingerprint === fingerprint)
        return { prepared: prior.state.prepared, calls };
      throw new Error("This setup key is already used by different data.");
    } catch (error) {
      if (!/checkpoint not found/i.test(String(error))) throw error;
    }
    const prepared = {
      id: `SETUP-${fingerprint.slice(0, 24)}`,
      title: config.mode === "screening" ? "Screening setup" : "Question setup",
      provider: config.provider,
      mode: config.mode,
      model: config.model,
      companyCount: cached.rows.length,
      batches: cached.publicPreview.batches,
      status: "prepared",
      executed: false,
      config,
      fingerprint,
      savedAt: new Date(now()).toISOString(),
      checkpoint: { runId: id, namespace, sequence: 1 },
    };
    const manifest = [];
    // Split storage independently of model batch size, preserving global indexes.
    // No partial record is considered approved until the final manifest exists.
    let chunk = [],
      size = 0;
    const chunks = [];
    for (let index = 0; index < cached.rows.length; index++) {
      const row = {
        index: index + 1,
        pk: cached.data.rows[index].pk,
        input: cached.rows[index],
        provenance: cached.data.rows[index].provenance ?? {},
      };
      const bytes = Buffer.byteLength(JSON.stringify(row));
      if (bytes > MAX_CHECKPOINT_BYTES - 1000)
        throw new Error(
          "A company row is too large to save safely. Choose fewer source columns.",
        );
      if (chunk.length && size + bytes > MAX_CHECKPOINT_BYTES) {
        chunks.push(chunk);
        chunk = [];
        size = 0;
      }
      chunk.push(row);
      size += bytes;
    }
    if (chunk.length) chunks.push(chunk);
    for (let number = 0; number < chunks.length; number++) {
      const rows = chunks[number],
        batchHash = digest(rows),
        chunkNamespace = `screening-data:${fingerprint}:${number + 1}`;
      let record;
      try {
        record = await traced("get_checkpoint", {
          run_id: id,
          namespace: chunkNamespace,
        });
      } catch (error) {
        if (!/checkpoint not found/i.test(String(error))) throw error;
      }
      if (record && record.state?.batchHash !== batchHash)
        throw new Error("A stored input snapshot conflicts with this setup.");
      if (!record)
        await traced("save_checkpoint", {
          run_id: id,
          namespace: chunkNamespace,
          expected_sequence: 0,
          state: { version: 1, batchHash, rows },
        });
      manifest.push({
        namespace: chunkNamespace,
        sequence: 1,
        hash: batchHash,
        count: rows.length,
        firstIndex: rows[0].index,
        lastIndex: rows[rows.length - 1].index,
      });
    }
    const state = {
      version: 1,
      fingerprint,
      prepared,
      lineage: fresh.lineage,
      manifest,
      protocol: {
        inputFormat: "markdown-table",
        outputHeaders: config.outputColumns,
        identityJoin: "immutable-global-index-to-pk",
        externalExecution: false,
        sharedLLMSuiteMessagesPerMinute: 7,
      },
    };
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_CHECKPOINT_BYTES)
      throw new Error("The preparation manifest is too large to save.");
    await traced("save_checkpoint", {
      run_id: id,
      namespace,
      expected_sequence: 0,
      state,
    });
    return { prepared, calls };
  }
  return { catalog, preview, approve };
}
