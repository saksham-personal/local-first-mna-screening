import { test } from "node:test";
import assert from "node:assert/strict";
import { exampleDefinition } from '../src/lib/chat-policy';
// The production scheduler is intentionally plain Node ESM so the bridge runs without a compile step.
// @ts-expect-error No declaration file is emitted for this server-only module.
import { companyEntryFromGridRow, createJobRegistry } from "../server/jobs.mjs";
import { companyFromRust, type SearchRow } from "../src/lib/tool-client";

const definition =
  "Veterinary appointment scheduling platform for independent clinics";
const input = {
  sessionId: "session-1",
  criteriaApproved: true,
  title: "Veterinary software",
  criteriaText: "Find veterinary scheduling software businesses",
  definition,
};

function shortlistPage(candidates: { company_id: string; name: string; considered: boolean; website?: string | null }[], args: Record<string, unknown>, sourceHash = "stable-source") {
  const cursor = String(args.after_company_id ?? "");
  const remaining = candidates.filter(candidate => candidate.company_id > cursor);
  const size = Number(args.limit);
  const page = remaining.slice(0, size);
  return {
    total: candidates.length,
    considered_count: candidates.filter(candidate => candidate.considered).length,
    source_hash: sourceHash,
    selection_revision: 1,
    candidates: page,
    has_more: remaining.length > page.length,
    next_after_company_id: remaining.length > page.length ? page.at(-1)?.company_id : null,
  };
}

type GridCompany = { company_id: string; name: string; considered: boolean; website?: string | null; [key: string]: unknown };

function screeningGridRow(candidate: { company_id: string; name: string; considered: boolean; website?: string }): GridCompany {
  return {
    ...candidate,
    website: candidate.website ?? null,
    hq_city: "Boston",
    hq_state: "MA",
    description: "Claims workflow software",
    source: "MID",
    mid_score: 0.91,
    iscc_score: null,
    pb: {},
    company_payload: {
      identifiers: [{ kind: "PK", value: candidate.company_id }],
      keywords: [],
      rogo: {},
      has_enrichment: false,
      mid_source_row: { "Company Name": candidate.name, Description: "Raw MID description" },
      name: candidate.name, website: candidate.website ?? null, description: "Claims workflow software",
    },
  };
}

function screeningGridPage(candidates: GridCompany[], args: Record<string, unknown>, sourceHash = "stable-source") {
  const cursor = String(args.after_company_id ?? "");
  const remaining = candidates.filter(candidate => candidate.company_id > cursor);
  const size = Number(args.limit);
  const rows = remaining.slice(0, size);
  const next = remaining.length > rows.length ? rows.at(-1)?.company_id ?? null : null;
  return {
    run_id: "rust-run-1",
    total: candidates.length,
    considered_count: candidates.filter(candidate => candidate.considered).length,
    hidden_count: candidates.filter(candidate => !candidate.considered).length,
    source_hash: sourceHash,
    selection_revision: 1,
    rows,
    next_cursor: next,
  };
}

type Call = (
  tool: string,
  args: Record<string, unknown>,
  approved: boolean,
  signal: AbortSignal,
) => Promise<Record<string, unknown>>;
type JobEvent = {
  id: string;
  type: "tool-start" | "tool-result" | "tool-error";
  tool: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  timestamp: string;
};

test('example discovery searches positive business text and passes only approved exclusions separately', async () => {
  let profile: Record<string, unknown> = {};
  const queries: Record<string, unknown>[] = [];
  const jobs = registry(async (tool, args) => {
    if (tool === 'create_run') { profile = args.initial_profile as Record<string, unknown>; return {run_id: 'example-run'}; }
    if (tool === 'get_active_screening_profile') return {content: profile, status: 'APPROVED'};
    if (tool === 'search_mid') {
      assert.doesNotMatch(String(args.query), /\b(?:exclude|NOT)\b/i);
      assert.equal(args.limit, 1000);
      assert.deepEqual(args.filters, {exclude_keywords: profile.core_business_exclusions});
      queries.push(args);
      return {query_id: 'positive-query', results: []};
    }
    if (tool === 'get_screening_grid') return screeningGridPage([], args);
    if (tool === 'get_shortlist_context') return shortlistPage([], args);
    if (tool === 'get_candidate_set') return {candidates: []};
    if (tool === 'get_discovery_summary') return {mid_only: 0, iscc_only: 0, both: 0, total_unique: 0};
    return response(tool, args);
  });
  const started = jobs.create({...input, definition: exampleDefinition});
  assert.equal((await jobs.wait(started.id)).state, 'completed');
  assert.equal(queries.length, 2);
  assert.deepEqual(profile.core_business_exclusions, ['broker marketplaces', 'generic CRM', 'pure consulting', 'outsourced claims services']);
  assert.equal(profile.business_definition, exampleDefinition);
});

function registry(call: Call) {
  let sequence = 0;
  return createJobRegistry({
    call,
    uuid: () => `id-${++sequence}`,
    now: () => new Date(1_700_000_000_000 + sequence).toISOString(),
  });
}

test("grid paging preserves every MID Company field from the former detail and source-row path", () => {
  const midSource = {
    "Company Name": "Claims Corp",
    Website: "mid.example",
    Description: "Claims workflow software",
    ECID: "E77",
    CID: "77",
    "HQ City": "Boston",
    "HQ State": "MA",
    "MID Segment": "Claims",
  };
  const detail = {
    company_id: "MID-77",
    name: "Claims Corp",
    website: "mid.example",
    description: "Claims workflow software",
    city: "Boston",
    metadata: { hq_state: "MA" },
    identifiers: [
      { kind: "PK", value: "MID-77" },
      { kind: "ECID", value: "E77" },
      { kind: "CID", value: "77" },
      { kind: "PBID", value: "PB-77" },
    ],
    keywords: ["claims", "workflow"],
    "PB_Website": "pb.example",
    "PB_Name": "Claims platform",
    "PB_Description": "PB description",
    "PB_LinkedIn URL": "https://linkedin.example/claims",
    "PB_HQ Location": "Boston, MA",
    "PB_Active Investors": "Investor One",
    "PB_Universe": "Software",
    ROGO: { Revenue: "$10m" },
  };
  const grid = {
    ...screeningGridRow({ company_id: "MID-77", name: "Claims platform", website: "pb.example", considered: true }),
    // The grid's own description is a labelled projection; the bridge must use the raw one.
    description: ["PitchBook Latest Description: PB description", "MID Description: Claims workflow software"].join("\n"),
    mid_score: 0.9,
    company_payload: {
      identifiers: detail.identifiers,
      keywords: detail.keywords,
      rogo: detail.ROGO,
      has_enrichment: true,
      mid_source_row: midSource,
      name: detail.name, website: detail.website, description: detail.description,
    },
    pb: {
      name: detail["PB_Name"],
      website: detail["PB_Website"],
      description: detail["PB_Description"],
      linkedin_url: detail["PB_LinkedIn URL"],
      hq_location: detail["PB_HQ Location"],
      active_investors: detail["PB_Active Investors"],
      universe: detail["PB_Universe"],
    },
  };
  const gridEntry = companyEntryFromGridRow(grid);
  const oldEntry = {
    row: {
      company: { company_id: "MID-77", name: "Claims Corp", website: "mid.example" },
      considered: true,
      // The old path uses the same best MID score now supplied on every grid row.
      score: 0.9,
      rank: 1,
    },
    detail,
    sourceRows: [{ source: "MID", row: midSource }],
  };
  const mapCompany = (entry: typeof oldEntry) => {
    const company = companyFromRust(entry.row as SearchRow, entry.detail);
    const source = entry.sourceRows.find((row) => row.source === "MID");
    if (source?.row && typeof source.row === "object")
      company.rawMid = source.row as Record<string, string | number>;
    return company;
  };
  const mappedGridCompany = mapCompany(gridEntry as typeof oldEntry);
  const mappedOldCompany = mapCompany(oldEntry);
  assert.deepEqual(mappedGridCompany, mappedOldCompany);
  assert.equal(mappedGridCompany.midScore, grid.mid_score);
});

function response(
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  switch (tool) {
    case "create_run":
      return { run_id: "rust-run-1" };
    case "get_mid_index_status":
      return { active: null };
    case "import_company_files":
      return { imported: 8 };
    case "approve_screening_profile":
      return { run_id: "rust-run-1", version: 1 };
    case "get_active_screening_profile":
      return {
        run_id: "rust-run-1",
        version: 1,
        content: { business_definition: definition },
        status: "APPROVED",
      };
    case "search_mid":
      return args.query === definition
        ? {
            query_id: "query-1",
            results: [
              {
                company: { company_id: "MID-A", name: "Alpha" },
                score: 1.37,
                rank: 1,
              },
            ],
          }
        : { query_id: "query-2", results: [] };
    case "add_candidates":
      return { added: 1 };
    case "get_candidate_set":
      return {
        candidates: [
          {
            company_id: "MID-A",
            company: { company_id: "MID-A", name: "Alpha" },
            considered: true,
            discovery: [{ source: "MID", retrieval_score: 1.37, rank: 1 }],
          },
        ],
      };
    case "get_screening_grid":
      return screeningGridPage([
        {
          ...screeningGridRow({ company_id: "MID-A", name: "Alpha", considered: true }),
          mid_score: 1.37,
          company_payload: {
            identifiers: [{ kind: "PK", value: "MID-A" }],
            keywords: [],
            rogo: {},
            has_enrichment: false,
            mid_source_row: { "Company Name": "Alpha", Description: "Raw MID description" },
            name: "Alpha", website: null, description: "Claims workflow software",
          },
        },
      ], args);
    case "get_shortlist_context":
      return shortlistPage([{ company_id: "MID-A", name: "Alpha", considered: true }], args);
    case "get_discovery_summary":
      return { mid_only: 1, iscc_only: 0, both: 0, other: 0, total_unique: 1 };
    case "save_checkpoint":
      return { namespace: "screening-ui", sequence: 1 };
    default:
      throw new Error(`Unexpected tool ${tool}`);
  }
}

test("background job runs the real-tool sequence, preserves native rows, and pairs stable event IDs", async () => {
  const calls: {
    tool: string;
    args: Record<string, unknown>;
    approved: boolean;
  }[] = [];
  const jobs = registry(async (tool, args, approved) => {
    calls.push({ tool, args, approved });
    return response(tool, args);
  });

  const started = jobs.create(input);
  assert.equal(started.state, "running");
  assert.equal(started.events.length, 0);
  const completed = await jobs.wait(started.id);
  assert.ok(completed);
  assert.equal(completed.state, "completed");
  assert.equal(completed.result.backendRunId, "rust-run-1");
  assert.deepEqual(completed.result.counts, {
    midOnly: 1,
    isccOnly: 0,
    both: 0,
  });
  assert.deepEqual(completed.result.companies[0], {
    row: {
      company: { company_id: "MID-A", name: "Alpha" },
      considered: true,
      score: 1.37,
      rank: 1,
    },
    detail: {
      company_id: "MID-A",
      name: "Alpha",
      website: null,
      description: "Claims workflow software",
      city: "Boston",
      metadata: { hq_state: "MA" },
      identifiers: [{ kind: "PK", value: "MID-A" }],
      keywords: [],
      PB_Website: null,
      PB_Name: null,
      PB_Description: null,
      "PB_LinkedIn URL": null,
      "PB_HQ Location": null,
      "PB_Active Investors": null,
      PB_Universe: null,
    },
    sourceRows: [
      { source: "MID", row: { "Company Name": "Alpha", Description: "Raw MID description" } },
    ],
  });

  const names = calls.map((call) => call.tool);
  assert.deepEqual(names.slice(0, 5), [
    "create_run",
    "approve_screening_profile",
    "get_active_screening_profile",
    "get_mid_index_status",
    "import_company_files",
  ]);
  assert.equal(names.filter((name) => name === "search_mid").length, 2);
  assert.ok(
    names.indexOf("get_active_screening_profile") < names.indexOf("search_mid"),
  );
  assert.ok(names.indexOf("get_screening_grid") < names.indexOf("get_discovery_summary"));
  assert.equal(names.some((name) => ["get_company", "get_source_rows", "get_company_context"].includes(name)), false);
  assert.deepEqual(calls.find((call) => call.tool === "get_screening_grid")?.args, {
    run_id: "rust-run-1",
    include_hidden: true,
    include_company_payload: true,
    limit: 2000,
  });
  assert.equal(names.at(-1), "save_checkpoint");
  assert.equal(calls.find((call) => call.tool === "get_candidate_set")?.args.include_hidden, true);
  assert.equal(
    calls.find((call) => call.tool === "create_run")?.approved,
    true,
  );
  assert.equal(
    calls.find((call) => call.tool === "approve_screening_profile")?.approved,
    true,
  );
  assert.deepEqual(
    calls
      .filter((call) => call.tool === "search_mid")
      .map((call) => call.args.query),
    [
      definition,
      "veterinary appointment scheduling platform independent clinics",
    ],
  );

  assert.equal(completed.events.length, calls.length * 2);
  for (let index = 0; index < completed.events.length; index += 2) {
    assert.equal(completed.events[index].type, "tool-start");
    assert.equal(completed.events[index + 1].type, "tool-result");
    assert.equal(completed.events[index].id, completed.events[index + 1].id);
    assert.equal(
      completed.events[index].tool,
      completed.events[index + 1].tool,
    );
  }
  assert.equal(jobs.get(started.id)?.state, "completed");
  assert.equal(jobs.list()[0].id, started.id);
});

test("discovery uses the approved criteria run and retains hidden candidates after another search", async () => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const jobs = registry(async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "get_screening_grid") return screeningGridPage([
      screeningGridRow({ company_id: "MID-A", name: "Alpha", considered: true }),
      screeningGridRow({ company_id: "MID-HIDDEN", name: "Original hidden company", considered: false }),
    ], args);
    if (tool === "get_shortlist_context") return shortlistPage([
      { company_id: "MID-A", name: "Alpha", considered: true },
      { company_id: "MID-HIDDEN", name: "Original hidden company", considered: false },
    ], args);
    if (tool === "get_candidate_set") return {
      candidates: [
        { company_id: "MID-A", considered: true, company: { company_id: "MID-A", name: "Alpha" }, discovery: [{ source: "MID", retrieval_score: 1.37 }] },
        { company_id: "MID-HIDDEN", considered: false, company: { company_id: "MID-HIDDEN", name: "Original hidden company" }, discovery: [{ source: "MID", retrieval_score: 0.91 }] },
      ],
    };
    if (tool === "get_discovery_summary") return { mid_only: 1, iscc_only: 0, both: 0, other: 0, total_unique: 1 };
    return response(tool, args);
  });
  const completed = await jobs.wait(jobs.create({ ...input, backendRunId: "approved-run" }).id);
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.result.backendRunId, "approved-run");
  assert.deepEqual(completed?.result.companies.map(({ row }: { row: { considered: boolean } }) => row.considered), [true, false]);
  assert.equal(completed?.result.companies[1].detail.name, "Original hidden company");
  assert.equal(calls.some(({ tool }) => tool === "create_run"), false);
  assert.equal(calls.some(({ tool }) => tool === "approve_screening_profile"), false);
  assert.ok(calls.findIndex(({ tool }) => tool === "get_active_screening_profile") < calls.findIndex(({ tool }) => tool === "import_company_files"));
  assert.ok(calls.findIndex(({ tool }) => tool === "import_company_files") < calls.findIndex(({ tool }) => tool === "search_mid"));
  assert.equal(calls.find(({ tool }) => tool === "get_candidate_set")?.args.include_hidden, true);
  assert.deepEqual((calls.find(({ tool }) => tool === "save_checkpoint")?.args.state as { company_ids: string[] }).company_ids, ["MID-A"]);
});

test("discovery reads more than 1,000 saved candidates and keeps late hidden rows", async () => {
  const saved = Array.from({ length: 2001 }, (_, index) => screeningGridRow({
    company_id: `MID-${String(index).padStart(4, "0")}`,
    name: `Company ${index}`,
    considered: index !== 2000,
  }));
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const jobs = registry(async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "search_mid") return { query_id: "empty", results: [] };
    if (tool === "get_screening_grid") return screeningGridPage(saved, args);
    if (tool === "get_shortlist_context") return shortlistPage(saved, args);
    if (tool === "get_candidate_set") return { candidates: saved.slice(0, 1000).map((item, index) => ({
      ...item, company: { company_id: item.company_id, name: item.name },
      discovery: index === 0 ? [{ source: "MID", retrieval_score: 0.9 }] : [],
    })) };
    if (tool === "get_discovery_summary") return { mid_only: 2000, iscc_only: 0, both: 0, other: 0, total_unique: 2000 };
    return response(tool, args);
  });
  const completed = await jobs.wait(jobs.create({ ...input, backendRunId: "approved-run" }).id);
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.result.companies.length, 2001);
  assert.equal(completed?.result.companies[0].row.score, 0.91);
  assert.equal(completed?.result.companies[2000].row.considered, false);
  assert.equal(completed?.result.companies[2000].row.score, 0.91);
  assert.equal(completed?.result.companies[2000].detail.name, "Company 2000");
  assert.deepEqual(calls.filter(({ tool, args }) => tool === "get_screening_grid" && args.limit === 2000).map(({ args }) => args.after_company_id), [undefined, "MID-1999"]);
  assert.equal(calls.some(({ tool }) => ["get_company", "get_source_rows", "get_company_context"].includes(tool)), false);
  assert.equal(calls.find(({ tool }) => tool === "get_candidate_set")?.args.limit, 1000);
  assert.equal((calls.find(({ tool }) => tool === "save_checkpoint")?.args.state as { company_ids: string[] }).company_ids.length, 2000);
});

test("discovery retries oversized grid pages at half size and continues from the same cursor", async () => {
  const saved = Array.from({ length: 1500 }, (_, index) => screeningGridRow({
    company_id: `MID-${String(index).padStart(4, "0")}`,
    name: `Company ${index}`,
    considered: true,
  }));
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const jobs = registry(async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "search_mid") return { query_id: "empty", results: [] };
    if (tool === "get_screening_grid") {
      if (Number(args.limit) > 1000) throw new Error("Response exceeds byte limit");
      return screeningGridPage(saved, args);
    }
    if (tool === "get_shortlist_context") return shortlistPage(saved, args);
    if (tool === "get_candidate_set") return { candidates: saved.slice(0, 1000).map((item) => ({
      company_id: item.company_id,
      company: { company_id: item.company_id, name: item.name },
      considered: true,
      discovery: [],
    })) };
    if (tool === "get_discovery_summary") return { mid_only: 1500, iscc_only: 0, both: 0, other: 0, total_unique: 1500 };
    return response(tool, args);
  });
  const completed = await jobs.wait(jobs.create({ ...input, backendRunId: "approved-run" }).id);
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.result.companies.length, 1500);
  assert.deepEqual(calls.filter(({ tool }) => tool === "get_screening_grid").map(({ args }) => args.limit), [2000, 1000, 1000]);
  assert.deepEqual(calls.filter(({ tool }) => tool === "get_screening_grid").map(({ args }) => args.after_company_id), [undefined, undefined, "MID-0999"]);
});

test("discovery rejects a shortlist changed between pages", async () => {
  const saved = Array.from({ length: 2001 }, (_, index) => screeningGridRow({ company_id: `MID-${String(index).padStart(4, "0")}`, name: `Company ${index}`, considered: true }));
  const jobs = registry(async (tool, args) => {
    if (tool === "search_mid") return { query_id: "empty", results: [] };
    if (tool === "get_screening_grid") return screeningGridPage(saved, args, args.after_company_id ? "changed-source" : "original-source");
    if (tool === "get_shortlist_context") return shortlistPage(saved, args);
    if (tool === "get_candidate_set") throw new Error("Should not read scores after a changed page");
    return response(tool, args);
  });
  const completed = await jobs.wait(jobs.create({ ...input, backendRunId: "approved-run" }).id);
  assert.equal(completed?.state, "error");
  assert.match(completed?.error ?? "", /changed during discovery/);
});

test("approval and request shape are enforced before any Rust call", () => {
  let calls = 0;
  const jobs = registry(async () => {
    calls += 1;
    return {};
  });
  assert.throws(
    () => jobs.create({ ...input, criteriaApproved: false }),
    /Approve the current screening criteria/,
  );
  assert.throws(
    () => jobs.create({ ...input, query: "arbitrary override" }),
    /Unsupported job field: query/,
  );
  assert.throws(
    () => jobs.create({ ...input, sessionId: "../other-session" }),
    /unsupported characters/,
  );
  assert.equal(calls, 0);
});

test("retries reuse the active session job and new criteria wait for cancellation to settle", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const jobs = registry(async (tool, args) => {
    calls++;
    if (tool === "create_run") await pending;
    return response(tool, args);
  });
  const first = jobs.create(input);
  await Promise.resolve();
  const retry = jobs.create({ ...input, title: "Renamed screening" });
  assert.equal(retry.id, first.id);
  assert.equal(calls, 1);
  assert.throws(
    () => jobs.create({ ...input, definition: "Payroll software" }),
    /Another search is running/,
  );
  jobs.cancel(first.id);
  assert.throws(() => jobs.create(input), /still stopping/);
  release();
  assert.equal((await jobs.wait(first.id)).state, "cancelled");
  const next = jobs.create(input);
  assert.notEqual(next.id, first.id);
  await jobs.wait(next.id);
});

test("repeat pass rejects a mismatched approved profile before search or writes", async () => {
  const calls: string[] = [];
  const jobs = registry(async (tool) => {
    calls.push(tool);
    if (tool === "get_active_screening_profile")
      return {
        content: { business_definition: "Unrelated payroll software" },
        status: "APPROVED",
      };
    throw new Error(`Unexpected tool ${tool}`);
  });
  const started = jobs.create({ ...input, backendRunId: "existing-run" });
  const failed = await jobs.wait(started.id);
  assert.equal(failed?.state, "error");
  assert.match(failed?.error ?? "", /different approved screening criteria/);
  assert.deepEqual(calls, ["get_active_screening_profile"]);
});

test("cancel aborts the pending call, records it, and prevents later writes", async () => {
  const calls: string[] = [];
  let importStarted!: () => void;
  const pending = new Promise<void>((resolve) => {
    importStarted = resolve;
  });
  const jobs = registry(async (tool, args, _approved, signal) => {
    calls.push(tool);
    if (["create_run", "approve_screening_profile", "get_active_screening_profile", "get_mid_index_status"].includes(tool)) return response(tool, args);
    if (tool === "import_company_files") {
      importStarted();
      return new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      });
    }
    throw new Error(`Unexpected later call ${tool}`);
  });
  const started = jobs.create(input);
  await pending;
  const cancelling = jobs.cancel(started.id);
  assert.equal(cancelling?.state, "running");
  const cancelled = await jobs.wait(started.id);
  assert.equal(cancelled?.state, "cancelled");
  assert.deepEqual(calls, ["create_run", "approve_screening_profile", "get_active_screening_profile", "get_mid_index_status", "import_company_files"]);
  const createEvents =
    cancelled?.events.filter(
      (event: JobEvent) => event.tool === "create_run",
    ) ?? [];
  assert.deepEqual(
    createEvents.map((event: JobEvent) => event.type),
    ["tool-start", "tool-result"],
  );
  const importEvents =
    cancelled?.events.filter(
      (event: JobEvent) => event.tool === "import_company_files",
    ) ?? [];
  assert.deepEqual(
    importEvents.map((event: JobEvent) => event.type),
    ["tool-start", "tool-error"],
  );
  assert.equal(importEvents[0].id, importEvents[1].id);
});

test("Rust failures remain observable as paired tool errors and terminal job errors", async () => {
  const jobs = registry(async (tool, args) => {
    if (tool === "search_mid") throw new Error("Rust lexical index failed");
    return response(tool, args);
  });
  const started = jobs.create(input);
  const failed = await jobs.wait(started.id);
  assert.equal(failed?.state, "error");
  assert.equal(failed?.error, "Rust lexical index failed");
  const events =
    failed?.events.filter((event: JobEvent) => event.tool === "search_mid") ??
    [];
  assert.deepEqual(
    events.map((event: JobEvent) => event.type),
    ["tool-start", "tool-error"],
  );
  assert.equal(events[0].id, events[1].id);
  assert.deepEqual(events[1].result, { error: "Rust lexical index failed" });
});

test('active MID bundle uses keyword v2 and semantic scoring without importing the fixture', async () => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const jobs = registry(async (tool, args) => {
    calls.push({tool, args});
    if (tool === 'get_mid_index_status') return {active: {bundle_id: 'active-mid'}};
    if (tool === 'import_company_files' || tool === 'add_candidates') throw new Error('The indexed path adds candidates in Rust.');
    if (tool === 'search_mid') {
      assert.equal(args.query, undefined);
      assert.equal(args.limit, 5000);
      assert.equal(args.add_to_run, true);
      assert.ok(Array.isArray(args.keywords));
      assert.equal(typeof args.expression, 'string');
      assert.equal(typeof args.rationale, 'string');
      return {query_id: 'indexed-query', results: [], added_to_run: true};
    }
    if (tool === 'score_mid_semantic') return {status: 'skipped', reason: 'Embedding model not configured.'};
    return response(tool, args);
  });
  const completed = await jobs.wait(jobs.create(input).id);
  assert.equal(completed.state, 'completed');
  assert.ok(calls.filter(call => call.tool === 'search_mid').length >= 2);
  assert.ok(calls.some(call => call.tool === 'score_mid_semantic'));
  assert.ok(!calls.some(call => call.tool === 'import_company_files'));
  assert.ok(completed.events.some((event: JobEvent) => event.tool === 'score_mid_semantic' && event.result?.reason === 'Embedding model not configured.'));
});
