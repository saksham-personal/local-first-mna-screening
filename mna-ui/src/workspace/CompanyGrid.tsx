import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  AllCommunityModule,
  themeQuartz,
  type ColDef,
  type GetRowIdParams,
  type GridApi,
  type ICellRendererParams,
} from "ag-grid-community";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import type { Company, Source } from "../lib/contracts";
import { useTheme } from "../lib/theme-store";
import "./company-grid.css";

type CompanyGridProps = {
  companies: Company[];
  selectedId?: string;
  onSelect: (company: Company) => void;
  onFilteredCount?: (count: number) => void;
};

type NameCellParams = ICellRendererParams<Company> & {
  onOpen: (company: Company) => void;
};

const modules = [AllCommunityModule];
const defaultColDef: ColDef<Company> = {
  sortable: true,
  resizable: true,
  filter: true,
};
const pageSizes = [25, 50, 100];
const rowSelection = {
  mode: "singleRow",
  checkboxes: false,
  enableClickSelection: "enableSelection",
} as const;
const getRowId = ({ data }: GetRowIdParams<Company>) => data.pk;

const lightTheme = themeQuartz.withParams({
  accentColor: "#8f5a39",
  backgroundColor: "#ffffff",
  foregroundColor: "#252a30",
  borderColor: "#e0e2de",
  headerBackgroundColor: "#f2f3f1",
  headerTextColor: "#676c73",
  rowHoverColor: "#f7f2ee",
  selectedRowBackgroundColor: "#f4e9e1",
  oddRowBackgroundColor: "#ffffff",
  fontFamily: '"Geist Variable", Geist, system-ui, sans-serif',
  fontSize: 13,
  headerFontWeight: 650,
  wrapperBorderRadius: 0,
});

const darkTheme = themeQuartz.withParams({
  accentColor: "#d7a17c",
  backgroundColor: "#202226",
  foregroundColor: "#eeeae6",
  borderColor: "#363a3e",
  headerBackgroundColor: "#272a2e",
  headerTextColor: "#b3b1af",
  rowHoverColor: "#302b28",
  selectedRowBackgroundColor: "#3a2e26",
  oddRowBackgroundColor: "#202226",
  fontFamily: '"Geist Variable", Geist, system-ui, sans-serif',
  fontSize: 13,
  headerFontWeight: 650,
  wrapperBorderRadius: 0,
});

function sourceLabel(source: Source): string {
  return source === "both" ? "MID + ISCC" : source;
}

function NameCell({ data, onOpen }: NameCellParams) {
  if (!data) return null;
  return (
    <div className="mna-grid-company">
      <button
        type="button"
        className="mna-grid-company-name"
        aria-label={`Open details for ${data.name}`}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onOpen(data);
        }}
      >
        {data.name}
      </button>
      <span className="mna-grid-company-description" title={data.description}>
        {data.description || "No business description"}
      </span>
    </div>
  );
}

function SourceCell({ data }: ICellRendererParams<Company>) {
  if (!data) return null;
  return (
    <span className={`mna-grid-source mna-grid-source-${data.source}`}>
      {sourceLabel(data.source)}
    </span>
  );
}

const scoreFormatter = ({ value }: { value: number | null | undefined }) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";

export default function CompanyGrid({
  companies,
  selectedId,
  onSelect,
  onFilteredCount,
}: CompanyGridProps) {
  const { resolved } = useTheme();
  const gridRef = useRef<AgGridReact<Company>>(null);

  const columnDefs = useMemo<ColDef<Company>[]>(
    () => [
      {
        colId: "company",
        headerName: "Company",
        field: "name",
        minWidth: 300,
        flex: 1,
        filter: "agTextColumnFilter",
        filterValueGetter: ({ data }) =>
          data ? `${data.name} ${data.description}` : "",
        cellRenderer: NameCell,
        cellRendererParams: { onOpen: onSelect },
        cellClass: "mna-grid-company-cell",
        tooltipValueGetter: ({ data }) => data?.description || undefined,
      },
      {
        field: "source",
        headerName: "Source",
        width: 110,
        minWidth: 100,
        filter: "agTextColumnFilter",
        filterValueGetter: ({ data }) => (data ? sourceLabel(data.source) : ""),
        cellRenderer: SourceCell,
      },
      {
        colId: "headquarters",
        headerName: "HQ location",
        width: 160,
        minWidth: 130,
        valueGetter: ({ data }) =>
          data ? [data.city, data.state].filter(Boolean).join(", ") : "",
        valueFormatter: ({ value }) => value || "—",
        filter: "agTextColumnFilter",
      },
      {
        field: "midScore",
        headerName: "MID score",
        width: 120,
        minWidth: 114,
        filter: "agNumberColumnFilter",
        cellDataType: "number",
        valueFormatter: scoreFormatter,
        cellClass: "mna-grid-score",
        headerTooltip: "MID score; separate from ISCC score",
      },
      {
        field: "isccScore",
        headerName: "ISCC score",
        width: 120,
        minWidth: 114,
        filter: "agNumberColumnFilter",
        cellDataType: "number",
        valueFormatter: scoreFormatter,
        cellClass: "mna-grid-score",
        headerTooltip: "ISCC score; separate from MID score",
      },
    ],
    [onSelect],
  );

  const syncSelection = useCallback(
    (api: GridApi<Company>) => {
      const target = selectedId ? api.getRowNode(selectedId) : undefined;
      const current = api.getSelectedNodes()[0];
      if (current?.id === target?.id) return;
      api.deselectAll();
      target?.setSelected(true);
    },
    [selectedId],
  );

  useEffect(() => {
    if (gridRef.current?.api) syncSelection(gridRef.current.api);
  }, [companies, syncSelection]);

  return (
    <div
      className="mna-company-grid"
      aria-label="Companies in the current screening"
    >
      <AgGridProvider modules={modules}>
        <AgGridReact<Company>
          ref={gridRef}
          rowData={companies}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={getRowId}
          theme={resolved === "dark" ? darkTheme : lightTheme}
          rowHeight={66}
          headerHeight={42}
          rowBuffer={8}
          animateRows={false}
          pagination
          paginationPageSize={50}
          paginationPageSizeSelector={pageSizes}
          rowSelection={rowSelection}
          onGridReady={({ api }) => syncSelection(api)}
          onRowDataUpdated={({ api }) => syncSelection(api)}
          onModelUpdated={({ api }) =>
            onFilteredCount?.(api.getDisplayedRowCount())
          }
          onSelectionChanged={(event) => {
            if (event.source !== "rowClicked" && event.source !== "spaceKey")
              return;
            const company = event.selectedNodes?.[0]?.data;
            if (company) onSelect(company);
          }}
          onCellKeyDown={(event) => {
            const keyEvent = event.event;
            if (
              !(keyEvent instanceof KeyboardEvent) ||
              keyEvent.key !== "Enter"
            )
              return;
            if (keyEvent.target instanceof HTMLButtonElement) return;
            if (event.data) onSelect(event.data);
          }}
          overlayNoRowsTemplate='<span class="mna-grid-empty">No companies match the current filters.</span>'
          suppressDragLeaveHidesColumns
        />
      </AgGridProvider>
    </div>
  );
}
