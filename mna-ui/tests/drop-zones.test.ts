import assert from "node:assert/strict";
import test from "node:test";
import { allowedExtensions, dedupeKey, dropTargets, routeDrop } from "../src/ui/drop-zones";

test("every chooser target routes only to its explicit purpose; outside cancels", () => {
  for (const target of dropTargets) assert.equal(routeDrop(target.purpose), target.purpose);
  for (const outside of [null, undefined, "", "unknown", "company-data"]) assert.equal(routeDrop(outside), undefined);
});
test("allowed file types depend on the destination", () => {
  assert.deepEqual(allowedExtensions("pitchbook"), [".csv", ".xlsx"]);
  assert.deepEqual(allowedExtensions("rogo"), [".csv", ".xlsx"]);
  assert.deepEqual(allowedExtensions("intake"), [".pdf", ".docx", ".txt"]);
  assert.deepEqual(allowedExtensions("chat"), [".pdf", ".docx", ".txt", ".csv", ".xlsx"]);
});
test("dedupe keys bind content to the session and purpose without delimiter collisions", () => {
  assert.equal(dedupeKey("s", "pitchbook", "abc"), dedupeKey("s", "pitchbook", "abc"));
  assert.notEqual(dedupeKey("s", "pitchbook", "abc"), dedupeKey("s", "rogo", "abc"));
  assert.notEqual(dedupeKey("s", "chat", "abc"), dedupeKey("t", "chat", "abc"));
  assert.notEqual(dedupeKey("s", "chat", "abc"), dedupeKey("s", "chat", "def"));
  assert.notEqual(dedupeKey("s:chat", "chat", "abc"), dedupeKey("s", "chat:chat", "abc"));
});
