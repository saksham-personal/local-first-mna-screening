import type { Company, FunnelCounts } from './contracts';
export type Stage = 'criteria' | 'discovery' | 'enrichment' | 'screening';
export type ResearchAction = 'pitchbook' | 'rogo' | 'bing' | 'llm' | 'copilot';
export type AssistantContext = {
  sessionId: string;
  title: string;
  stage: Stage;
  criteriaApproved: boolean;
  mandate: string;
  definition: string;
  counts: FunnelCounts;
  plan: ResearchAction[];
  bingQuery: string;
  backendRunId?: string;
  companies?: Company[];
};
export type WorkspaceAction =
  | { type: 'navigate'; stage: Stage }
  | { type: 'plan'; actions: ResearchAction[] }
  | { type: 'broaden'; amount: number }
  | { type: 'export' }
  | { type: 'session-log' }
  | { type: 'example-results'; companies: Company[]; counts: FunnelCounts; backendRunId: string };
