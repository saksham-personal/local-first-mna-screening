import type { DataSource, IdentitySources, ScreeningConfig } from "../lib/screening-contract";

/** Every source the setup dialog can offer, in picker order. */
export const SOURCE_ORDER: readonly DataSource[] = ["MID", "ISCC", "PB", "ROGO", "RESULTS", "BING"];
/** Company-detail sources in precedence order: name and website take the first selected source with a value. */
export const IDENTITY_ORDER: readonly DataSource[] = ["PB", "MID", "ISCC"];

/** The part of a ScreeningCatalog that says whether a source has data. A ScreeningCatalog fits as is. */
export type SourceSignals = {
  sources: readonly {
    source: DataSource;
    /** Run-wide: the source has been hydrated for this run. */
    hydrated?: boolean;
    /** Run-wide companies with a value. PB, ROGO and BING come from shortlist coverage. */
    companyCount?: number;
    fields?: readonly { count: number }[];
  }[];
};

function hasData(entry: SourceSignals["sources"][number]): boolean {
  if (typeof entry.hydrated === "boolean" || (typeof entry.companyCount === "number" && Number.isFinite(entry.companyCount))) {
    return entry.hydrated === true || (entry.companyCount ?? 0) > 0;
  }
  if (entry.fields?.length) return entry.fields.some((field) => field.count > 0);
  // No counts and no fields: nothing says the source is empty, so it stays visible.
  return true;
}

/** Sources the setup dialog may show for this catalog, in picker order. A source with no signal stays visible. */
export function availableSources(catalog: SourceSignals): DataSource[] {
  return SOURCE_ORDER.filter((source) => {
    const entry = catalog.sources.find((item) => item.source === source);
    return !entry || hasData(entry);
  });
}

/** The source a column draws on ("PB:Revenue" is PB). Index and identifier columns have none. */
export function columnSource(column: string): DataSource | undefined {
  const separator = column.indexOf(":");
  return SOURCE_ORDER.find((source) => separator > 0 && column.slice(0, separator) === source);
}

/**
 * Drops references to sources that are not available: identity sources and the input columns drawn
 * from them. This is silent by design, so a saved setup from an earlier catalog never throws.
 */
export function withAvailableSources(config: ScreeningConfig, available: readonly DataSource[]): ScreeningConfig {
  const identitySources = {} as IdentitySources;
  for (const key of ["name", "website", "description"] as const) {
    identitySources[key] = IDENTITY_ORDER.filter(
      (source) => available.includes(source) && config.identitySources[key].includes(source),
    );
  }
  return {
    ...config,
    identitySources,
    inputColumns: config.inputColumns.filter((column) => {
      const source = columnSource(column);
      return !source || available.includes(source);
    }),
  };
}
