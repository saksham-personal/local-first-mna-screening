import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { companies } from '../src/lib/fixtures';
import { buildWorkbook } from '../src/lib/exports';
import type { Company } from '../src/lib/contracts';

const decoder = new TextDecoder();
function files(kind: 'pitchbook' | 'llm' | 'full', source: Company[] = companies): Record<string, string> {
  const zipped = unzipSync(buildWorkbook(kind, source));
  return Object.fromEntries(Object.entries(zipped).map(([path, content]) => [path, decoder.decode(content)]));
}
function firstRow(xml: string): string[] {
  const row = xml.match(/<row r="1">([\s\S]*?)<\/row>/)?.[1] ?? '';
  return [...row.matchAll(/<t xml:space="preserve">([\s\S]*?)<\/t>/g)].map((match) =>
    match[1].replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'));
}

test('creates valid XLSX package structure and PitchBook header order', () => {
  const workbook = files('pitchbook');
  for (const path of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(workbook[path], `missing ${path}`);
  }
  assert.deepEqual(firstRow(workbook['xl/worksheets/sheet1.xml']), ['pk', 'Company Name', 'Website', 'HQ City', 'HQ State', 'Source']);
  assert.match(workbook['xl/worksheets/sheet1.xml'], /<row r="9">/);
});

test('LLM export has the exact headers and numeric one-based indexes', () => {
  const sheet = files('llm')['xl/worksheets/sheet1.xml'];
  assert.deepEqual(firstRow(sheet), ['index', 'pk', 'Company Name', 'Website', 'Source', 'Description']);
  assert.match(sheet, /<c r="A2"><v>1<\/v><\/c>/);
  assert.match(sheet, /<c r="A9"><v>8<\/v><\/c>/);
});

test('full export has MID and ISCC provenance sheets, includes both in each, and keeps pk first', () => {
  const workbook = files('full');
  assert.match(workbook['xl/workbook.xml'], /name="MID"/);
  assert.match(workbook['xl/workbook.xml'], /name="ISCC"/);
  const mid = workbook['xl/worksheets/sheet1.xml'];
  const iscc = workbook['xl/worksheets/sheet2.xml'];
  assert.equal(firstRow(mid)[0], 'pk');
  assert.equal(firstRow(iscc)[0], 'pk');
  // Three both-source records are present alongside source-specific records in both sheets.
  assert.equal((mid.match(/<row r="/g) ?? []).length, 7);
  assert.equal((iscc.match(/<row r="/g) ?? []).length, 6);
  assert.match(mid, /Northstar Claims Cloud/);
  assert.match(iscc, /ISCC-1001/);
  assert.match(mid, /<t xml:space="preserve">both<\/t>/);
});

test('writes formula-looking content as escaped inline text', () => {
  const crafted: Company = {
    ...companies[0], name: '=1+1 & <unsafe>', description: '=HYPERLINK("https://bad.example")',
  };
  const sheet = files('llm', [crafted])['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /t="inlineStr"><is><t xml:space="preserve">=1\+1 &amp; &lt;unsafe&gt;<\/t><\/is><\/c>/);
  assert.match(sheet, /t="inlineStr"><is><t xml:space="preserve">=HYPERLINK\(&quot;https:\/\/bad.example&quot;\)<\/t><\/is><\/c>/);
  assert.doesNotMatch(sheet, /<f>/);
});
