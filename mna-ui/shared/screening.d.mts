import type {
  ScreeningCatalog,
  ScreeningConfig,
  ScreeningMode,
  ScreeningProvider,
  ScreeningSourceRow,
  IdentitySources,
} from "../src/lib/screening-contract";
export const DEFAULT_INPUTS: string[];
export const SOURCES: string[];
export function usableText(value: unknown): string;
export function projectIdentity(
  row: ScreeningSourceRow,
  choices?: IdentitySources,
): { name: string; website: string; description: string };
export function buildCatalog(rows: ScreeningSourceRow[]): ScreeningCatalog;
export function suggestOutputColumns(
  request: string,
  mode: ScreeningMode,
): string[];
export function recommendedPrompt(
  mode: ScreeningMode,
  criteriaText: string,
  request: string,
  outputColumns: string[],
): string;
export function defaultScreeningConfig(
  provider: ScreeningProvider,
  mode: ScreeningMode,
  criteriaText: string,
  request?: string,
): ScreeningConfig;
export function validateConfig(
  config: unknown,
  catalog: ScreeningCatalog,
  requireModel?: boolean,
): ScreeningConfig;
export function projectRows(
  sourceRows: ScreeningSourceRow[],
  config: ScreeningConfig,
): Record<string, string | number>[];
export function markdownInputs(
  rows: Record<string, string | number>[],
  columns: string[],
): string;
