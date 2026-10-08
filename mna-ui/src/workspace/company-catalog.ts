import type { GridCatalogColumn } from "../lib/grid-client";
import type { GridColumnSpec } from "../grid/grid-types";
import type { GridCompany } from "../lib/grid-client";

export const catalogGroups = ["identity", "scores", "coverage", "hydration", "mid", "iscc", "rounds", "status"] as const;
export const groupLabels: Record<GridCatalogColumn["group"], string> = { identity: "Identity", scores: "Scores", coverage: "Coverage", hydration: "Hydration", mid: "MID", iscc: "ISCC", rounds: "Rounds", status: "Status" };
export type ColumnChoice = { visible: string[]; known: string[] };
export function readColumnChoice(raw: string | null): ColumnChoice | undefined {
  try {
    const value = JSON.parse(raw ?? "null");
    return value && Array.isArray(value.visible) && Array.isArray(value.known) && [...value.visible, ...value.known].every(id => typeof id === "string") ? value : undefined;
  } catch { return undefined; }
}
export function visibleCatalogIds(catalog: GridCatalogColumn[], saved?: ColumnChoice): string[] {
  return catalog.filter(column => saved ? saved.visible.includes(column.id) || (!saved.known.includes(column.id) && column.default_visible) : column.default_visible).map(column => column.id);
}
export function descriptionColumn(id: string): boolean { return /description/i.test(id); }
// Descriptions are loaded separately for the page, never included in every grid request.
export function requestedCatalogIds(catalog: GridCatalogColumn[], saved?: ColumnChoice): string[] {
  const visible = new Set(visibleCatalogIds(catalog, saved));
  return catalog.filter(column => visible.has(column.id) && !pageDescriptionColumn(column)).map(column => column.id);
}

// The page-description endpoint contains MID/ISCC text; hydration text stays in values.
export function pageDescriptionColumn(column: GridCatalogColumn): boolean {
  return column.group !== "hydration" && descriptionColumn(column.id);
}

export function catalogColumnSpecs(catalog: GridCatalogColumn[]): GridColumnSpec<GridCompany>[] {
  return [...catalog].sort((a, b) => catalogGroups.indexOf(a.group) - catalogGroups.indexOf(b.group)).map(column => {
    const company = column.id === "Company" || column.id === "Company Name";
    const semantic = /MID[_ ]Semantic Score/.test(column.id);
    const unitScore = ["MID Score", "MID_Keyword Score", "ISCC Score", "ISCC_Score"].includes(column.id);
    return {
      id: column.id, header: column.label, group: groupLabels[column.group], kind: column.type,
      hidden: !column.default_visible, pinned: company ? "left" : undefined,
      width: company ? 250 : descriptionColumn(column.id) ? 280 : 165, minWidth: company ? 210 : 130,
      value: row => row.values?.[column.id] ?? null,
      ...(column.type === "score" ? { bucketScheme: unitScore ? { type: "bins" as const, min: 0, max: 1, count: 10 } : semantic ? { type: "bins" as const, min: 0, max: 10, count: 10 } : { type: "integer" as const, min: 0, max: 10 } } : {}),
    };
  });
}
