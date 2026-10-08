import type { GridCatalogColumn, GridCompany, GridDescription } from "../lib/grid-client";
import { pageDescriptionColumn } from "./company-catalog";

export function descriptionSections(description: GridDescription | undefined) {
  const sources = [...(description?.sources ?? [])].sort((a, b) => Number(a.source === "ISCC") - Number(b.source === "ISCC"));
  return sources.map(source => ({
    heading: sources.length > 1 ? `${source.source} DESCRIPTION` : undefined,
    items: source.items.filter(item => item.text.trim() && item.text.trim() !== "-").map(item => ({
      label: item.label.replace(/^(MID|ISCC)[_ ]/i, "").replace(/:$/, ""), text: item.text,
    })),
  }));
}
export function descriptionPreview(description: GridDescription | undefined, columnId: string, source?: string): string | undefined {
  const label = columnId.replace(/^(MID|ISCC)[_ ]/i, "");
  const sourceId = /^(MID|ISCC)[_ ]/i.exec(columnId)?.[1] ?? (/^(mid|iscc)$/i.test(source ?? "") ? source : undefined);
  const selected = sourceId ? { company_id: description?.company_id ?? "", sources: (description?.sources ?? []).filter(item => item.source === sourceId.toUpperCase()) } : description;
  const items = descriptionSections(selected).flatMap(section => section.items);
  return items.find(item => item.label === label)?.text;
}

// Give sorting and filtering the same page-cached text that the cell displays.
// The catalog/column definitions stay stable as descriptions arrive.
export function withDescriptionValues(row: GridCompany, catalog: GridCatalogColumn[], description: GridDescription | undefined): GridCompany {
  if (!description) return row;
  const values = { ...row.values };
  for (const column of catalog) {
    if (pageDescriptionColumn(column)) values[column.id] = descriptionPreview(description, column.id, column.source) ?? null;
  }
  return { ...row, values };
}
