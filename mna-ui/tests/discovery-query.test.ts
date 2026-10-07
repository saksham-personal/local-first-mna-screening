import assert from 'node:assert/strict';
import test from 'node:test';
import { discoveryDefinition, discoveryQueries } from '../src/lib/discovery-query.mjs';
import { exampleDefinition } from '../src/lib/chat-policy';

test('approved exclusion clauses never become discovery query syntax', () => {
  const business = discoveryDefinition(exampleDefinition);
  assert.deepEqual(business.exclusions, ['broker marketplaces', 'generic CRM', 'pure consulting', 'outsourced claims services']);
  assert.equal(business.positive, 'Software products used in insurance policy administration or claims management');
  assert.ok(discoveryQueries(exampleDefinition).every(query => !/\b(?:exclude|NOT)\b/i.test(query)));
});

test('non-core exclusions stay deferred and text negation cannot bypass approved filters', () => {
  assert.deepEqual(discoveryDefinition('Claims software. Exclude US companies, low revenue, founder owned, broker marketplaces').exclusions, ['broker marketplaces']);
  assert.deepEqual(discoveryQueries('Software that is not only used for claims'), ['software claims']);
  assert.throws(() => discoveryQueries('Exclude consulting'), /core business description/);
});

import { midKeywordPlan } from '../src/lib/discovery-query.mjs';

test('MID planner creates deterministic broad Boolean groups with verbatim approved exclusions', () => {
  const business = discoveryDefinition(exampleDefinition);
  const plan = midKeywordPlan(exampleDefinition, business.exclusions);
  assert.deepEqual(plan, midKeywordPlan(exampleDefinition, business.exclusions));
  assert.ok(plan.length >= 2 && plan.length <= 4);
  assert.match(plan[0].expression, /\) AND \(/);
  assert.match(plan[0].expression, /AND NOT/);
  assert.deepEqual(plan[0].keywords.filter(keyword => keyword.id.startsWith('x')).map(keyword => keyword.text), business.exclusions);
  assert.ok(plan[0].keywords.some(keyword => keyword.text === 'insurance*'));
  assert.ok(plan[0].keywords.some(keyword => keyword.text === 'software*'));
  const phrases = plan[1].keywords.filter(keyword => keyword.id.startsWith('c')).map(keyword => keyword.text);
  // Approved exclusions bind every group, including the phrase group.
  assert.match(plan[1].expression, /AND NOT/);
  assert.ok(!phrases.includes('in insurance'));
  for (const phrase of ['insurance policy', 'policy administration', 'claims management']) assert.ok(phrases.includes(phrase));
  assert.ok(phrases.every(phrase => business.positive.toLowerCase().includes(phrase)));
  assert.ok(plan.every(group => group.rationale.endsWith('.') && group.keywords.every(keyword => keyword.weight === 1 && keyword.match === 'stem')));
});

test('MID planner never invents exclusions and keeps deferred attributes out of keywords', () => {
  const plan = midKeywordPlan('Claims software in US. Exclude consulting');
  assert.ok(plan.every(group => !group.expression.includes('NOT')));
  assert.ok(plan.flatMap(group => group.keywords).every(keyword => !/consulting|\bus\b/i.test(keyword.text)));
  // One word has no core phrases, so only the broad group remains.
  assert.deepEqual(midKeywordPlan('Insurance').map(group => group.keywords[0].text), ['insurance*']);
  // Exclusions that cannot be keywords are skipped instead of failing discovery.
  assert.equal(midKeywordPlan('Claims software', ['x'.repeat(200)])[0].expression.includes('NOT'), false);
  assert.throws(() => midKeywordPlan('Exclude consulting'), /core business description/);
});
