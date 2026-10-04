import type { Company } from "./contracts";
import type {
  PreparedScreening,
  ScreeningCatalog,
  ScreeningConfig,
  ScreeningPreview,
  ScreeningSourceRow,
} from "./screening-contract";
import {
  artifactBase,
  getChatState,
  mirrorWorkspace,
  saveArtifact,
  updateChatState,
} from "./chat-store";
import { sessionStore } from "./session-store";
import {
  callTool,
  uploadEnrichmentFiles,
  type ToolResult,
} from "./tool-client";
import { projectIdentity, usableText } from "./screening-data";

type Trace = {
  tool: string;
  args: unknown;
  result?: unknown;
  error?: string;
  startedAt: string;
  finishedAt: string;
  status: "success" | "error";
};
function recordCalls(sessionId: string, calls: Trace[]) {
  for (const call of calls)
    sessionStore.addEvent({
      sessionId,
      kind: "tool",
      origin: "workspace",
      status: call.status,
      title:
        call.tool === "get_candidate_source_data"
          ? "Read selected company sources"
          : call.tool === "save_checkpoint"
            ? "Save setup snapshot"
            : call.tool.replaceAll("_", " "),
      toolName: call.tool,
      args: call.args,
      result: call.result,
      error: call.error,
      startedAt: call.startedAt,
      finishedAt: call.finishedAt,
      durationMs: Math.max(
        0,
        Date.parse(call.finishedAt) - Date.parse(call.startedAt),
      ),
    });
}
async function request<T>(
  sessionId: string,
  route: string,
  input: unknown,
): Promise<T> {
  const response = await fetch(`/api/screening/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json();
  recordCalls(sessionId, Array.isArray(body.calls) ? body.calls : []);
  if (!response.ok)
    throw new Error(body.error ?? "The setup could not be prepared.");
  return body as T;
}
export async function getScreeningCatalog(
  sessionId: string,
  runId?: string,
): Promise<ScreeningCatalog> {
  return (
    await request<{ catalog: ScreeningCatalog }>(sessionId, "catalog", {
      runId,
    })
  ).catalog;
}
export async function previewScreening(
  sessionId: string,
  runId: string | undefined,
  config: ScreeningConfig,
): Promise<ScreeningPreview> {
  return (
    await request<{ preview: ScreeningPreview }>(sessionId, "preview", {
      runId,
      config,
    })
  ).preview;
}
export async function approveScreening(
  sessionId: string,
  runId: string | undefined,
  config: ScreeningConfig,
  preview: ScreeningPreview,
): Promise<PreparedScreening> {
  const { prepared } = await request<{ prepared: PreparedScreening }>(
    sessionId,
    "approve",
    { runId, config, fingerprint: preview.fingerprint, approved: true },
  );
  const existing = getChatState(sessionId).artifacts.find(
    (a) =>
      a.type === "screening-setup" &&
      a.prepared.fingerprint === prepared.fingerprint,
  );
  if (existing) return prepared;
  const artifact = saveArtifact(sessionId, {
    ...artifactBase(prepared.title),
    type: "screening-setup",
    prepared,
  });
  const messageId = crypto.randomUUID();
  updateChatState(sessionId, (state) => ({
    ...state,
    branchMessageIds: [...state.branchMessageIds, messageId],
  }));
  sessionStore.addEvent({
    sessionId,
    kind: "approval",
    origin: "workspace",
    status: "success",
    title: "Setup approved and saved",
    result: {
      setupId: prepared.id,
      fingerprint: prepared.fingerprint,
      provider: prepared.provider,
      mode: prepared.mode,
      executed: false,
      checkpoint: prepared.checkpoint,
    },
  });
  sessionStore.addEvent({
    sessionId,
    messageId,
    kind: "message",
    role: "assistant",
    origin: "workspace",
    status: "success",
    title: "Setup saved",
    text: "The setup and input snapshot are saved. No information was sent to a provider.",
    content: [
      {
        type: "text",
        text: "The setup and input snapshot are saved. No information was sent to a provider.",
      },
      {
        type: "data",
        name: "screening-artifact",
        data: { artifactId: artifact.id },
      },
    ],
  });
  return prepared;
}
function refreshCompany(company: Company, row: ScreeningSourceRow): Company {
  const identity = projectIdentity(row);
  const pb = row.sources.PB;
  const textRecord = (source: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(source).map(([key, value]) => [key, usableText(value)]),
    );
  const mid = Object.keys(row.sources.MID).length > 0,
    iscc = Object.keys(row.sources.ISCC).length > 0;
  return {
    ...company,
    name: identity.name,
    website: identity.website,
    description: identity.description,
    rawMid: mid ? textRecord(row.sources.MID) : undefined,
    rawIscc: iscc ? textRecord(row.sources.ISCC) : undefined,
    source: mid && iscc ? "both" : iscc ? "ISCC" : "MID",
    pbId: usableText(row.PBId) || undefined,
    pbWebsite: usableText(pb.PB_Website ?? pb.Website) || undefined,
    linkedin:
      usableText(pb["PB_LinkedIn URL"] ?? pb["LinkedIn URL"]) || undefined,
    enrichment: { ...pb, ROGO: row.sources.ROGO },
  };
}
export async function hydrateScreeningSources(
  sessionId: string,
  runId: string,
  files: File[],
): Promise<void> {
  const result = await uploadEnrichmentFiles(files, runId, { sessionId });
  const state = getChatState(sessionId);
  if (state.backendRunId !== runId)
    throw new Error(
      "The files were imported into their original screening. Open that screening to see the updated data.",
    );
  const updated = new Map<string, ScreeningSourceRow>();
  let cursor: string | undefined;
  let size = 100;
  do {
    const args: ToolResult = {
      run_id: runId,
      limit: size,
      ...(cursor ? { after_company_id: cursor } : {}),
    };
    const receipt = sessionStore.startTool("get_candidate_source_data", args, {
      sessionId,
      title: "Refresh company sources",
    });
    let page: ToolResult;
    try {
      page = await callTool("get_candidate_source_data", args);
      sessionStore.finishTool(receipt, {
        rows_returned: (page.rows as unknown[])?.length,
        total: page.total,
        next_cursor: page.next_cursor,
      });
    } catch (error) {
      sessionStore.finishTool(receipt, null, "error", String(error));
      if (size > 1 && /too large|exceeds|2 MB/i.test(String(error))) {
        size = Math.max(1, Math.floor(size / 2));
        continue;
      }
      throw error;
    }
    for (const row of page.rows as ScreeningSourceRow[])
      updated.set(row.pk, row);
    cursor =
      typeof page.next_cursor === "string" ? page.next_cursor : undefined;
  } while (cursor);
  const latest = getChatState(sessionId);
  if (latest.backendRunId !== runId) return;
  const companies = latest.companies.map((company) =>
    updated.has(company.pk)
      ? refreshCompany(company, updated.get(company.pk)!)
      : company,
  );
  const next = updateChatState(sessionId, { companies });
  mirrorWorkspace(next);
  const artifact = saveArtifact(sessionId, {
    ...artifactBase("Updated company data"),
    type: "companies",
    companies,
    counts: next.counts,
    backendRunId: runId,
    note: result.summary,
  });
  const messageId = crypto.randomUUID();
  updateChatState(sessionId, (s) => ({
    ...s,
    branchMessageIds: [...s.branchMessageIds, messageId],
  }));
  sessionStore.addEvent({
    sessionId,
    messageId,
    kind: "message",
    role: "assistant",
    origin: "workspace",
    status: "success",
    title: "Company data populated",
    text: result.summary,
    content: [
      { type: "text", text: result.summary },
      {
        type: "data",
        name: "screening-artifact",
        data: { artifactId: artifact.id },
      },
    ],
  });
}
