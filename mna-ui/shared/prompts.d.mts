export const START_MARKER: string;
export const END_MARKER: string;
export type PromptErrorCode =
  | "bad_marker"
  | "missing_marker"
  | "duplicate_marker"
  | "bad_header"
  | "bad_inputs"
  | "bad_placeholder"
  | "undeclared_placeholder"
  | "unused_input"
  | "unbalanced_section"
  | "section_depth"
  | "missing_input"
  | "unknown_input"
  | "bad_value"
  | "bad_id"
  | "not_found";
export class PromptError extends Error {
  constructor(code: PromptErrorCode, message: string, location?: { file?: string; line?: number });
  code: PromptErrorCode;
  file?: string;
  line?: number;
}
export type PromptInput = { name: string; required: boolean; description: string };
export type PromptMetadata = {
  id: string;
  title: string;
  summary: string;
  description: string;
  context: string;
  inputs: PromptInput[];
  output: string;
  suppliedTo: string;
  version: number;
  file: string;
};
export type ParsedPrompt = PromptMetadata & { body: string; contentHash: string };
export type PromptVars = Record<string, string | number | null | undefined>;
export type RenderedPrompt = { prompt: string; promptId: string; promptVersion: number; promptHash: string };
export function parsePromptFile(text: string, file?: string): ParsedPrompt;
export function renderParsedPrompt(prompt: ParsedPrompt, vars?: PromptVars): string;
export function promptsDir(): string;
export function clearPromptCache(): void;
export function loadPrompt(id: string): ParsedPrompt;
export function renderPrompt(id: string, vars?: PromptVars): string;
export function renderPromptResult(id: string, vars?: PromptVars): RenderedPrompt;
export function listPrompts(): PromptMetadata[];
export function renderScreeningPrompt(input: import("./screening.mjs").ScreeningPromptInput): RenderedPrompt;
