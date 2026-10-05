import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Server-only controller is tested with an injected transport.
import { createBingResearch } from '../server/bing-research.mjs';

const queries = ['{company} products', '{company} {website} customers', '{company} business description'];

function fixture(count = 1, connected = false) {
  const calls: { tool: string; args: Record<string, any> }[] = [];
  const companies = Array.from({ length: count }, (_, index) => ({ company_id: `A-${String(index).padStart(4, '0')}`, name: `MID ${index}`, website: `mid${index}.example`, PB_Name: `PB ${index}`, PB_Website: `pb${index}.example`, coverage: { PB: true, ROGO: false, BING: false } }));
  let templates: string[] = [];
  let revision = 'revision-1';
  const service = createBingResearch({ connected: () => connected, call: async (tool: string, args: Record<string, any>) => {
    calls.push({ tool, args });
    if (tool === 'get_shortlist_context') {
      const start = args.after_company_id ? companies.findIndex(company => company.company_id === args.after_company_id) + 1 : 0;
      const candidates = companies.slice(start, start + args.limit);
      return { candidates, considered_count: companies.length, selection_revision: revision, criteria_revision: { revision: 2, digest: "approved-criteria" }, source_hash: JSON.stringify({ revision, companies: companies.map(item => [item.company_id, item.PB_Name, item.PB_Website, item.coverage.PB, item.coverage.ROGO]) }), has_more: start + candidates.length < companies.length, next_after_company_id: candidates.at(-1)?.company_id };
    }
    if (tool === 'create_run') return { run_id: 'run-1' };
    if (tool === 'propose_action_plan') { templates = args.steps[0].query_templates; return { plan_id: 'plan-1' }; }
    if (tool === 'approve_action_plan') return { status: 'APPROVED' };
    if (tool === 'prepare_bing_queries') return { queries: args.company_ids.flatMap((id: string) => {
      const company = companies.find(item => item.company_id === id)!;
      return templates.map(template => ({ company_id: id, query: template.replace(/\{company\}|\{website\}|<company>/gi, (token: string) => token.toLowerCase() === '{website}' ? company.PB_Website : company.PB_Name) }));
    }) };
    if (tool === 'bing_search') {
      const company = companies.find(item => item.company_id === args.company_id);
      if (company) company.coverage.BING = true;
      return { evidence_id: 'evidence-1', results: [{ title: 'Primary page', url: 'https://pb.example/products', snippet: 'Business description' }] };
    }
    throw new Error(`Unexpected call ${tool}`);
  } });
  return { service, calls, companies, setRevision: (value: string) => { revision = value; } };
}

test('company preview derives all considered IDs and prefers PitchBook identity', async () => {
  const f = fixture(2);
  const preview = await f.service.preview({ runId: 'run-1', mode: 'company', companyIds: ['wrong-manual-id'], queries: ['{company} products'] });
  assert.equal(preview.companyCount, 2);
  assert.equal(preview.queryCount, 2);
  assert.equal(preview.queries[0].query, 'PB 0 products');
  assert.deepEqual(f.calls.find(call => call.tool === 'propose_action_plan')?.args.steps[0].company_ids, f.companies.map(company => company.company_id));
  const result = await f.service.run({ token: preview.token, approved: true });
  assert.equal(result.executed, false);
  assert.ok(!f.calls.some(call => call.tool === 'bing_search'));
});

test('stale selection or source identity prevents approval and send', async () => {
  const f = fixture(1, true), preview = await f.service.preview({ runId: 'run-1', mode: 'company', queries });
  f.companies[0].PB_Name = 'Changed';
  await assert.rejects(f.service.run({ token: preview.token, approved: true }), /changed/i);
  assert.ok(!f.calls.some(call => call.tool === 'approve_action_plan'));
  const f2 = fixture(1, true), second = await f2.service.preview({ runId: 'run-1', mode: 'company', queries });
  f2.setRevision('revision-2');
  await assert.rejects(f2.service.run({ token: second.token, approved: true }), /changed/i);
});

test('connected research sends exact approved queries and returns unverified leads', async () => {
  const f = fixture(1, true), preview = await f.service.preview({ runId: 'run-1', mode: 'company', queries });
  await assert.rejects(f.service.run({ token: preview.token, approved: false }), /approve/i);
  const result = await f.service.run({ token: preview.token, approved: true });
  assert.equal(result.executed, true);
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows[0].Verification, 'Unverified research lead');
  assert.equal(f.calls.filter(call => call.tool === 'bing_search').length, 3);
});

test('more than 100 considered companies are paged and every approved query is processed in bounded sends', async () => {
  const f = fixture(501, true);
  const preview = await f.service.preview({ runId: 'run-1', mode: 'company', queries: ['{company} products'] });
  assert.equal(preview.queryCount, 501);
  assert.equal(preview.queries.length, 20);
  assert.equal(preview.previewTruncated, true);
  assert.equal(f.calls.filter(call => call.tool === 'get_shortlist_context').length, 2);
  let result;
  do { result = await f.service.run({ token: preview.token, approved: true }); } while (result.more);
  assert.equal(result.processedQueries, 501);
  assert.equal(f.calls.filter(call => call.tool === 'bing_search').length, 501);
});

test('unknown placeholders, duplicate templates, and general research remain explicit', async () => {
  const f = fixture(0);
  await assert.rejects(f.service.preview({ mode: 'general', queries: ['{unknown} products'] }), /placeholder/i);
  await assert.rejects(f.service.preview({ mode: 'general', queries: ['Product market', 'product market'] }), /distinct/i);
  const preview = await f.service.preview({ mode: 'general', queries: ['Insurance claims software terminology'] });
  assert.equal(preview.queryCount, 1);
  assert.equal(preview.companyCount, 0);
  assert.ok(f.calls.some(call => call.tool === 'create_run'));
});


test('query expansion inserts identity literally and does not expand inserted placeholders', async () => {
  const f = fixture(1, true);
  f.companies[0].PB_Name = 'A $& {website} Group';
  f.companies[0].PB_Website = 'site.example';
  const preview = await f.service.preview({ runId: 'run-1', mode: 'company', queries: ['{company} {WEBSITE} products'] });
  assert.equal(preview.queries[0].query, 'A $& {website} Group site.example products');
  const result = await f.service.run({ token: preview.token, approved: true });
  assert.equal(result.executed, true);
});
