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
            discovery: [{ source: "MID", retrieval_score: 1.37, rank: 1 }],
          },
        ],
      };
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
  assert.deepEqual(names.slice(0, 4), [
    "create_run",
    "import_company_files",
    "approve_screening_profile",
    "get_active_screening_profile",
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
    if (tool === "create_run") return response(tool, args);
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
  assert.deepEqual(calls, ["create_run", "import_company_files"]);
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
