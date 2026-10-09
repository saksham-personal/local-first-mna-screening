import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
// @ts-expect-error Server-only ESM has no emitted declaration.
import { contentDisposition, resolveExportDownload } from "../server/bridge.mjs";
import { exportActivity, type ExportJob } from "../src/lib/screening-client";

const job: ExportJob = {
  export_id: "export_1", run_id: "run-1", kind: "pitchbook", state: "running",
  rows_done: 500, rows_total: 6000, started_at: "2026-10-08T00:00:00Z",
};

test("export Activity maps progress, completion, failures and download availability", () => {
  assert.deepEqual(exportActivity(job), {
    title: "Export · PitchBook", label: "Running", state: "running",
    percent: 500 / 6000 * 100, download: undefined,
  });
  const completed = exportActivity({ ...job, kind: "llm", state: "done", rows_done: 6000, file: "export_1.xlsx" });
  assert.equal(completed.title, "Export · LLM Suite");
  assert.equal(completed.label, "Completed");
  assert.equal(completed.state, "completed");
  assert.equal(completed.percent, 100);
  assert.equal(completed.download, "/api/exports/export_1");
  const failed = exportActivity({ ...job, kind: "full", state: "failed", file: "export_1.xlsx", error: "interrupted" });
  assert.equal(failed.title, "Export · Full data");
  assert.equal(failed.label, "Failed");
  assert.equal(failed.state, "error");
  assert.equal(failed.download, undefined);
  assert.equal(exportActivity({ ...job, state: "done" }).download, undefined);
  assert.equal(exportActivity({ ...job, rows_done: 7000 }).percent, 100);
  assert.equal(exportActivity({ ...job, rows_done: -1 }).percent, 0);
  assert.equal(exportActivity({ ...job, rows_total: 0, rows_done: 0 }).percent, 0);
  assert.equal(exportActivity({ ...job, rows_total: 0, rows_done: 0, state: "done" }).percent, 100);
});

test("export download accepts only a finished file and rejects ids and paths before filesystem access", async () => {
  const unavailableRoot = "does-not-exist";
  const status = { ...job, state: "done", file: "export_1.xlsx" };
  for (const id of ["", "..", "../outside", "a/b", "a\\b", "%2e%2e%2foutside", "a.xlsx", "a?x", 'a"x', String.fromCharCode(97, 10)]) {
    await assert.rejects(resolveExportDownload(unavailableRoot, id, { ...status, export_id: id }), /Invalid export id/);
  }
  for (const file of ["../outside.xlsx", "..\\outside.xlsx", "E:/outside.xlsx", "export_1.csv", "a.xlsx/other", 'a".xlsx', String.fromCharCode(97, 10) + ".xlsx"]) {
    await assert.rejects(resolveExportDownload(unavailableRoot, job.export_id, { ...status, file }), /not ready/);
  }
  await assert.rejects(resolveExportDownload(unavailableRoot, job.export_id, { ...status, export_id: "another" }), /not ready/);
  for (const state of ["running", "failed"]) {
    await assert.rejects(resolveExportDownload(unavailableRoot, job.export_id, { ...status, state }), /not ready/);
  }
  const testRoot = resolve(".screening-data", "export-download-tests");
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, "job-"));
  try {
    const exports = join(directory, "exports");
    await mkdir(exports);
    const file = join(exports, status.file);
    await writeFile(file, "test file");
    assert.equal(await resolveExportDownload(exports, job.export_id, status), await realpath(file));
    await assert.rejects(resolveExportDownload(exports, job.export_id, { ...status, file: "missing.xlsx" }), /ENOENT/);
  } finally {
    assert.ok(directory.startsWith(testRoot + "/") || directory.startsWith(testRoot + "\\"));
    await rm(directory, { recursive: true, force: true });
  }
});

test("export download header names the file readably with a printable ASCII fallback", () => {
  assert.equal(
    contentDisposition("Insurance software - Full data - 2026-10-09.xlsx"),
    `attachment; filename="Insurance software - Full data - 2026-10-09.xlsx"; filename*=UTF-8''Insurance%20software%20-%20Full%20data%20-%202026-10-09.xlsx`,
  );
  assert.equal(
    contentDisposition("Café – Données.xlsx"),
    `attachment; filename="Caf_ _ Donn_es.xlsx"; filename*=UTF-8''Caf%C3%A9%20%E2%80%93%20Donn%C3%A9es.xlsx`,
  );
  assert.equal(contentDisposition("a\"b\r\nc.xlsx"), `attachment; filename="a_b__c.xlsx"; filename*=UTF-8''a%22b%0D%0Ac.xlsx`);
  assert.equal(contentDisposition("it's (draft)*.xlsx"), `attachment; filename="it's (draft)*.xlsx"; filename*=UTF-8''it%27s%20%28draft%29%2A.xlsx`);
  assert.equal(contentDisposition("../secret/report.xlsx"), `attachment; filename="report.xlsx"; filename*=UTF-8''report.xlsx`);
});

test("export download rejects a directory link outside the export directory", async () => {
  const testRoot = resolve(".screening-data", "export-download-tests");
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, "link-"));
  try {
    const exports = join(directory, "exports");
    await mkdir(exports);
    const outside = join(directory, "outside");
    await mkdir(outside);
    await symlink(outside, join(exports, "escape.xlsx"), "junction");
    await assert.rejects(resolveExportDownload(exports, job.export_id, { ...job, state: "done", file: "escape.xlsx" }), /inside the export directory/);
  } finally {
    assert.ok(directory.startsWith(testRoot + "/") || directory.startsWith(testRoot + "\\"));
    await rm(directory, { recursive: true, force: true });
  }
});
