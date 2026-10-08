import { defaultFilter, rowPassesColumn } from "../grid/grid-filter";
import type { BucketKey, BucketScheme, ColumnFilter, GridColumnSpec } from "../grid/grid-types";
import type { GridSource, RoundColumns } from "../lib/grid-client";

export type CompanyTab = "All" | "MID" | "ISCC";
export function belongsToTab(source: GridSource | null, tab: CompanyTab): boolean {
  return tab === "All" || source === "both" || source === tab;
}
export function defaultMetric<Row>(tab: CompanyTab, columns: GridColumnSpec<Row>[], rounds: RoundColumns[], availability?: { has_semantic: boolean; has_iscc: boolean }): string | undefined {
  const scores = columns.filter((column) => column.kind === "score");
  const latest = [...rounds].sort((a, b) => b.round_no - a.round_no).find((round) => round.score_columns.length);
  const latestId = latest ? `${latest.key} ${latest.provider_label} ${latest.score_columns[0]}` : undefined;
  const preferences = tab === "MID" ? ["MID Score", "MID Semantic Score", "mid_semantic_score"] : tab === "ISCC" ? ["ISCC Score", "iscc_relevancy"] : [latestId, "MID_Keyword Score", "MID Score", availability?.has_semantic === false ? undefined : "MID_Semantic Score", availability?.has_semantic === false ? undefined : "mid_semantic_score", availability?.has_iscc === false ? undefined : "ISCC_Score", availability?.has_iscc === false ? undefined : "iscc_relevancy"];
  return preferences.find(id => scores.some(column => column.id === id)) ?? scores[0]?.id;
}

export function toggleScoreBucket(filter: ColumnFilter | undefined, key: BucketKey, scheme: BucketScheme): ColumnFilter {
  const current = filter?.kind === "score" ? filter : defaultFilter("score") as Extract<ColumnFilter, { kind: "score" }>;
  const numericKeys = Array.from({ length: scheme.type === "integer" ? scheme.max - scheme.min + 1 : scheme.count }, (_, index) => scheme.type === "integer" ? scheme.min + index : index);
  const keys: BucketKey[] = [...numericKeys, "CHECK"];
  const selected = new Set<BucketKey>(current.buckets ?? keys.filter((bucket) => {
    const value = bucket === "CHECK" ? bucket : scheme.type === "integer" ? bucket : scheme.min + (bucket + 0.5) * (scheme.max - scheme.min) / scheme.count;
    return rowPassesColumn(value, { id: "score", header: "Score", kind: "score", value: (row) => row, bucketScheme: scheme }, current);
  }));
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  const buckets = [...selected].sort((a, b) => a === "CHECK" ? 1 : b === "CHECK" ? -1 : a - b);
  // An empty bucket list means unrestricted in the grid engine. A below-range
  // condition expresses an explicitly empty selection without changing that engine.
  return { kind: "score", buckets, includeCheck: selected.has("CHECK"), ...(buckets.length ? {} : { op: "lt", a: scheme.min }) };
}
