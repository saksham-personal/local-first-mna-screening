import { sessionStore } from "./session-store";
import type { Company } from "./contracts";
import type { StagedFile } from "./chat-contract";
import { projectIdentity, usableText } from "./screening-data";
import {
  artifactBase,
  getChatState,
  patchArtifact,
  saveArtifact,
  updateChatState,
} from "./chat-store";

export type ToolResult = Record<string, unknown>;
export async function callTool(
  tool: string,
  args: ToolResult,
  options: { signal?: AbortSignal; analystApproved?: boolean } = {},
): Promise<ToolResult> {
  const response = await fetch("/api/tools", {
    method: "POST",
    signal: options.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tool,
      arguments: args,
      analystApproved: options.analystApproved,
    }),
  });
  const body = await response.json();
  if (!response.ok || body.ok === false)
    throw new Error(body.error ?? "The tool did not complete.");
  if (!body.result || typeof body.result !== "object")
    throw new Error("The tool returned an unreadable result.");
  return body.result;
}

export type SearchRow = {
  company: Record<string, unknown>;
  score?: number;
  rank?: number;
};
export function searchRows(result: ToolResult): SearchRow[] {
  if (!Array.isArray(result.results))
    throw new Error("The search did not return a company list.");
  return result.results.filter((row): row is SearchRow =>
    Boolean(
      row &&
        typeof row === "object" &&
        row.company &&
        typeof row.company.company_id === "string",
    ),
  );
}
export function companyFromRust(
  row: SearchRow,
  detail?: ToolResult,
  original?: Company,
): Company {
  const c = detail ?? row.company;
  const metadata =
    c.metadata && typeof c.metadata === "object"
      ? (c.metadata as ToolResult)
      : {};
  const identifiers = Array.isArray(c.identifiers)
    ? (c.identifiers as { kind: string; value: string }[])
    : [];
  const identifier = (kind: string) =>
    identifiers.find((item) => item.kind === kind)?.value ?? null;
  const value = (key: string) =>
    typeof c[key] === "string" ? (c[key] as string) : "";
  const name = value("name");
  const enriched =
    c.enrichment && typeof c.enrichment === "object"
      ? (c.enrichment as ToolResult)
      : c;
  const pk = value("company_id");
  const rawMid =
    original?.rawMid ??
    (original?.source === "ISCC"
      ? undefined
      : {
          "Company Name": name,
          Website: value("website"),
          Description: value("description"),
        });
  const rawIscc = original?.rawIscc;
  const pb = Object.fromEntries(
    Object.entries(enriched).filter(
      ([key, item]) => key.startsWith("PB_") && item != null,
    ),
  );
  const identity = projectIdentity({
    pk,
    PBId: identifier("PBID") ?? "",
    sources: { MID: rawMid ?? {}, ISCC: rawIscc ?? {}, PB: pb, ROGO: {} },
    provenance: {},
  });
  return {
    pk,
    ecid: identifier("ECID"),
    cid: identifier("CID"),
    name: identity.name,
    website: identity.website,
    city: value("city"),
    state: typeof metadata.hq_state === "string" ? metadata.hq_state : "",
    source: original?.source ?? "MID",
    description: identity.description,
    midScore: typeof row.score === "number" ? row.score : undefined,
    signal: "Needs research",
    tags: Array.isArray(c.keywords)
      ? c.keywords.filter((item): item is string => typeof item === "string")
      : [],
    pbId: identifier("PBID") ?? undefined,
    pbWebsite: usableText(enriched.PB_Website) || undefined,
    linkedin: usableText(enriched["PB_LinkedIn URL"]) || undefined,
    enrichment: Object.fromEntries(
      Object.entries(enriched).filter(
        ([key, item]) =>
          (key.startsWith("PB_") || key === "ROGO") && item != null,
      ),
    ),
    rawIscc,
    rawMid: rawMid
      ? {
          ...rawMid,
          "Company Name": rawMid["Company Name"] ?? name,
          Website: rawMid.Website ?? value("website"),
          Description: rawMid.Description ?? value("description"),
          ECID: identifier("ECID") ?? "",
          CID: identifier("CID") ?? "",
          "HQ City": value("city"),
          "HQ State":
            typeof metadata.hq_state === "string" ? metadata.hq_state : "",
        }
      : undefined,
  };
}

export async function stageUploads(
  files: File[],
  options: {
    sessionId: string;
    signal?: AbortSignal;
    workspaceMessage?: boolean;
  },
): Promise<StagedFile[]> {
  if (
    !files.length ||
    files.some((file) => !file.size || file.size > 20 * 1024 * 1024)
  )
    throw new Error("Choose nonempty files under 20 MB.");
  const payload = await Promise.all(
    files.map(
      (file) =>
        new Promise<{ name: string; base64: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () =>
            reject(new Error(`Could not read ${file.name}.`));
          reader.onload = () =>
            resolve({
              name: file.name,
              base64: String(reader.result).split(",")[1],
            });
          reader.readAsDataURL(file);
        }),
    ),
  );
  const staged = await fetch("/api/files", {
    method: "POST",
    signal: options.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files: payload }),
  });
  const parsed = await staged.json();
  if (!staged.ok)
    throw new Error(parsed.error ?? "Files could not be uploaded.");
  const stagedFiles = (parsed.files as StagedFile[]).map(file => ({ ...file, ...(file.importable ? { stagingStatus: "checking" as const, stagingMessage: "Identifying spreadsheet headers…" } : {}) }));
  const artifacts = stagedFiles.map((file) =>
    saveArtifact(options.sessionId, {
      ...artifactBase(file.name),
      type: "file",
      file,
      importStatus: "Uploaded",
    }),
  );
  updateChatState(options.sessionId, (state) => ({
    ...state,
    files: [...state.files, ...stagedFiles],
  }));
  if (stagedFiles.some(file => file.importable)) {
    window.dispatchEvent(new CustomEvent("screening:files-staged", { detail: { sessionId: options.sessionId } }));
    void import("./import-pipeline").then(({ processStagedUploads }) => processStagedUploads(options.sessionId));
  }
  if (options.workspaceMessage && stagedFiles.some(file => !file.importable)) {
    const messageId = crypto.randomUUID();
    updateChatState(options.sessionId, (state) => ({
      ...state,
      branchMessageIds: [...state.branchMessageIds, messageId],
    }));
    sessionStore.addEvent({
      sessionId: options.sessionId,
      messageId,
      kind: "message",
      role: "user",
      origin: "workspace",
      status: "success",
      title: "Files added in workspace",
      text: `Added ${stagedFiles.length} file${stagedFiles.length === 1 ? "" : "s"} in the workspace.`,
      content: [
        { type: "text", text: "Added files in the workspace." },
        ...artifacts.filter(artifact => artifact.type !== "file" || !artifact.file.importable).map((artifact) => ({
          type: "data",
          name: "screening-artifact",
          data: { artifactId: artifact.id },
        })),
      ],
    });
  }
  return stagedFiles;
}

export async function uploadEnrichmentFiles(
  files: File[],
  runId: string,
  options: { sessionId: string; signal?: AbortSignal },
): Promise<{ files: { name: string; status: string }[]; summary: string }> {
  if (files.some((file) => !/\.(csv|xlsx)$/i.test(file.name)))
    throw new Error("Choose CSV or XLSX files for company data.");
  const stagedFiles = await stageUploads(files, {
    ...options,
    workspaceMessage: true,
  });
  await (await import("./import-pipeline")).processStagedUploads(options.sessionId);
  const latest = getChatState(options.sessionId);
  const imported = latest.files.filter(file => stagedFiles.some(item => item.id === file.id));
  const errors = imported.filter(file => file.stagingStatus === "error" || file.stagingStatus === "unrecognized");
  if (errors.length) throw new Error(errors.map(file => `${file.name}: ${file.stagingMessage}`).join("\n"));
  if (latest.backendRunId !== runId) throw new Error("The screening changed. Open the original screening to view its files.");
  return { files: imported.map(file => ({ name: file.name, status: file.stagingMessage ?? "Staged" })), summary: "Company context refreshed. Use /data to view the current table." };
}
