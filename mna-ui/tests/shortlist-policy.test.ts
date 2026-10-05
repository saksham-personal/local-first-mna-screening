import assert from "node:assert/strict";
import test from "node:test";
import { nextStepRecommendations } from "../src/lib/chat-policy";
import { meetsScoreRule } from "../src/lib/shortlist-review";
import { companies } from "../src/lib/fixtures";
import type { Company } from "../src/lib/contracts";

const context = (count: number, coverage = { PB: 0, ROGO: 0, BING: 0 }) => ({
  companies: Array.from({ length: count }, (_, i): Company => ({ ...companies[0], pk: `C-${i}`, considered: true, enrichment: {} })), coverage,
});
test("recommendations follow the active shortlist and strict threshold boundaries", () => {
  assert.deepEqual(nextStepRecommendations(context(2500)).recommended, ["llm"]);
  assert.deepEqual(nextStepRecommendations(context(2000)).recommended, []);
  assert.deepEqual(nextStepRecommendations(context(1000)).recommended, ["rogo"]);
  assert.deepEqual(nextStepRecommendations(context(500)).recommended, ["pitchbook", "bing"]);
  assert.deepEqual(nextStepRecommendations(context(750)).recommended, ["pitchbook", "bing", "rogo"]);
  assert.deepEqual(nextStepRecommendations(context(150, { PB: 100, ROGO: 0, BING: 0 })).recommended, ["pitchbook", "bing", "copilot"]);
  assert.ok(!nextStepRecommendations(context(250, { PB: 100, ROGO: 0, BING: 0 })).recommended.includes("copilot"));
  const reviewed = context(2500); reviewed.companies.forEach((company, i) => { company.considered = i < 400; });
  assert.equal(nextStepRecommendations(reviewed).count, 400);
  assert.ok(!nextStepRecommendations(reviewed).recommended.includes("llm"));
});
test("accordion defaults depend on coverage and count without interpreting empty source objects as hydration", () => {
  assert.equal(nextStepRecommendations(context(750)).uploadsOpen, true);
  assert.equal(nextStepRecommendations(context(400)).researchOpen, true);
  assert.equal(nextStepRecommendations(context(5000)).uploadsOpen, true);
  assert.equal(nextStepRecommendations(context(5001)).researchOpen, true);
  assert.equal(nextStepRecommendations(context(750, { PB: 0, ROGO: 20, BING: 0 })).researchOpen, true);
  const empty = context(750); empty.companies[0].enrichment = { BING: {} };
  assert.equal(nextStepRecommendations(empty).hydrated, false);
  empty.companies[0].enrichment = { PB_Name: '', PB_Website: '#N/A' };
  assert.equal(nextStepRecommendations(empty).pb, false);
});
test("score review preserves CHECK separately from unscored rows and rejects malformed numeric values", () => {
  const answers = [4, "4.5", "CHECK", " check ", "", null, "4/10", "-1", "11", "NaN"];
  assert.deepEqual(answers.filter(value => meetsScoreRule(value, 4, true, false)), [4, "4.5", "CHECK", " check "]);
  assert.equal(meetsScoreRule("CHECK", 7, false, true), false);
  assert.equal(meetsScoreRule(undefined, 7, true, false), false);
  assert.equal(meetsScoreRule(undefined, 7, true, true), true);
});
