import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error The bridge's policy is a native Node module.
import { allowedUploadExtensions, uploadDedupeKey, validateUploadPurpose, withUploadLock } from "../server/upload-policy.mjs";
import { allowedExtensions } from "../src/ui/drop-zones";

test("bridge and UI destination policies agree, including Intake Form", () => {
  for (const purpose of ["chat", "pitchbook", "rogo", "intake", "company-data"] as const) assert.deepEqual(allowedUploadExtensions(purpose), allowedExtensions(purpose));
  validateUploadPurpose("Mapping.CSV", "pitchbook");
  validateUploadPurpose("research.xlsx", "rogo");
  validateUploadPurpose("Intake.PDF", "intake");
  assert.throws(() => validateUploadPurpose("Original intake.pdf", "pitchbook"), /Original intake.pdf: PitchBook data accepts/);
  assert.throws(() => validateUploadPurpose("export.xlsx", "intake"), /export.xlsx: Intake Form accepts/);
  assert.throws(() => validateUploadPurpose("source.csv", "unknown"));
});
test("bridge hashes actual bytes and separates sessions and purposes", () => {
  const bytes = Buffer.from("abc");
  const key = uploadDedupeKey("s", "chat", bytes);
  assert.match(key, /ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad/);
  assert.equal(key, uploadDedupeKey("s", "chat", Buffer.from("abc")));
  assert.notEqual(key, uploadDedupeKey("s", "pitchbook", bytes));
  assert.notEqual(key, uploadDedupeKey("t", "chat", bytes));
  assert.notEqual(key, uploadDedupeKey("s", "chat", Buffer.from("abcd")));
});
test("identical concurrent uploads share the manifest lock, which recovers after errors", async () => {
  const manifest = new Map(), order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = withUploadLock(manifest, async () => { order.push("first"); await gate; order.push("saved"); throw new Error("failed"); });
  const second = withUploadLock(manifest, async () => { order.push("second"); });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(order, ["first"]);
  release();
  await assert.rejects(first, /failed/);
  await second;
  assert.deepEqual(order, ["first", "saved", "second"]);
});
