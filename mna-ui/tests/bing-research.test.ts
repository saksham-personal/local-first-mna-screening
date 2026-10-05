import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Server-only controller is tested with an injected transport.
import { createBingResearch } from "../server/bing-research.mjs";

function fixture(connected = false) {
  const calls: { tool: string; args: Record<string, any>; approved: boolean }[] = [];
  const company = { company_id: "A-1", name: "MID name", website: "mid.example", PB_Name: "PB name", PB_Website: "pb.example" };
  let templates: string[] = [];
  const service = createBingResearch({ connected: () => connected, call: async (tool: string, args: Record<string, any>, approved = false) => {
    calls.push({ tool, args, approved });
    if (tool === "get_company") return company;
    if (tool === "create_run") { assert.ok(args.objective); return { run_id: "run-1" }; }
    if (tool === "propose_action_plan") { templates = args.steps[0].query_templates; return { plan_id: "plan-1" }; }
    if (tool === "approve_action_plan") { assert.equal(approved, true); return { status: "APPROVED" }; }
    if (tool === "prepare_bing_queries") return { queries: templates.map(query => ({ company_id: "A-1", query: query.replaceAll("{company}", company.PB_Name).replaceAll("{website}", company.PB_Website) })) };
    if (tool === "bing_search") return { evidence_id: "evidence-1", results: [{ title: "Primary page", url: "https://pb.example/products", snippet: "Business description" }] };
    throw new Error(`Unexpected call ${tool}`);
  } });
  return { service, calls, company };
}
const input = { runId: "run-1", companyIds: ["A-1"], queries: ["{company} products", "{company} {website} customers", "{company} business description"] };

test("Bing preview prefers PitchBook identity and disconnected approval does not execute", async () => {
  const f = fixture();
  const preview = await f.service.preview(input);
  assert.equal(preview.executed, false);
  assert.equal(preview.queries[0].query, "PB name products");
  await assert.rejects(f.service.run({ token: preview.token, approved: false }), /approve/i);
  const result = await f.service.run({ token: preview.token, approved: true });
  assert.equal(result.executed, false);
  assert.deepEqual(result.rows, []);
  assert.ok(!f.calls.some(call => call.tool === "bing_search"));
});
test("source identity changes require a new Bing preview before approval", async () => {
  const f = fixture(true), preview = await f.service.preview(input);
  f.company.PB_Name = "Changed identity";
  await assert.rejects(f.service.run({ token: preview.token, approved: true }), /sources changed/i);
  assert.ok(!f.calls.some(call => call.tool === "approve_action_plan"));
});
test("connected manual research calls authorized tools and marks hydrated sources unverified", async () => {
  const f = fixture(true), preview = await f.service.preview(input);
  const result = await f.service.run({ token: preview.token, approved: true });
  assert.equal(result.executed, true);
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows[0].pk, "A-1");
  assert.equal(result.rows[0].Verification, "Unverified research lead");
  assert.ok(f.calls.filter(call => call.tool === "bing_search").every(call => call.args.plan_id === "plan-1" && call.args.step_id === "bing-grounding"));
  await f.service.run({ token: preview.token, approved: true });
  assert.equal(f.calls.filter(call => call.tool === "bing_search").length, 3);
});
test("general grounding works without a company or LinkedIn URL", async () => {
  const f = fixture();
  const preview = await f.service.preview({ companyIds: [], queries: ["Insurance claims software terminology"] });
  assert.equal(preview.queries.length, 1);
  assert.equal(preview.queries[0].company_id, undefined);
  assert.ok(f.calls.some(call => call.tool === "create_run"));
});
