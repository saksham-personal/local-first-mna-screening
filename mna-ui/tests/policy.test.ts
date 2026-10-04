import test from 'node:test';
import assert from 'node:assert/strict';
import { initialCounts } from '../src/lib/fixtures';
import { normalizedCompanyKey, planActions, recommendNext, uniqueCount } from '../src/lib/policy';

test('counts the three disjoint funnel buckets and switches exactly at 2,000', () => {
  assert.equal(uniqueCount(initialCounts), 8);
  assert.equal(recommendNext(1999), 'PitchBook enrichment');
  assert.equal(recommendNext(2000), 'LLM screening');
  assert.equal(recommendNext(2001), 'LLM screening');
});

test('normalizes placeholders and preserves the preferred company key', () => {
  for (const value of ['', ' ', '-', '0', 'NA', '#N/A', 'notavailable', 'not available']) {
    assert.equal(normalizedCompanyKey(value, value), null, `placeholder ${JSON.stringify(value)}`);
  }
  assert.equal(normalizedCompanyKey(null, null), null);
  assert.equal(normalizedCompanyKey('ECID-42', 'CID-42'), 'ECID-42-CID-42');
  assert.equal(normalizedCompanyKey('ECID-42', null), 'ECID-42-X');
  assert.equal(normalizedCompanyKey('-', 'CID-42'), 'X-CID-42');
});

test('detects a prose plan in natural mention order, deduplicates, and maps Microsoft 365 to copilot', () => {
  assert.deepEqual(
    planActions('Start with Bing and Rogo; use Bing again, then PitchBook, M365, and an LLM. Copilot can review.'),
    ['bing', 'rogo', 'pitchbook', 'copilot', 'llm'],
  );
  assert.deepEqual(planActions('Office 365 then large language models'), ['copilot', 'llm']);
  assert.deepEqual(planActions('No named steps here'), []);
});
