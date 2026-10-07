import { test } from "node:test";
import assert from "node:assert/strict";
import { createFileAdapter } from "../src/lib/chat-driver";
import { attachmentError } from "../src/lib/attachment-policy";
import { getChatState } from "../src/lib/chat-store";
import { sessionStore } from "../src/lib/session-store";

test("picked and dropped files use the same supported extensions and size boundary", () => {
  for (const name of [
    "Intake Form.pdf",
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

test("adding a chat attachment stages it immediately without sending it to a provider", async () => {
  const previous = globalThis.fetch, priorReader = globalThis.FileReader;
  let calls = 0;
  class Reader {
    result = ''; onload: (() => void) | null = null; onerror: (() => void) | null = null;
    readAsDataURL(file: File) { void file.arrayBuffer().then(buffer => { this.result = `data:application/pdf;base64,${Buffer.from(buffer).toString('base64')}`; this.onload?.(); }); }
  }
  globalThis.FileReader = Reader as unknown as typeof FileReader;
  globalThis.fetch = async url => {
    calls++; assert.equal(url, '/api/files');
    return new Response(JSON.stringify({ files: [{ id: 'staged-pdf.pdf', name: 'brief.pdf', kind: 'pdf', bytes: 16 }] }));
  };
  try {
    const id = sessionStore.createSession('Isolated attachment draft');
    const adapter = createFileAdapter(id);
    const attachment = await adapter.add({ file: new File(['%PDF-1.7 fixture'], 'brief.pdf', { type: 'application/pdf' }) });
    assert.ok('name' in attachment);
    assert.equal(attachment.name, 'brief.pdf');
    assert.equal(attachment.status.type, 'requires-action');
    assert.equal(calls, 1);
    const staged = getChatState(id).files[0];
    assert.equal(staged.purpose, 'chat');
    assert.equal(staged.passToProvider, true);
  } finally { globalThis.fetch = previous; globalThis.FileReader = priorReader; }
});

test("unsupported file drops are rejected by the adapter before staging", async () => {
  const adapter = createFileAdapter("invalid-attachment-draft");
  await assert.rejects(
    async () => adapter.add({ file: new File(["content"], "file.zip") }),
    /use a PDF/,
  );
});
