import type { IncomingMessage, ServerResponse } from "node:http";
import type { ScreeningPromptInput } from "../shared/screening.mjs";

export const PUBLIC_PROMPTS: Set<string>;
export function screeningDraftInput(input: unknown): ScreeningPromptInput;
export function routePrompt(request: {
  method?: string;
  pathname: string;
  input?: unknown;
}): { status: number; payload: Record<string, unknown> } | undefined;
export function handlePromptRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  helpers: {
    respond: (res: ServerResponse, status: number, payload: unknown) => void;
    body: (req: IncomingMessage) => Promise<unknown>;
  },
): Promise<boolean>;
