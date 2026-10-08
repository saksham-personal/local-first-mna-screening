import type { GridCatalogColumn } from "../lib/grid-client";

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
  return visibleCatalogIds(catalog, saved).filter(id => !descriptionColumn(id));
}
