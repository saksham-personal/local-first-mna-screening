import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AllCommunityModule,
  themeQuartz,
  type ColDef,
  type ICellRendererParams,
  type GridApi,
} from "ag-grid-community";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import { Download, Search } from "lucide-react";
import { useTheme } from "../lib/theme-store";
import "./data-table.css";

type DataTableProps = {
  rows: Record<string, unknown>[];
  columns?: string[];
  label?: string;
  onOpenCompany?: (pk: string) => void;
  selectedCompanyIds?: string[];
  onSelectionChange?: (companyIds: string[]) => void;
  exportCompanyIds?: string[];
};

const modules = [AllCommunityModule];
const pageSizes = [25, 50, 100];
const defaultColDef: ColDef<Record<string, unknown>> = {
  sortable: true,
  resizable: true,
  filter: true,
  minWidth: 110,
  flex: 1,
  tooltipValueGetter: ({ value }) => formatCell(value),
};

const lightTheme = themeQuartz.withParams({
  accentColor: "#8f5a39", backgroundColor: "#ffffff", foregroundColor: "#252a30",
  borderColor: "#e0e2de", headerBackgroundColor: "#f2f3f1", headerTextColor: "#676c73",
  rowHoverColor: "#f7f2ee", selectedRowBackgroundColor: "#f4e9e1", oddRowBackgroundColor: "#ffffff",
  fontFamily: '"Geist Variable", Geist, system-ui, sans-serif', fontSize: 12, headerFontWeight: 650,
  wrapperBorderRadius: 0,
});
const darkTheme = themeQuartz.withParams({
  accentColor: "#d7a17c", backgroundColor: "#202226", foregroundColor: "#eeeae6",
  borderColor: "#363a3e", headerBackgroundColor: "#272a2e", headerTextColor: "#b3b1af",
  rowHoverColor: "#302b28", selectedRowBackgroundColor: "#3a2e26", oddRowBackgroundColor: "#202226",
  fontFamily: '"Geist Variable", Geist, system-ui, sans-serif', fontSize: 12, headerFontWeight: 650,
  wrapperBorderRadius: 0,
});

function formatCell(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function OpenCompanyCell({ value, onOpenCompany }: ICellRendererParams<Record<string, unknown>> & { onOpenCompany: (pk: string) => void }) {
  if (value == null || value === "") return null;
  const pk = String(value);
  return <button type="button" className="chat-data-open" aria-label={`Open company ${pk}`} onClick={(event) => { event.stopPropagation(); onOpenCompany(pk); }}>{pk}</button>;
}

function csvValue(value: unknown) {
  const text = value == null || value === "" ? "" : typeof value === "string" && /^[\s]*[=+@-]/.test(value) ? `'${value}` : formatCell(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export default function DataTable({ rows, columns, label = "Data table", onOpenCompany, selectedCompanyIds, onSelectionChange, exportCompanyIds }: DataTableProps) {
  const { resolved } = useTheme();
  const gridRef = useRef<AgGridReact<Record<string, unknown>>>(null);
  const [query, setQuery] = useState("");
  const [visibleRows, setVisibleRows] = useState(rows.length);
  const reviewSelection = selectedCompanyIds !== undefined && onSelectionChange !== undefined;
  const selectionKey = reviewSelection ? [...selectedCompanyIds].sort().join("\u0000") : "";
  const syncingSelection = useRef(false);
  const updateCount = useCallback(({ api }: { api: GridApi<Record<string, unknown>> }) => setVisibleRows(api.getDisplayedRowCount()), []);
  const keys = useMemo(() => {
    const discovered = columns ? [...columns] : [...new Set(rows.flatMap((row) => Object.keys(row)))].sort((a, b) => a.localeCompare(b));
    const ordered: string[] = [];
    for (const key of ["index", "pk", ...discovered]) if (discovered.includes(key) && !ordered.includes(key)) ordered.push(key);
    return ordered;
  }, [columns, rows]);
  const hasPk = keys.includes("pk");
  const syncSelection = useCallback(({ api }: { api: GridApi<Record<string, unknown>> }) => {
    if (!reviewSelection || api.isDestroyed()) return;
    const selected = new Set(selectedCompanyIds ?? []);
    syncingSelection.current = true;
    try {
      api.forEachNode((node) => {
        const pk = node.data?.pk;
        if (pk == null) return;
        const shouldSelect = selected.has(String(pk));
        if (node.isSelected() !== shouldSelect) node.setSelected(shouldSelect);
      });
    } finally { syncingSelection.current = false; }
  }, [reviewSelection, selectionKey]);
  useEffect(() => {
    const api = gridRef.current?.api;
    if (api) syncSelection({ api });
  }, [syncSelection, rows]);
  const columnDefs = useMemo<ColDef<Record<string, unknown>>[]>(() => {
    const defs: ColDef<Record<string, unknown>>[] = keys.map((key) => ({
      colId: key,
      headerName: key,
      valueGetter: ({ data }) => data?.[key],
      valueFormatter: ({ value }) => formatCell(value),
      cellRenderer: key === "pk" && onOpenCompany ? OpenCompanyCell : undefined,
      cellRendererParams: key === "pk" && onOpenCompany ? { onOpenCompany } : undefined,
      filter: "agTextColumnFilter",
      comparator: (a, b) => {
        if (typeof a === "number" && typeof b === "number") return a - b;
        return formatCell(a).localeCompare(formatCell(b), undefined, { numeric: true, sensitivity: "base" });
      },
    }));
    return defs;
  }, [keys, onOpenCompany]);
  const downloadCsv = useCallback(() => {
    const api = gridRef.current?.api;
    if (!api) return;
    const lines = [keys.map(csvValue).join(",")];
    const exportIds = exportCompanyIds ? new Set(exportCompanyIds) : undefined;
    api.forEachNodeAfterFilterAndSort(({ data }) => {
      if (!data) return;
      if (exportIds && !exportIds.has(String(data.pk))) return;
      lines.push(keys.map((key) => csvValue(data[key])).join(","));
    });
    const blob = new Blob([`\uFEFF${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "data"}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [keys, label, exportCompanyIds]);

  return (
    <section className="chat-data-table" aria-label={label}>
      <div className="chat-data-toolbar">
        <label className="chat-data-search">
          <Search size={14} aria-hidden="true" />
          <span className="chat-data-visually-hidden">Search {label}</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search rows" />
        </label>
        <span className="chat-data-count" role="status" aria-live="polite">{visibleRows.toLocaleString()} of {rows.length.toLocaleString()} {rows.length === 1 ? "row" : "rows"}</span>
        <button type="button" className="chat-data-download" onClick={downloadCsv} disabled={!rows.length} aria-label={`Download ${label} as CSV`} title="Download CSV"><Download size={14} aria-hidden="true" /><span>CSV</span></button>
      </div>
      <div className="chat-data-grid" role="region" aria-label={`${label}${onOpenCompany && hasPk ? "; double-click a row or use its company ID to open details" : ""}`}>
        <AgGridProvider modules={modules}>
          <AgGridReact<Record<string, unknown>>
            ref={gridRef}
            rowData={rows}
            {...(reviewSelection ? {
              getRowId: ({ data }: { data: Record<string, unknown> }) => String(data.pk),
              rowSelection: { mode: "multiRow" as const, checkboxes: true, headerCheckbox: true, selectAll: "all" as const, enableClickSelection: false },
              onSelectionChanged: ({ api }: { api: GridApi<Record<string, unknown>> }) => {
                if (syncingSelection.current || api.isDestroyed()) return;
                const ids = api.getSelectedRows().filter(data => data.pk != null).map(data => String(data.pk));
                if ([...ids].sort().join("\u0000") !== selectionKey) onSelectionChange?.(ids);
              },
            } : {})}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            theme={resolved === "dark" ? darkTheme : lightTheme}
            quickFilterText={query}
            onGridReady={({ api }) => { updateCount({ api }); syncSelection({ api }); }}
            onRowDataUpdated={syncSelection}
            onFilterChanged={updateCount}
            onModelUpdated={updateCount}
            pagination
            paginationPageSize={25}
            paginationPageSizeSelector={pageSizes}
            rowHeight={34}
            headerHeight={36}
            rowBuffer={8}
            animateRows={false}
            suppressDragLeaveHidesColumns
            onRowDoubleClicked={({ data }) => {
              const pk = data?.pk;
              if (onOpenCompany && pk != null && pk !== "") onOpenCompany(String(pk));
            }}
            overlayNoRowsTemplate='<span class="chat-data-empty">No rows match this search or filter.</span>'
          />
        </AgGridProvider>
      </div>
    </section>
  );
}
