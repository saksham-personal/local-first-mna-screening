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
  const stagedFiles = parsed.files as StagedFile[];
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
  if (options.workspaceMessage) {
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
        ...artifacts.map((artifact) => ({
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
  const fileArtifacts = getChatState(options.sessionId).artifacts.filter(
    (a) =>
      a.type === "file" && stagedFiles.some((file) => file.id === a.file.id),
  );
  const args = { run_id: runId, files: stagedFiles.map((file) => file.id) };
  const receipt = sessionStore.startTool("import_enrichment_files", args, {
    sessionId: options.sessionId,
    origin: "workspace",
    title: "Import company data",
  });
  try {
    const result = await callTool("import_enrichment_files", args, {
      signal: options.signal,
    });
    sessionStore.finishTool(receipt, result);
    fileArtifacts.forEach((artifact) =>
      patchArtifact(options.sessionId, artifact.id, {
        importStatus: "Imported",
      }),
    );
    const summary = `Imported ${files.length} file${files.length === 1 ? "" : "s"}: ${result.mapping_unique_companies ?? 0} PitchBook IDs, ${result.pb_unique_companies ?? 0} PitchBook records, ${result.rogo_unique_companies ?? 0} ROGO records. ${Number(result.pb_unmatched ?? 0) + Number(result.rogo_unmatched ?? 0)} rows could not be matched.`;
    return {
      files: files.map((file) => ({ name: file.name, status: "Imported" })),
      summary,
    };
  } catch (error) {
    fileArtifacts.forEach((artifact) =>
      patchArtifact(options.sessionId, artifact.id, {
        importStatus: options.signal?.aborted
          ? "Import stopped"
          : "Import failed",
      }),
    );
    sessionStore.finishTool(
      receipt,
      null,
      options.signal?.aborted ? "cancelled" : "error",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
