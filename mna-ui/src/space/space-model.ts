export type Keyword = { id: string; text: string; match: "stem" | "exact" };
export type SpaceSearch =
  | { kind: "browse"; sort?: { column: string; direction: "asc" | "desc" } }
  | { kind: "lexical"; keywords: Keyword[]; expression: string }
  | { kind: "semantic"; text: string }
  | { kind: "iscc"; query: string; count: number };

// Keep ids stable when removing/editing chips: expressions can reference k1, k2…
export function appendKeywords(current: Keyword[], input: string): Keyword[] {
  const result = [...current];
  let next = Math.max(0, ...current.map(k => Number(k.id.slice(1)) || 0)) + 1;
  for (const text of input.split(/[,\n]/).map(s => s.trim()).filter(Boolean)) {
    if (result.length >= 50) break;
    if (!result.some(k => k.text.toLocaleLowerCase() === text.toLocaleLowerCase())) {
      result.push({ id: `k${next++}`, text, match: "stem" });
    }
  }
  return result;
}
export function editKeyword(current: Keyword[], id: string, text: string): Keyword[] {
  text = text.trim();
  if (!text || current.some(k => k.id !== id && k.text.toLocaleLowerCase() === text.toLocaleLowerCase())) return current;
  return current.map(k => k.id === id ? { ...k, text } : k);
}
export function insertExpression(value: string, token: string, start = value.length, end = start) {
  const before = value.slice(0, start), after = value.slice(end);
  const inserted = `${before && !/\s$|\($/.test(before) && token !== ")" ? " " : ""}${token}${token !== "(" && ((!after && token !== ")") || (after && !/^\s|\)/.test(after))) ? " " : ""}`;
  return { value: before + inserted + after, cursor: before.length + inserted.length };
}
export function searchRequest(search: SpaceSearch, offset: number, limit: number) {
  switch (search.kind) {
    case "browse": return { tool: "space_browse", args: { offset, limit, ...(search.sort ? { sort: search.sort } : {}) } };
    case "lexical": return { tool: "space_search_lexical", args: { keywords: search.keywords, ...(search.expression.trim() ? { expression: search.expression.trim() } : {}), offset, limit } };
    case "semantic": return { tool: "space_search_semantic", args: { text: search.text.trim(), offset, limit } };
    case "iscc": return { tool: "space_search_iscc", args: { query: search.query.trim(), count: search.count } };
  }
}
export function pager(total: number, offset: number, limit: number) {
  return { first: total ? offset + 1 : 0, last: Math.min(offset + limit, total), previous: Math.max(0, offset - limit), next: offset + limit, canPrevious: offset > 0, canNext: offset + limit < total };
}
export type SpaceDraft = { source: "MID" | "ISCC"; method: "lexical" | "semantic"; keywords: Keyword[]; expression: string; text: string; query: string; count: number; search: SpaceSearch; offset: number; limit: number };
export const draftKey = "screening-search-space-v1";
export const defaultDraft: SpaceDraft = { source: "MID", method: "lexical", keywords: [], expression: "", text: "", query: "", count: 100, search: { kind: "browse" }, offset: 0, limit: 100 };
export function restoreDraft(raw: string | null): SpaceDraft {
  try {
    const d = JSON.parse(raw ?? "null") as SpaceDraft;
    if (!d || !["MID", "ISCC"].includes(d.source) || !["lexical", "semantic"].includes(d.method) || !Array.isArray(d.keywords) || d.keywords.length > 50 || !d.keywords.every(k => typeof k.id === "string" && typeof k.text === "string" && ["stem", "exact"].includes(k.match)) || ![d.expression, d.text, d.query].every(v => typeof v === "string") || ![100, 200].includes(d.limit) || !Number.isInteger(d.offset) || d.offset < 0 || d.offset > 200000 || !Number.isInteger(d.count) || d.count < 1 || d.count > 1000) return defaultDraft;
    const search = d.search;
    if (!search || !["browse", "lexical", "semantic", "iscc"].includes(search.kind)) return defaultDraft;
    // Restore controls; reapply explicitly. Avoid repeating ISCC hydration on reload.
    return { ...d, search: { kind: "browse" }, offset: 0 };
  } catch { return defaultDraft; }
}
