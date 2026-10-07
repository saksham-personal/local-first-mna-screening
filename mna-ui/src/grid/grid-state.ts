import { describeFilter, isFilterActive } from "./grid-filter";
import type { FilterState, GridColumnSpec } from "./grid-types";

export type GridPreferences = {
  visibleColumnIds: string[];
  sidePanelOpen: boolean;
};

export type FilterChip<Row> = {
  columnId: string;
  label: string;
};

export function defaultVisibleColumnIds<Row>(
  columns: GridColumnSpec<Row>[],
): string[] {
  return columns.filter((column) => !column.hidden).map((column) => column.id);
}

export function readGridPreferences<Row>(
  columns: GridColumnSpec<Row>[],
  raw: string | null,
  defaultSidePanelOpen = false,
): GridPreferences {
  const defaults = defaultVisibleColumnIds(columns);
  if (!raw) {
    return { visibleColumnIds: defaults, sidePanelOpen: defaultSidePanelOpen };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { visibleColumnIds: defaults, sidePanelOpen: defaultSidePanelOpen };
    }
    const record = parsed as Record<string, unknown>;
    const known = new Set(defaults);
    const stored = record.visibleColumnIds;
    let visibleColumnIds = defaults;
    if (Array.isArray(stored) && stored.every((id) => typeof id === "string")) {
      const matched = [...new Set(stored.filter((id) => known.has(id)))];
      visibleColumnIds = stored.length > 0 && matched.length === 0 ? defaults : matched;
    }
    return {
      visibleColumnIds,
      sidePanelOpen:
        typeof record.sidePanelOpen === "boolean"
          ? record.sidePanelOpen
          : defaultSidePanelOpen,
    };
  } catch {
    return { visibleColumnIds: defaults, sidePanelOpen: defaultSidePanelOpen };
  }
}

export function serializeGridPreferences(
  visibleColumnIds: string[],
  sidePanelOpen: boolean,
): string {
  return JSON.stringify({ visibleColumnIds, sidePanelOpen });
}

export function buildFilterChips<Row>(
  columns: GridColumnSpec<Row>[],
  state: FilterState,
): FilterChip<Row>[] {
  return columns.flatMap((column) => {
    const filter = state.columns[column.id];
    return filter && isFilterActive(filter)
      ? [{ columnId: column.id, label: describeFilter(column, filter) }]
      : [];
  });
}

export function setFilteredSelection<Row>(
  selectedIds: string[],
  filteredRows: Row[],
  getRowId: (row: Row) => string,
  selected: boolean,
): string[] {
  const filteredIds = new Set(filteredRows.map(getRowId));
  const next = new Set(selectedIds);
  if (selected) {
    for (const id of filteredIds) next.add(id);
  } else {
    for (const id of filteredIds) next.delete(id);
  }
  return [...next];
}

export function areFilteredRowsSelected<Row>(
  selectedIds: string[],
  filteredRows: Row[],
  getRowId: (row: Row) => string,
): boolean {
  if (filteredRows.length === 0) return false;
  const selected = new Set(selectedIds);
  return filteredRows.every((row) => selected.has(getRowId(row)));
}
