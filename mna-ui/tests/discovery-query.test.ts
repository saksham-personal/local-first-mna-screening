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
