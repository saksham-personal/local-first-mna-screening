import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-ignore Local server runner is exercised with an injected offline transport.
import { createBingResearch } from '../server/bing-research.mjs';

const templates = ['{company} products', '{company} customers', '{company} competitors'];

function fixture(count = 3, isConnected = true, options: { storeFile?: string; holdQuery?: (args: Record<string, string>) => Promise<void>; setTimer?: (callback: () => void, delay?: number) => number; clearTimer?: (timer: number) => void } = {}) {
  const companies = Array.from({ length: count }, (_, index) => `company-${index + 1}`);
  const calls: { tool: string; args: Record<string, any>; approved: boolean }[] = [];
  let planCompanies: string[] = [];
  let planTemplates: string[] = [];
  let revision: string | number = 'revision-1';
  const call = async (tool: string, args: Record<string, any>, approved = false) => {
    calls.push({ tool, args, approved });
    if (tool === 'get_shortlist_context') {
      const source = args.limit === 1 ? companies.slice(0, 1) : companies;
      return { candidates: source.map(company_id => ({ company_id })), considered_count: companies.length,
        selection_revision: revision, has_more: false, next_after_company_id: null };
    }
    if (tool === 'create_run') return { run_id: 'run-1' };
    if (tool === 'propose_action_plan') {
      planCompanies = args.steps[0].company_ids;
      planTemplates = args.steps[0].query_templates;
      return { plan_id: 'plan-1', status: 'PROPOSED' };
    }
    if (tool === 'approve_action_plan') return { plan_id: 'plan-1', status: 'APPROVED' };
    if (tool === 'prepare_bing_queries') return { queries: args.company_ids.flatMap((company_id: string) => planTemplates.map(query => ({
      company_id, query: query.replaceAll('{company}', company_id).replaceAll('{website}', `${company_id}.example`),
    }))) };
    if (tool === 'bing_search') {
      await options.holdQuery?.(args);
      return { query_id: `query-${calls.filter(item => item.tool === 'bing_search').length}`, evidence_id: 'evidence-1', results: [{ title: 'Lead', url: 'https://example.test', snippet: 'Unverified result' }] };
    }
    if (tool === 'discard_plan_results') return { discarded: true };
    throw new Error(`Unexpected tool ${tool}`);
  };
  const service = createBingResearch({ call, connected: () => isConnected, storeFile: options.storeFile,
    ...(options.setTimer ? { setTimer: options.setTimer, clearTimer: options.clearTimer } : {}) });
  return { service, calls, companies, call, setRevision: (value: string | number) => { revision = value; } };
}

async function until(predicate: () => boolean | Promise<boolean>) {
  for (let count = 0; count < 300; count++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(await predicate(), 'background Bing work did not advance');
}

function gate() {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  return { waiting, release, hold: async () => { entered(); await held; } };
}

// The old browser-driven `run` loop asserted a batch result per request. These tests now
// assert that one approved start owns the server runner and later progress needs no run call.
test('start returns before sending and background queries progress without client run calls', async () => {
  const f = fixture(1, true);
  const preview = await f.service.preview({ runId: 'run-1', mode: 'company', queries: templates });
  const started = await f.service.start({ token: preview.token, approved: true, sessionId: 'session-1' });
  assert.equal(started.state, 'queued');
  await until(() => f.calls.filter(item => item.tool === 'bing_search').length === 3);
  await until(async () => (await f.service.list())[0]?.state === 'completed');
  const listed = (await f.service.list())[0];
  assert.equal(listed.kind, 'bing');
  assert.equal(listed.sessionId, 'session-1');
  assert.equal(listed.processedQueries, 3);
  assert.equal(listed.queryCount, 3);
  assert.deepEqual(listed.steps.map((step: { label: string }) => step.label), [
    'Approve plan', 'Send queries · 3 of 3', 'Save observations',
  ]);
  assert.equal(f.calls.filter(item => item.tool === 'approve_action_plan').length, 1);
  assert.equal(f.calls.filter(item => item.tool === 'prepare_bing_queries').length, 1);
  assert.equal(f.calls.filter(item => item.tool === 'bing_search').length, 3);
});

test('pause waits for the active query, then stops before the next query', async () => {
  const held = gate();
  const f = fixture(2, true, { holdQuery: async () => { if (f.calls.filter(item => item.tool === 'bing_search').length === 1) await held.hold(); } });
  const preview = await f.service.preview({ runId: 'run-1', mode: 'company', queries: ['{company} products'] });
  await f.service.start({ token: preview.token, approved: true });
  await until(() => f.calls.filter(item => item.tool === 'bing_search').length === 1);
  await held.waiting;
  const pausing = f.service.pause({ token: preview.token });
  held.release();
  const paused = await pausing;
  assert.equal(paused.state, 'paused');
  assert.equal(paused.processedQueries, 1);
  assert.equal(f.calls.filter(item => item.tool === 'bing_search').length, 1);
});

test('resume continues at the saved query index without repeating completed queries', async () => {
  const held = gate();
  let holdFirst = true;
  const f = fixture(3, true, { holdQuery: async () => { if (holdFirst && f.calls.filter(item => item.tool === 'bing_search').length === 1) await held.hold(); } });
  const preview = await f.service.preview({ runId: 'run-1', mode: 'company', queries: ['{company} products'] });
  await f.service.start({ token: preview.token, approved: true });
  await until(() => f.calls.filter(item => item.tool === 'bing_search').length === 1);
  await held.waiting;
  const pausing = f.service.pause({ token: preview.token });
  held.release();
  await pausing;
  holdFirst = false;
  await f.service.resume({ token: preview.token });
  await until(async () => (await f.service.list())[0]?.state === 'completed');
  const sent = f.calls.filter(item => item.tool === 'bing_search').map(item => item.args.company_id);
  assert.deepEqual(sent, ['company-1', 'company-2', 'company-3']);
});

test('cancel with keep stops after the current query and does not discard observations', async () => {
  const held = gate();
  const f = fixture(3, true, { holdQuery: async () => { if (f.calls.filter(item => item.tool === 'bing_search').length === 1) await held.hold(); } });
  const preview = await f.service.preview({ runId: 'run-1', mode: 'company', queries: ['{company} products'] });
  await f.service.start({ token: preview.token, approved: true });
  await until(() => f.calls.filter(item => item.tool === 'bing_search').length === 1);
  await held.waiting;
  const cancelling = f.service.cancel({ token: preview.token, keep: true });
  held.release();
  const cancelled = await cancelling;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.processedQueries, 1);
  assert.equal(f.calls.filter(item => item.tool === 'bing_search').length, 1);
  assert.equal(f.calls.filter(item => item.tool === 'discard_plan_results').length, 0);
});

test('cancel without keep stops after the current query and calls analyst discard', async () => {
  const held = gate();
  const f = fixture(3, true, { holdQuery: async () => { if (f.calls.filter(item => item.tool === 'bing_search').length === 1) await held.hold(); } });
  const preview = await f.service.preview({ runId: 'run-1', mode: 'company', queries: ['{company} products'] });
  await f.service.start({ token: preview.token, approved: true });
  await until(() => f.calls.filter(item => item.tool === 'bing_search').length === 1);
  await held.waiting;
  const cancelling = f.service.cancel({ token: preview.token, keep: false });
  held.release();
  const cancelled = await cancelling;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(f.calls.filter(item => item.tool === 'bing_search').length, 1);
  const discard = f.calls.find(item => item.tool === 'discard_plan_results');
  assert.deepEqual(discard?.args, { run_id: 'run-1', plan_id: 'plan-1', kind: 'research',
    reason: 'Analyst chose to discard observations from cancelled Bing research.' });
  assert.equal(discard?.approved, true);
});

test('running research reloads as paused and resumes from its persisted cursor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bing-research-'));
  let restored: ReturnType<typeof createBingResearch> | undefined;
  try {
    const file = join(dir, 'research.json');
    const f = fixture(2, true, { storeFile: file, setTimer: () => 1, clearTimer: () => {} });
    const preview = await f.service.preview({ runId: 'run-1', mode: 'company', queries: ['{company} products'] });
    await f.service.start({ token: preview.token, approved: true });
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    persisted.runs[0].state = 'running';
    await writeFile(file, JSON.stringify(persisted));
    f.service.close();
    restored = createBingResearch({ call: f.call, connected: () => true, storeFile: file });
    const jobs = await restored.list();
    assert.equal(jobs[0].state, 'paused');
    assert.equal(jobs[0].processedQueries, 0);
    await restored.resume({ planId: 'plan-1' });
    await until(async () => (await restored!.list())[0]?.state === 'completed');
    assert.equal((await restored.list())[0].processedQueries, 2);
  } finally { restored?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('preview keeps strict templates, pages company scope, and approves only the reviewed selection', async () => {
  const f = fixture(501);
  await assert.rejects(f.service.preview({ mode: 'general', queries: ['{other} products'] }), /placeholder/i);
  await assert.rejects(f.service.preview({ mode: 'general', queries: ['Market', ' market '] }), /distinct/i);
  const preview = await f.service.preview({ runId: 'run-1', mode: 'company', queries: ['{company} products'] });
  f.setRevision('revision-2');
  await assert.rejects(f.service.start({ token: preview.token, approved: true }), /changed since the preview/i);
  assert.equal(f.calls.some(item => item.tool === 'approve_action_plan'), false);
});
