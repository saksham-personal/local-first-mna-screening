import test from "node:test";
import assert from "node:assert/strict";
import { buildCatalog, defaultScreeningConfig, validateConfig } from "../shared/screening.mjs";
import { batchLimit, defaultBatchSize, type ScreeningProvider } from "../src/lib/screening-contract";

const catalog = buildCatalog([]);
const withBatch = (provider: ScreeningProvider, batchSize: number) => ({
  ...defaultScreeningConfig(provider, "screening", "insurance"),
  model: "deployment",
  batchSize,
});

test("M365 batches are capped at 50 on the server: 50 is accepted and 51 is rejected", () => {
  assert.equal(validateConfig(withBatch("copilot", 1), catalog).batchSize, 1);
  assert.equal(validateConfig(withBatch("copilot", 50), catalog).batchSize, 50);
  assert.throws(() => validateConfig(withBatch("copilot", 51), catalog), {
    message: "Batch size must be between 1 and 50 for M365.",
  });
});

test("LLMSuite keeps its existing batch limit of 200", () => {
  assert.equal(validateConfig(withBatch("llm_suite", 51), catalog).batchSize, 51);
  assert.equal(validateConfig(withBatch("llm_suite", 200), catalog).batchSize, 200);
  assert.throws(() => validateConfig(withBatch("llm_suite", 201), catalog), {
    message: "Batch size must be between 1 and 200.",
  });
});

test("batch sizes must be whole numbers from 1 up to the provider limit", () => {
  for (const provider of ["llm_suite", "copilot"] as const) {
    for (const batchSize of [0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => validateConfig(withBatch(provider, batchSize), catalog),
        /Batch size must be between 1 and \d+/,
      );
    }
  }
});

test("server defaults match the setup dialog: M365 10, LLMSuite 25", () => {
  assert.equal(defaultScreeningConfig("copilot", "screening", "insurance").batchSize, 10);
  assert.equal(defaultScreeningConfig("llm_suite", "screening", "insurance").batchSize, 25);
  for (const provider of ["llm_suite", "copilot"] as const) {
    const config = defaultScreeningConfig(provider, "screening", "insurance");
    assert.equal(config.batchSize, defaultBatchSize(provider));
    assert.equal(validateConfig(config, catalog).batchSize, defaultBatchSize(provider));
  }
});

test("server and setup dialog agree on each provider's limit", () => {
  for (const provider of ["llm_suite", "copilot"] as const) {
    const limit = batchLimit(provider);
    assert.equal(validateConfig(withBatch(provider, limit), catalog).batchSize, limit);
    assert.throws(() => validateConfig(withBatch(provider, limit + 1), catalog), /Batch size must be between 1 and/);
  }
});
