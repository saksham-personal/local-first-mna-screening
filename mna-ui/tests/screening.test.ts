import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCatalog,
  defaultScreeningConfig,
  markdownInputs,
  projectIdentity,
  projectRows,
  suggestOutputColumns,
  validateConfig,
} from "../src/lib/screening-data";
import { companyFromRust } from "../src/lib/tool-client";
import type { Company } from "../src/lib/contracts";
import type { ScreeningSourceRow } from "../src/lib/screening-contract";
// @ts-expect-error Server-only ESM has no emitted declaration.
import { createScreeningPreparation } from "../server/screening.mjs";

const source: ScreeningSourceRow = {
  pk: "A-1",
  PBId: "PB-1",
  sources: {
    MID: {
      "Company Name": "MID name",
      Website: "mid.example",
      Description: "MID description",
      Sector: "Insurance",
    },
    ISCC: {
      "Company Name": "ISCC name",
      Website: "iscc.example",
      Description: "ISCC description",
    },
    PB: {
      PB_Name: "PB name",
      PB_Website: " #N/A ",
      PB_Description: "PB description",
      "PB_LinkedIn URL": "",
    },
    ROGO: { Answer: "Adds policy software" },
  },
  provenance: { MID: [{ row_hash: "original" }] },
};
test("prefers each usable PB identity independently and retains all descriptions", () => {
  assert.deepEqual(projectIdentity(source), {
    name: "PB name",
    website: "mid.example",
    description:
      "PitchBook Latest Description: PB description\nMID Description: MID description\nISCC Description: ISCC description",
  });
  const onlyISCC = {
    ...source,
    PBId: null,
    sources: { MID: {}, ISCC: source.sources.ISCC, PB: {}, ROGO: {} },
  };
  assert.equal(projectIdentity(onlyISCC).name, "ISCC name");
  assert.equal(
    projectIdentity(onlyISCC).description,
    "ISCC Description: ISCC description",
  );
});
test("source-specific values remain blank and LinkedIn never falls back to a non-PB field", () => {
  const rows = [
    source,
    {
      ...source,
      pk: "B-2",
      PBId: null,
      sources: {
        MID: {
          "Company Name": "Other",
          "LinkedIn URL": "https://linkedin.com/company/nonpb",
        },
        ISCC: {},
        PB: {},
        ROGO: {},
      },
    },
  ];
  const catalog = buildCatalog(rows),
    config = defaultScreeningConfig(
      "copilot",
      "question",
      "",
      "Which product does each company offer?",
    );
  config.inputColumns.push("ISCC:Description", "ROGO:Answer", "MID:Sector");
  const projected = projectRows(rows, validateConfig(config, catalog));
  assert.equal(projected[1]["ISCC:Description"], "");
  assert.equal(projected[1]["LinkedIn URL"], "");
  assert.equal(projected[1].PBId, "");
  assert.equal(projected[1]["ROGO:Answer"], "");
  assert.equal(
    catalog.sources.find((s) => s.source === "ISCC")?.companyCount,
    1,
  );
  assert.equal(
    catalog.sources.find((s) => s.source === "ROGO")?.fields[0].count,
    1,
  );
  assert.deepEqual(config.outputColumns, ["index", "Answer"]);
  const withLinkedIn = (url: string) => ({
    ...source,
    sources: {
      ...source.sources,
      PB: { ...source.sources.PB, "PB_LinkedIn URL": url },
    },
  });
  assert.equal(
    projectRows(
      [withLinkedIn("https://www.linkedin.com/company/real")],
      config,
    )[0]["LinkedIn URL"],
    "https://www.linkedin.com/company/real",
  );
  assert.equal(
    projectRows(
      [withLinkedIn("https://linkedin.com.other.example/company/spoof")],
      config,
    )[0]["LinkedIn URL"],
    "",
  );
});
test("selected data columns retain valid zero values instead of treating them as missing identifiers", () => {
  const rows = [
    { ...source, sources: { ...source.sources, MID: { Revenue: 0 } } },
  ];
  const config = defaultScreeningConfig(
    "llm_suite",
    "question",
    "",
    "Show the reported values",
  );
  config.inputColumns.push("MID:Revenue");
  assert.equal(projectRows(rows, config)[0]["MID:Revenue"], "0");
  assert.equal(buildCatalog(rows).sources[0].fields[0].count, 1);
});
test("editable columns validate uniqueness and immutable index, with transparent local suggestions", () => {
  const config = defaultScreeningConfig(
    "llm_suite",
    "screening",
    "policy administration",
  );
  const catalog = buildCatalog([source]);
  assert.deepEqual(
    suggestOutputColumns(
      "Output columns: Product, Evidence, Confidence",
      "question",
    ),
    ["index", "Product", "Evidence", "Confidence"],
  );
  assert.throws(
    () =>
      validateConfig({ ...config, outputColumns: ["index", "PBId"] }, catalog),
    /cannot echo/,
  );
  assert.throws(
    () =>
      validateConfig(
        { ...config, outputColumns: ["index", "Score", "score"] },
        catalog,
      ),
    /unique/,
  );
  assert.throws(
    () => validateConfig({ ...config, inputColumns: ["pk", "index"] }, catalog),
    /first/,
  );
  assert.throws(
    () =>
      validateConfig(
        { ...config, inputColumns: ["index", "PB:missing"] },
        catalog,
      ),
    /no longer/,
  );
  assert.equal(validateConfig(config, catalog, true).model, "");
  assert.equal(
    validateConfig({ ...config, model: " chosen-deployment " }, catalog, true)
      .model,
    "chosen-deployment",
  );
});
test("Markdown input data escapes pipe, markup and multiline description cells", () => {
  const table = markdownInputs(
    [{ index: 26, Description: "a | b\n<script>x</script>" }],
    ["index", "Description"],
  );
  assert.match(table, /26 \| a \\\| b<br>&lt;script&gt;x&lt;\/script&gt;/);
});
test("company refresh preserves actual ISCC/MID observations across blank PB enrichment", () => {
  const original: Company = {
    pk: "A-1",
    ecid: "A",
    cid: "1",
    name: "ISCC name",
    website: "iscc.example",
    city: "",
    state: "",
    source: "both",
    description: "",
    signal: "Needs research",
    tags: [],
    rawMid: { ...source.sources.MID } as Record<string, string>,
    rawIscc: { ...source.sources.ISCC } as Record<string, string>,
  };
  const canonical = {
    company_id: "A-1",
    name: "canonical overwrite",
    website: "canonical.example",
    description: "canonical overwrite",
    PB_Name: " ",
    PB_Website: "",
    PB_Description: "PB description",
    linkedin_url: "https://linkedin.com/company/nonpb",
  };
  const refreshed = companyFromRust(
    { company: canonical },
    canonical,
    original,
  );
  assert.equal(refreshed.name, "MID name");
  assert.equal(refreshed.website, "mid.example");
  assert.equal(refreshed.rawMid?.Description, "MID description");
  assert.equal(refreshed.rawIscc?.Description, "ISCC description");
  assert.equal(refreshed.linkedin, undefined);
  assert.match(refreshed.description, /PitchBook Latest Description/);
  assert.match(refreshed.description, /ISCC Description/);
});

function fixture() {
  let rows = [structuredClone(source)],
    version = 1,
    clock = 1000;
  const records = new Map<string, Record<string, any>>();
  const executed: string[] = [];
  const call = async (tool: string, args: Record<string, any>) => {
    executed.push(tool);
    if (tool === "get_run_context")
      return {
        run_id: args.run_id,
        active_profile_version: version,
        active_criteria_version: 1,
      };
    if (tool === "get_candidate_source_data")
      return {
        run_id: args.run_id,
        total: rows.length,
        rows,
        next_cursor: null,
      };
    if (tool === "get_checkpoint") {
      if (!records.has(args.namespace)) throw new Error("checkpoint not found");
      return records.get(args.namespace);
    }
    if (tool === "save_checkpoint") {
      assert.equal(args.expected_sequence, 0);
      assert.ok(!records.has(args.namespace));
      const saved = { ...args, sequence: 1 };
      records.set(args.namespace, saved);
      return saved;
    }
    if (tool === "create_run") return { run_id: args.run_id };
    throw new Error(`Unexpected provider call ${tool}`);
  };
  return {
    service: createScreeningPreparation({ call, now: () => clock }),
    records,
    executed,
    setRows: (value: ScreeningSourceRow[]) => {
      rows = value;
    },
    setVersion: (value: number) => {
      version = value;
    },
    expire: () => {
      clock += 16 * 60_000;
    },
  };
}
test("approval saves frozen data and exact index mapping once, with no provider call", async () => {
  const f = fixture(),
    config = {
      ...defaultScreeningConfig("copilot", "screening", "insurance"),
      model: "chosen-later",
    };
  const { preview } = await f.service.preview({ runId: "run-1", config });
  const request = {
    runId: "run-1",
    config,
    fingerprint: preview.fingerprint,
    approved: true,
  };
  const [first, second] = await Promise.all([
    f.service.approve(request),
    f.service.approve(request),
  ]);
  assert.equal(first.prepared.id, second.prepared.id);
  assert.equal(first.prepared.executed, false);
  assert.equal(f.records.size, 2);
  const data = [...f.records.values()].find((record) => record.state.rows);
  assert.equal(data?.state.rows[0].index, 1);
  assert.equal(data?.state.rows[0].pk, "A-1");
  assert.equal(data?.state.rows[0].input.Website, "mid.example");
  const manifest = [...f.records.values()].find(
    (record) => record.state.prepared,
  );
  assert.equal(manifest?.state.protocol.externalExecution, false);
  assert.equal(manifest?.state.protocol.outputHeaders[0], "index");
  assert.ok(
    f.executed.every(
      (tool) => !tool.includes("screening_batch") && !tool.includes("research"),
    ),
  );
});
test("source changes, profile changes, edited prompt, missing approval, and expired previews refuse approval", async () => {
  for (const change of ["data", "profile", "prompt", "approval", "expiry"]) {
    const f = fixture(),
      config = {
        ...defaultScreeningConfig("llm_suite", "screening", "insurance"),
        model: "later",
      };
    const { preview } = await f.service.preview({ runId: "run-1", config });
    const request = {
      runId: "run-1",
      config,
      fingerprint: preview.fingerprint,
      approved: true,
    };
    if (change === "data")
      f.setRows([
        {
          ...source,
          sources: { ...source.sources, PB: { PB_Name: "changed" } },
        },
      ]);
    if (change === "profile") f.setVersion(2);
    if (change === "prompt") request.config = { ...config, prompt: "edited" };
    if (change === "approval") request.approved = false;
    if (change === "expiry") f.expire();
    await assert.rejects(f.service.approve(request));
    assert.equal(f.records.size, 0, change);
  }
});
test("general question preparation works without a company scope or criteria approval", async () => {
  const f = fixture(),
    config = {
      ...defaultScreeningConfig(
        "copilot",
        "question",
        "",
        "What questions should I ask about claims software?",
      ),
      model: "later",
    };
  const { preview } = await f.service.preview({ config });
  assert.equal(preview.companyCount, 0);
  assert.equal(preview.batches, 1);
  const { prepared } = await f.service.approve({
    config,
    fingerprint: preview.fingerprint,
    approved: true,
  });
  assert.equal(prepared.mode, "question");
  assert.deepEqual(prepared.config.outputColumns, ["index", "Answer"]);
  assert.ok(prepared.checkpoint.runId.startsWith("QUESTION-"));
  assert.equal(f.records.size, 1);
});
