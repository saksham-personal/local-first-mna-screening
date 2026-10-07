import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchScreeningGrid,
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
    assert.equal(requests[0].limit, 2000);
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
