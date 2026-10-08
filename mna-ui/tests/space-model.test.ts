import assert from "node:assert/strict";
import test from "node:test";
import { appendKeywords, defaultDraft, editKeyword, insertExpression, pager, restoreDraft, searchRequest } from "../src/space/space-model";

test("chips accept comma/Enter batches, dedupe case-insensitively and stop at 50", () => {
  const chips = appendKeywords([], " nitrogen fertilizer, ammonia\nurea,AMMONIA,, ");
  assert.deepEqual(chips.map(k => [k.id, k.text]), [["k1", "nitrogen fertilizer"], ["k2", "ammonia"], ["k3", "urea"]]);
  assert.equal(appendKeywords(chips, Array.from({ length: 70 }, (_, i) => `keyword ${i}`).join(",")).length, 50);
});
test("chip removal/edit preserves expression ids and prevents duplicate edits", () => {
  const chips = appendKeywords([], "claims,policy,consulting");
  const removed = chips.filter(k => k.id !== "k2");
  assert.equal(appendKeywords(removed, "software")[2].id, "k4");
  assert.equal(editKeyword(chips, "k2", " CLAIMS "), chips);
  assert.deepEqual(editKeyword(chips, "k2", " insurance ")[1], { id: "k2", text: "insurance", match: "stem" });
});
test("expression buttons insert at caret or replace selection and preserve parentheses", () => {
  assert.deepEqual(insertExpression("k1 k2", "AND", 3), { value: "k1 AND k2", cursor: 7 });
  assert.deepEqual(insertExpression("k1 OR k2", "AND", 3, 5), { value: "k1 AND k2", cursor: 6 });
  assert.equal(insertExpression("", "NOT").value, "NOT");
  assert.equal(insertExpression("(k1", ")").value, "(k1)");
  assert.equal(insertExpression("k1 OR ", "(").value, "k1 OR (");
});
test("lexical request retains chip ids while expression overrides on the server", () => {
  const keywords = appendKeywords([], "claims,software");
  assert.deepEqual(searchRequest({ kind: "lexical", keywords, expression: " k1 AND k2 " }, 100, 200), { tool: "space_search_lexical", args: { keywords, expression: "k1 AND k2", offset: 100, limit: 200 } });
  assert.deepEqual(searchRequest({ kind: "lexical", keywords, expression: " " }, 0, 100).args, { keywords, offset: 0, limit: 100 });
});
test("semantic, ISCC and sorted browse map exactly to existing tool schemas", () => {
  assert.deepEqual(searchRequest({ kind: "semantic", text: " insurance software " }, 200, 100), { tool: "space_search_semantic", args: { text: "insurance software", offset: 200, limit: 100 } });
  assert.deepEqual(searchRequest({ kind: "iscc", query: " claims ", count: 1000 }, 100, 200), { tool: "space_search_iscc", args: { query: "claims", count: 1000 } });
  assert.deepEqual(searchRequest({ kind: "browse", sort: { column: "Company", direction: "desc" } }, 0, 100), { tool: "space_browse", args: { offset: 0, limit: 100, sort: { column: "Company", direction: "desc" } } });
});
test("pager handles empty, first, final, and exact full pages", () => {
  assert.deepEqual(pager(0, 0, 100), { first: 0, last: 0, previous: 0, next: 100, canPrevious: false, canNext: false });
  assert.deepEqual(pager(4897, 4800, 100), { first: 4801, last: 4897, previous: 4700, next: 4900, canPrevious: true, canNext: false });
  assert.equal(pager(200, 100, 100).canNext, false);
  assert.equal(pager(201, 100, 100).canNext, true);
});
test("reload remembers independent source and controls without rehydrating ISCC", () => {
  const saved = { ...defaultDraft, source: "ISCC", query: "claims", count: 200, search: { kind: "iscc", query: "claims", count: 200 }, offset: 100 };
  const restored = restoreDraft(JSON.stringify(saved));
  assert.equal(restored.source, "ISCC"); assert.equal(restored.query, "claims");
  assert.deepEqual(restored.search, { kind: "browse" }); assert.equal(restored.offset, 0);
  assert.equal(restoreDraft("oops"), defaultDraft);
  assert.equal(restoreDraft(JSON.stringify({ ...saved, count: 1001 })), defaultDraft);
});
