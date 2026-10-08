import { ExternalLink } from "lucide-react";
import type { DataGridColumn } from "../grid/DataGrid";
import type { GridCatalogColumn, GridCompany } from "../lib/grid-client";
import { KeywordTooltip, ScorePill, SemanticBar } from "./score-cells";
import { catalogGroups, descriptionColumn, groupLabels } from "./company-catalog";
import { DescriptionCell } from "./DescriptionTooltip";

function websiteUrl(value: string | null): string | undefined {
  if (!value?.trim()) return undefined;
  try { const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); return ["http:", "https:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
export function roundScoreId(key: string, column: string): string { return `round:${key}:score:${column}`; }
export function buildCompanyColumns(catalog: GridCatalogColumn[]): DataGridColumn<GridCompany>[] {
  return [...catalog].sort((a, b) => catalogGroups.indexOf(a.group) - catalogGroups.indexOf(b.group)).map(column => {
    const semantic = /MID[_ ]Semantic Score/.test(column.id);
    const keyword = column.id === "MID Score" || column.id === "MID_Keyword Score";
    const iscc = /ISCC[_ ]Score/.test(column.id);
    const company = column.id === "Company" || column.id === "Company Name";
    const description = descriptionColumn(column.id);
    const flag = column.group === "hydration" && column.id.endsWith("_hydrated");
    const spec: DataGridColumn<GridCompany> = {
      id: column.id, header: column.label, group: groupLabels[column.group], kind: column.type,
      hidden: !column.default_visible, pinned: company ? "left" : undefined,
      width: company ? 250 : description ? 280 : 165, minWidth: company ? 210 : 130,
      value: row => row.values?.[column.id] ?? null,
      ...(column.type === "score" ? { bucketScheme: keyword || iscc ? { type: "bins" as const, min: 0, max: 1, count: 10 } : semantic ? { type: "bins" as const, min: 0, max: 10, count: 10 } : { type: "integer" as const, min: 0, max: 10 } } : {}),
    };
    if (company) spec.render = row => {
      const href = websiteUrl(row.website);
      return <span className="ws-grid-company-cell"><span className="ws-grid-company-heading"><strong>{String(spec.value(row) ?? row.name)}</strong>{row.simulated && <span className="ws-simulated-badge">Simulated</span>}</span>{href && <a href={href} target="_blank" rel="noreferrer">{row.website}<ExternalLink size={11} /></a>}</span>;
    };
    else if (description) spec.render = row => <DescriptionCell row={row} columnId={column.id} />;
    else if (keyword) spec.render = row => <KeywordTooltip data={row.mid_keyword}>{spec.value(row) == null ? "?" : Number(spec.value(row)).toFixed(3)}</KeywordTooltip>;
    else if (semantic) spec.render = row => <SemanticBar value={spec.value(row) as number | null} />;
    else if (iscc) spec.render = row => <span>{spec.value(row) == null ? "?" : Number(spec.value(row)).toFixed(2)}</span>;
    else if (column.type === "score") spec.render = row => <ScorePill value={spec.value(row)} />;
    else if (flag) spec.render = row => <span className={`ws-grid-badge ${spec.value(row) === true ? "ws-grid-considered" : "ws-grid-hidden"}`}>{column.id.split("_")[0].toUpperCase()}: {spec.value(row) == null ? "?" : spec.value(row) ? "Available" : "Not available"}</span>;
    return spec;
  });
}
