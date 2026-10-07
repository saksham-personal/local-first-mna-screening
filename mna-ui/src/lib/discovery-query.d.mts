export function discoveryDefinition(definition: string): { positive: string; exclusions: string[] };
export function qualitativeQuery(definition: string): string;
export function discoveryQueries(definition: string): string[];
export type MidKeyword = { id: string; text: string; weight: number; match: "stem" | "exact" };
export function midKeywordPlan(definition: string, exclusions?: string[]): { rationale: string; keywords: MidKeyword[]; expression: string }[];
