import type { Company, ExportKind, FunnelCounts } from "./contracts";
import type {
  PreparedScreening,
  ScreeningMode,
  ScreeningProvider,
} from "./screening-contract";

export type StagedFile = {
  id: string;
  name: string;
  bytes: number;
  kind: string;
  parseKind?: string;
  importable?: boolean;
  excerpt?: string;
  sourceKinds?: string[];
  stagingStatus?: "checking" | "waiting" | "importing" | "imported" | "unrecognized" | "error";
  stagingMessage?: string;
  hydratedScope?: string;
};
export type ResearchStep = "pitchbook" | "rogo" | "bing" | "llm" | "copilot";
type ArtifactBase = { id: string; title: string; createdAt: string };
export type ChatArtifact = ArtifactBase &
  (
    | {
        type: "screening-request";
        provider: ScreeningProvider;
        mode: ScreeningMode;
        request: string;
      }
    | { type: "screening-setup"; prepared: PreparedScreening }
    | { type: "file"; file: StagedFile; importStatus?: string }
    | { type: "data-table"; rows: Record<string, unknown>[]; columns: string[]; note?: string; planId?: string }
    | {
        type: "criteria";
        criteriaText: string;
        definition: string;
        ignored: string[];
        revision: number;
        decision: "pending" | "approved" | "declined";
      }
    | {
        type: "companies";
        companies: Company[];
        counts: FunnelCounts;
        backendRunId: string;
        note?: string;
      }
    | {
        type: "options";
        recommended: ResearchStep;
        options: {
          id: ResearchStep;
          label: string;
          description: string;
          available: boolean;
        }[];
        selected?: ResearchStep[];
        dismissed?: boolean;
      }
    | {
        type: "plan";
        steps: {
          id: string;
          label: string;
          status: "pending" | "running" | "done" | "error";
          detail?: string;
        }[];
        diagram: string;
      }
    | {
        type: "research";
        questions: string[];
        state: "draft" | "unavailable" | "completed";
        planId?: string;
        stepId?: string;
        companies?: { name: string; website: string }[];
      }
    | {
        type: "memory";
        entries: {
          title: string;
          text: string;
          source: string;
          companyId?: string;
        }[];
      }
    | {
        type: "job";
        jobId: string;
        state: "running" | "completed" | "cancelled" | "error";
        detail?: string;
      }
    | { type: "checkpoint"; key: string; backendRunId: string; summary: string }
    | {
        type: "handoff";
        service: string;
        detail: string;
        state: "awaiting-files" | "unavailable" | "complete";
      }
  );
export type ArtifactAction =
  | {
      type: "configure-screening";
      artifactId: string;
      provider: ScreeningProvider;
      mode: ScreeningMode;
      request?: string;
    }
  | {
      type:
        | "approve-criteria"
        | "edit-criteria"
        | "decline-criteria"
        | "upload"
        | "open-log"
        | "inspect-checkpoint"
        | "dismiss-options";
      artifactId: string;
    }
  | { type: "export"; artifactId: string; format: ExportKind }
  | { type: "preview-file"; artifactId: string }
  | { type: "start-screening" | "run-research"; artifactId: string }
  | { type: "choose-option"; artifactId: string; option: ResearchStep }
  | { type: "inspect-company"; artifactId: string; companyId: string }
  | { type: "stop-job"; artifactId: string; jobId: string };
export type ChatState = {
  version: 1;
  sessionId: string;
  criteriaText: string;
  definition: string;
  revision: number;
  approvedRevision?: number;
  ignored: string[];
  artifacts: ChatArtifact[];
  companies: Company[];
  counts: FunnelCounts;
  backendRunId?: string;
  jobId?: string;
  files: StagedFile[];
  model: "local";
  branchMessageIds: string[];
  jobContext?: {
    id: string;
    revision: number;
    turnId: string;
    messageId: string;
    startedAt?: string;
  };
  criteriaMessageId?: string;
};
export type JobEvent = {
  id: string;
  type: "tool-start" | "tool-result" | "tool-error";
  tool: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  timestamp: string;
};
export type JobSnapshot = {
  id: string;
  sessionId: string;
  state: "running" | "completed" | "cancelled" | "error";
  startedAt: string;
  finishedAt?: string;
  events: JobEvent[];
  error?: string;
  result?: {
    backendRunId: string;
    companies: {
      row: { company: Record<string, unknown>; score?: number; rank?: number };
      detail: Record<string, unknown>;
      sourceRows: Record<string, unknown>[];
    }[];
    counts: { midOnly: number; isccOnly: number; both: number };
  };
};
