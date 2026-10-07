import { useMemo, useState } from "react";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Search } from "lucide-react";
import {
  defaultFilter,
  distinctValues,
  filterRows,
  scoreBuckets,
} from "./grid-filter";
import type {
  BucketKey,
  ColumnFilter,
  DateOp,
  FilterState,
  GridColumnSpec,
  NumberOp,
  SortState,
} from "./grid-types";

const NUMBER_OPTIONS: { value: NumberOp; label: string }[] = [
  { value: "gt", label: "Greater than" },
  { value: "gte", label: "At least" },
  { value: "lt", label: "Less than" },
  { value: "lte", label: "At most" },
  { value: "eq", label: "Equals" },
  { value: "neq", label: "Does not equal" },
  { value: "between", label: "Between" },
  { value: "blank", label: "Blanks" },
  { value: "notBlank", label: "Not blank" },
];

const DATE_OPTIONS: { value: DateOp; label: string }[] = [
  { value: "on", label: "On" },
  { value: "before", label: "Before" },
  { value: "after", label: "After" },
  { value: "between", label: "Between" },
  { value: "blank", label: "Blanks" },
  { value: "notBlank", label: "Not blank" },
];

export type FilterPanelProps<Row> = {
  column: GridColumnSpec<Row>;
  rows: Row[];
  columns: GridColumnSpec<Row>[];
  state: FilterState;
  filter: ColumnFilter | undefined;
  sort: SortState;
  onChange: (filter: ColumnFilter | undefined) => void;
  onSortChange: (sort: SortState) => void;
  onDone?: () => void;
  hideHeading?: boolean;
};

function numericInput(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isNumberWithoutValue(op: NumberOp | undefined): boolean {
  return op === "blank" || op === "notBlank";
}

function isDateWithoutValue(op: DateOp | undefined): boolean {
  return op === "blank" || op === "notBlank";
}

export default function FilterPanel<Row>({
  column,
  rows,
  columns,
  state,
  filter,
  sort,
  onChange,
  onSortChange,
  onDone,
  hideHeading = false,
}: FilterPanelProps<Row>) {
  const [valueSearch, setValueSearch] = useState("");
  const candidateRows = useMemo(
    () => filterRows(rows, columns, state, { ignoreColumnId: column.id }),
    [rows, columns, state, column.id],
  );
  const allValues = useMemo(
    () => distinctValues(candidateRows, column),
    [candidateRows, column],
  );
  const shownValues = useMemo(
    () => distinctValues(candidateRows, column, valueSearch),
    [candidateRows, column, valueSearch],
  );
  const scoreScheme =
    column.bucketScheme ?? { type: "integer" as const, min: 0, max: 10 };
  const bucketCounts = useMemo(
    () =>
      column.kind === "score"
        ? scoreBuckets(candidateRows, column, scoreScheme, true)
        : [],
    [
      candidateRows,
      column,
      column.kind,
      scoreScheme.type,
      scoreScheme.min,
      scoreScheme.max,
      scoreScheme.type === "bins" ? scoreScheme.count : undefined,
    ],
  );

  const updateChecklist = (next: string[]) => {
    const isAll = allValues.length > 0
      && next.length === allValues.length
      && allValues.every((entry) => next.includes(entry.value));
    const values = isAll ? undefined : next;
    if (column.kind === "text") {
      const current = filter?.kind === "text" ? filter : { kind: "text" as const };
      onChange({ ...current, values });
    } else if (column.kind === "category") {
      const current = filter?.kind === "category" ? filter : undefined;
      onChange({ kind: "category", values: values ?? [], contains: current?.contains });
    } else if (column.kind === "number") {
      const current = filter?.kind === "number" ? filter : { kind: "number" as const };
      onChange({ ...current, values });
    }
  };

  const valuesForChecklist =
    filter?.kind === "text" || filter?.kind === "category" || filter?.kind === "number"
      ? filter.values
      : undefined;
  const allSelected = !valuesForChecklist?.length;
  const selectedValues: string[] = allSelected
    ? allValues.map((entry) => entry.value)
    : valuesForChecklist ?? [];
  const toggleValue = (value: string) => {
    const next = new Set(selectedValues);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    updateChecklist([...next]);
  };

  const sortBy = (direction: "asc" | "desc") =>
    onSortChange({ columnId: column.id, direction });
  const sortActions = (
    <div className="dg-filter-sort">
      <button type="button" onClick={() => sortBy("asc")}>
        <ArrowUpNarrowWide size={14} aria-hidden="true" />
        {column.kind === "date" ? "Sort oldest first" : "Sort smallest first"}
      </button>
      <button type="button" onClick={() => sortBy("desc")}>
        <ArrowDownWideNarrow size={14} aria-hidden="true" />
        {column.kind === "date" ? "Sort newest first" : "Sort largest first"}
      </button>
    </div>
  );

  const checklist = (
    <>
      <label className="dg-filter-search">
        <Search size={14} aria-hidden="true" />
        <span className="sr-only">Search {column.header} values</span>
        <input
          type="search"
          value={valueSearch}
          onChange={(event) => setValueSearch(event.target.value)}
          placeholder="Search values"
        />
      </label>
      <div className="dg-filter-check-actions">
        <button
          type="button"
          onClick={() => updateChecklist(shownValues.map((entry) => entry.value))}
          disabled={shownValues.length === 0}
        >
          Select shown
        </button>
        <button type="button" onClick={() => updateChecklist([])}>
          Clear
        </button>
      </div>
      <div className="dg-filter-values" role="group" aria-label={column.header + " values"}>
        {shownValues.length === 0 ? (
          <p className="dg-filter-note">No matching values.</p>
        ) : (
          <>
            {shownValues.slice(0, 300).map((entry) => (
              <label className="dg-filter-value" key={entry.value || "__blank"}>
                <input
                  type="checkbox"
                  checked={selectedValues.includes(entry.value)}
                  onChange={() => toggleValue(entry.value)}
                />
                <span className="dg-filter-value-label">{entry.label}</span>
                <span className="dg-filter-value-count">{entry.count.toLocaleString()}</span>
              </label>
            ))}
            {shownValues.length > 300 && (
              <p className="dg-filter-note">Type to narrow to 300 values or fewer.</p>
            )}
          </>
        )}
      </div>
    </>
  );

  let body;
  if (column.kind === "text") {
    const current = filter?.kind === "text" ? filter : undefined;
    body = (
      <>
        <label className="dg-filter-field">
          <span>Contains</span>
          <input
            type="search"
            value={current?.contains ?? ""}
            onChange={(event) =>
              onChange({
                kind: "text",
                contains: event.target.value || undefined,
                values: current?.values,
              })
            }
            placeholder={"Search " + column.header}
          />
        </label>
        {checklist}
      </>
    );
  } else if (column.kind === "category") {
    const current = filter?.kind === "category" ? filter : undefined;
    body = (
      <>
        <label className="dg-filter-field">
          <span>Contains</span>
          <input
            type="search"
            value={current?.contains ?? ""}
            onChange={(event) =>
              onChange({
                kind: "category",
                values: current?.values ?? [],
                contains: event.target.value || undefined,
              })
            }
            placeholder={"Search " + column.header}
          />
        </label>
        {checklist}
      </>
    );
  } else if (column.kind === "number") {
    const current = filter?.kind === "number" ? filter : undefined;
    const op = current?.op;
    const requiresValue = !isNumberWithoutValue(op);
    body = (
      <>
        {sortActions}
        <label className="dg-filter-field">
          <span>Condition</span>
          <select
            value={op ?? ""}
            onChange={(event) => {
              const nextOp = (event.target.value || undefined) as NumberOp | undefined;
              onChange({
                kind: "number",
                values: current?.values,
                op: nextOp,
                a: isNumberWithoutValue(nextOp) ? undefined : current?.a,
                b: nextOp === "between" ? current?.b : undefined,
              });
            }}
          >
            <option value="">No condition</option>
            {NUMBER_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {op && requiresValue && (
          <div className="dg-filter-input-pair">
            <label className="dg-filter-field">
              <span>{op === "between" ? "From" : "Value"}</span>
              <input
                type="number"
                value={current?.a ?? ""}
                onChange={(event) =>
                  onChange({
                    kind: "number",
                    values: current?.values,
                    op,
                    a: numericInput(event.target.value),
                    b: op === "between" ? current?.b : undefined,
                  })
                }
              />
            </label>
            {op === "between" && (
              <label className="dg-filter-field">
                <span>To</span>
                <input
                  type="number"
                  value={current?.b ?? ""}
                  onChange={(event) =>
                    onChange({
                      kind: "number",
                      values: current?.values,
                      op,
                      a: current?.a,
                      b: numericInput(event.target.value),
                    })
                  }
                />
              </label>
            )}
          </div>
        )}
        {checklist}
      </>
    );
  } else if (column.kind === "date") {
    const current = filter?.kind === "date" ? filter : undefined;
    const op = current?.op;
    const requiresValue = !isDateWithoutValue(op);
    body = (
      <>
        {sortActions}
        <label className="dg-filter-field">
          <span>Condition</span>
          <select
            value={op ?? ""}
            onChange={(event) => {
              const nextOp = (event.target.value || undefined) as DateOp | undefined;
              onChange({
                kind: "date",
                op: nextOp,
                a: isDateWithoutValue(nextOp) ? undefined : current?.a,
                b: nextOp === "between" ? current?.b : undefined,
              });
            }}
          >
            <option value="">No condition</option>
            {DATE_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {op && requiresValue && (
          <div className="dg-filter-input-pair">
            <label className="dg-filter-field">
              <span>{op === "between" ? "From" : "Date"}</span>
              <input
                type="date"
                value={current?.a ?? ""}
                onChange={(event) =>
                  onChange({
                    kind: "date",
                    op,
                    a: event.target.value || undefined,
                    b: op === "between" ? current?.b : undefined,
                  })
                }
              />
            </label>
            {op === "between" && (
              <label className="dg-filter-field">
                <span>To</span>
                <input
                  type="date"
                  value={current?.b ?? ""}
                  onChange={(event) =>
                    onChange({
                      kind: "date",
                      op,
                      a: current?.a,
                      b: event.target.value || undefined,
                    })
                  }
                />
              </label>
            )}
          </div>
        )}
      </>
    );
  } else {
    const current =
      filter?.kind === "score"
        ? filter
        : (defaultFilter("score") as Extract<ColumnFilter, { kind: "score" }>);
    const bucketMode = current.buckets !== undefined;
    const selectedBuckets = current.buckets ?? [];
    const setBuckets = (next: BucketKey[]) =>
      onChange({ kind: "score", buckets: next, includeCheck: true });
    const toggleBucket = (key: BucketKey) => {
      const next = new Set(selectedBuckets);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setBuckets([...next]);
    };
    const setCondition = (patch: Partial<Extract<ColumnFilter, { kind: "score" }>>) =>
      onChange({ kind: "score", includeCheck: current.includeCheck, ...patch });
    const op = current.op;
    const requiresValue = !isNumberWithoutValue(op);
    body = (
      <>
        {sortActions}
        <div className="dg-filter-segmented" role="group" aria-label="Score filter mode">
          <button
            type="button"
            aria-pressed={bucketMode}
            className={bucketMode ? "is-active" : ""}
            onClick={() => onChange({ kind: "score", buckets: [], includeCheck: true })}
          >
            Buckets
          </button>
          <button
            type="button"
            aria-pressed={!bucketMode}
            className={!bucketMode ? "is-active" : ""}
            onClick={() => onChange({ kind: "score", includeCheck: current.includeCheck })}
          >
            Condition
          </button>
        </div>
        {bucketMode ? (
          <div className="dg-filter-values dg-filter-score-buckets" role="group" aria-label={column.header + " score buckets"}>
            {bucketCounts.map((bucket) => (
              <label className="dg-filter-value" key={String(bucket.key)}>
                <input
                  type="checkbox"
                  checked={selectedBuckets.includes(bucket.key)}
                  onChange={() => toggleBucket(bucket.key)}
                />
                <span className="dg-filter-value-label">{bucket.label}</span>
                <span className="dg-filter-value-count">{bucket.count.toLocaleString()}</span>
              </label>
            ))}
          </div>
        ) : (
          <>
            <label className="dg-filter-field">
              <span>Condition</span>
              <select
                value={op ?? ""}
                onChange={(event) => {
                  const nextOp = (event.target.value || undefined) as NumberOp | undefined;
                  setCondition({
                    op: nextOp,
                    a: isNumberWithoutValue(nextOp) ? undefined : current.a,
                    b: nextOp === "between" ? current.b : undefined,
                    buckets: undefined,
                  });
                }}
              >
                <option value="">No condition</option>
                {NUMBER_OPTIONS.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {op && requiresValue && (
              <div className="dg-filter-input-pair">
                <label className="dg-filter-field">
                  <span>{op === "between" ? "From" : "Value"}</span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={current.a ?? ""}
                    onChange={(event) =>
                      setCondition({
                        op,
                        a: numericInput(event.target.value),
                        b: op === "between" ? current.b : undefined,
                        buckets: undefined,
                      })
                    }
                  />
                </label>
                {op === "between" && (
                  <label className="dg-filter-field">
                    <span>To</span>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={current.b ?? ""}
                      onChange={(event) =>
                        setCondition({
                          op,
                          a: current.a,
                          b: numericInput(event.target.value),
                          buckets: undefined,
                        })
                      }
                    />
                  </label>
                )}
              </div>
            )}
            <label className="dg-filter-check dg-filter-include-check">
              <input
                type="checkbox"
                checked={current.includeCheck}
                onChange={(event) => setCondition({ includeCheck: event.target.checked, buckets: undefined })}
              />
              <span>Include CHECK</span>
            </label>
          </>
        )}
      </>
    );
  }

  return (
    <section className="dg-filter-panel" aria-label={column.header + " filter"}>
      {!hideHeading && (
        <div className="dg-filter-panel-heading">
          <div>
            <strong>{column.header}</strong>
            <span>Filter values and conditions</span>
          </div>
          {onDone && (
            <button type="button" className="dg-filter-done" onClick={onDone}>
              Done
            </button>
          )}
        </div>
      )}
      <div className="dg-filter-panel-body">{body}</div>
      <div className="dg-filter-panel-footer">
        <button type="button" onClick={() => onChange(defaultFilter(column.kind))}>
          Clear
        </button>
        {sort?.columnId === column.id && (
          <span aria-live="polite">Sorted {sort.direction === "asc" ? "ascending" : "descending"}</span>
        )}
      </div>
    </section>
  );
}
