import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScreeningExample, type WorkflowEvent } from '../src/lib/tool-workflow';
import type { AssistantContext } from '../src/lib/assistant-contract';
import type { ToolResult } from '../src/lib/tool-client';

const context: AssistantContext = {
  sessionId: 'session-1', title: 'Insurance software', stage: 'discovery',
  criteriaApproved: true, mandate: 'Find insurance technology businesses',
  definition: 'Insurance claims workflow software',
  counts: { midOnly: 0, isccOnly: 0, both: 0 }, plan: [], bingQuery: '',
};

type CallOptions = { signal?: AbortSignal; analystApproved?: boolean };
type MockCall = (tool: string, args: ToolResult, options?: CallOptions) => Promise<ToolResult>;

function company(companyId: string, name: string) {
  return { company_id: companyId, name, website: `${companyId}.example`, description: `${name} software`, identifiers: [], keywords: [] };
}

function responses(tool: string, args: ToolResult): ToolResult {
  switch (tool) {
    case 'create_run': return { run_id: 'rust-run-1' };
    case 'search_mid': {
      if (args.query === context.definition) return {
        query_id: 'query-1', results: [
          { company: company('MID-A', 'Alpha'), score: 1.37, rank: 1 },
          { company: company('MID-B', 'Beta'), score: 0.42, rank: 2 },
        ],
      };
      return {
        query_id: 'query-2', results: [
          { company: company('MID-B', 'Beta'), score: 0.99, rank: 1 },
          { company: company('MID-C', 'Gamma'), score: 0.18, rank: 2 },
        ],
      };
    }
    case 'get_company': {
      const id = String(args.company_id);
      return company(id, ({ 'MID-A': 'Alpha', 'MID-B': 'Beta', 'MID-C': 'Gamma' } as Record<string, string>)[id] ?? id);
    }
    case 'get_source_rows': return { rows: [{ source: 'MID', row: { ECID: 'E1', CID: 'C1', CompanyName: 'Example', Description: 'Original source row' } }] };
    case 'get_discovery_summary': return { mid_only: 3, iscc_only: 0, both: 0, total_unique: 3 };
    default: return {};
  }
}

async function collect(contextNow: () => AssistantContext, call: MockCall, options: { signal?: AbortSignal; broader?: boolean } = {}, initial: AssistantContext = context) {
  const events: WorkflowEvent[] = [];
  const generator = runScreeningExample(initial, { signal: options.signal ?? new AbortController().signal, current: contextNow, call, broader: options.broader });
  while (true) {
    const next = await generator.next();
    if (next.done) return events;
    events.push(next.value);
  }
}

test('real-tool workflow approves before MID search, preserves scores, and uses Rust summary counts', async () => {
  const calls: { tool: string; args: ToolResult; options?: CallOptions }[] = [];
  const call: MockCall = async (tool, args, options) => {
    calls.push({ tool, args, options });
    return responses(tool, args);
  };
  const events = await collect(() => context, call);
  const names = calls.map(item => item.tool);

  assert.ok(names.indexOf('approve_screening_profile') < names.indexOf('search_mid'));
  assert.equal(calls.find(item => item.tool === 'create_run')?.options?.analystApproved, true);
  assert.equal(calls.find(item => item.tool === 'approve_screening_profile')?.options?.analystApproved, true);
  assert.equal(names.includes('search_iscc'), false);
  assert.deepEqual(names.filter(name => name === 'search_mid'), ['search_mid', 'search_mid']);

  const complete = events.find((event): event is Extract<WorkflowEvent, { type: 'complete' }> => event.type === 'complete');
  assert.ok(complete);
  assert.deepEqual(complete.action.counts, { midOnly: 3, isccOnly: 0, both: 0 });
  assert.deepEqual(complete.action.companies.map(item => item.pk), ['MID-A', 'MID-B', 'MID-C']);
  assert.deepEqual(complete.action.companies.map(item => item.midScore), [1.37, 0.42, 0.18]);
  assert.deepEqual(complete.action.companies[0].rawMid, { ECID: 'E1', CID: 'C1', CompanyName: 'Example', Description: 'Original source row' });
  assert.equal(calls.filter(item => item.tool === 'get_source_rows').length, 3);
  assert.match(complete.message, /ISCC is not connected, so it was not searched/);
  assert.deepEqual(calls.find(item => item.tool === 'save_checkpoint')?.args, {
    run_id: 'rust-run-1', namespace: 'screening-ui',
    state: { company_ids: ['MID-A', 'MID-B', 'MID-C'], counts: { midOnly: 3, isccOnly: 0, both: 0 }, step: 'company-list-ready' },
  });
});

test('an empty MID search is a valid completed result when Rust reports zero counts', async () => {
  const calls: string[] = [];
  const call: MockCall = async (tool, args) => {
    calls.push(tool);
    if (tool === 'search_mid') return { query_id: 'empty-query', results: [] };
    if (tool === 'get_discovery_summary') return { mid_only: 0, iscc_only: 0, both: 0, total_unique: 0 };
    return responses(tool, args);
  };
  const events = await collect(() => context, call);
  const complete = events.find((event): event is Extract<WorkflowEvent, { type: 'complete' }> => event.type === 'complete');
  assert.ok(complete);
  assert.deepEqual(complete.action.companies, []);
  assert.deepEqual(complete.action.counts, { midOnly: 0, isccOnly: 0, both: 0 });
  assert.equal(calls.includes('get_company'), false);
  assert.equal(calls.includes('get_company_context'), false);
  assert.equal(calls.includes('save_checkpoint'), true);
});

test('edited non-insurance criteria generate both search queries from the approved definition', async () => {
  const definition = 'Veterinary appointment scheduling platform for independent clinics; exclude payroll or billing systems.';
  const edited = { ...context, definition };
  const queries: string[] = [];
  const call: MockCall = async (tool, args) => {
    if (tool === 'search_mid') {
      queries.push(String(args.query));
      return { query_id: `query-${queries.length}`, results: [] };
    }
    if (tool === 'get_discovery_summary') return { mid_only: 0, iscc_only: 0, both: 0, total_unique: 0 };
    return responses(tool, args);
  };
  await collect(() => edited, call, {}, edited);
  assert.deepEqual(queries, ['Veterinary appointment scheduling platform for independent clinics', 'veterinary appointment scheduling platform independent clinics']);
  assert.ok(queries.every(query => !/insurance/i.test(query)));
});

test('broader search retains prior candidates and restores their MID score from discovery history', async () => {
  const broaderContext = { ...context, backendRunId: 'existing-run' };
  const calls: string[] = [];
  const call: MockCall = async (tool, args) => {
    calls.push(tool);
    if (tool === 'search_mid') {
      return args.query === context.definition
        ? { query_id: 'broader-query', results: [{ company: company('MID-NEW', 'New match'), score: 0.56, rank: 1 }] }
        : { query_id: 'broader-query-2', results: [] };
    }
    if (tool === 'get_candidate_set') return {
      candidates: [{ company_id: 'MID-OLD', discovery: [{ source: 'MID', retrieval_score: 1.44, rank: 1 }] }],
    };
    if (tool === 'get_company') return company(String(args.company_id), String(args.company_id));
    if (tool === 'get_source_rows') return { rows: [] };
    if (tool === 'get_discovery_summary') return { mid_only: 2, iscc_only: 0, both: 0, total_unique: 2 };
    return {};
  };
  const events: WorkflowEvent[] = [];
  for await (const event of runScreeningExample(broaderContext, { signal: new AbortController().signal, current: () => broaderContext, call, broader: true })) events.push(event);
  const complete = events.find((event): event is Extract<WorkflowEvent, { type: 'complete' }> => event.type === 'complete');
  assert.ok(complete);
  assert.deepEqual(complete.action.companies.map(item => item.pk), ['MID-NEW', 'MID-OLD']);
  assert.deepEqual(complete.action.companies.map(item => item.midScore), [0.56, 1.44]);
  assert.equal(calls.includes('create_run'), false);
});

test('criteria edits during search stop the workflow before candidate writes', async () => {
  const calls: string[] = [];
  let live = context;
  const call: MockCall = async (tool, args) => {
    calls.push(tool);
    const result = responses(tool, args);
    if (tool === 'search_mid') live = { ...live, definition: 'Changed criteria' };
    return result;
  };
  await assert.rejects(collect(() => live, call), { name: 'AbortError' });
  assert.equal(calls.at(-1), 'search_mid');
  assert.equal(calls.includes('add_candidates'), false);
  assert.equal(calls.includes('save_checkpoint'), false);
});

test('an abort during a Rust search stops subsequent writes', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const call: MockCall = async (tool, args) => {
    calls.push(tool);
    const result = responses(tool, args);
    if (tool === 'search_mid') controller.abort();
    return result;
  };
  await assert.rejects(collect(() => context, call, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.at(-1), 'search_mid');
  assert.equal(calls.includes('add_candidates'), false);
  assert.equal(calls.includes('save_checkpoint'), false);
});
