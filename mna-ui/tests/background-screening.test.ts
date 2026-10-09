import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-ignore Local controller module is exercised with an injected offline transport.
import { createBackgroundScreening } from '../server/background-screening.mjs';

function fixture(states = ['READY', 'READY'], isConnected = true) {
  const plan = { plan_id: 'plan-1', run_id: 'run-1', digest: 'digest-1',
    status: 'APPROVED', executed: false, fresh: true, spec: { provider: 'llm_suite', mode: 'screening' },
    jobs: states.map((state, ordinal) => ({ job_id: `job-${ordinal + 1}`, ordinal,
      state, input_hash: `hash-${ordinal + 1}` })) };
  const jobs = new Map(plan.jobs.map(item => [item.job_id, { ...item,
    plan_id: plan.plan_id, run_id: plan.run_id, attempt: 0, executed: false, next_eligible_at: undefined as string | undefined, lease_expires_at: undefined as string | undefined, retryable: false }]));
  const sent: string[] = [];
  const call = async (tool: string, args: Record<string, string>) => {
    if (tool === 'get_execution_progress') {
      assert.equal(args.plan_id, plan.plan_id);
      return { ...plan, jobs: plan.jobs.map(item => ({ ...jobs.get(item.job_id)! })) };
    }
    if (tool === 'get_execution_job') return { ...jobs.get(args.job_id) };
    if (tool === 'get_model_assessments') return { assessments: [
      { plan_id: 'plan-1', job_id: 'job-1', eligible_for_current_use: true, result: { score: 4 } },
      { plan_id: 'plan-1', job_id: 'job-2', eligible_for_current_use: false, result: { score: 9 } },
    ], question_answers: [] };
    throw new Error(`Unexpected tool ${tool}`);
  };
  const dispatch = async ({ job_id, controller_id }: { job_id: string; controller_id: string }) => {
    assert.match(controller_id, /^screening-ui-/);
    sent.push(job_id);
    const job = jobs.get(job_id)!;
    job.state = 'SUCCEEDED'; job.attempt++; job.executed = true;
    return { job_id, state: 'SUCCEEDED' };
  };
  return { plan, jobs, sent, call, dispatch, connected: () => isConnected };
}

async function until(predicate: () => boolean) {
  for (let count = 0; count < 100 && !predicate(); count++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'background work did not advance');
}

test('disconnected start is explicitly blocked and never dispatches', async () => {
  const f = fixture(['READY'], false);
  const svc = createBackgroundScreening(f);
  const snapshot = await svc.start({ planId: 'plan-1', digest: 'digest-1', approved: true });
  assert.equal(snapshot.state, 'blocked');
  assert.equal(snapshot.executed, false);
  assert.match(snapshot.message, /No request was sent/);
  assert.deepEqual(f.sent, []);
  svc.close();
});

test('restored stale plans retain provider, batch counts and actual execution without permitting new work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'background-stale-'));
  let restored: ReturnType<typeof createBackgroundScreening> | undefined;
  try {
    const f = fixture(['READY', 'SUCCEEDED'], false);
    f.plan.spec.provider = 'copilot';
    f.jobs.get('job-2')!.executed = true;
    let failRead = false;
    const options = { ...f, storeFile: join(dir, 'controls.json'), call: async (tool: string, args: Record<string, string>) => {
      if (failRead && tool === 'get_execution_progress') throw new Error('Connection temporarily unavailable');
      return f.call(tool, args);
    } };
    const svc = createBackgroundScreening(options);
    await svc.start({ planId: 'plan-1', digest: 'digest-1', approved: true, sessionId: 'session-1' });
    svc.close();
    failRead = true;
    restored = createBackgroundScreening(options);
    const offline = (await restored.list())[0];
    assert.equal(offline.provider, 'copilot');
    assert.equal(offline.total, 2);
    assert.equal(offline.completed, 1);
    assert.equal(offline.executed, true);
    assert.equal(offline.current, false);
    assert.equal(offline.sessionId, 'session-1');
    failRead = false;
    f.plan.fresh = false;
    const stale = (await restored.list())[0];
    assert.equal(stale.state, 'blocked');
    assert.equal(stale.provider, 'copilot');
    assert.equal(stale.total, 2);
    assert.equal(stale.completed, 1);
    assert.equal(stale.executed, true);
    assert.equal(stale.current, false);
    assert.match(stale.message, /screening setup is no longer current/);
    f.plan.status = 'STALE';
    f.jobs.get('job-1')!.state = 'SUCCEEDED';
    f.jobs.get('job-1')!.executed = true;
    const completedStale = (await restored.list())[0];
    assert.equal(completedStale.state, 'blocked');
    assert.equal(completedStale.provider, 'copilot');
    assert.equal(completedStale.total, 2);
    assert.equal(completedStale.completed, 2);
    assert.equal(completedStale.executed, true);
    assert.equal(completedStale.current, false);
    assert.match(completedStale.message, /screening setup is no longer current/);
    await assert.rejects(() => restored!.stage({ planId: 'plan-1' }), /screening setup is no longer current/);
    await assert.rejects(() => restored!.resume({ planId: 'plan-1' }), /screening setup is no longer current/);
    assert.deepEqual(f.sent, []);
  } finally { restored?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('background progression, pause persistence, resume and staging use Rust records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'background-screening-'));
  try {
    const f = fixture();
    let tick: (() => void) | undefined;
    const timers = new Map<number, () => void>();
    let next = 0;
    const options = { ...f, storeFile: join(dir, 'controls.json'),
      setTimer: (callback: () => void) => { timers.set(++next, callback); tick = callback; return next; },
      clearTimer: (timer: number) => { timers.delete(timer); } };
    const svc = createBackgroundScreening(options);
    await svc.start({ planId: 'plan-1', digest: 'digest-1', approved: true, sessionId: 'session-1' });
    await tick!();
    await until(() => f.sent.length === 1);
    const paused = await svc.pause({ planId: 'plan-1' });
    assert.equal(paused.state, 'paused');
    assert.equal(paused.completed, 1);
    svc.close();
    const restored = createBackgroundScreening(options);
    await restored.init();
    assert.equal((await restored.get({ planId: 'plan-1' }))!.state, 'paused');
    await restored.resume({ planId: 'plan-1' });
    await tick!();
    await until(() => f.sent.length === 2);
    const complete = await restored.get({ planId: 'plan-1' });
    assert.equal(complete?.completed, 2);
    const staged = await restored.stage({ planId: 'plan-1' });
    assert.equal(staged.rows.length, 1);
    assert.equal(staged.job.staged, 1);
    assert.equal((await restored.stage({ planId: 'plan-1' })).rows.length, 1);
    restored.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ambiguous and failed attempts are never automatically resent', async () => {
  const f = fixture(['AMBIGUOUS', 'FAILED']);
  const svc = createBackgroundScreening(f);
  const snapshot = await svc.start({ planId: 'plan-1', digest: 'digest-1', approved: true });
  assert.equal(snapshot.failed, 2);
  assert.equal(snapshot.errors[0].retryable, false);
  await assert.rejects(() => svc.retry({ planId: 'plan-1', jobId: 'job-1' }), /Reconcile/);
  await assert.rejects(() => svc.retry({ planId: 'plan-1', jobId: 'job-2' }), /cannot be safely retried/);
  assert.deepEqual(f.sent, []);
  svc.close();
});

test('approval digest is required and a recovered running attempt is not dispatched again', async () => {
  const f = fixture(['RUNNING']);
  const svc = createBackgroundScreening(f);
  await assert.rejects(() => svc.start({ planId: 'plan-1', digest: 'wrong', approved: true }), /screening setup is no longer current/);
  await assert.rejects(() => svc.start({ planId: 'plan-1', digest: 'digest-1', approved: false }), /Approve/);
  const started = await svc.start({ planId: 'plan-1', digest: 'digest-1', approved: true });
  assert.equal(started.running, 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(f.sent, []);
  svc.close();
});

test('a future rate wait is not dispatched early and the gateway owns the shared gate', async () => {
  const f = fixture(['WAITING_RATE']);
  f.jobs.get('job-1')!.next_eligible_at = new Date(Date.now() + 60_000).toISOString();
  const delays: number[] = [];
  const svc = createBackgroundScreening({ ...f,
    setTimer: (callback: () => void, delay: number) => { delays.push(delay); if (delay === 0) queueMicrotask(callback); return delays.length; },
    clearTimer: () => {} });
  await svc.start({ planId: 'plan-1', digest: 'digest-1', approved: true });
  await until(() => delays.length > 1);
  assert.ok(delays[1] > 50_000);
  assert.deepEqual(f.sent, []);
  svc.close();
});

test('analyst retry requeues only definitive failed batches and preserves successful work', async () => {
  const f = fixture(['FAILED', 'SUCCEEDED']);
  f.jobs.get('job-1')!.attempt = 1;
  f.jobs.get('job-1')!.retryable = true;
  const baseCall = f.call;
  const svc = createBackgroundScreening({ ...f, call: async (tool: string, args: Record<string, string | number | boolean>) => {
    if (tool === 'retry_execution_job') {
      assert.equal(args.job_id, 'job-1'); assert.equal(args.attempt, 1); assert.equal(args.analyst_requested, true);
      f.jobs.get('job-1')!.state = 'READY'; return { state: 'READY' };
    }
    return baseCall(tool, args as Record<string, string>);
  } });
  await svc.start({ planId: 'plan-1', digest: 'digest-1', approved: true });
  await svc.retry({ planId: 'plan-1' });
  await until(() => f.sent.length === 1);
  assert.deepEqual(f.sent, ['job-1']);
  assert.equal((await svc.get({ planId: 'plan-1' }))!.completed, 2);
  svc.close();
});

test('a failed provider batch does not prevent later ready batches from completing', async () => {
  const f = fixture();
  const svc = createBackgroundScreening({ ...f, dispatch: async (args: { job_id: string; controller_id: string }) => {
    if (args.job_id === 'job-1') { f.jobs.get('job-1')!.state = 'FAILED'; throw new Error('Provider rejected the request'); }
    return f.dispatch(args);
  } });
  await svc.start({ planId: 'plan-1', digest: 'digest-1', approved: true });
  await until(() => f.sent.length === 1);
  const status = await svc.get({ planId: 'plan-1' });
  assert.equal(status.completed, 1); assert.equal(status.failed, 1);
  assert.equal(status.events.filter((event: { status: string }) => event.status === 'error').length, 1);
  svc.close();
});

test('expired undispatched leases are recovered, but expired sends are quarantined without resending', async () => {
  const f = fixture(['LEASED', 'RUNNING']);
  f.jobs.forEach(job => { job.lease_expires_at = new Date(Date.now() - 1000).toISOString(); });
  const baseCall = f.call;
  const svc = createBackgroundScreening({ ...f, call: async (tool: string, args: Record<string, string>) => {
    if (tool === 'lease_execution_job') {
      assert.equal(args.job_id, 'job-2'); f.jobs.get('job-2')!.state = 'AMBIGUOUS'; throw new Error('Expired dispatched lease requires reconciliation');
    }
    return baseCall(tool, args);
  } });
  await svc.start({ planId: 'plan-1', digest: 'digest-1', approved: true });
  await until(() => f.sent.length === 1);
  assert.deepEqual(f.sent, ['job-1']);
  assert.equal(f.jobs.get('job-2')!.state, 'AMBIGUOUS');
  svc.close();
});

test('a pause that completes during batch preparation prevents the next dispatch', async () => {
  const f = fixture();
  let tick: (() => void) | undefined;
  let reads = 0;
  let continueRead!: () => void;
  let beganRead!: () => void;
  const waiting = new Promise<void>(resolve => { beganRead = resolve; });
  const hold = new Promise<void>(resolve => { continueRead = resolve; });
  const baseCall = f.call;
  const svc = createBackgroundScreening({ ...f, setTimer: (callback: () => void) => { tick = callback; return 1; }, clearTimer: () => {}, call: async (tool: string, args: Record<string, string>) => {
    if (tool === 'get_execution_progress' && ++reads === 2) { beganRead(); await hold; }
    return baseCall(tool, args);
  } });
  await svc.start({ planId: 'plan-1', digest: 'digest-1', approved: true });
  tick!(); await waiting;
  await svc.pause({ planId: 'plan-1' });
  continueRead();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(f.sent, []);
  svc.close();
});

test('screening cancellation waits for an active batch, cancels pending Rust jobs, and keeps completed assessments', async () => {
  const f = fixture(['SUCCEEDED', 'READY']);
  f.jobs.get('job-1')!.executed = true;
  let tick: (() => void) | undefined;
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const adminCalls: string[] = [];
  const baseCall = f.call;
  const svc = createBackgroundScreening({ ...f,
    setTimer: (callback: () => void) => { tick = callback; return 1; }, clearTimer: () => {},
    dispatch: async (args: { job_id: string; controller_id: string }) => { entered(); await held; return f.dispatch(args); },
    call: async (tool: string, args: Record<string, string>) => {
      if (tool === 'cancel_prepared_plan') {
        adminCalls.push(tool); assert.equal(args.plan_id, 'plan-1'); assert.equal(args.cancelled_by, 'screening-ui-analyst');
        f.plan.status = 'CANCELLED'; f.jobs.get('job-2')!.state = 'CANCELLED';
        return { status: 'CANCELLED' };
      }
      if (tool === 'discard_plan_results') { adminCalls.push(tool); return { discarded: true }; }
      return baseCall(tool, args);
    } });
  await svc.start({ planId: 'plan-1', digest: 'digest-1', approved: true });
  tick!(); await waiting;
  const cancelling = svc.cancel({ planId: 'plan-1', keep: true });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(adminCalls, []);
  release();
  const cancelled = await cancelling;
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(adminCalls, ['cancel_prepared_plan']);
  assert.equal(cancelled.steps[0].label, 'Build input table');
  assert.equal(cancelled.steps[1].label, 'Send batches · 2 of 2');
  const staged = await svc.stage({ planId: 'plan-1' });
  assert.equal(staged.rows.length, 1);
  assert.equal(staged.rows[0].job_id, 'job-1');
  svc.close();
});

test('screening cancellation discards processed results only when the analyst chooses discard', async () => {
  const f = fixture(['SUCCEEDED', 'READY']);
  f.jobs.get('job-1')!.executed = true;
  const calls: string[] = [];
  const baseCall = f.call;
  const svc = createBackgroundScreening({ ...f, setTimer: () => 1, clearTimer: () => {},
    call: async (tool: string, args: Record<string, string>) => {
      if (tool === 'cancel_prepared_plan') {
        calls.push(tool); f.plan.status = 'CANCELLED'; f.jobs.get('job-2')!.state = 'CANCELLED';
        return { status: 'CANCELLED' };
      }
      if (tool === 'discard_plan_results') {
        calls.push(tool); assert.equal(args.run_id, 'run-1'); assert.equal(args.plan_id, 'plan-1'); assert.equal(args.kind, 'screening');
        return { discarded: true };
      }
      return baseCall(tool, args);
    } });
  await svc.start({ planId: 'plan-1', digest: 'digest-1', approved: true });
  const cancelled = await svc.cancel({ planId: 'plan-1', keep: false });
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(calls, ['cancel_prepared_plan', 'discard_plan_results']);
  assert.match(cancelled.message, /discarded/);
  svc.close();
});

test('accepted durable results can be staged after provider disconnection', async () => {
  const f = fixture(['SUCCEEDED'], false);
  f.jobs.get('job-1')!.executed = true;
  const svc = createBackgroundScreening(f);
  const run = await svc.start({ planId: 'plan-1', digest: 'digest-1', approved: true });
  assert.equal(run.state, 'completed');
  const staged = await svc.stage({ planId: 'plan-1' });
  assert.equal(staged.rows.length, 1);
  assert.equal(staged.job.staged, 1);
  assert.deepEqual(f.sent, []);
  svc.close();
});
