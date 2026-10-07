import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  AllCommunityModule,
  themeQuartz,
  type ColDef,
  type GetRowIdParams,
  type ICellRendererParams,
  type IHeaderParams,
} from "ag-grid-community";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import { Columns3, Search, X } from "lucide-react";
import {
  defaultFilter,
  emptyFilterState,
  filterRows,
  isFilterActive,
  sortRows,
} from "./grid-filter";
import {
  areFilteredRowsSelected,
  buildFilterChips,
  defaultVisibleColumnIds,
  readGridPreferences,
  serializeGridPreferences,
  setFilteredSelection,
} from "./grid-state";
import GridHeader from "./GridHeader";
import SidePanel from "./SidePanel";
import Skeleton from "../ui/Skeleton";
import type {
  ColumnFilter,
  FilterState,
  GridColumnSpec,
  SortState,
} from "./grid-types";
import "./grid.css";

export type DataGridColumn<Row> = GridColumnSpec<Row> & {
  render?: (row: Row) => ReactNode;
  tooltip?: (row: Row) => string | undefined;
};

export type SidePanelTab = {
  id: string;
  label: string;
  count?: number;
  render: () => ReactNode;
};

export type DataGridProps<Row> = {
  rows: Row[];
  columns: DataGridColumn<Row>[];
  getRowId: (row: Row) => string;
  label: string;
  height?: number | "fill";
  loading?: boolean;
  emptyText?: string;
  filterState?: FilterState;
  onFilterStateChange?: (state: FilterState) => void;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  visibleColumnIds?: string[];
  onVisibleColumnIdsChange?: (ids: string[]) => void;
  selectable?: boolean;
  selectedIds?: string[];
  onSelectedIdsChange?: (ids: string[]) => void;
  actionBar?: (selectedIds: string[]) => ReactNode;
  toolbarExtra?: ReactNode;
  isRowMuted?: (row: Row) => boolean;                 // memoise it: a new function redraws all rows
  onOpenRow?: (row: Row) => void;
  onVisibleRowsChange?: (rows: Row[]) => void;
  sidePanelTabs?: SidePanelTab[];
  sidePanelDefaultOpen?: boolean;
  storageKey?: string;
  rowHeight?: number;
};

type SelectionHeaderParams<Row> = IHeaderParams<Row> & {
  getStatus: () => { checked: boolean; indeterminate: boolean; disabled: boolean };
  onToggle: (selected: boolean) => void;
};

function SelectionHeader<Row>({ getStatus, onToggle }: SelectionHeaderParams<Row>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const status = getStatus();
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = status.indeterminate;
  }, [status.indeterminate]);
  return (
    <div className="dg-selection-header">
      <input
        ref={inputRef}
        type="checkbox"
        aria-label="Select all filtered rows"
        checked={status.checked}
        disabled={status.disabled}
        onChange={(event) => onToggle(event.target.checked)}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}

const gridModules = [AllCommunityModule];
const defaultGridColDef: ColDef = { sortable: false, filter: false, resizable: true };
const gridTheme = themeQuartz.withParams({
  accentColor: "var(--accent)",
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--text)",
  borderColor: "var(--border)",
  headerBackgroundColor: "var(--surface-muted)",
  headerTextColor: "var(--text-muted)",
  rowHoverColor: "var(--accent-soft)",
  selectedRowBackgroundColor: "var(--accent-soft)",
  oddRowBackgroundColor: "var(--surface)",
  fontFamily: '"Geist Variable", Geist, system-ui, sans-serif',
  fontSize: 13,
  headerFontWeight: 650,
  wrapperBorderRadius: 0,
});

function getStoredPreferences<Row>(
  columns: DataGridColumn<Row>[],
  storageKey: string | undefined,
  defaultOpen: boolean,
) {
  if (!storageKey || typeof window === "undefined") {
    return {
      visibleColumnIds: defaultVisibleColumnIds(columns),
      sidePanelOpen: defaultOpen,
    };
  }
  try {
    return readGridPreferences(columns, window.localStorage.getItem(storageKey), defaultOpen);
  } catch {
    return readGridPreferences(columns, null, defaultOpen);
  }
}

function cleanColumnFilter<Row>(column: DataGridColumn<Row>, filter: ColumnFilter): ColumnFilter | undefined {
  if (filter.kind !== column.kind) return filter;
  switch (filter.kind) {
    case "text":
      return filter.contains || filter.values?.length ? filter : undefined;
    case "category":
      return filter.contains || filter.values.length ? filter : undefined;
    case "number":
      return filter.values?.length || filter.op ? filter : undefined;
    case "score":
      return filter.buckets !== undefined || filter.op || !filter.includeCheck
        ? filter
        : undefined;
    case "date":
      return filter.op ? filter : undefined;
  }
}

function quickFilterValue<Row>(column: DataGridColumn<Row>, filter: ColumnFilter | undefined): string {
  if (!filter || filter.kind !== column.kind) return "";
  if (filter.kind === "text" || filter.kind === "category") return filter.contains ?? "";
  if (filter.kind === "number" || filter.kind === "score") {
    return filter.op === "gte" && filter.a !== undefined ? String(filter.a) : "";
  }
  return filter.op === "on" ? filter.a ?? "" : "";
}

function displayCellValue(value: unknown, kind: GridColumnSpec<unknown>["kind"]): string {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return "—";
  }
  if (kind === "number" && typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString();
  }
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

export function DataGrid<Row>({
  rows,
  columns,
  getRowId,
  label,
  height = "fill",
  loading = false,
  emptyText = "No rows match the current filters.",
  filterState: controlledFilterState,
  onFilterStateChange,
  sort: controlledSort,
  onSortChange,
  visibleColumnIds: controlledVisibleColumnIds,
  onVisibleColumnIdsChange,
  selectable = false,
  selectedIds: controlledSelectedIds,
  onSelectedIdsChange,
  actionBar,
  toolbarExtra,
  isRowMuted,
  onOpenRow,
  onVisibleRowsChange,
  sidePanelTabs = [],
  sidePanelDefaultOpen = false,
  storageKey,
  rowHeight = 44,
}: DataGridProps<Row>) {
  const [internalFilterState, setInternalFilterState] = useState(emptyFilterState);
  const filterState = controlledFilterState ?? internalFilterState;
  const [internalSort, setInternalSort] = useState<SortState>(null);
  const sort = controlledSort !== undefined ? controlledSort : internalSort;
  const [internalPreferences, setInternalPreferences] = useState(() =>
    getStoredPreferences(columns, storageKey, sidePanelDefaultOpen),
  );
  const [internalSelectedIds, setInternalSelectedIds] = useState<string[]>([]);
  const visibleColumnIds = controlledVisibleColumnIds ?? internalPreferences.visibleColumnIds;
  const selectedIds = controlledSelectedIds ?? internalSelectedIds;
  const [activeSideTab, setActiveSideTab] = useState("columns");
  const [openFilterColumn, setOpenFilterColumn] = useState<string | null>(null);
  const [quickSearchDraft, setQuickSearchDraft] = useState(filterState.quick);
  const sidePanelId = `dg-side-panel-${useId()}`;
  const gridRef = useRef<AgGridReact<Row>>(null);

  const filterStateRef = useRef(filterState);
  filterStateRef.current = filterState;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const filteredRows = useMemo(() => filterRows(rows, columns, filterState), [rows, columns, filterState]);
  const displayedRows = useMemo(() => sortRows(filteredRows, columns, sort), [filteredRows, columns, sort]);
  const displayedRowsRef = useRef(displayedRows);
  displayedRowsRef.current = displayedRows;
  const getRowIdRef = useRef(getRowId);
  getRowIdRef.current = getRowId;

  useEffect(() => {
    onVisibleRowsChange?.(displayedRows);
  }, [displayedRows, onVisibleRowsChange]);

  const updateFilterState = useCallback((next: FilterState) => {
    if (controlledFilterState === undefined) setInternalFilterState(next);
    onFilterStateChange?.(next);
  }, [controlledFilterState, onFilterStateChange]);

  const setColumnFilter = useCallback((columnId: string, nextFilter: ColumnFilter | undefined) => {
    const column = columns.find((item) => item.id === columnId);
    const cleaned = nextFilter && column ? cleanColumnFilter(column, nextFilter) : nextFilter;
    const nextColumns = { ...filterStateRef.current.columns };
    if (cleaned) nextColumns[columnId] = cleaned;
    else delete nextColumns[columnId];
    updateFilterState({ ...filterStateRef.current, columns: nextColumns });
  }, [columns, updateFilterState]);

  const updateSort = useCallback((next: SortState) => {
    if (controlledSort === undefined) setInternalSort(next);
    onSortChange?.(next);
  }, [controlledSort, onSortChange]);

  const updateVisibleColumnIds = useCallback((ids: string[]) => {
    if (controlledVisibleColumnIds === undefined) {
      setInternalPreferences((current) => ({ ...current, visibleColumnIds: ids }));
    }
    onVisibleColumnIdsChange?.(ids);
  }, [controlledVisibleColumnIds, onVisibleColumnIdsChange]);

  const setPanelOpen = useCallback((open: boolean) => {
    setInternalPreferences((current) => ({ ...current, sidePanelOpen: open }));
    if (open) setActiveSideTab("columns");
  }, []);
  const sidePanelOpen = internalPreferences.sidePanelOpen;

  const updateSelectedIds = useCallback((ids: string[]) => {
    if (controlledSelectedIds === undefined) setInternalSelectedIds(ids);
    onSelectedIdsChange?.(ids);
  }, [controlledSelectedIds, onSelectedIdsChange]);
  const toggleFilteredSelection = useCallback((selected: boolean) => {
    updateSelectedIds(setFilteredSelection(
      selectedIdsRef.current,
      displayedRowsRef.current,
      (row) => getRowIdRef.current(row),
      selected,
    ));
  }, [updateSelectedIds]);
  const toggleSingleSelection = useCallback((row: Row, selected: boolean) => {
    updateSelectedIds(setFilteredSelection(
      selectedIdsRef.current,
      [row],
      (item) => getRowIdRef.current(item),
      selected,
    ));
  }, [updateSelectedIds]);

  const setQuickFilter = useCallback((column: DataGridColumn<Row>, value: string) => {
    const current = filterStateRef.current.columns[column.id];
    if (column.kind === "text") {
      const text = current?.kind === "text" ? current : { kind: "text" as const };
      setColumnFilter(column.id, { ...text, contains: value || undefined });
    } else if (column.kind === "category") {
      const category = current?.kind === "category" ? current : { kind: "category" as const, values: [] };
      setColumnFilter(column.id, { ...category, contains: value || undefined });
    } else if (column.kind === "number") {
      const number = current?.kind === "number" ? current : { kind: "number" as const };
      const parsed = value.trim() ? Number(value) : undefined;
      setColumnFilter(column.id, {
        ...number,
        op: parsed !== undefined && Number.isFinite(parsed) ? "gte" : undefined,
        a: parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
        b: undefined,
      });
    } else if (column.kind === "score") {
      const score = current?.kind === "score"
        ? current
        : (defaultFilter("score") as Extract<ColumnFilter, { kind: "score" }>);
      const parsed = value.trim() ? Number(value) : undefined;
      setColumnFilter(column.id, {
        ...score,
        buckets: undefined,
        op: parsed !== undefined && Number.isFinite(parsed) ? "gte" : undefined,
        a: parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
        b: undefined,
      });
    } else {
      const date = current?.kind === "date" ? current : { kind: "date" as const };
      setColumnFilter(column.id, {
        ...date,
        op: value ? "on" : undefined,
        a: value || undefined,
        b: undefined,
      });
    }
  }, [setColumnFilter]);

  useEffect(() => {
    setQuickSearchDraft(filterState.quick);
  }, [filterState.quick]);
  useEffect(() => {
    if (quickSearchDraft === filterState.quick) return;
    const timer = window.setTimeout(() => {
      updateFilterState({ ...filterStateRef.current, quick: quickSearchDraft });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [filterState.quick, quickSearchDraft, updateFilterState]);

  useEffect(() => {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(
        storageKey,
        serializeGridPreferences(visibleColumnIds, sidePanelOpen),
      );
    } catch {
      // Storage is optional; private browsing or quota limits must not prevent grid use.
    }
  }, [storageKey, visibleColumnIds, sidePanelOpen]);

  useEffect(() => {
    const api = gridRef.current?.api;
    if (api && selectable) {
      api.refreshCells({ columns: ["__dg_select"], force: true });
      api.refreshHeader();
    }
  }, [selectedIds, displayedRows, selectable]);

  // rowClassRules read isRowMuted through a ref, so re-run them when the caller's rule changes.
  useEffect(() => {
    gridRef.current?.api?.redrawRows();
  }, [isRowMuted]);

  const visibleColumns = useMemo(
    () => columns.filter((column) => visibleColumnIds.includes(column.id)),
    [columns, visibleColumnIds],
  );
  const chips = useMemo(() => buildFilterChips(columns, filterState), [columns, filterState]);
  const safeHeight: CSSProperties = height === "fill"
    ? { flex: "1 1 auto", minHeight: 420 }
    : { height };

  const columnDefs = useMemo<ColDef<Row>[]>(() => {
    const definitions: ColDef<Row>[] = [];
    if (selectable) {
      definitions.push({
        colId: "__dg_select",
        headerName: "Select rows",
        pinned: "left",
        width: 48,
        minWidth: 48,
        maxWidth: 48,
        resizable: false,
        sortable: false,
        filter: false,
        suppressMovable: true,
        lockPosition: "left",
        headerComponent: SelectionHeader,
        headerComponentParams: {
          getStatus: () => ({
            checked: areFilteredRowsSelected(selectedIdsRef.current, displayedRowsRef.current, (row) => getRowIdRef.current(row)),
            indeterminate: displayedRowsRef.current.some((row) => selectedIdsRef.current.includes(getRowIdRef.current(row)))
              && !areFilteredRowsSelected(selectedIdsRef.current, displayedRowsRef.current, (row) => getRowIdRef.current(row)),
            disabled: displayedRowsRef.current.length === 0,
          }),
          onToggle: (selected: boolean) => toggleFilteredSelection(selected),
        },
        cellRenderer: (params: ICellRendererParams<Row>) => {
          if (!params.data) return null;
          const id = getRowIdRef.current(params.data);
          return (
            <label className="dg-selection-cell" aria-label={`Select row ${id}`}>
              <input
                type="checkbox"
                checked={selectedIdsRef.current.includes(id)}
                aria-label={`Select row ${id}`}
                onChange={(event) => toggleSingleSelection(params.data as Row, event.target.checked)}
                onClick={(event) => event.stopPropagation()}
              />
            </label>
          );
        },
      });
    }
    for (const column of visibleColumns) {
      const filter = filterState.columns[column.id];
      definitions.push({
        colId: column.id,
        headerName: column.header,
        width: column.width,
        minWidth: column.minWidth ?? 116,
        pinned: column.pinned,
        sortable: false,
        filter: false,
        resizable: true,
        suppressHeaderMenuButton: true,
        headerComponent: GridHeader,
        headerComponentParams: {
          gridColumn: column,
          rows,
          columns: columns,
          filterState,
          columnFilter: filter,
          sortState: sort,
          filterOpen: openFilterColumn === column.id,
          activeFilterCount: isFilterActive(filter) ? 1 : 0,
          quickFilterValue: quickFilterValue(column, filter),
          onSortChange: updateSort,
          onFilterChange: (next: ColumnFilter | undefined) => setColumnFilter(column.id, next),
          onFilterOpenChange: (columnId: string, open: boolean) => setOpenFilterColumn(open ? columnId : null),
          onQuickFilterChange: (value: string) => setQuickFilter(column, value),
        },
        valueGetter: ({ data }) => data ? column.value(data) : undefined,
        cellRenderer: (params: ICellRendererParams<Row>) => {
          if (!params.data) return null;
          const content = column.render
            ? column.render(params.data)
            : displayCellValue(column.value(params.data), column.kind);
          return <div className="dg-cell-content">{content}</div>;
        },
        tooltipValueGetter: ({ data }) => data ? column.tooltip?.(data) : undefined,
        wrapText: false,
        autoHeight: false,
      });
    }
    return definitions;
  }, [
    selectable,
    visibleColumns,
    filterState,
    rows,
    columns,
    sort,
    openFilterColumn,
    updateSort,
    setColumnFilter,
    setQuickFilter,
    toggleFilteredSelection,
    toggleSingleSelection,
  ]);

  const isRowMutedRef = useRef(isRowMuted);
  isRowMutedRef.current = isRowMuted;
  const rowClassRules = useMemo(() => ({
    "dg-row-muted": (params: { data?: Row }) => Boolean(params.data && isRowMutedRef.current?.(params.data)),
  }), []);
  const getGridRowId = useCallback(({ data }: GetRowIdParams<Row>) => getRowId(data), [getRowId]);
  const openRow = useCallback((event: { data?: Row; event?: Event | null }) => {
    if (!event.data || !onOpenRow) return;
    const target = event.event?.target;
    if (target instanceof Element && target.closest("button,a,input,select,textarea,[role='button']")) return;
    onOpenRow(event.data);
  }, [onOpenRow]);
  const openRowByKeyboard = useCallback((event: { data?: Row; event?: Event | null }) => {
    const keyEvent = event.event;
    if (!(keyEvent instanceof KeyboardEvent) || keyEvent.key !== "Enter" || !event.data || !onOpenRow) return;
    const target = keyEvent.target;
    if (target instanceof Element && target.closest("button,a,input,select,textarea,[role='button']")) return;
    onOpenRow(event.data);
  }, [onOpenRow]);

  const gridElement = loading ? (
    <Skeleton variant="table" className="dg-loading" label={`Loading ${label}`} rows={7} cols={Math.min(Math.max(visibleColumns.length, 1), 8)} />
  ) : (
    <AgGridProvider modules={gridModules}>
      <AgGridReact<Row>
        ref={gridRef}
        rowData={displayedRows}
        columnDefs={columnDefs}
        defaultColDef={defaultGridColDef}
        getRowId={getGridRowId}
        theme={gridTheme}
        rowHeight={rowHeight}
        headerHeight={70}
        rowBuffer={10}
        animateRows={false}
        suppressMultiSort
        suppressRowClickSelection
        suppressDragLeaveHidesColumns
        rowClassRules={rowClassRules}
        onRowClicked={openRow}
        onCellKeyDown={openRowByKeyboard}
        overlayNoRowsTemplate={`<span class="dg-empty">${escapeHtml(emptyText)}</span>`}
      />
    </AgGridProvider>
  );

  return (
    <section className="dg-shell" style={safeHeight} aria-label={label}>
      <div className="dg-toolbar">
        <label className="dg-global-search">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">Search all columns</span>
          <input
            type="search"
            value={quickSearchDraft}
            onChange={(event) => setQuickSearchDraft(event.target.value)}
            placeholder="Search all columns"
            aria-label="Search all columns"
          />
        </label>
        <span className="dg-result-count" aria-live="polite">
          {filteredRows.length.toLocaleString()} of {rows.length.toLocaleString()}
        </span>
        {toolbarExtra && <div className="dg-toolbar-extra">{toolbarExtra}</div>}
        <button
          type="button"
          className="dg-columns-toggle"
          aria-expanded={sidePanelOpen}
          aria-controls={sidePanelId}
          onClick={() => setPanelOpen(!sidePanelOpen)}
        >
          <Columns3 size={15} aria-hidden="true" />
          <span>Columns</span>
        </button>
      </div>

      {chips.length > 0 && (
        <div className="dg-filter-chips" aria-label="Applied filters">
          {chips.map((chip) => (
            <span className="dg-filter-chip" key={chip.columnId}>
              <span>{chip.label}</span>
              <button
                type="button"
                aria-label={`Remove ${chip.label}`}
                onClick={() => setColumnFilter(chip.columnId, undefined)}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="dg-clear-all"
            onClick={() => updateFilterState({ ...filterStateRef.current, columns: {} })}
          >
            Clear all
          </button>
        </div>
      )}

      {selectable && selectedIds.length > 0 && (
        <div className="dg-action-bar">
          <span>{selectedIds.length.toLocaleString()} selected</span>
          <div className="dg-action-content">{actionBar?.(selectedIds)}</div>
          <button type="button" className="dg-clear-selection" onClick={() => updateSelectedIds([])}>
            Clear selection
          </button>
        </div>
      )}

      <div className="dg-work-area">
        {sidePanelOpen && (
          <div id={sidePanelId} className="dg-side-panel-wrap">
            <SidePanel
              columns={columns}
              visibleColumnIds={visibleColumnIds}
              onVisibleColumnIdsChange={updateVisibleColumnIds}
              filterState={filterState}
              rows={rows}
              sort={sort}
              onFilterChange={setColumnFilter}
              onSortChange={updateSort}
              callerTabs={sidePanelTabs}
              activeTabId={activeSideTab}
              onActiveTabChange={setActiveSideTab}
              idPrefix={sidePanelId}
            />
          </div>
        )}
        <div className="dg-grid-host" role="region" aria-label={`${label} results`}>
          {gridElement}
        </div>
      </div>
    </section>
  );
}
