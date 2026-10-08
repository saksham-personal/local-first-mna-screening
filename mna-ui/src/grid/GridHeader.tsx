import { useSyncExternalStore } from "react";
import { isFilterActive } from "./grid-filter";
import { createGridRuntime } from "./grid-runtime";
import { Popover } from "radix-ui";
import { ArrowDown, ArrowUp, ArrowUpDown, Filter } from "lucide-react";
import type { IHeaderParams } from "ag-grid-community";
import FilterPanel from "./FilterPanel";
import type { GridColumnSpec } from "./grid-types";
import type { ColumnFilter, FilterState, SortState } from "./grid-types";

export type GridHeaderParams<Row> = IHeaderParams<Row> & {
  gridColumn: GridColumnSpec<Row>;
  runtime: ReturnType<typeof createGridRuntime<GridHeaderSnapshot<Row>>>;
  onSortChange: (sort: SortState) => void;
  onFilterChange: (filter: ColumnFilter | undefined) => void;
  onFilterOpenChange: (columnId: string, open: boolean) => void;
  onQuickFilterChange: (value: string) => void;
};

export type GridHeaderSnapshot<Row> = {
  rows: Row[]; columns: GridColumnSpec<Row>[]; filterState: FilterState;
  sortState: SortState; openFilterColumn: string | null; selectedIds: string[];
};
export function headerQuickValue<Row>(column: GridColumnSpec<Row>, filter: ColumnFilter | undefined): string {
  if (!filter || filter.kind !== column.kind) return "";
  if (filter.kind === "text" || filter.kind === "category") return filter.contains ?? "";
  if (filter.kind === "number" || filter.kind === "score") return filter.op === "gte" && filter.a !== undefined ? String(filter.a) : "";
  return filter.op === "on" ? filter.a ?? "" : "";
}

export default function GridHeader<Row>(params: GridHeaderParams<Row>) {
  const { gridColumn, runtime, onSortChange, onFilterChange, onFilterOpenChange, onQuickFilterChange } = params;
  const { rows, columns, filterState, sortState, openFilterColumn } = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const columnFilter = filterState.columns[gridColumn.id];
  const filterOpen = openFilterColumn === gridColumn.id;
  const activeFilterCount = isFilterActive(columnFilter) ? 1 : 0;
  const quickFilterValue = headerQuickValue(gridColumn, columnFilter);
  const id = gridColumn.id;
  const direction =
    sortState?.columnId === id ? sortState.direction : undefined;
  const sortLabel = direction ?? "none";
  const sortIcon =
    direction === "asc" ? (
      <ArrowUp size={13} aria-hidden="true" />
    ) : direction === "desc" ? (
      <ArrowDown size={13} aria-hidden="true" />
    ) : (
      <ArrowUpDown size={13} aria-hidden="true" />
    );

  const cycleSort = () => {
    if (gridColumn.sortable === false) return;
    if (direction === undefined) onSortChange({ columnId: id, direction: "asc" });
    else if (direction === "asc") onSortChange({ columnId: id, direction: "desc" });
    else onSortChange(null);
  };

  return (
    <div className="dg-header">
      <div className="dg-header-main">
        <button
          type="button"
          className="dg-header-sort"
          aria-label={"Sort " + gridColumn.header + ", currently " + sortLabel}
          aria-pressed={Boolean(direction)}
          disabled={gridColumn.sortable === false}
          onClick={(event) => {
            event.stopPropagation();
            cycleSort();
          }}
        >
          <span className="dg-header-label">{gridColumn.header}</span>
          <span className="dg-header-sort-icon">{sortIcon}</span>
        </button>
        <Popover.Root
          open={filterOpen}
          onOpenChange={(open) => onFilterOpenChange(id, open)}
        >
          <Popover.Trigger asChild>
            <button
              type="button"
              className={"dg-header-filter" + (activeFilterCount ? " is-active" : "")}
              aria-label={
                "Filter " +
                gridColumn.header +
                (activeFilterCount ? ", " + activeFilterCount + " active" : "")
              }
              aria-pressed={activeFilterCount > 0}
              aria-expanded={filterOpen}
              onClick={(event) => event.stopPropagation()}
            >
              <Filter size={13} aria-hidden="true" />
              {activeFilterCount > 0 && (
                <span className="dg-header-filter-count">{activeFilterCount}</span>
              )}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              className="dg-filter-popover"
              side="bottom"
              align="start"
              sideOffset={6}
              collisionPadding={12}
              aria-label={gridColumn.header + " filter"}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <FilterPanel
                column={gridColumn}
                rows={rows}
                columns={columns}
                state={filterState}
                filter={columnFilter}
                sort={sortState}
                onChange={onFilterChange}
                onSortChange={onSortChange}
                onDone={() => onFilterOpenChange(id, false)}
              />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
      <label className="dg-floating-filter">
        <span className="sr-only">Quick filter {gridColumn.header}</span>
        <input
          type={
            gridColumn.kind === "number" || gridColumn.kind === "score"
              ? "number"
              : gridColumn.kind === "date"
                ? "date"
                : "search"
          }
          min={gridColumn.kind === "score" ? 0 : undefined}
          max={gridColumn.kind === "score" ? gridColumn.bucketScheme?.max ?? 10 : undefined}
          value={quickFilterValue}
          placeholder={
            gridColumn.kind === "number" || gridColumn.kind === "score"
              ? "≥"
              : gridColumn.kind === "date"
                ? "On date"
                : "Contains"
          }
          aria-label={"Quick filter " + gridColumn.header}
          onChange={(event) => onQuickFilterChange(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </label>
    </div>
  );
}
