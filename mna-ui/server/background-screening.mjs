import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const ACTIVE = new Set(['READY', 'LEASED', 'WAITING_RATE', 'PARSE_REVIEW', 'RUNNING']);
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'STALE', 'CANCELLED', 'AMBIGUOUS']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const STALE_SETUP_MESSAGE = 'This screening setup is no longer current. Review and approve a new setup.';

function id(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`Use a valid ${label}.`);
  return value;
}

function message(error) { return error instanceof Error ? error.message : String(error); }
function eligible(job, now) {
  return job.state === 'READY' || job.state === 'PARSE_REVIEW' || (job.state === 'LEASED' && Date.parse(job.lease_expires_at ?? '') <= now) ||
    (job.state === 'WAITING_RATE' && Date.parse(job.next_eligible_at ?? '') <= now);
}

/** Background orchestration only. The Rust plan, job ledger, gateway, parser,
 * assessments, and shared LLM Suite rate gate are authoritative. */
export function createBackgroundScreening({ call, dispatch, connected = () => false,
  storeFile, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (typeof call !== 'function' || typeof dispatch !== 'function') throw new Error('A Rust controller and gateway are required.');
  const controls = new Map();
  const running = new Set();
  const timers = new Map();
  const preferred = new Map();
  const controllerId = `screening-ui-${randomUUID()}`;
  let saveQueue = Promise.resolve();
  let loaded = false;

  async function init() {
    if (loaded) return;
    if (storeFile) {
      try {
        const saved = JSON.parse(await readFile(storeFile, 'utf8'));
        if (saved?.version === 1 && Array.isArray(saved.controls)) {
          for (const item of saved.controls) {
            if (SAFE_ID.test(item?.planId ?? '') && SAFE_ID.test(item?.digest ?? '') &&
                typeof item.paused === 'boolean' && Number.isSafeInteger(item.staged) && item.staged >= 0) {
              controls.set(item.planId, { planId: item.planId, digest: item.digest,
                sessionId: item.sessionId, paused: item.paused, staged: item.staged,
                lastSnapshot: item.lastSnapshot, events: Array.isArray(item.events) ? item.events : [], blocked: item.blocked ?? '', updatedAt: item.updatedAt ?? new Date(now()).toISOString() });
            }
          }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    loaded = true;
    for (const control of controls.values())
      if (!control.paused && !control.blocked) schedule(control.planId);
  }

  function save() {
    if (!storeFile) return Promise.resolve();
    const content = JSON.stringify({ version: 1, controls: [...controls.values()] });
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(storeFile), { recursive: true });
      const tmp = `${storeFile}.${randomUUID()}.tmp`;
      await writeFile(tmp, content, { flag: 'wx' });
      await rename(tmp, storeFile);
    });
    return saveQueue;
  }

  async function planJobs(planId, expectedDigest, { allowStale = false } = {}) {
    const plan = await call('get_execution_progress', { plan_id: planId });
    if (plan?.plan_id !== planId || !(plan.status === 'APPROVED' || (allowStale && plan.status === 'STALE')) || plan.digest !== expectedDigest ||
        plan.executed !== false || (!allowStale && plan.fresh !== true) || !Array.isArray(plan.jobs) || !plan.jobs.length)
      throw new Error(STALE_SETUP_MESSAGE);
    if (!['llm_suite', 'copilot'].includes(plan.spec?.provider)) throw new Error('Unsupported screening provider.');
    const jobs = plan.jobs.map(entry => {
      id(entry.job_id, 'execution job');
      if (entry.plan_id !== planId || typeof entry.input_hash !== 'string') throw new Error('The durable job ledger changed during the snapshot.');
      return entry;
    });
    return { plan, jobs };
  }

  function snapshot({ plan, jobs }, control, { stale = false } = {}) {
    const counts = { total: jobs.length, completed: 0, failed: 0, running: 0 };
    const errors = [];
    for (const job of jobs) {
      if (job.state === 'SUCCEEDED') counts.completed++;
      else if (job.state === 'RUNNING' || job.state === 'LEASED') counts.running++;
      else if (TERMINAL.has(job.state)) {
        counts.failed++;
        errors.push({ batch: job.ordinal + 1, jobId: job.job_id,
          message: job.error || (job.state === 'AMBIGUOUS'
            ? 'The provider attempt may have been sent. Reconcile its receipt before retrying.'
            : `Job is ${job.state.toLowerCase()}.`), retryable: job.retryable === true });
      }
    }
    const hasPending = jobs.some(job => ACTIVE.has(job.state));
    const executed = jobs.some(job => job.executed === true);
    const blocked = stale ? STALE_SETUP_MESSAGE : control.blocked || (!connected(plan.spec.provider) ? (executed ? 'Provider connection is unavailable. Recorded results remain saved.' : 'Provider connection is unavailable. No request was sent.') : '');
    const state = stale ? 'blocked' : !hasPending && !counts.failed ? 'completed' : control.paused ? 'paused' : blocked ? 'blocked' :
      counts.running || running.has(plan.plan_id) ? 'running' :
      hasPending ? 'queued' : counts.failed ? 'error' : 'completed';
    return { id: plan.plan_id, planId: plan.plan_id, runId: plan.run_id,
      title: plan.spec?.mode === 'question' ? 'Question' : 'Screening', provider: plan.spec?.provider,
      state, ...counts, staged: control.staged, message: blocked ||
        (state === 'paused' ? 'Paused after the current provider request.' :
          state === 'completed' ? 'All durable jobs completed.' : ''),
      errors, updatedAt: control.updatedAt, executed, current: !stale, events: control.events ?? [],
      ...(control.sessionId ? { sessionId: control.sessionId } : {}), digest: plan.digest };
  }

  async function get({ planId }) {
    await init();
    planId = id(planId, 'plan');
    const control = controls.get(planId);
    if (!control) return undefined;
    // Historical progress remains readable after a source edit. Execution,
    // retry and staging still require the current approved inputs.
    const data = await planJobs(planId, control.digest, { allowStale: true });
    const result = snapshot(data, control, { stale: data.plan.fresh !== true || data.plan.status === 'STALE' });
    control.lastSnapshot = result;
    return result;
  }

  async function list() {
    await init();
    const out = [];
    for (const [planId, control] of controls) {
      try { out.push(await get({ planId })); }
      catch (error) { out.push({ ...(control.lastSnapshot ?? { id: planId, planId, runId: '', title: 'Screening', provider: 'llm_suite', total: 0, completed: 0, failed: 0, running: 0, staged: control.staged, executed: false, sessionId: control.sessionId }), state: 'blocked', current: false, message: message(error), errors: [], updatedAt: new Date(now()).toISOString() }); }
    }
    return out;
  }

  function schedule(planId, delay = 0) {
    if (timers.has(planId)) clearTimer(timers.get(planId));
    const timer = setTimer(() => {
      timers.delete(planId);
      void pump(planId).catch(async error => {
        const control = controls.get(planId);
        if (control) { control.blocked = message(error); control.updatedAt = new Date(now()).toISOString(); await save(); }
      });
    }, Math.max(0, delay));
    timers.set(planId, timer);
    timer?.unref?.();
  }

  async function pump(planId) {
    const control = controls.get(planId);
    if (!control || control.paused || running.has(planId)) return;
    running.add(planId);
    try {
      const { jobs, plan } = await planJobs(planId, control.digest);
      // Expired dispatched attempts must be quarantined by the durable controller.
      for (const item of jobs.filter(job => job.state === 'RUNNING' && Date.parse(job.lease_expires_at ?? '') <= now())) {
        try { await call('lease_execution_job', { job_id: item.job_id, controller_id: controllerId }); }
        catch (error) {
          const recorded = await call('get_execution_job', { job_id: item.job_id });
          if (recorded.state !== 'AMBIGUOUS') throw error;
        }
        for (const event of control.events ?? []) if (event.args?.job_id === item.job_id && event.status === 'running') { event.status = 'error'; event.error = 'Interrupted dispatched attempt requires reconciliation.'; event.finishedAt = new Date(now()).toISOString(); }
        await save();
      }
      if (!connected(plan.spec.provider) || control.paused) return;
      const chosen = preferred.get(planId);
      preferred.delete(planId);
      const job = jobs.find(item => item.job_id === chosen && eligible(item, now())) ??
        jobs.find(item => eligible(item, now()));
      if (!job) {
        const due = jobs.filter(item => ['WAITING_RATE', 'LEASED', 'RUNNING'].includes(item.state))
          .map(item => Date.parse(item.state === 'WAITING_RATE' ? item.next_eligible_at ?? '' : item.lease_expires_at ?? '') - now())
          .filter(value => Number.isFinite(value) && value > 0);
        if (due.length) schedule(planId, Math.min(...due));
        return;
      }
      // The Rust gateway leases and dispatches this exact approved frozen job.
      // Its own durable slot ledger covers screening, questions and parse repairs.
      if (control.paused) return;
      const event = { id: randomUUID(), tool: 'dispatch_execution_job', args: { job_id: job.job_id }, startedAt: new Date(now()).toISOString(), status: 'running' };
      control.events ??= [];
      control.events.push(event);
      control.events = control.events.slice(-5000);
      await save();
      if (control.paused) { control.events = control.events.filter(item => item.id !== event.id); await save(); return; }
      try {
        const result = await dispatch({ job_id: job.job_id, controller_id: controllerId });
        event.status = 'success'; event.result = { job_id: result.job_id, state: result.state, executed: result.executed, accepted: result.accepted, next_eligible_at: result.next_eligible_at };
      } catch (error) {
        event.status = 'error'; event.error = message(error);
        // A definitive failed batch must not stop unrelated ready batches.
        const recorded = await call('get_execution_job', { job_id: job.job_id });
        if (!['FAILED', 'AMBIGUOUS', 'WAITING_RATE', 'PARSE_REVIEW'].includes(recorded.state)) throw error;
      } finally { event.finishedAt = new Date(now()).toISOString(); await save(); }
      control.updatedAt = new Date(now()).toISOString();
      await save();
      if (!control.paused) schedule(planId);
    } finally { running.delete(planId); }
  }

  async function start({ planId, sessionId, digest, approved }) {
    await init();
    planId = id(planId, 'plan'); digest = id(digest, 'plan digest');
    if (approved !== true) throw new Error('Approve the exact prepared plan before starting.');
    const current = controls.get(planId);
    if (current && current.digest !== digest) throw new Error('This plan already has a different approval digest.');
    const data = await planJobs(planId, digest);
    const control = current ?? { planId, digest, staged: 0, paused: false, blocked: '', events: [], updatedAt: '' };
    if (sessionId !== undefined) control.sessionId = id(sessionId, 'session');
    control.paused = false;
    control.blocked = connected(data.plan.spec.provider) ? '' : (data.jobs.some(job => job.executed) ? 'Provider connection is unavailable. Recorded results remain saved.' : 'Provider connection is unavailable. No request was sent.');
    control.updatedAt = new Date(now()).toISOString();
    control.lastSnapshot = snapshot(data, control);
    controls.set(planId, control);
    await save();
    if (!control.blocked) schedule(planId);
    return control.lastSnapshot;
  }

  async function pause({ planId }) {
    await init(); planId = id(planId, 'plan');
    const control = controls.get(planId);
    if (!control) throw new Error('Background screening plan was not started.');
    control.paused = true; control.updatedAt = new Date(now()).toISOString();
    if (timers.has(planId)) { clearTimer(timers.get(planId)); timers.delete(planId); }
    await save();
    return get({ planId });
  }

  async function resume({ planId }) {
    await init(); planId = id(planId, 'plan');
    const control = controls.get(planId);
    if (!control) throw new Error('Background screening plan was not started.');
    const data = await planJobs(planId, control.digest);
    control.paused = false;
    control.blocked = connected(data.plan.spec.provider) ? '' : (data.jobs.some(job => job.executed) ? 'Provider connection is unavailable. Recorded results remain saved.' : 'Provider connection is unavailable. No request was sent.');
    control.updatedAt = new Date(now()).toISOString(); await save();
    if (!control.blocked) schedule(planId);
    return snapshot(data, control);
  }

  async function retry({ planId, jobId }) {
    await init(); planId = id(planId, 'plan');
    const control = controls.get(planId);
    if (!control) throw new Error('Background screening plan was not started.');
    const data = await planJobs(planId, control.digest);
    if (!connected(data.plan.spec.provider)) throw new Error('Provider connection is unavailable. No retry was sent.');
    const selected = jobId ? data.jobs.filter(job => job.job_id === id(jobId, 'execution job')) : data.jobs.filter(job => job.retryable === true);
    if (!selected.length) throw new Error('There are no safely retryable failed batches.');
    for (const job of selected) {
      if (job.state === 'FAILED' && job.retryable === true) {
        await call('retry_execution_job', { job_id: job.job_id, attempt: job.attempt, reason: 'Analyst requested retry from background progress', analyst_requested: true });
      } else if (!eligible(job, now())) throw new Error(job.state === 'AMBIGUOUS' ? 'This attempt may have been sent. Reconcile its receipt before retrying.' : `Job cannot be safely retried from ${job.state}.`);
    }
    control.paused = false; control.blocked = '';
    if (jobId) preferred.set(planId, jobId);
    control.updatedAt = new Date(now()).toISOString(); await save();
    schedule(planId);
    return get({ planId });
  }

  async function stage({ planId }) {
    await init(); planId = id(planId, 'plan');
    const control = controls.get(planId);
    if (!control) throw new Error('Background screening plan was not started.');
    const data = await planJobs(planId, control.digest);
    const accepted = new Set(data.jobs.filter(job => job.state === 'SUCCEEDED').map(job => job.job_id));
    const persisted = await call('get_model_assessments', { run_id: data.plan.run_id, plan_id: planId });
    const rows = (persisted.assessments ?? []).filter(row =>
      row.plan_id === planId && accepted.has(row.job_id) && row.eligible_for_current_use === true);
    const answers = (persisted.question_answers ?? []).filter(row =>
      row.plan_id === planId && accepted.has(row.job_id) && row.eligible_for_current_use === true);
    control.staged = new Set([...rows, ...answers].map(row => row.job_id)).size;
    control.updatedAt = new Date(now()).toISOString(); await save();
    return { job: snapshot(data, control), rows, answers };
  }

  function close() { for (const timer of timers.values()) clearTimer(timer); timers.clear(); }
  return { init, list, get, start, pause, resume, retry, stage, close };
}
