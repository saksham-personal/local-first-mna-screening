import type {
  BucketKey,
  BucketScheme,
  ColumnFilter,
  DateOp,
  FilterKind,
  FilterState,
  GridColumnSpec,
  NumberOp,
  SortState,
} from "./grid-types";

export const BLANK_LABEL = "(Blanks)";

export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

export function normalizeValue(value: unknown): string {
  return isBlank(value) ? "" : String(value).trim();
}

function parseNumericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[,$%]/g, "");
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function isCheck(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "check";
}

export function parseScore(value: unknown): number | "CHECK" | null {
  if (isBlank(value)) return null;
  if (isCheck(value)) return "CHECK";
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 && number <= 10 ? number : null;
}

export function bucketOf(value: unknown, scheme: BucketScheme): BucketKey | null {
  if (isBlank(value)) return null;
  if (isCheck(value)) return "CHECK";
  const number = parseNumericValue(value);
  if (number === null) return null;
  if (scheme.type === "integer") {
    return Math.min(scheme.max, Math.max(scheme.min, Math.round(number)));
  }
  if (scheme.count <= 0) return null;
  if (scheme.max <= scheme.min) return 0;
  if (number >= scheme.max) return scheme.count - 1;
  if (number <= scheme.min) return 0;
  const index = Math.floor(((number - scheme.min) / (scheme.max - scheme.min)) * scheme.count);
  return Math.min(scheme.count - 1, Math.max(0, index));
}

function formatBucketNumber(value: number): string {
  return String(Number(value.toPrecision(12)));
}

export function bucketLabel(key: BucketKey, scheme: BucketScheme): string {
  if (key === "CHECK") return "CHECK";
  if (scheme.type === "integer") return formatBucketNumber(key);
  if (scheme.count <= 0) return "";
  const step = (scheme.max - scheme.min) / scheme.count;
  const start = scheme.min + key * step;
  const end = scheme.min + (key + 1) * step;
  return `${formatBucketNumber(start)}–${formatBucketNumber(end)}`;
}

export function emptyFilterState(): FilterState {
  return { quick: "", columns: {} };
}

export function defaultFilter(kind: FilterKind): ColumnFilter | undefined {
  return kind === "score" ? { kind: "score", includeCheck: true } : undefined;
}

function effectiveNumberOp(op: NumberOp | undefined, a: number | undefined, b: number | undefined): NumberOp | undefined {
  if (op === "blank" || op === "notBlank") return op;
  if (!op) return undefined;
  if (a === undefined || !Number.isFinite(a)) return undefined;
  if (op === "between" && (b === undefined || !Number.isFinite(b))) return undefined;
  return op;
}

function effectiveDateOp(op: DateOp | undefined, a: string | undefined, b: string | undefined): DateOp | undefined {
  if (op === "blank" || op === "notBlank") return op;
  if (!op || a === undefined) return undefined;
  if (op === "between" && b === undefined) return undefined;
  return op;
}

export function isFilterActive(filter: ColumnFilter | undefined): boolean {
  if (!filter) return false;
  switch (filter.kind) {
    case "text":
      return Boolean(filter.contains) || Boolean(filter.values?.length);
    case "category":
      return filter.values.length > 0;
    case "number":
      return Boolean(filter.values?.length) || effectiveNumberOp(filter.op, filter.a, filter.b) !== undefined;
    case "score":
      return Boolean(filter.buckets?.length) || !filter.includeCheck || effectiveNumberOp(filter.op, filter.a, filter.b) !== undefined;
    case "date":
      return effectiveDateOp(filter.op, filter.a, filter.b) !== undefined;
  }
}

export function activeFilterCount(state: FilterState): number {
  return Object.values(state.columns).filter(isFilterActive).length + (state.quick.trim() ? 1 : 0);
}

function matchesNumberOp(value: unknown, op: NumberOp | undefined, a?: number, b?: number): boolean {
  const activeOp = effectiveNumberOp(op, a, b);
  if (!activeOp) return true;
  if (activeOp === "blank") return isBlank(value);
  if (activeOp === "notBlank") return !isBlank(value);
  if (isBlank(value)) return false;
  const number = parseNumericValue(value);
  if (number === null) return false;
  switch (activeOp) {
    case "gt": return number > a!;
    case "gte": return number >= a!;
    case "lt": return number < a!;
    case "lte": return number <= a!;
    case "eq": return number === a!;
    case "neq": return number !== a!;
    case "between": {
      const lower = Math.min(a!, b!);
      const upper = Math.max(a!, b!);
      return number >= lower && number <= upper;
    }
    default: return true;
  }
}

function parseDate(value: unknown): number | null {
  if (typeof value !== "string" || isBlank(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function utcDay(time: number): number {
  const date = new Date(time);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function matchesDateOp(value: unknown, op: DateOp | undefined, a?: string, b?: string): boolean {
  const activeOp = effectiveDateOp(op, a, b);
  if (!activeOp) return true;
  if (activeOp === "blank") return isBlank(value);
  if (activeOp === "notBlank") return !isBlank(value);
  const time = parseDate(value);
  if (time === null) return false;
  const start = parseDate(a);
  if (start === null) return false;
  switch (activeOp) {
    case "on": return utcDay(time) === utcDay(start);
    case "before": return time < start;
    case "after": return time > start;
    case "between": {
      const end = parseDate(b);
      if (end === null) return false;
      return time >= Math.min(start, end) && time <= Math.max(start, end);
    }
    default: return true;
  }
}

function matchesValues(value: unknown, values: string[] | undefined): boolean {
  return !values?.length || values.includes(normalizeValue(value));
}

export function rowPassesColumn<Row>(row: Row, column: GridColumnSpec<Row>, filter: ColumnFilter | undefined): boolean {
  if (!filter || filter.kind !== column.kind) return true;
  const value = column.value(row);
  switch (filter.kind) {
    case "text": {
      const contains = filter.contains ?? "";
      return (!contains || normalizeValue(value).toLowerCase().includes(contains.toLowerCase()))
        && matchesValues(value, filter.values);
    }
    case "category":
      return matchesValues(value, filter.values);
    case "number":
      return matchesValues(value, filter.values) && matchesNumberOp(value, filter.op, filter.a, filter.b);
    case "score": {
      const buckets = filter.buckets ?? [];
      if (buckets.length) {
        const key = bucketOf(value, column.bucketScheme ?? { type: "integer", min: 0, max: 10 });
        return key !== null && buckets.includes(key);
      }
      const score = parseScore(value);
      if (score === "CHECK") return filter.includeCheck;
      if (score === null && isBlank(value)) {
        const op = effectiveNumberOp(filter.op, filter.a, filter.b);
        return !op || op === "blank";
      }
      if (score === null) {
        const op = effectiveNumberOp(filter.op, filter.a, filter.b);
        return !op || op === "notBlank";
      }
      return matchesNumberOp(score, filter.op, filter.a, filter.b);
    }
    case "date":
      return matchesDateOp(value, filter.op, filter.a, filter.b);
  }
}

export function rowPassesQuick<Row>(row: Row, columns: GridColumnSpec<Row>[], quick: string): boolean {
  const query = quick.trim().toLowerCase();
  if (!query) return true;
  return columns.some((column) => normalizeValue(column.value(row)).toLowerCase().includes(query));
}

export function filterRows<Row>(
  rows: Row[],
  columns: GridColumnSpec<Row>[],
  state: FilterState,
  opts?: { ignoreColumnId?: string },
): Row[] {
  return rows.filter((row) => rowPassesQuick(row, columns, state.quick)
    && columns.every((column) => column.id === opts?.ignoreColumnId
      || rowPassesColumn(row, column, state.columns[column.id])));
}

export function distinctValues<Row>(
  rows: Row[],
  column: GridColumnSpec<Row>,
  search = "",
): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = normalizeValue(column.value(row));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const query = search.trim().toLowerCase();
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: value === "" ? BLANK_LABEL : value, count }))
    .filter((entry) => !query || entry.label.toLowerCase().includes(query))
    .sort((a, b) => {
      if (a.value === "") return b.value === "" ? 0 : -1;
      if (b.value === "") return 1;
      return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" });
    });
}

export function scoreBuckets<Row>(
  rows: Row[],
  column: GridColumnSpec<Row>,
  scheme: BucketScheme,
  includeCheck = true,
): { key: BucketKey; label: string; count: number }[] {
  const keys: BucketKey[] = scheme.type === "integer"
    ? Array.from({ length: Math.max(0, Math.floor(scheme.max - scheme.min) + 1) }, (_, index) => scheme.min + index)
    : Array.from({ length: Math.max(0, scheme.count) }, (_, index) => index);
  if (includeCheck) keys.push("CHECK");
  const counts = new Map<BucketKey, number>(keys.map((key) => [key, 0]));
  for (const row of rows) {
    const key = bucketOf(column.value(row), scheme);
    if (key !== null && counts.has(key)) counts.set(key, counts.get(key)! + 1);
  }
  return keys.map((key) => ({ key, label: bucketLabel(key, scheme), count: counts.get(key)! }));
}

function isCheckSortValue(value: unknown): boolean {
  return isCheck(value);
}

function compareText(a: unknown, b: unknown): number {
  return normalizeValue(a).localeCompare(normalizeValue(b), undefined, { numeric: true, sensitivity: "base" });
}

export function compareRows<Row>(a: Row, b: Row, column: GridColumnSpec<Row>, direction: "asc" | "desc"): number {
  const left = column.value(a);
  const right = column.value(b);
  const leftRank = isBlank(left) ? 2 : isCheckSortValue(left) ? 1 : 0;
  const rightRank = isBlank(right) ? 2 : isCheckSortValue(right) ? 1 : 0;
  if (leftRank !== rightRank) return leftRank - rightRank;

  let comparison = 0;
  if (column.kind === "number" || column.kind === "score") {
    const leftNumber = parseNumericValue(left);
    const rightNumber = parseNumericValue(right);
    comparison = leftNumber !== null && rightNumber !== null
      ? leftNumber - rightNumber
      : compareText(left, right);
  } else if (column.kind === "date") {
    const leftDate = Date.parse(String(left));
    const rightDate = Date.parse(String(right));
    comparison = Number.isFinite(leftDate) && Number.isFinite(rightDate)
      ? leftDate - rightDate
      : compareText(left, right);
  } else {
    comparison = compareText(left, right);
  }
  return direction === "asc" ? comparison : -comparison;
}

export function sortRows<Row>(rows: Row[], columns: GridColumnSpec<Row>[], sort: SortState): Row[] {
  if (!sort) return [...rows];
  const column = columns.find((candidate) => candidate.id === sort.columnId);
  if (!column) return [...rows];
  return rows.map((row, index) => ({ row, index }))
    .sort((left, right) => compareRows(left.row, right.row, column, sort.direction) || left.index - right.index)
    .map(({ row }) => row);
}

function displayValue(value: string): string {
  return value === "" ? BLANK_LABEL : value;
}

function displayNumberOp(op: NumberOp | undefined, a?: number, b?: number): string | undefined {
  const activeOp = effectiveNumberOp(op, a, b);
  if (!activeOp) return undefined;
  switch (activeOp) {
    case "gt": return `> ${a}`;
    case "gte": return `≥ ${a}`;
    case "lt": return `< ${a}`;
    case "lte": return `≤ ${a}`;
    case "eq": return `= ${a}`;
    case "neq": return `≠ ${a}`;
    case "between": return `${Math.min(a!, b!)}–${Math.max(a!, b!)}`;
    case "blank": return BLANK_LABEL;
    case "notBlank": return "Not blank";
  }
}

function displayDateOp(op: DateOp | undefined, a?: string, b?: string): string | undefined {
  const activeOp = effectiveDateOp(op, a, b);
  if (!activeOp) return undefined;
  switch (activeOp) {
    case "on": return `on ${a}`;
    case "before": return `before ${a}`;
    case "after": return `after ${a}`;
    case "between": return `${a}–${b}`;
    case "blank": return BLANK_LABEL;
    case "notBlank": return "Not blank";
  }
}

export function describeFilter<Row>(column: GridColumnSpec<Row>, filter: ColumnFilter): string {
  if (filter.kind !== column.kind) return `${column.header}: All values`;
  switch (filter.kind) {
    case "text": {
      const pieces: string[] = [];
      if (filter.contains) pieces.push(`${column.header} contains ${filter.contains}`);
      if (filter.values?.length) pieces.push(`${column.header}: ${filter.values.map(displayValue).join(", ")}`);
      return pieces.join("; ") || `${column.header}: All values`;
    }
    case "category":
      return `${column.header}: ${filter.values.map(displayValue).join(", ") || "All values"}`;
    case "number": {
      const pieces: string[] = [];
      if (filter.values?.length) pieces.push(filter.values.map(displayValue).join(", "));
      const op = displayNumberOp(filter.op, filter.a, filter.b);
      if (op) pieces.push(op);
      return `${column.header}: ${pieces.join(" + ") || "All values"}`;
    }
    case "score": {
      const buckets = filter.buckets ?? [];
      if (buckets.length) {
        const values = buckets.filter((key): key is number => key !== "CHECK").sort((a, b) => a - b);
        const labels = values.map((key) => bucketLabel(key, column.bucketScheme ?? { type: "integer", min: 0, max: 10 }));
        if (buckets.includes("CHECK")) labels.push("CHECK");
        return `${column.header}: ${labels.join(", ")}`;
      }
      const pieces: string[] = [];
      const op = displayNumberOp(filter.op, filter.a, filter.b);
      if (op) pieces.push(op);
      if (filter.includeCheck) pieces.push("CHECK");
      if (!pieces.length && !filter.includeCheck) pieces.push("Excluding CHECK");
      return `${column.header}: ${pieces.join(" + ") || "All values"}`;
    }
    case "date":
      return `${column.header}: ${displayDateOp(filter.op, filter.a, filter.b) ?? "All values"}`;
  }
}
