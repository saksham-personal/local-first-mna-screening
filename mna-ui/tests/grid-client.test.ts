import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchScreeningGrid,
  fetchScreeningRounds,
  fetchCompanyDetail,
  hiddenReasonLabel,
  hideIds,
  keepOnlyIds,
  restoreIds,
  type GridCompany,
} from "../src/lib/grid-client";

function company(company_id: string, considered: boolean): GridCompany {
  return {
    company_id,
    name: company_id,
    website: null,
    hq_city: null,
    hq_state: null,
    description: null,
    source: "MID",
    considered,
    consideration_reason: considered ? null : "manual",
    pbid: null,
    mid_score: null,
    iscc_score: null,
    mid_keyword: null,
    mid_semantic_score: null,
    iscc_relevancy: null,
    simulated: false,
    rounds: {},
    coverage: { pb: false, rogo: false, bing: false },
    pb: { name: null, website: null, description: null, hq_location: null, active_investors: null, universe: null, linkedin_url: null },
    discovery_count: 0,
  };
}

function pageRow(id: string, considered: boolean) {
  return {
    company_id: id,
    name: id,
    website: null,
    hq_city: null,
    hq_state: null,
    description: null,
    source: "MID",
    considered,
    consideration_reason: considered ? null : "manual",
    pbid: null,
    mid_score: null,
    iscc_score: null,
    coverage: { pb: false, rogo: false, bing: false },
    pb: { name: null, website: null, description: null, hq_location: null, active_investors: null, universe: null, linkedin_url: null },
    discovery_count: 0,
  };
}

test("fetchScreeningGrid pages all companies and preserves the selection revision", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { tool: string; arguments: Record<string, unknown> };
    requests.push(request.arguments);
    const secondPage = request.arguments.after_company_id === "company-1";
    const result = {
      run_id: "run-1",
      selection_revision: 8,
      criteria_revision: 2,
      source_hash: "source-3",
      include_hidden: true,
      total: 2,
      considered_count: 1,
      hidden_count: 1,
      next_cursor: secondPage ? null : "company-1",
      rows: [pageRow(secondPage ? "company-2" : "company-1", secondPage ? false : true)],
    };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const result = await fetchScreeningGrid("run-insurance", "run-1");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].include_hidden, true);
    assert.equal(requests[0].limit, 1000);
    assert.equal(requests[1].after_company_id, "company-1");
    assert.deepEqual(result.rows.map((row) => row.company_id), ["company-1", "company-2"]);
    assert.equal(result.total, 2);
    assert.equal(result.consideredCount, 1);
    assert.equal(result.hiddenCount, 1);
    assert.equal(result.selectionRevision, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const roundColumns = [{ key: "R1", round_no: 1, provider: "llmsuite", provider_label: "LLM Suite", score_columns: ["fit", "risk"], output_columns: ["fit", "risk", "rationale"] }];
const keyword = { best_match_pct: 75, hit_count: 2, matched: [{ id: 1, text: "insurance" }], queries: [{ query_id: "q1", rationale: "Core business", display_query: "insurance OR claims", match_pct: 75 }] };
const rounds = { R1: { provider: "llmsuite", provider_label: "LLM Suite", score_columns: ["fit", "risk"], values: { fit: "CHECK", risk: 0, rationale: "Analyst review" }, scores: { fit: "CHECK", risk: 0 } } };
async function withToolResult(result: unknown, action: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "Content-Type": "application/json" } });
  try { await action(); } finally { globalThis.fetch = original; }
}

test("grid parses separate Phase 2 scores, keyword evidence, simulation and multiple round outputs", async () => {
  await withToolResult({ rows: [{ ...pageRow("one", true), mid_score: 3, mid_keyword: keyword, mid_semantic_score: 7.4, iscc_relevancy: 0.88, simulated: true, rounds }], total: 1, considered_count: 1, hidden_count: 0, selection_revision: 1, source_hash: "one", rounds: roundColumns, has_mid_keyword: true, has_semantic: true, has_iscc: true }, async () => {
    const grid = await fetchScreeningGrid("run-insurance", "one");
    assert.deepEqual(grid.rounds, roundColumns);
    assert.equal(grid.has_semantic, true);
    assert.equal(grid.has_mid_keyword, true);
    assert.equal(grid.has_iscc, true);
    assert.equal(grid.rows[0].mid_score, 3);
    assert.equal(grid.rows[0].mid_semantic_score, 7.4);
    assert.equal(grid.rows[0].iscc_relevancy, 0.88);
    assert.equal(grid.rows[0].simulated, true);
    assert.deepEqual(grid.rows[0].mid_keyword, keyword);
    assert.deepEqual(grid.rows[0].rounds, rounds);
  });
});

test("missing and invalid new scores remain null; real zero scores stay zero", async () => {
  await withToolResult({ rows: [{ ...pageRow("one", true), mid_semantic_score: 0, iscc_relevancy: 2, rounds: { R1: { ...rounds.R1, scores: { fit: null, risk: 11 } } } }, pageRow("two", true)], total: 2, considered_count: 2, hidden_count: 0, selection_revision: 1, source_hash: "one" }, async () => {
    const grid = await fetchScreeningGrid("run-insurance", "one");
    assert.equal(grid.rows[0].mid_semantic_score, 0);
    assert.equal(grid.rows[0].iscc_relevancy, null);
    assert.deepEqual(grid.rows[0].rounds.R1.scores, { fit: null, risk: null });
    assert.equal(grid.rows[1].mid_semantic_score, null);
    assert.equal(grid.rows[1].mid_keyword, null);
    assert.deepEqual(grid.rounds, []);
  });
});

test("grid rejects round metadata changing during pagination", async () => {
  const original = globalThis.fetch;
  let page = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: { rows: [pageRow(String(++page), true)], next_cursor: page === 1 ? "1" : null, total: 2, considered_count: 2, hidden_count: 0, selection_revision: 1, source_hash: "one", rounds: page === 1 ? [] : roundColumns } }));
  try { await assert.rejects(fetchScreeningGrid("run-insurance", "one"), /changed while/); } finally { globalThis.fetch = original; }
});

test("detail and timeline parse backend Phase 2 shapes", async () => {
  await withToolResult({ company_id: "one", company: { name: "One" }, mid_keyword: keyword, mid_semantic: { score: 0 }, iscc: { relevancy: 0 }, simulated: true, rounds }, async () => {
    const detail = await fetchCompanyDetail("run-insurance", "run1", "one");
    assert.deepEqual(detail.mid_keyword, keyword);
    assert.equal(detail.mid_semantic?.score, 0);
    assert.equal(detail.iscc?.relevancy, 0);
    assert.deepEqual(detail.rounds, rounds);
    assert.equal(detail.simulated, true);
  });
  await withToolResult({ rounds: [{ ...roundColumns[0], plan_id: "plan1", created_at: "2026-10-07T05:25:00Z", jobs: { total: 10, ready: 0, running: 0, done: 9, failed: 1, other: 0 }, assessed_companies: 9, score_distribution: { fit: { "7": 4, CHECK: 2 } }, simulated: true }] }, async () => {
    const timeline = await fetchScreeningRounds("run-insurance", "run1");
    assert.equal(timeline[0].jobs.failed, 1);
    assert.equal(timeline[0].score_distribution.fit.CHECK, 2);
    assert.equal(timeline[0].simulated, true);
  });
});

test("hide, keep-only, and restore helpers produce the full considered set", () => {
  const rows = [company("one", true), company("two", true), company("three", false)];
  assert.deepEqual(hideIds(rows, ["two"]), ["one"]);
  assert.deepEqual(keepOnlyIds(rows, ["three", "missing", "one"]), ["three", "one"]);
  assert.deepEqual(restoreIds(rows, ["three"]), ["one", "two", "three"]);
  assert.deepEqual(restoreIds(rows, ["missing"]), ["one", "two"]);
});

test("hidden reason labels match analyst and PitchBook review reasons", () => {
  assert.equal(hiddenReasonLabel("manual"), "Manual");
  assert.equal(hiddenReasonLabel("analyst"), "Manual");
  assert.equal(hiddenReasonLabel("pitchbook_unmatched"), "No PitchBook match");
  assert.equal(hiddenReasonLabel("pitchbook_non_company"), "PitchBook profile");
  assert.equal(hiddenReasonLabel("profile_not_company"), "PitchBook profile");
  assert.equal(hiddenReasonLabel("score_review"), "Score review");
  assert.equal(hiddenReasonLabel("unknown_reason"), "Hidden");
});
