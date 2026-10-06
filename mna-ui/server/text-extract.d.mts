export type StagedTextRecord = { name: string; path: string; bytes: number };

export function xmlText(xml: string): string;
export function zipExcerpt(bytes: Uint8Array, kind: string): string;
export function pdfExcerpt(bytes: Uint8Array): Promise<string>;
export function redact(text: string): string;
export function extractText(record: StagedTextRecord): Promise<{
  name: string;
  media_type: "text/plain";
  content: string;
}>;
