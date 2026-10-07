import { test } from "node:test";
import assert from "node:assert/strict";
import { exampleDefinition } from '../src/lib/chat-policy';
// The production scheduler is intentionally plain Node ESM so the bridge runs without a compile step.
// @ts-expect-error No declaration file is emitted for this server-only module.
import { createJobRegistry } from "../server/jobs.mjs";

const definition =
  "Veterinary appointment scheduling platform for independent clinics";
const input = {
  sessionId: "session-1",
  criteriaApproved: true,
  title: "Veterinary software",
  criteriaText: "Find veterinary scheduling software businesses",
  definition,
};

function shortlistPage(candidates: { company_id: string; name: string; considered: boolean; website?: string }[], args: Record<string, unknown>, sourceHash = "stable-source") {
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
    case "get_shortlist_context":
      return shortlistPage([{ company_id: "MID-A", name: "Alpha", considered: true }], args);
    case "get_company":
      return {
        company_id: "MID-A",
        name: "Alpha",
        description: "Original company detail",
      };
    case "get_source_rows":
      return {
        rows: [{ source: "MID", row: { Description: "Raw MID description" } }],
      };
    case "get_company_context":
      return { company_id: "MID-A", sections: { core: { name: "Alpha" } } };
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
      description: "Original company detail",
    },
    sourceRows: [
      { source: "MID", row: { Description: "Raw MID description" } },
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
  assert.ok(
    names.indexOf("get_company_context") <
      names.indexOf("get_discovery_summary"),
  );
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
    if (tool === "get_company") return { company_id: args.company_id, name: args.company_id === "MID-HIDDEN" ? "Original hidden company" : "Alpha", description: "Original detail" };
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
  const saved = Array.from({ length: 1001 }, (_, index) => ({
    company_id: `MID-${String(index).padStart(4, "0")}`,
    name: `Company ${index}`,
    considered: index !== 1000,
  }));
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const jobs = registry(async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "search_mid") return { query_id: "empty", results: [] };
    if (tool === "get_shortlist_context") return shortlistPage(saved, args);
    if (tool === "get_candidate_set") return { candidates: saved.slice(0, 1000).map((item, index) => ({
      ...item, company: { company_id: item.company_id, name: item.name },
      discovery: index === 0 ? [{ source: "MID", retrieval_score: 0.9 }] : [],
    })) };
    if (tool === "get_company") return { company_id: args.company_id, name: `Original ${args.company_id}` };
    if (tool === "get_source_rows") return { rows: [] };
    if (tool === "get_company_context") return {};
    if (tool === "get_discovery_summary") return { mid_only: 1000, iscc_only: 0, both: 0, other: 0, total_unique: 1000 };
    return response(tool, args);
  });
  const completed = await jobs.wait(jobs.create({ ...input, backendRunId: "approved-run" }).id);
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.result.companies.length, 1001);
  assert.equal(completed?.result.companies[0].row.score, 0.9);
  assert.equal(completed?.result.companies[1000].row.considered, false);
  assert.equal(completed?.result.companies[1000].detail.name, "Original MID-1000");
  assert.deepEqual(calls.filter(({ tool, args }) => tool === "get_shortlist_context" && args.limit === 500).map(({ args }) => args.after_company_id), [undefined, "MID-0499", "MID-0999"]);
  assert.equal(calls.find(({ tool }) => tool === "get_candidate_set")?.args.limit, 1000);
  assert.equal((calls.find(({ tool }) => tool === "save_checkpoint")?.args.state as { company_ids: string[] }).company_ids.length, 1000);
});

test("discovery rejects a shortlist changed between pages", async () => {
  const saved = Array.from({ length: 501 }, (_, index) => ({ company_id: `MID-${String(index).padStart(4, "0")}`, name: `Company ${index}`, considered: true }));
  const jobs = registry(async (tool, args) => {
    if (tool === "search_mid") return { query_id: "empty", results: [] };
    if (tool === "get_shortlist_context") return shortlistPage(saved, args, args.after_company_id ? "changed-source" : "original-source");
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
