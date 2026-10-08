import test from "node:test";
import assert from "node:assert/strict";
import { buildCatalog, defaultScreeningConfig, projectRows } from "../shared/screening.mjs";
// @ts-expect-error Server-only ESM has no emitted declaration.
import { createDurableScreeningPreparation } from "../server/durable-screening.mjs";

const row = {
  pk: "A-1", PBId: "PB-1",
  sources: {
    MID: { "Company Name": "MID name", Website: "mid.example", Description: "Insurer software" },
    ISCC: {}, PB: { PB_Name: "PB name", PB_Website: "pb.example", PB_Description: "PB detail", "PB_LinkedIn URL": "https://linkedin.com/company/pb" }, ROGO: {},
  },
  provenance: {},
};

function fixture({ stale = false, model = "deployment", deployment = () => "" }: {
  stale?: boolean; model?: string; deployment?: () => string;
} = {}) {
  const calls: Array<{ tool: string; args: Record<string, any>; approved: boolean }> = [];
  const config = { ...defaultScreeningConfig("copilot", "screening", "insurance"), model };
  const catalog = buildCatalog([row]);
  const frozen = projectRows([row], config)[0];
  const plan = {
    plan_id: "plan-1", run_id: "run-1", schema_version: 2, digest: "backend-digest",
    status: "PROPOSED", spec: {}, snapshot: { input_columns: config.inputColumns,
      rows: [{ ...frozen, index: 1 }], compiled_prompt: "Compiled prompt from frozen plan", coverage: {}, catalog: catalog.sources,
      pb_linkedin_count: 1 }, executed: false, jobs: [{ job_id: "job-1", ordinal: 1, state: "PENDING", input_hash: "hash" }],
  };
  const call = async (tool: string, args: Record<string, any>, approved = false) => {
    calls.push({ tool, args, approved });
    if (tool === "get_shortlist_context") return { considered_count: 1, coverage: { PB: 1 } };
    if (tool === "get_candidate_source_data") return { run_id: args.run_id, total: 1, rows: [row], next_cursor: null };
    if (tool === "propose_prepared_plan") { assert.equal(args.run_id, "run-1"); return plan; }
    if (tool === "approve_prepared_plan") {
      assert.equal(approved, true);
      if (stale) throw new Error("prepared plan is stale");
      plan.status = "APPROVED";
      return { plan_id: plan.plan_id, digest: plan.digest, approved: true, executed: false };
    }
    if (tool === "get_prepared_plan") return plan;
    throw new Error(`Unexpected call ${tool}`);
  };
  return { service: createDurableScreeningPreparation({ call, now: () => 10_000, deployment }), calls, config };
}

async function prepareAndFreeze(service: any, input: any) {
  await service.catalog(input);
  const { build } = await service.preview(input);
  let current;
  for (let attempt = 0; attempt < 100; attempt++) {
    current = service.build({ id: build.id }).build;
    if (current.status !== "building") break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(current.status, "ready", current.error);
  return { preview: current.preview };
}

test("automatic screening prepares without a deployment and keeps execution unavailable", async () => {
  const f = fixture({ model: "" });
  const { preview } = await prepareAndFreeze(f.service, { runId: "run-1", config: f.config });
  assert.equal(f.calls.find((entry) => entry.tool === "propose_prepared_plan")?.args.deployment, "automatic");
  assert.deepEqual(preview.warnings, []);
  const { prepared } = await f.service.approve({ runId: "run-1", config: f.config, fingerprint: preview.fingerprint, approved: true });
  assert.equal(prepared.model, "automatic");
  assert.equal(prepared.config.model, prepared.model);
  assert.equal(prepared.executed, false);
});

test("configured automatic model is frozen in the approved proposal", async () => {
  let configured = "configured-m365";
  const f = fixture({ model: "", deployment: () => configured });
  const { preview } = await prepareAndFreeze(f.service, { runId: "run-1", config: f.config });
  assert.equal(f.calls.find((entry) => entry.tool === "propose_prepared_plan")?.args.deployment, configured);
  configured = "changed-after-preview";
  const { prepared } = await f.service.approve({ runId: "run-1", config: f.config, fingerprint: preview.fingerprint, approved: true });
  assert.equal(prepared.model, "configured-m365");
  assert.equal(prepared.config.model, prepared.model);
});

test("durable preview uses the backend digest and approval returns the frozen prepared plan", async () => {
  const f = fixture();
  const { preview } = await prepareAndFreeze(f.service, { runId: "run-1", config: f.config });
  assert.equal(preview.fingerprint, "backend-digest");
  assert.equal(preview.prompt, "Compiled prompt from frozen plan");
  assert.equal(preview.companyCount, 1);
  assert.equal(preview.rows[0].index, 1);
  const { prepared } = await f.service.approve({ runId: "run-1", config: f.config, fingerprint: preview.fingerprint, approved: true });
  assert.equal(prepared.id, "plan-1");
  assert.equal(prepared.schemaVersion, 2);
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.executed, false);
  assert.equal(prepared.jobs[0].job_id, "job-1");
  const proposed = f.calls.find((entry) => entry.tool === "propose_prepared_plan")!;
  assert.deepEqual(proposed.args.source_columns, []);
  assert.equal(proposed.args.input_columns[0], "index");
  assert.deepEqual(proposed.args.output_columns, ["Fit Score", "Rationale"]);
  const approval = f.calls.find((entry) => entry.tool === "approve_prepared_plan")!;
  assert.deepEqual(approval.args, { plan_id: "plan-1", digest: "backend-digest",
    approved_by: "Analyst approval in Screening UI", approval_key: "backend-digest" });
  assert.ok(f.calls.every((entry) => !/execute|provider|research_batch/i.test(entry.tool)));
});

test("configuration mutation and Rust stale-plan rejection prevent approval", async () => {
  const f = fixture({ stale: true });
  const { preview } = await prepareAndFreeze(f.service, { runId: "run-1", config: f.config });
  await assert.rejects(f.service.approve({ runId: "run-1", config: { ...f.config, prompt: "edited" }, fingerprint: preview.fingerprint, approved: true }), /changed after preview/);
  await assert.rejects(f.service.approve({ runId: "run-1", config: f.config, fingerprint: preview.fingerprint, approved: true }), /stale/);
  assert.equal(f.calls.filter((entry) => entry.tool === "approve_prepared_plan").length, 1);
});

test("general question proposals have no rows and no table output columns", async () => {
  const calls: string[] = [];
  const config = { ...defaultScreeningConfig("llm_suite", "question", "", "What should I ask?"), model: "deployment" };
  const call = async (tool: string, args: Record<string, any>) => {
    calls.push(tool);
    if (tool === "create_run") return { run_id: args.run_id };
    if (tool === "propose_prepared_plan") {
      assert.equal(args.mode, "question");
      assert.deepEqual(args.company_ids, []);
      assert.deepEqual(args.output_columns, []);
      return { plan_id: "plan-q", run_id: args.run_id, schema_version: 2, digest: "q-digest",
        status: "PROPOSED", spec: {}, snapshot: { rows: [], input_columns: [], coverage: {}, catalog: [], pb_linkedin_count: 0 }, executed: false };
    }
    throw new Error(`Unexpected call ${tool}`);
  };
  const service = createDurableScreeningPreparation({ call });
  const { preview } = await prepareAndFreeze(service, { config });
  assert.equal(preview.companyCount, 0);
  assert.ok(calls.includes("create_run"));
});

// Prepare replaces the old synchronous preview; only the Activity job reads every row.
test("Prepare counts only; background build proposes exactly once with the entire paged scope", async () => {
  const calls: { tool: string; args: any }[] = [];
  const count = 5613;
  const rows = Array.from({ length: count }, (_, i) => ({ ...row, pk: `A-${String(i).padStart(5, "0")}` }));
  const config = defaultScreeningConfig("llm_suite", "screening", "insurance");
  const service = createDurableScreeningPreparation({ call: async (tool: string, args: any) => {
    calls.push({ tool, args });
    if (tool === "get_shortlist_context") return { considered_count: count, coverage: { PB: count } };
    if (tool === "get_candidate_source_data") {
      const start = args.after_company_id ? rows.findIndex(row => row.pk === args.after_company_id) + 1 : 0;
      const page = rows.slice(start, start + args.limit);
      return { total: count, rows: page, next_cursor: start + page.length < count ? page.at(-1)?.pk : null };
    }
    if (tool === "propose_prepared_plan") {
      assert.deepEqual(args.company_ids, rows.map(row => row.pk));
      return { plan_id: "full-plan", digest: "frozen-digest", status: "PROPOSED", executed: false,
        snapshot: { rows: projectRows(rows, config) } };
    }
    throw new Error(`Unexpected call ${tool}`);
  } });
  await service.catalog({ runId: "run-1" });
  calls.length = 0;
  const prepared = await service.preview({ runId: "run-1", config });
  assert.equal(prepared.preview.companyCount, count);
  assert.equal(prepared.preview.rows.length, 5);
  assert.equal(prepared.preview.fingerprint, "");
  assert.ok(calls.every(call => call.tool !== "get_candidate_source_data" && call.tool !== "propose_prepared_plan"));
  await assert.rejects(service.approve({ runId: "run-1", config, fingerprint: "", approved: true }), /expired/);
  let build;
  for (let attempt = 0; attempt < 100; attempt++) {
    build = service.build({ id: prepared.build.id }).build;
    if (build.status !== "building") break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(build.status, "ready", build.error);
  assert.equal(build.preview.companyCount, count);
  assert.equal(build.preview.fingerprint, "frozen-digest");
  assert.equal(calls.filter(call => call.tool === "propose_prepared_plan").length, 1);
  assert.equal(calls.filter(call => call.tool === "get_candidate_source_data").length, Math.ceil(count / 100));
  assert.equal(service.list().builds[0].completed, count);
});

test("a count change since Prepare is disclosed on the frozen review", async () => {
  let count = 1;
  const rows = [row, { ...row, pk: "A-2" }];
  const config = defaultScreeningConfig("llm_suite", "screening", "insurance");
  const service = createDurableScreeningPreparation({ call: async (tool: string, args: any) => {
    if (tool === "get_shortlist_context") return { considered_count: count, coverage: { PB: count } };
    if (tool === "get_candidate_source_data") return { total: count, rows: rows.slice(0, count), next_cursor: null };
    if (tool === "propose_prepared_plan") return { plan_id: "changed-plan", digest: "changed-digest", status: "PROPOSED", executed: false, snapshot: { rows: projectRows(rows, config) } };
    throw new Error(`Unexpected call ${tool}`);
  } });
  await service.catalog({ runId: "run-1" });
  const prepared = await service.preview({ runId: "run-1", config });
  count = 2;
  await new Promise(resolve => setImmediate(resolve));
  const build = service.build({ id: prepared.build.id }).build;
  assert.equal(build.status, "ready", build.error);
  assert.equal(build.preview.companyCount, 2);
  assert.match(build.preview.warnings[0], /count changed since Prepare: 1 .* 2/);
  assert.equal(build.preview.fingerprint, "changed-digest");
});
