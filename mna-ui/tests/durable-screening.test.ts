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

test("automatic screening prepares without a deployment and keeps execution unavailable", async () => {
  const f = fixture({ model: "" });
  const { preview } = await f.service.preview({ runId: "run-1", config: f.config });
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
  const { preview } = await f.service.preview({ runId: "run-1", config: f.config });
  assert.equal(f.calls.find((entry) => entry.tool === "propose_prepared_plan")?.args.deployment, configured);
  configured = "changed-after-preview";
  const { prepared } = await f.service.approve({ runId: "run-1", config: f.config, fingerprint: preview.fingerprint, approved: true });
  assert.equal(prepared.model, "configured-m365");
  assert.equal(prepared.config.model, prepared.model);
});

test("durable preview uses the backend digest and approval returns the frozen prepared plan", async () => {
  const f = fixture();
  const { preview } = await f.service.preview({ runId: "run-1", config: f.config });
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
  const { preview } = await f.service.preview({ runId: "run-1", config: f.config });
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
  const { preview } = await service.preview({ config });
  assert.equal(preview.companyCount, 0);
  assert.ok(calls.includes("create_run"));
});
