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

// @ts-expect-error The bridge policy is a native Node module.
import { indexUploadMaxBytes, validateIndexWorkbookName, validateIndexWorkbookSignature, validateIndexUploadSize } from "../server/upload-policy.mjs";
test("streaming index uploads validate names and the full ZIP local header", () => {
  assert.equal(validateIndexWorkbookName("MID.XLSX"), "MID.XLSX");
  for (const name of [null, "", "mid.csv", "../mid.xlsx", "C:\\mid.xlsx", "bad\n.xlsx", "x".repeat(256) + ".xlsx"]) assert.throws(() => validateIndexWorkbookName(name));
  validateIndexWorkbookSignature(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  for (const bytes of [[], [0x50, 0x4b], [0x50, 0x4b, 0x05, 0x06], [1, 2, 3, 4]]) assert.throws(() => validateIndexWorkbookSignature(Buffer.from(bytes)), /not an XLSX/);
  assert.deepEqual(allowedUploadExtensions("mid_index"), allowedExtensions("mid_index"));
});
test("index upload cap defaults safely and reports a 413 on overflow", () => {
  for (const input of [undefined, "", "NaN", "0", "-1", "1.5", "Infinity"]) assert.equal(indexUploadMaxBytes(input), 1024 ** 3);
  assert.equal(indexUploadMaxBytes("1024"), 1024);
  validateIndexUploadSize(1024, 1024);
  assert.throws(() => validateIndexUploadSize(1025, 1024), (error: unknown) => error instanceof Error && (error as Error & { status: number }).status === 413 && /1,024 bytes/.test(error.message));
});
