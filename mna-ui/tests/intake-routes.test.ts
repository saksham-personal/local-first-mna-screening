import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeIntake } from "../server/intake-routes.mjs";

test("routeIntake reads a staged text file and returns bounded text plus extracted fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "intake-route-"));
  try {
    const path = join(directory, "intake.txt");
    const text = "Submitter name: Casey Morgan\nIndustry: Diversified\nSector: Basic Materials\nInvestment thesis: Find building products makers.";
    await writeFile(path, text);
    const stagedFiles = new Map([["intake-id", { id: "intake-id", name: "intake.txt", path, bytes: (await stat(path)).size }]]);
    const result = await routeIntake({ fileId: "intake-id" }, stagedFiles);
    assert.equal(result.fileId, "intake-id");
    assert.equal(result.fileName, "intake.txt");
    assert.equal(result.text, text);
    assert.equal(result.fields.submitterName, "Casey Morgan");
    assert.equal(result.fields.industry, "Diversified");
    assert.equal(result.fields.sector, "Basic Materials");
    assert.ok(result.matched.includes("Investment thesis"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("routeIntake only accepts staged PDF, DOCX, or TXT files", async () => {
  await assert.rejects(routeIntake({ fileId: "missing" }, new Map()), /staged file/i);
  await assert.rejects(routeIntake({ fileId: "csv-id" }, new Map([["csv-id", { id: "csv-id", name: "data.csv", path: "ignored", bytes: 0 }]])), /PDF, DOCX, or TXT/i);
});
