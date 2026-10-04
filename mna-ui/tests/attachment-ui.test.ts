import { test } from "node:test";
import assert from "node:assert/strict";
import { createFileAdapter } from "../src/lib/chat-driver";
import { attachmentError } from "../src/lib/attachment-policy";
import { productCopy } from "../src/lib/product-copy";

test("picked and dropped files use the same supported extensions and size boundary", () => {
  for (const name of [
    "DDI.PDF",
    "criteria.docx",
    "brief.txt",
    "mapping.csv",
    "data.xlsx",
  ]) {
    assert.equal(attachmentError({ name, size: 20 * 1024 * 1024 }), undefined);
  }
  assert.match(
    attachmentError({ name: "criteria.pdf.exe", size: 10 })!,
    /use a PDF/,
  );
  assert.match(attachmentError({ name: "empty.pdf", size: 0 })!, /empty/);
  assert.match(
    attachmentError({ name: "large.pdf", size: 20 * 1024 * 1024 + 1 })!,
    /too large/,
  );
});

test("adding an attachment waits for Send and does not stage bytes or create approval", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("Unexpected staging");
  };
  try {
    const adapter = createFileAdapter("isolated-attachment-draft");
    const file = new File(["%PDF-1.7 fixture"], "brief.pdf", {
      type: "application/pdf",
    });
    const attachment = await adapter.add({ file });
    assert.ok("status" in attachment);
    assert.equal(attachment.name, "brief.pdf");
    assert.deepEqual(attachment.status, {
      type: "requires-action",
      reason: "composer-send",
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test("unsupported file drops are rejected by the adapter before staging", async () => {
  const adapter = createFileAdapter("invalid-attachment-draft");
  await assert.rejects(
    async () => adapter.add({ file: new File(["content"], "file.zip") }),
    /use a PDF/,
  );
});

test("historical assistant copy uses product terms while preserving business words", () => {
  assert.equal(
    productCopy(
      "This example uses real Rust tools. Rust checkpoints remain saved.",
    ),
    "This example uses working tools. saved checkpoints remain saved.",
  );
  assert.equal(
    productCopy("Trusted firms support industrial rust prevention."),
    "Trusted firms support industrial rust prevention.",
  );
});
