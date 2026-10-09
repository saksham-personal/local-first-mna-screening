export type Keyword = { id: string; text: string; match: "stem" | "exact" };
export type SpaceSearch =
  | { kind: "browse"; sort?: { column: string; direction: "asc" | "desc" } }
  | { kind: "lexical"; keywords: Keyword[]; expression: string }
  | { kind: "semantic"; text: string }
  | { kind: "iscc"; query: string; count: number };
export type SpaceRow = { company_id: string; name: string; website?: string; values: Record<string, unknown>; matched_keywords?: { id: string; text: string }[]; raw_score?: number; match_strength?: number; score?: number; simulated?: boolean };
export type SpaceResult = { results: SpaceRow[]; columns?: string[]; total: number; query_id?: string; bundle_id?: string; status?: string; reason?: string; simulated?: boolean };

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

// Paging. The grid appends server pages as the analyst scrolls. The backend takes limit 1..200,
// and semantic offset + limit must stay at or below 5,000. ISCC returns its whole result in one call.
export const spacePageSize = 100;
export const spaceMaxPageSize = 200;
export const semanticRowCap = 5000;

export function isServerPaged(search: SpaceSearch): boolean {
  return search.kind !== "iscc";
}

/** Rows the analyst can reach for a search: semantic stops at the backend cap. */
export function accessibleTotal(search: SpaceSearch, total: number): number {
  return search.kind === "semantic" ? Math.min(semanticRowCap, total) : total;
}

/**
 * Rows loaded for one search, in server order. `offset` counts the rows the server returned,
 * repeats included, so a request never asks again for a range the server already served.
 */
export type SpaceLoad = { result: SpaceResult; offset: number; exhausted: boolean };

export function firstLoad(page: SpaceResult): SpaceLoad {
  return mergePage({ result: { ...page, results: [] }, offset: 0, exhausted: false }, page, 0);
}

/**
 * Appends a server page after the rows already loaded. A page that answers another offset is
 * ignored, and companies already loaded are dropped. The first page's metadata (query_id, columns,
 * bundle_id) is kept: the backend returns query_id only on the first page.
 */
export function mergePage(load: SpaceLoad, page: SpaceResult, requestedOffset: number): SpaceLoad {
  if (requestedOffset !== load.offset) return load;
  const seen = new Set(load.result.results.map(row => row.company_id));
  const fresh: SpaceRow[] = [];
  for (const row of page.results) {
    if (seen.has(row.company_id)) continue;
    seen.add(row.company_id);
    fresh.push(row);
  }
  return {
    result: { ...load.result, total: page.total, results: [...load.result.results, ...fresh] },
    offset: load.offset + page.results.length,
    exhausted: page.results.length === 0,
  };
}

/** The offset the next request starts at: the rows the server has returned so far. */
export function nextOffset(load: SpaceLoad): number {
  return load.offset;
}

/** Whether another page can be requested. ISCC never pages; an empty page or the cap ends paging. */
export function canLoadMore(search: SpaceSearch, load: SpaceLoad): boolean {
  return isServerPaged(search) && !load.exhausted && load.offset < accessibleTotal(search, load.result.total);
}

/**
 * The next request, or undefined when results are complete, the cap is reached, or a request for
 * the same offset is already pending. The limit never runs past the accessible total.
 */
export function nextPage(search: SpaceSearch, load: SpaceLoad, pending: ReadonlySet<number>, pageSize = spacePageSize): { offset: number; limit: number } | undefined {
  if (!canLoadMore(search, load) || pending.has(nextOffset(load))) return undefined;
  const remaining = accessibleTotal(search, load.result.total) - load.offset;
  return { offset: nextOffset(load), limit: Math.min(pageSize, spaceMaxPageSize, remaining) };
}

export type SpaceDraft = { source: "MID" | "ISCC"; method: "lexical" | "semantic"; keywords: Keyword[]; expression: string; text: string; query: string; count: number; search: SpaceSearch };
export const draftKey = "screening-search-space-v1";
export const defaultDraft: SpaceDraft = { source: "MID", method: "lexical", keywords: [], expression: "", text: "", query: "", count: 100, search: { kind: "browse" } };
export function restoreDraft(raw: string | null): SpaceDraft {
  try {
    const d = JSON.parse(raw ?? "null") as SpaceDraft;
    if (!d || !["MID", "ISCC"].includes(d.source) || !["lexical", "semantic"].includes(d.method) || !Array.isArray(d.keywords) || d.keywords.length > 50 || !d.keywords.every(k => typeof k.id === "string" && typeof k.text === "string" && ["stem", "exact"].includes(k.match)) || ![d.expression, d.text, d.query].every(v => typeof v === "string") || !Number.isInteger(d.count) || d.count < 1 || d.count > 1000) return defaultDraft;
    const search = d.search;
    if (!search || !["browse", "lexical", "semantic", "iscc"].includes(search.kind)) return defaultDraft;
    // Restore controls; reapply explicitly. Avoid repeating ISCC hydration on reload.
    return { source: d.source, method: d.method, keywords: d.keywords, expression: d.expression, text: d.text, query: d.query, count: d.count, search: { kind: "browse" } };
  } catch { return defaultDraft; }
}
