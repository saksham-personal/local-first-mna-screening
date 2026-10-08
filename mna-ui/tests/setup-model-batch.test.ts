import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { batchLimit, batchWarning, defaultBatchSize, loadScreeningModels, selectedModel, syncBatchSize, type ScreeningModels } from "../src/lib/screening-contract";

const models = JSON.parse(readFileSync(new URL("../server/llm-models.json", import.meta.url), "utf8")) as ScreeningModels;
test("editable bridge model list loads, defaults to the first model and retains a selected id", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async url => { assert.equal(url, "/api/screening/models"); return new Response(JSON.stringify(models)); }) as typeof fetch;
    const loaded = await loadScreeningModels();
    assert.deepEqual(loaded, models);
    assert.equal(selectedModel(loaded.llm_suite), "gpt-4.1");
    assert.equal(selectedModel(loaded.llm_suite, "gpt-4o"), "gpt-4o");
    assert.equal(selectedModel(loaded.copilot, "automatic"), "m365-copilot");
    assert.ok(!Object.values(loaded).flat().some(model => /automatic/i.test(model.label)));
  } finally { globalThis.fetch = original; }
});
test("model loading fails plainly on disconnected and malformed lists", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Disconnected" }), { status: 503 })) as typeof fetch;
    await assert.rejects(loadScreeningModels(), /Disconnected/);
    globalThis.fetch = (async () => new Response(JSON.stringify({ llm_suite: [], copilot: models.copilot }))) as typeof fetch;
    await assert.rejects(loadScreeningModels(), /model list is invalid/);
  } finally { globalThis.fetch = original; }
});
test("slider and numeric box use one bounded value for each provider", () => {
  assert.equal(defaultBatchSize("copilot"), 10);
  assert.equal(defaultBatchSize("llm_suite"), 25);
  assert.equal(batchLimit("llm_suite"), 200);
  assert.equal(batchLimit("copilot"), 50);
  for (const provider of ["llm_suite", "copilot"] as const) {
    for (const input of [1, 10, 25, 50, 200]) assert.equal(syncBatchSize(provider, String(input)), syncBatchSize(provider, input));
    assert.equal(syncBatchSize(provider, ""), 1);
    assert.equal(syncBatchSize(provider, 0), 1);
    assert.equal(syncBatchSize(provider, 999), batchLimit(provider));
  }
});
test("M365 context warning begins strictly above 20", () => {
  assert.equal(batchWarning("copilot", 20), "");
  assert.equal(batchWarning("copilot", 21), "Large M365 batches can lose web context; 10–20 is recommended.");
  assert.equal(batchWarning("llm_suite", 25), "");
});
