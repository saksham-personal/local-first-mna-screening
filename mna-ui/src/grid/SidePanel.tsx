import { useMemo, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import FilterPanel from "./FilterPanel";
import { isFilterActive } from "./grid-filter";
import type { DataGridColumn, SidePanelTab } from "./DataGrid";
import type { ColumnFilter, FilterState, SortState } from "./grid-types";

type SidePanelProps<Row> = {
  columns: DataGridColumn<Row>[];
  visibleColumnIds: string[];
  onVisibleColumnIdsChange: (ids: string[]) => void;
  filterState: FilterState;
  rows: Row[];
  sort: SortState;
  onFilterChange: (columnId: string, filter: ColumnFilter | undefined) => void;
  onSortChange: (sort: SortState) => void;
  callerTabs: SidePanelTab[];
  activeTabId: string;
  onActiveTabChange: (id: string) => void;
  idPrefix: string;
};

type PanelTab = {
  id: string;
  label: string;
  count?: number;
  content: ReactNode;
};

export default function SidePanel<Row>({
  columns,
  visibleColumnIds,
  onVisibleColumnIdsChange,
  filterState,
  rows,
  sort,
  onFilterChange,
  onSortChange,
  callerTabs,
  activeTabId,
  onActiveTabChange,
  idPrefix,
}: SidePanelProps<Row>) {
  const [columnSearch, setColumnSearch] = useState("");
  const [openFilterIds, setOpenFilterIds] = useState<string[]>(() => {
    const active = columns.find((column) => isFilterActive(filterState.columns[column.id]));
    return active ? [active.id] : [];
  });
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);

  const filteredColumns = useMemo(() => {
    const query = columnSearch.trim().toLowerCase();
    return columns.filter((column) => !query || column.header.toLowerCase().includes(query));
  }, [columns, columnSearch]);
  const groupedColumns = useMemo(() => {
    const groups = new Map<string, DataGridColumn<Row>[]>();
    for (const column of filteredColumns) {
      const group = column.group || "Columns";
      groups.set(group, [...(groups.get(group) ?? []), column]);
    }
    return [...groups.entries()];
  }, [filteredColumns]);

  const allColumnIds = columns.map((column) => column.id);
  const defaultColumnIds = columns.filter((column) => !column.hidden).map((column) => column.id);
  const setVisible = (id: string, visible: boolean) => {
    const current = new Set(visibleColumnIds);
    if (visible) current.add(id);
    else current.delete(id);
    onVisibleColumnIdsChange(columns.filter((column) => current.has(column.id)).map((column) => column.id));
  };

  const activeFilterColumns = [...columns]
    .sort((left, right) =>
      Number(isFilterActive(filterState.columns[right.id])) - Number(isFilterActive(filterState.columns[left.id]))
      || columns.indexOf(left) - columns.indexOf(right),
    );
  const activeFilterCount = columns.filter((column) => isFilterActive(filterState.columns[column.id])).length;
  const filtersContent = (
    <div className="dg-side-filter-sections">
      {activeFilterColumns.map((column) => {
        const open = openFilterIds.includes(column.id);
        const active = isFilterActive(filterState.columns[column.id]);
        return (
          <details
            className="dg-side-filter-section"
            key={column.id}
            open={open}
            onToggle={(event) => {
              const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
              setOpenFilterIds((current) => nextOpen
                ? [...new Set([...current, column.id])]
                : current.filter((id) => id !== column.id));
            }}
          >
            <summary>
              <span>{column.header}</span>
              {active && <span className="dg-side-filter-active" aria-label="Active filter">Active</span>}
            </summary>
            {open && (
              <FilterPanel
                column={column}
                rows={rows}
                columns={columns}
                state={filterState}
                filter={filterState.columns[column.id]}
                sort={sort}
                onChange={(filter) => onFilterChange(column.id, filter)}
                onSortChange={onSortChange}
                hideHeading
              />
            )}
          </details>
        );
      })}
      {activeFilterCount === 0 && <p className="dg-side-empty">No active column filters.</p>}
    </div>
  );

  const columnsContent = (
    <div className="dg-side-columns">
      <label className="dg-filter-search dg-side-column-search">
        <Search size={14} aria-hidden="true" />
        <span className="sr-only">Search columns</span>
        <input
          type="search"
          value={columnSearch}
          onChange={(event) => setColumnSearch(event.target.value)}
          placeholder="Search columns"
        />
      </label>
      <div className="dg-side-column-actions">
        <button type="button" onClick={() => onVisibleColumnIdsChange(allColumnIds)}>Select all</button>
        <button type="button" onClick={() => onVisibleColumnIdsChange(defaultColumnIds)}>Reset</button>
      </div>
      {groupedColumns.map(([group, groupColumns]) => {
        const collapsed = collapsedGroups.includes(group);
        return (
          <section className="dg-column-group" key={group}>
            <button
              type="button"
              className="dg-column-group-heading"
              aria-expanded={!collapsed}
              onClick={() => setCollapsedGroups((current) => collapsed
                ? current.filter((entry) => entry !== group)
                : [...current, group])}
            >
              <span>{group}</span>
              <span>{groupColumns.length}</span>
            </button>
            {!collapsed && groupColumns.map((column) => (
              <label className="dg-column-choice" key={column.id}>
                <input
                  type="checkbox"
                  checked={visibleColumnIds.includes(column.id)}
                  onChange={(event) => setVisible(column.id, event.target.checked)}
                />
                <span>{column.header}</span>
              </label>
            ))}
          </section>
        );
      })}
    </div>
  );

  const tabs: PanelTab[] = [
    { id: "columns", label: "COLUMNS", content: columnsContent },
    {
      id: "filters",
      label: "FILTERS",
      count: activeFilterCount,
      content: filtersContent,
    },
    ...callerTabs.map((tab) => ({
      id: tab.id,
      label: tab.label.toUpperCase(),
      count: tab.count,
      content: tab.render(),
    })),
  ];
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  return (
    <aside className="dg-side-panel" aria-label="Grid options">
      <div
        id={`${idPrefix}-content-${activeTab.id}`}
        className="dg-side-panel-content"
        role="tabpanel"
        aria-labelledby={`${idPrefix}-tab-${activeTab.id}`}
      >
        <div className="dg-side-panel-heading">
          <strong>{activeTab.label}</strong>
          {activeTab.count !== undefined && <span>{activeTab.count.toLocaleString()}</span>}
        </div>
        {activeTab.content}
      </div>
      <div className="dg-side-panel-tabs" role="tablist" aria-label="Grid options">
        {tabs.map((tab) => (
          <button
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={activeTab.id === tab.id}
            aria-controls={`${idPrefix}-content-${tab.id}`}
            className={activeTab.id === tab.id ? "is-active" : ""}
            key={tab.id}
            onClick={() => onActiveTabChange(tab.id)}
          >
            <span>{tab.label}</span>
            {tab.count !== undefined && tab.count > 0 && <small>{tab.count}</small>}
          </button>
        ))}
      </div>
    </aside>
  );
}
