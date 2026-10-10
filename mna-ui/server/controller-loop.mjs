import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const terminal = state => ['completed', 'cancelled', 'failed'].includes(state);
const message = error => error instanceof Error ? error.message : String(error);

/** Turn boundaries belong to Rust; this runner schedules one boundary at a time.
 * POST start is the analyst's Loop-on/send action, not a model instruction.
 */
export function createControllerLoop({ call, connected = () => false, storeFile, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, retryMs = 60_000 }) {
  const runs = new Map(), timers = new Map(), pumps = new Map(), starts = new Map();
  let saveQueue = Promise.resolve(), loading;
  const timestamp = () => new Date(now()).toISOString();

  function snapshot(saved) {
    const done = saved.state === 'completed' || (saved.state === 'cancelled' && saved.appliedReviewId);
    return { id: saved.id, kind: 'loop', runId: saved.runId, sessionId: saved.sessionId, title: saved.title,
      state: saved.state, turn: saved.turn, maxTurns: saved.maxTurns, queries: saved.queries,
      consolidatedCount: saved.consolidatedCount,
      steps: [
        { id: 'plan-queries', label: 'Plan queries', state: saved.turn || terminal(saved.state) ? 'completed' : saved.state },
        { id: 'refine', label: `Refine · turn ${saved.turn} of ${saved.maxTurns}`, state: saved.state },
        { id: 'consolidate', label: 'Consolidate', state: done ? 'completed' : saved.state === 'consolidating' ? 'running' : 'queued' },
        { id: 'apply-shortlist', label: 'Apply shortlist', state: saved.appliedReviewId ? 'completed' : terminal(saved.state) ? 'skipped' : 'queued' },
      ], message: saved.message, startedAt: saved.startedAt, updatedAt: saved.updatedAt,
      simulated: saved.simulated, appliedReviewId: saved.appliedReviewId, finalCount: saved.finalCount,
      undoneReviewId: saved.undoneReviewId,
    };
  }
  function merge(saved, loop) {
    if (loop.loop_id !== saved.id) throw new Error('Loop service returned a different loop ID.');
    saved.turn = loop.turns_used; saved.maxTurns = loop.max_turns; saved.queries = loop.queries ?? [];
    saved.consolidatedCount = loop.consolidated_count ?? 0; saved.appliedReviewId = loop.applied_review_id;
    saved.finalCount = loop.final_count; saved.simulated = Boolean(loop.simulated); saved.undoneReviewId = loop.undone_review_id;
    if (terminal(loop.status)) saved.state = loop.status;
    saved.message = loop.summary || `Discovery loop · turn ${saved.turn} of ${saved.maxTurns}.`;
    saved.updatedAt = timestamp();
  }
  function persist() {
    if (!storeFile) return Promise.resolve();
    const content = JSON.stringify({ version: 1, runs: [...runs.values()] });
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(storeFile), { recursive: true });
      const temp = `${storeFile}.${randomUUID()}.tmp`;
      await writeFile(temp, content, { flag: 'wx' }); await rename(temp, storeFile);
    });
    return saveQueue;
  }
  function init() {
    loading ??= (async () => {
      if (storeFile) {
        try {
          const saved = JSON.parse(await readFile(storeFile, 'utf8'));
          if (saved?.version === 1 && Array.isArray(saved.runs)) for (const run of saved.runs) {
            if (!SAFE_ID.test(run?.id ?? '') || !SAFE_ID.test(run?.runId ?? '') || !Number.isInteger(run.turn) || !Number.isInteger(run.maxTurns)) continue;
            if (!terminal(run.state)) { run.state = 'paused'; run.message = 'Paused after the bridge restarted. Resume to continue.'; }
            run.pauseRequested = false; run.cancelRequested = false; run.updatedAt = timestamp(); runs.set(run.id, run);
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await persist();
    })();
    return loading;
  }
  function find(input = {}) {
    const id = input.id ?? input.loopId;
    if (typeof id !== 'string' || !SAFE_ID.test(id) || !runs.has(id)) throw new Error('Controller loop was not found.');
    return runs.get(id);
  }
  function unschedule(id) { if (timers.has(id)) clearTimer(timers.get(id)); timers.delete(id); }
  function schedule(id, delay = 0) {
    unschedule(id);
    const timer = setTimer(() => { timers.delete(id); void pump(id).catch(() => {}); }, delay);
    timers.set(id, timer); timer?.unref?.();
  }
  async function pumpOnce(id) {
    const saved = runs.get(id);
    if (!saved || saved.state !== 'running' || saved.pauseRequested || saved.cancelRequested) return;
    if (!connected()) { saved.state = 'paused'; saved.message = 'LLM Suite is unavailable. Resume when connected.'; await persist(); return; }
    try {
      // Reconcile a completed apply after a crash between the Rust commit and Node save.
      const current = await call('get_controller_loop', { loop_id: id }); merge(saved, current);
      if (terminal(saved.state)) { await persist(); return; }
      if (saved.pauseRequested || saved.cancelRequested) return;
      const result = await call('run_controller_loop_turn', { loop_id: id }, true); merge(saved, result);
      if (!terminal(saved.state)) saved.state = saved.pauseRequested ? 'paused' : saved.cancelRequested ? 'cancelling' : 'running';
      await persist();
    } catch (error) {
      if (error.code === 'RATE_LIMITED' || error.status === 429 || /rate.limit|seven.*(?:send|minute)|rolling minute/i.test(message(error))) {
        saved.message = 'Waiting for the shared LLM Suite rate gate.'; saved.updatedAt = timestamp(); await persist();
        if (!saved.pauseRequested && !saved.cancelRequested) schedule(id, retryMs);
        return;
      }
      saved.state = !connected() || error.code === 'PROVIDER_UNAVAILABLE' ? 'paused' : 'failed';
      saved.message = message(error); saved.updatedAt = timestamp(); await persist();
    }
    if (saved.state === 'running' && !saved.pauseRequested && !saved.cancelRequested) schedule(id);
  }
  function pump(id) {
    if (pumps.has(id)) return pumps.get(id);
    const pending = Promise.resolve().then(() => pumpOnce(id)).finally(() => pumps.delete(id));
    pumps.set(id, pending); return pending;
  }
  async function start(input) {
    await init();
    if (typeof input.runId !== 'string' || !SAFE_ID.test(input.runId) || typeof input.message !== 'string' || !input.message.trim() || [...input.message].length > 4000) throw new Error('Use a runId and a message of 1..4,000 characters.');
    if (input.maxTurns !== undefined && (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 50)) throw new Error('maxTurns must be 1..50.');
    if (input.title !== undefined && typeof input.title !== 'string') throw new Error('title must be text.');
    if (input.sessionId !== undefined && (typeof input.sessionId !== 'string' || !SAFE_ID.test(input.sessionId))) throw new Error('Use a valid sessionId.');
    if (starts.has(input.runId)) return starts.get(input.runId);
    const pending = (async () => {
      if ([...runs.values()].some(run => run.runId === input.runId && !terminal(run.state))) throw new Error('An active loop already exists for this run.');
      const loop = await call('start_controller_loop', { run_id: input.runId, analyst_message: input.message, ...(input.maxTurns !== undefined ? { max_turns: input.maxTurns } : {}) }, true);
      const saved = { id: loop.loop_id, runId: input.runId, sessionId: input.sessionId, title: input.title?.slice(0, 160) || 'LLM Suite discovery loop', state: connected() ? 'running' : 'paused', startedAt: timestamp(), updatedAt: timestamp() };
      merge(saved, loop); runs.set(saved.id, saved); await persist();
      if (saved.state === 'running') schedule(saved.id);
      return snapshot(saved);
    })().finally(() => starts.delete(input.runId));
    starts.set(input.runId, pending); return pending;
  }
  async function pause(input) {
    await init(); const saved = find(input); if (terminal(saved.state)) return snapshot(saved);
    saved.pauseRequested = true; unschedule(saved.id); await pumps.get(saved.id);
    if (!terminal(saved.state)) { saved.state = 'paused'; saved.message = 'Paused at the turn boundary.'; }
    saved.pauseRequested = false; saved.updatedAt = timestamp(); await persist(); return snapshot(saved);
  }
  async function resume(input) {
    await init(); const saved = find(input);
    if (terminal(saved.state) || saved.cancelRequested) return snapshot(saved);
    saved.pauseRequested = false; saved.state = connected() ? 'running' : 'paused';
    saved.message = connected() ? 'Discovery loop resumed from saved decisions.' : 'LLM Suite is unavailable. Resume when connected.';
    saved.updatedAt = timestamp(); await persist();
    if (saved.state === 'running' && !pumps.has(saved.id)) schedule(saved.id);
    return snapshot(saved);
  }
  async function cancel(input) {
    await init(); const saved = find(input);
    if (typeof input.keep !== 'boolean') throw new Error('Choose keep:true or keep:false.');
    if (terminal(saved.state)) return snapshot(saved);
    saved.cancelRequested = true; saved.pauseRequested = false; saved.state = 'cancelling'; unschedule(saved.id); await persist();
    await pumps.get(saved.id);
    // A finishing turn can have completed before cancellation reached its boundary.
    if (!terminal(saved.state)) {
      const result = await call('cancel_controller_loop', { loop_id: saved.id, keep: input.keep }, true);
      merge(saved, result); saved.state = 'cancelled';
    }
    saved.cancelRequested = false; saved.updatedAt = timestamp(); await persist(); return snapshot(saved);
  }
  async function undo(input) {
    await init(); const saved = find(input); await pumps.get(saved.id);
    if (input.force !== undefined && typeof input.force !== 'boolean') throw new Error('force must be boolean.');
    const result = await call('undo_controller_loop', { loop_id: saved.id, ...(input.force !== undefined ? { force: input.force } : {}) }, true);
    merge(saved, result); saved.message = 'Restored the shortlist selection from before this loop.'; await persist(); return snapshot(saved);
  }
  async function list() { await init(); return [...runs.values()].map(snapshot); }
  function close() { for (const id of timers.keys()) unschedule(id); for (const saved of runs.values()) if (!terminal(saved.state)) saved.pauseRequested = true; }
  return { init, start, pause, resume, cancel, undo, list, close };
}
