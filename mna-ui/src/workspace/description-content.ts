import type { GridDescription } from "../lib/grid-client";

export function descriptionSections(description: GridDescription | undefined) {
  const sources = description?.sources ?? [];
  return sources.map(source => ({
    heading: sources.length > 1 ? `${source.source} DESCRIPTION` : undefined,
    items: source.items.filter(item => item.text.trim()).map(item => ({
      label: item.label.replace(/^(MID|ISCC)[_ ]/i, "").replace(/:$/, ""), text: item.text,
    })),
  }));
}
export function descriptionPreview(description: GridDescription | undefined, columnId: string): string | undefined {
  const label = columnId.replace(/^(MID|ISCC)[_ ]/i, "");
  const items = descriptionSections(description).flatMap(section => section.items);
  return items.find(item => item.label === label)?.text ?? items[0]?.text;
}
