import { test } from "node:test";
import assert from "node:assert/strict";
import { productCopy } from "../src/lib/product-copy";

test("historical assistant and artifact copy uses current product terms", () => {
  assert.equal(
    productCopy("Attach your DDI and Ask M365 Copilot a question."),
    "Attach your Intake Form and a question for M365 Copilot.",
  );
  assert.equal(productCopy("LLMSuite can screen the saved companies."), "LLM Suite can screen the saved companies.");
});

test("historical copy no longer names the Rust layer", () => {
  assert.equal(
    productCopy("This example uses real Rust tools. Rust checkpoints remain saved."),
    "This example uses working tools. saved checkpoints remain saved.",
  );
});

test("product copy leaves unrelated business words unchanged", () => {
  assert.equal(
    productCopy("Trusted firms support industrial rust prevention."),
    "Trusted firms support industrial rust prevention.",
  );
});
