import type { ExtractedIntakeFields } from '../shared/intake-extract.mjs';

export type IntakeStagedFile = {
  id: string;
  name: string;
  bytes: number;
  path: string;
  purpose?: string;
};
export type IntakeRouteResult = {
  text: string;
  fields: ExtractedIntakeFields;
  matched: string[];
  fileId: string;
  fileName: string;
};

export function routeIntake(input: unknown, stagedFiles: Map<string, IntakeStagedFile>): Promise<IntakeRouteResult>;
export function handleIntakeRoute(
  req: { method?: string; headers: Record<string, string | string[] | undefined> },
  res: unknown,
  url: URL,
  context: {
    respond: (res: unknown, status: number, payload: unknown) => unknown;
    body: (req: unknown) => Promise<unknown>;
    stagedFiles: Map<string, IntakeStagedFile>;
  },
): Promise<boolean>;
