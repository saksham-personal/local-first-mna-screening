import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
// @ts-ignore Injected local server transport.
import { createControllerLoop } from '../server/controller-loop.mjs';
// @ts-ignore Dev adapter with no network calls.
import { createStub } from '../server/llmsuite-stub.mjs';

async function until(predicate: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 300; n++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.ok(await predicate(), 'loop did not advance');
}
function gate() {
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { release = r; });
  return { waiting, release, hold: async () => { entered(); await held; } };
}
function fixture(options: { hold?: () => Promise<void>; storeFile?: string; error?: () => Error | undefined; maxTurns?: number } = {}) {
  const calls: { tool: string; args: any; approved: boolean }[] = [];
  let active = 0, maxActive = 0, connected = true;
  const loop: any = { loop_id: 'loop-1', run_id: 'R', status: 'running', max_turns: options.maxTurns ?? 50, turns_used: 0, queries: [], consolidated_count: 0, simulated: true };
  const call = async (tool: string, args: any, approved = false) => {
    calls.push({ tool, args, approved });
    if (tool === 'start_controller_loop' || tool === 'get_controller_loop') return structuredClone(loop);
    if (tool === 'run_controller_loop_turn') {
      active++; maxActive = Math.max(active, maxActive);
      try {
        await options.hold?.(); const error = options.error?.(); if (error) throw error;
        loop.turns_used++; loop.queries = [{ id: 'Q1', source: 'MID_KEYWORD', total: 8 }]; loop.consolidated_count = 4;
        if (loop.turns_used >= loop.max_turns) { loop.status = 'completed'; loop.final_count = 4; loop.applied_review_id = 'REV-1'; }
        return structuredClone(loop);
      } finally { active--; }
    }
    if (tool === 'cancel_controller_loop') { loop.status = 'cancelled'; loop.applied_review_id = args.keep ? 'REV-1' : null; return structuredClone(loop); }
    if (tool === 'undo_controller_loop') { loop.undone_review_id = 'REV-UNDO'; return structuredClone(loop); }
    throw new Error(`Unexpected call ${tool}`);
  };
  const service = createControllerLoop({ call, connected: () => connected, storeFile: options.storeFile, retryMs: 5 });
  return { service, call, calls, loop, maxActive: () => maxActive, setConnected: (value: boolean) => { connected = value; } };
}

test('start, pause and resume at a boundary with no overlapping turns', async () => {
  const hold = gate(), f = fixture({ hold: hold.hold });
  try {
    const started = await f.service.start({ runId: 'R', message: 'Find claims software', sessionId: 'S' });
    assert.equal(started.kind, 'loop'); assert.equal(started.turn, 0); assert.equal(started.sessionId, 'S');
    await until(() => f.calls.some(c => c.tool === 'run_controller_loop_turn')); await hold.waiting;
    await Promise.all([f.service.resume({ id: started.id }), f.service.resume({ id: started.id })]);
    const paused = f.service.pause({ id: started.id }); hold.release();
    assert.equal((await paused).state, 'paused'); assert.equal(f.maxActive(), 1);
    assert.equal(f.calls.filter(c => c.tool === 'run_controller_loop_turn').length, 1);
    f.setConnected(false); assert.equal((await f.service.resume({ id: started.id })).state, 'paused');
    f.setConnected(true); await f.service.resume({ id: started.id });
    await until(() => f.loop.turns_used >= 2); await f.service.pause({ id: started.id });
    assert.equal(f.maxActive(), 1); assert.ok(f.calls.filter(c => c.tool.endsWith('_turn')).every(c => c.approved));
  } finally { f.service.close(); }
});

for (const keep of [true, false]) test(`cancel keep=${keep} waits for current turn and uses the privileged op`, async () => {
  const hold = gate(), f = fixture({ hold: hold.hold });
  try {
    const started = await f.service.start({ runId: 'R', message: 'Find claims' }); await until(() => f.calls.some(c => c.tool === 'run_controller_loop_turn')); await hold.waiting;
    const cancelled = f.service.cancel({ id: started.id, keep }); hold.release();
    const result = await cancelled; assert.equal(result.state, 'cancelled');
    assert.equal(Boolean(result.appliedReviewId), keep); assert.equal(f.maxActive(), 1);
    const cancellation = f.calls.find(c => c.tool === 'cancel_controller_loop'); assert.equal(cancellation?.args.keep, keep); assert.equal(cancellation?.approved, true);
    assert.equal((await f.service.resume({ id: started.id })).state, 'cancelled');
  } finally { f.service.close(); }
});

test('persisted runs restart paused and resume reconciles Rust state', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.loop-test-')), hold = gate();
  const f = fixture({ storeFile: join(dir, 'runs.json'), hold: hold.hold }); let second: any;
  try {
    const started = await f.service.start({ runId: 'R', message: 'Find claims' }); await until(() => f.calls.some(c => c.tool === 'run_controller_loop_turn')); await hold.waiting;
    f.service.close(); hold.release(); await f.service.pause({ id: started.id });
    second = createControllerLoop({ call: f.call, connected: () => true, storeFile: join(dir, 'runs.json') });
    assert.equal((await second.list())[0].state, 'paused'); assert.match((await second.list())[0].message, /bridge restarted/);
    f.loop.status = 'completed'; f.loop.applied_review_id = 'REV-1';
    await second.resume({ id: started.id }); await until(async () => (await second.list())[0].state === 'completed');
    assert.equal(f.calls.filter(c => c.tool === 'run_controller_loop_turn').length, 1);
  } finally { f.service.close(); second?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('rate-limit errors wait and retry without failing; undo passes explicit force', async () => {
  let failures = 1;
  const f = fixture({ maxTurns: 1, error: () => failures-- > 0 ? Object.assign(new Error('Rate limit'), { code: 'RATE_LIMITED' }) : undefined });
  try {
    const started = await f.service.start({ runId: 'R', message: 'Find claims' });
    await until(async () => (await f.service.list())[0].state === 'completed');
    assert.equal(f.calls.filter(c => c.tool === 'run_controller_loop_turn').length, 2);
    const undone = await f.service.undo({ id: started.id, force: true }); assert.equal(undone.undoneReviewId, 'REV-UNDO');
    assert.deepEqual(f.calls.at(-1)?.args, { loop_id: 'loop-1', force: true });
    assert.equal(undone.steps.at(-1).label, 'Apply shortlist');
  } finally { f.service.close(); }
});

test('duplicate start cannot create two loops; invalid bounds rejected', async () => {
  const f = fixture();
  f.setConnected(false);
  try {
    const [a, b] = await Promise.all([f.service.start({ runId: 'R', message: 'Find claims' }), f.service.start({ runId: 'R', message: 'Find claims' })]);
    assert.equal(a.id, b.id); assert.equal(f.calls.filter(c => c.tool === 'start_controller_loop').length, 1);
    await assert.rejects(f.service.start({ runId: 'R', message: 'Find claims', maxTurns: 51 }));
    await assert.rejects(f.service.cancel({ id: a.id }));
  } finally { f.service.close(); }
});

test('full deterministic stub loop on seeded rows applies its consolidated set with an in-memory transport', async () => {
  const stub = createStub();
  const loop: any = { loop_id: 'loop-stub', status: 'running', turns_used: 0, max_turns: 50, queries: [], consolidated_count: 0, simulated: true };
  const seed = ['A', 'B', 'C', 'D'], considered = new Set(seed), keeps = new Map<string, number>();
  const histogram = '0.0–0.1:0 0.1–0.2:0 0.2–0.3:1 0.3–0.4:0 0.4–0.5:0 0.5–0.6:2 0.6–0.7:0 0.7–0.8:0 0.8–0.9:0 0.9–1.0:1';
  let observations = '', inspected = false, applied = false;
  const call = async (tool: string) => {
    if (tool === 'start_controller_loop' || tool === 'get_controller_loop') return structuredClone(loop);
    assert.equal(tool, 'run_controller_loop_turn');
    const turn = loop.turns_used + 1;
    const state = `Turn ${turn} of 50 (${51 - turn} remaining)\nCriteria: Claims software\nQueries:\n${loop.queries.map((q: any) => `${q.id} · ${q.source} · "claims" · 4 hits · ${keeps.has(q.id) ? `keep ≥ ${keeps.get(q.id)}` : 'not kept'}`).join('\n')}\nConsolidated: ${loop.consolidated_count} companies`;
    const prompt = turn === 1 ? `You are running a discovery loop\nLoop state:\n${state}` : `${state.split('\n')[0]}. Continue\nObservations from your last instruction set:\n${observations}\nLoop state:\n${state}`;
    const reply = stub.reply({ conversation_id: 'conv-loop', prompt, model: 'stub' }).response_text;
    const instructions = reply.split(/\n\d+\. \*\*/).slice(1);
    observations = '';
    for (const item of instructions) {
      const action = item.split('**')[0], fields = Object.fromEntries([...item.matchAll(/^\s+- (\w+): (.+)$/gm)].map(m => [m[1], m[2]]));
      if (action.startsWith('search_mid')) {
        if (action === 'search_mid_semantic') { observations += 'search_mid_semantic: skipped — vectors unavailable\n'; continue; }
        const q = { id: `Q${loop.queries.length + 1}`, source: 'MID_KEYWORD', total: 4 }; loop.queries.push(q);
        observations += `${q.id} · MID_KEYWORD · "claims" · 4 hits (4 new) · scale: match strength 0–1\nHistogram: ${histogram}\nTop:\n- 1.00 · A · Claims software\nBorderline (around 0.50):\n- 0.50 · B · Claims software\nBottom:\n- 0.25 · D · Consulting\n`;
      } else if (action === 'keep_query_results') keeps.set(fields.query_id, Number(fields.min_score));
      else if (action === 'inspect_band') inspected = true;
      else if (action === 'finish_loop') {
        considered.clear(); for (const [index, id] of seed.entries()) if ([...keeps.values()].some(threshold => [1, 0.5, 0.5, 0.25][index] >= threshold)) considered.add(id);
        applied = true; loop.status = 'completed'; loop.applied_review_id = 'REV-STUB'; loop.final_count = considered.size;
      } else assert.fail(`Unexpected stub action ${action}`);
    }
    loop.turns_used++; loop.consolidated_count = [...seed].filter((_, index) => [...keeps.values()].some(threshold => [1, 0.5, 0.5, 0.25][index] >= threshold)).length;
    return structuredClone(loop);
  };
  const runner = createControllerLoop({ call, connected: () => true });
  try {
    await runner.start({ runId: 'R', message: 'Find claims software' }); await until(async () => (await runner.list())[0].state === 'completed');
    assert.equal(inspected, true); assert.equal(applied, true); assert.equal(considered.size, 3); assert.equal(seed.length - considered.size, 1);
    assert.equal((await runner.list())[0].turn, 4); assert.equal((await runner.list())[0].simulated, true);
    console.log(`In-memory stub loop final considered count: ${considered.size}`);
  } finally { runner.close(); }
});

test('STUB_LOOP_TURNS searches until the reserve notice, then keeps and finishes', () => {
  const stub = createStub({ loopTurns: 50 });
  const reply = (turn: number, budget = '') => stub.reply({ conversation_id: 'reserve', model: 'stub', prompt: `Turn ${turn} of 50. Continue\nLoop state:\nQ1 · MID_KEYWORD · "claims" · 4 hits · not kept\n${budget}` }).response_text;
  assert.match(reply(20), /\*\*search_mid\*\*/);
  const reserved = reply(46, 'TURN BUDGET: 5 turns left. Reserve them to consolidate;');
  assert.match(reserved, /\*\*keep_query_results\*\*/); assert.match(reserved, /\*\*finish_loop\*\*/); assert.doesNotMatch(reserved, /\*\*search_mid\*\*/);
});
