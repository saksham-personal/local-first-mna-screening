import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
// @ts-expect-error Server-only controller is tested with an injected transport.
import { createProviderConversation, parseBingTemplates } from '../server/provider-conversation.mjs';

test('direct ask includes selected staged text and omits excluded attachments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-conversation-'));
  try {
    const csv = join(dir, 'sample.csv'), docx = join(dir, 'brief.docx');
    await writeFile(csv, 'Company,Description\nAcme,Claims software');
    await writeFile(docx, zipSync({ 'word/document.xml': strToU8('<w:document><w:t>Private brief</w:t></w:document>') }));
    const staged = new Map([
      ['csv-id', { id: 'csv-id', name: 'sample.csv', path: csv, bytes: (await stat(csv)).size, sessionId: 'session-1' }],
      ['doc-id', { id: 'doc-id', name: 'brief.docx', path: docx, bytes: (await stat(docx)).size }],
    ]);
    const dispatched: any[] = [];
    const conversation = createProviderConversation({ stagedFiles: staged, connected: () => true, deployment: () => 'configured-deployment',
      dispatch: async (args: any) => { dispatched.push(args); return { executed: true, text: 'Acme makes claims software.' }; } });
    const result = await conversation.ask({ sessionId: 'session-1', requestId: 'message-1', provider: 'llm_suite', question: 'What does Acme make?', attachments: [{ id: 'csv-id' }, { id: 'doc-id', include: false }] });
    assert.equal(result.executed, true);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].deployment, 'configured-deployment');
    assert.match(dispatched[0].request_id, /^[a-f0-9]{20}-message-1$/);
    assert.equal(dispatched[0].attachments.length, 1);
    assert.match(dispatched[0].attachments[0].content, /Claims software/);
    assert.ok(!JSON.stringify(result.calls).includes('Claims software'));
    await assert.rejects(conversation.ask({ sessionId: 'session-1', provider: 'llm_suite', question: 'Question', attachments: [{ id: '../other' }] }), /staged/i);
    await assert.rejects(conversation.ask({ sessionId: 'session-2', provider: 'llm_suite', question: 'Question', attachments: [{ id: 'csv-id' }] }), /another chat/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('disconnected provider returns honest nonexecution without dispatch', async () => {
  let count = 0;
  const conversation = createProviderConversation({ stagedFiles: new Map(), connected: () => false, deployment: () => '', dispatch: async () => { count++; return {}; } });
  const answer = await conversation.ask({ sessionId: 'session-1', provider: 'copilot', question: 'What is known?' });
  assert.equal(answer.executed, false);
  assert.equal(count, 0);
  const generated = await conversation.generate({ purpose: 'bing-templates', businessDefinition: 'Claims software' });
  assert.equal(generated.executed, false);
  assert.equal(count, 0);
});

test('direct ask reads bounded current criteria and considered source context', async () => {
  const calls: any[] = [], dispatched: any[] = [];
  const service = createProviderConversation({ stagedFiles: new Map(), connected: () => true, deployment: () => 'configured-deployment',
    call: async (tool: string, args: any) => {
      calls.push({ tool, args });
      if (tool === 'get_shortlist_context') return { considered_count: 350, coverage: { PB: 1 }, candidates: [{ company_id: 'kept-pk' }] };
      if (tool === 'get_criteria_history') return { revisions: [{ business_definition: 'Claims workflow software', approved: true, good_fit_examples: ['Good example'] }] };
      return { rows: [{ pk: 'kept-pk', PB_Name: 'PitchBook preferred company', Description: 'x'.repeat(10000) }] };
    }, dispatch: async (args: any) => { dispatched.push(args); return { executed: true, text: 'Answer from current data.' }; } });
  const result = await service.ask({ sessionId: 'session-1', runId: 'run-1', requestId: 'ask:message:1', provider: 'copilot', question: 'What is the business?' });
  assert.equal(result.executed, true);
  assert.deepEqual(calls.map(item => item.tool), ['get_shortlist_context', 'get_criteria_history', 'get_run_source_projection']);
  assert.equal(calls[0].args.limit, 5);
  assert.equal(calls[0].args.include_hidden, undefined);
  assert.deepEqual(calls[2].args.company_ids, ['kept-pk']);
  assert.match(dispatched[0].prompt, /Claims workflow software/);
  assert.match(dispatched[0].prompt, /PitchBook preferred company/);
  assert.match(dispatched[0].prompt, /"totalConsidered":350/);
  assert.ok(!dispatched[0].prompt.includes('x'.repeat(801)));
  assert.match(dispatched[0].request_id, /^[A-Za-z0-9._-]+$/);
  assert.equal(result.calls.length, 4);
});

test('enrichment files cannot be attached to a provider question', async () => {
  let count = 0;
  const service = createProviderConversation({ stagedFiles: new Map([['mapping', { name: 'mapping.csv', sessionId: 'session-1', purpose: 'pitchbook' }]]),
    connected: () => true, deployment: () => 'configured-deployment', dispatch: async () => { count++; return {}; } });
  await assert.rejects(service.ask({ sessionId: 'session-1', provider: 'llm_suite', question: 'Read mapping', attachments: [{ id: 'mapping' }] }), /separate chat attachment/i);
  assert.equal(count, 0);
});

test('staged PDF and XLSX attachments are excerpted before an authorized ask', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-documents-'));
  try {
    const pdf = new URL('../public/examples/screening-brief.pdf', import.meta.url);
    const xlsx = join(dir, 'companies.xlsx');
    await writeFile(xlsx, zipSync({ 'xl/worksheets/sheet1.xml': strToU8('<worksheet><row><c><v>Claims software</v></c></row></worksheet>') }));
    const attachments: any[] = [];
    const service = createProviderConversation({ stagedFiles: new Map([
      ['pdf', { name: 'screening-brief.pdf', path: pdf, bytes: (await stat(pdf)).size }],
      ['xlsx', { name: 'companies.xlsx', path: xlsx, bytes: (await stat(xlsx)).size }],
    ]), connected: () => true, deployment: () => 'configured-deployment',
    dispatch: async (args: any) => { attachments.push(...args.attachments); return { executed: true, text: 'Received.' }; } });
    const result = await service.ask({ sessionId: 'session-1', provider: 'llm_suite', question: 'Summarize the files.', attachments: [{ id: 'pdf' }, { id: 'xlsx' }] });
    assert.equal(result.executed, true);
    assert.equal(attachments.length, 2);
    assert.ok(attachments[0].content.length > 20);
    assert.match(attachments[1].content, /Claims software/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('template generation parses plain lines and leaves format repairs to the shared gateway', async () => {
  const responses = ['Unknown {sector}', 'QUERY: {company} products\nQUERY: {company} customers'];
  const dispatched: any[] = [];
  const conversation = createProviderConversation({ stagedFiles: new Map(), connected: () => true, deployment: () => 'configured-deployment',
    dispatch: async (args: any) => { dispatched.push(args); return { executed: true, text: responses.shift() }; } });
  const invalid = await conversation.generate({ purpose: 'bing-templates', criteriaText: 'Claims software' });
  assert.equal(invalid.executed, true);
  assert.match(invalid.message, /could not be used/i);
  const result = await conversation.generate({ purpose: 'bing-templates', sessionId: 'session-1', requestId: 'draft-1', criteriaText: 'Claims software' });
  assert.deepEqual(result.templates, ['{company} products', '{company} customers']);
  assert.equal(dispatched.length, 2);
  assert.ok(dispatched.every(item => item.expected_format === 'query_templates'));
  assert.match(dispatched[1].request_id, /^[a-f0-9]{20}-draft-1$/);
  assert.throws(() => parseBingTemplates('QUERY: {company} products\nQUERY: {COMPANY} products'), /distinct/i);
  assert.deepEqual(parseBingTemplates('BEGIN_QUERIES\nQUERY: {company} products\nEND_QUERIES'), ['{company} products']);
});
