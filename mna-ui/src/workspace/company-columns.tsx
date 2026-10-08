import { ExternalLink } from "lucide-react";
import type { DataGridColumn } from "../grid/DataGrid";
import type { GridCatalogColumn, GridCompany } from "../lib/grid-client";
import { KeywordTooltip, ScorePill, SemanticBar } from "./score-cells";
import { catalogColumnSpecs, descriptionColumn, hydrationFlag, pageDescriptionColumn } from "./company-catalog";
import { DescriptionCell } from "./DescriptionTooltip";

function websiteUrl(value: string | null): string | undefined {
  if (!value?.trim()) return undefined;
  try { const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); return ["http:", "https:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
export function roundScoreId(key: string, column: string): string { return `round:${key}:score:${column}`; }
export function buildCompanyColumns(catalog: GridCatalogColumn[]): DataGridColumn<GridCompany>[] {
  const specs = catalogColumnSpecs(catalog);
  return specs.map(base => {
    const column = catalog.find(column => column.id === base.id)!;
    const semantic = /MID[_ ]Semantic Score/.test(column.id);
    const keyword = column.id === "MID Score" || column.id === "MID_Keyword Score";
    const iscc = /ISCC[_ ]Score/.test(column.id);
    const company = column.id === "Company" || column.id === "Company Name";
    const description = pageDescriptionColumn(column);
    const flag = column.group === "hydration" && column.id.endsWith("_hydrated");
    const spec: DataGridColumn<GridCompany> = base;
    if (company) spec.render = row => {
      const href = websiteUrl(row.website);
      return <span className="ws-grid-company-cell"><span className="ws-grid-company-heading"><strong>{String(spec.value(row) ?? row.name)}</strong>{row.simulated && <span className="ws-simulated-badge">Simulated</span>}</span>{href && <a href={href} target="_blank" rel="noreferrer">{row.website}<ExternalLink size={11} /></a>}</span>;
    };
    else if (description) spec.render = row => <DescriptionCell row={row} columnId={column.id} source={column.source} />;
    else if (keyword) spec.render = row => <KeywordTooltip data={row.mid_keyword}>{spec.value(row) == null ? "—" : Number(spec.value(row)).toFixed(3)}</KeywordTooltip>;
    else if (semantic) spec.render = row => <SemanticBar value={spec.value(row) as number | null} />;
    else if (iscc) spec.render = row => <span>{spec.value(row) == null ? "—" : Number(spec.value(row)).toFixed(2)}</span>;
    else if (column.type === "score") spec.render = row => <ScorePill value={spec.value(row)} />;
    else if (flag) spec.render = row => {
      const hydrated = hydrationFlag(spec.value(row));
      return <span className={`ws-grid-badge ${hydrated === true ? "ws-grid-considered" : "ws-grid-hidden"}`}>{column.id.split("_")[0].toUpperCase()}: {hydrated == null ? "—" : hydrated ? "Available" : "Not available"}</span>;
    };
    else if (column.id === "considered") spec.render = row => <span className={`ws-grid-badge ${row.considered ? "ws-grid-considered" : "ws-grid-hidden"}`}>{row.considered ? "Considered" : "Hidden"}</span>;
    else if (column.id === "source") spec.render = row => <span className="ws-grid-badge ws-grid-source">{row.source === "both" ? "MID + ISCC" : row.source ?? "—"}</span>;
    else if (descriptionColumn(column.id)) spec.render = row => <span className="ws-grid-description" title={String(spec.value(row) ?? "")}>{String(spec.value(row) ?? "—")}</span>;
    return spec;
  });
}
