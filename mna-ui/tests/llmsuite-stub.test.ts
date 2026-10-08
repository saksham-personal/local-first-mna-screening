import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
// @ts-expect-error Server-only module is tested through the adapter contract.
import { createStub } from '../server/llmsuite-stub.mjs';
import { renderPrompt } from '../shared/prompts.mjs';

const guide = ['search_mid', 'score_mid_semantic', 'search_iscc', 'get_discovery_summary', 'get_shortlist_context', 'get_mid_index_status', 'propose_prepared_plan'].map(action => `${action}: permitted action`).join('\n');
const prompt = (message: string, actions = guide) => renderPrompt('controller-instruction-set', { action_guide: actions, run_summary: 'Criteria revision: 1; approved: true', analyst_message: message });

// Check the documented Markdown envelope here; the Rust controller integration
// tests exercise this server with the actual instruction-set parser/converter.
function shape(text: string) {
  const normalized = text.replace(/^\*\*([^\n*]+)\*\*$/gm, '## $1');
  const section = (name: string) => normalized.split(`## ${name}\n`)[1]?.split('\n## ')[0].trim();
  const instructions = [...(section('Instruction set') ?? '').matchAll(/^\d+\. \*\*([^*]+)\*\* — ([^\n]+)\n?((?:[ \t]+-[^\n]*\n?)*)/gm)].map(match => ({ action: match[1], title: match[2], fields: Object.fromEntries([...match[3].matchAll(/^\s+- ([a-z_]+)(?:: | = )([^\n]+)/gm)].map(field => [field[1], field[2]])) }));
  return { context: section('Context'), reasoning: section('Reasoning'), notes: section('Notes for the analyst'), instructions };
}

test('stub recognizes intents in rendered controller prompts with valid Markdown fields', async () => {
  const stub = createStub();
  const examples: [string, string][] = [['Find claims software', 'search_mid'], ['semantic scoring', 'score_mid_semantic'], ['search iscc claims software', 'search_iscc'], ['summary', 'get_discovery_summary'], ['index status', 'get_mid_index_status'], ['screen candidates', 'propose_prepared_plan'], ['bing research', 'get_shortlist_context']];
  for (const [message, action] of examples) {
    const answer = stub.reply({ conversation_id: 'conv-1', model: 'stub-model', prompt: await prompt(message) });
    const parsed = shape(answer.response_text);
    assert.ok(parsed.context); assert.ok(parsed.reasoning); assert.match(parsed.notes!, /SIMULATED/);
    assert.equal(parsed.instructions.length, 1); assert.equal(parsed.instructions[0].action, action);
    if (action === 'search_mid') assert.equal(parsed.instructions[0].fields.keywords, 'claims software');
    if (action === 'propose_prepared_plan') { assert.equal(parsed.instructions[0].fields.mode, 'screening'); assert.equal(parsed.instructions[0].fields.deployment, 'stub-model'); }
    assert.ok(answer.usage.prompt_tokens > 0);
  }
  assert.equal(stub.transcripts.get('conv-1').length, examples.length);
  assert.throws(() => stub.reply({ conversation_id: '', prompt: 'find', model: 'stub-model' }), /bounded/);
});

test('deviations exercise bold headings, equals fields and repair only the rejected item', async () => {
  const stub = createStub({ deviations: true });
  const request = { conversation_id: 'conv-deviations', model: 'stub-model', prompt: await prompt('Find claims software') };
  assert.equal(shape(stub.reply(request).response_text).instructions[0].action, 'search_mid');
  const second = stub.reply(request).response_text;
  assert.match(second, /\*\*Instruction set\*\*/); assert.match(second, /keywords = claims software/);
  assert.equal(shape(second).instructions[0].fields.keywords, 'claims software');
  assert.equal(shape(stub.reply(request).response_text).instructions[0].action, 'unavailable_stub_action');
  const feedback = await renderPrompt('instruction-feedback', { feedback: 'Instruction 1 was not run: unknown action.', allowed_actions: guide });
  const correction = shape(stub.reply({ ...request, prompt: feedback }).response_text);
  assert.equal(correction.instructions.length, 1); assert.equal(correction.instructions[0].action, 'search_mid');
  assert.equal(stub.transcripts.get(request.conversation_id).length, 4);
});

test('conversation histories are isolated, handoff has no actions and narrowed guide is honored', async () => {
  const stub = createStub({ deviations: true });
  const handoff = await renderPrompt('conversation-handoff', { run_summary: 'Criteria revision: 2; approved: false', recent_decisions: 'New analyst revision needs approval.' });
  const answer = stub.reply({ conversation_id: 'conv-new', model: 'stub-model', prompt: handoff });
  assert.match(answer.response_text, /Criteria revision: 2; approved: false/); assert.doesNotMatch(answer.response_text, /\*\*search_mid\*\*/);
  const status = stub.reply({ conversation_id: 'conv-other', model: 'stub-model', prompt: await prompt('Find claims software', 'get_mid_index_status: read status') });
  assert.equal(shape(status.response_text).instructions[0].action, 'get_mid_index_status');
  assert.equal(stub.transcripts.get('conv-new').length, 1); assert.equal(stub.transcripts.get('conv-other').length, 1);
});

test('HTTP stub serves only authenticated adapter calls and bounded local health', async () => {
  const { server, transcripts } = createStub();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const payload = { conversation_id: 'conv-http', model: 'stub-model', prompt: await prompt('summary') };
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/v1/chat`, { method: 'POST', body: JSON.stringify(payload) })).status, 401);
    const result = await fetch(`${base}/v1/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' }, body: JSON.stringify(payload) });
    assert.equal(result.status, 200); assert.equal(shape((await result.json()).response_text).instructions[0].action, 'get_discovery_summary');
    assert.equal(transcripts.get('conv-http').length, 1);
    assert.equal((await fetch(`${base}/anything`)).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(done)); }
});

test('bridge includes guarded controller routes and isolates stub provider environment', async () => {
  const source = await readFile(new URL('../server/bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /url\.pathname === '\/api\/controller\/turn'/);
  assert.match(source, /url\.pathname === '\/api\/controller\/turns'/);
  assert.match(source, /run_controller_turn: '\/admin\/controller-turn'/);
  assert.match(source, /'X-MNA-Controller-Key': controllerKey/);
  assert.match(source, /if \(origin && !origins\.has\(origin\)\)/);
  assert.match(source, /if \(!hosts\.has/);
  assert.match(source, /MNA_ENABLE_EXTERNAL: 'true', MNA_LLMSUITE_ENDPOINT:/);
  assert.match(source, /LLMSUITE\|BING\|M365\|ISCC/);
  assert.match(source, /llmsuiteStub\?\.kill\(\)/);
});
