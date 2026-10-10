// Invoked by the Rust integration test against its authenticated local router.
import assert from 'node:assert/strict';
import { createControllerLoop } from '../server/controller-loop.mjs';
const [address, id, action] = process.argv.slice(2);
const call = async (tool, args, approved) => {
  if (tool === 'start_controller_loop') return call('get_controller_loop', { loop_id: id });
  if (tool === 'run_controller_loop_turn') assert.equal(approved, undefined);
  const op = { run_controller_loop_turn: 'turn', cancel_controller_loop: 'cancel', undo_controller_loop: 'undo' }[tool];
  const response = await fetch(`${address}${op ? `/admin/controller-loop-${op}` : '/tools/call'}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer loop-service-key-with-24-characters', 'x-mna-controller-key': 'loop-controller-key-with-24-characters' },
    body: JSON.stringify(op ? args : { tool, arguments: args }),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, status: response.status });
  return op ? result : result.result;
};
const runner = createControllerLoop({ call, connected: () => true });
const until = async state => {
  for (let n = 0; n < 500; n++) {
    if ((await runner.list())[0]?.state === state) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Expected ${state}: ${JSON.stringify(await runner.list())}`);
};
try {
  await runner.start({ runId: 'R', message: 'Find claims' });
  await until('paused');
  assert.equal((await call('get_controller_loop', { loop_id: id })).status, 'paused');
  assert.equal((await runner.list())[0].message, 'The shortlist changed during the loop. Resume to re-apply, or cancel.');
  if (action === 'resume') { await runner.resume({ id }); await until('completed'); }
  else { assert.equal((await runner.cancel({ id, keep: action === 'keep' })).state, 'cancelled'); }
  const shortlist = await call('get_shortlist_context', { run_id: 'R' });
  assert.equal(shortlist.considered_count, action === 'discard' ? 0 : 4);
  assert.equal(Boolean((await runner.list())[0].appliedReviewId), action !== 'discard');
  console.log(`Stale apply Rust + Node ${action}: recovered; considered=${shortlist.considered_count}`);
} finally { runner.close(); }
