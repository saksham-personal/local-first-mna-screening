export type FilterKind = "text" | "number" | "score" | "date" | "category";
export type NumberOp = "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "between" | "blank" | "notBlank";
export type DateOp = "on" | "before" | "after" | "between" | "blank" | "notBlank";
export type BucketKey = number | "CHECK";
export type BucketScheme =
  | { type: "integer"; min: number; max: number }
  | { type: "bins"; min: number; max: number; count: number };
export type GridColumnSpec<Row> = {
  id: string;
  header: string;
  group?: string;
  kind: FilterKind;
  value: (row: Row) => unknown;
  bucketScheme?: BucketScheme;
  hidden?: boolean;
  width?: number;
  minWidth?: number;
  pinned?: "left" | "right";
  sortable?: boolean;
};
export type ColumnFilter =
  | { kind: "text"; contains?: string; values?: string[] }
  | { kind: "category"; values: string[] }
  | { kind: "number"; op?: NumberOp; a?: number; b?: number; values?: string[] }
  | { kind: "score"; op?: NumberOp; a?: number; b?: number; buckets?: BucketKey[]; includeCheck: boolean }
  | { kind: "date"; op?: DateOp; a?: string; b?: string };
export type FilterState = { quick: string; columns: Record<string, ColumnFilter> };
export type SortState = { columnId: string; direction: "asc" | "desc" } | null;
