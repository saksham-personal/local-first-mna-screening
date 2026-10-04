import { strToU8, zipSync } from "fflate";
import type {
  LogFormat,
  ResearchSession,
  SessionEvent,
} from "./session-contract";

type ExportResult = { bytes: Uint8Array; mime: string; filename: string };

function safePart(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/-+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 64)
      .toLowerCase() || "session"
  );
}

function safeAttachmentName(name: string): string {
  const extension = /\.[a-z0-9]{1,12}$/i.exec(name)?.[0] ?? "";
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${safePart(stem)}${extension.toLowerCase()}`;
}

function jsonl(session: ResearchSession): string {
  const lines = [
    JSON.stringify({
      type: "session",
      schemaVersion: 1,
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
    }),
  ];
  for (const event of session.events)
    lines.push(JSON.stringify({ type: "event", ...event }));
  return `${lines.join("\n")}\n`;
}

function jsonFence(value: unknown): string {
  const json = JSON.stringify(value ?? null, null, 2);
  const longest = Math.max(
    0,
    ...Array.from(json.matchAll(/`+/g), (m) => m[0].length),
  );
  return `${"`".repeat(Math.max(3, longest + 1))}json\n${json}\n${"`".repeat(Math.max(3, longest + 1))}`;
}

function markdown(session: ResearchSession): string {
  const out = [
    `# ${session.title}`,
    "",
    `- Session ID: ${session.id}`,
    `- Created: ${session.createdAt}`,
    `- Events: ${session.events.length}`,
    "",
    "## Timeline",
    "",
  ];
  for (const event of session.events) {
    const when = event.startedAt;
    out.push(
      `### ${event.sequence}. ${event.title}`,
      "",
      `- Time: ${when}`,
      `- Kind: ${event.kind} · Status: ${event.status}${event.durationMs !== undefined ? ` · Duration: ${event.durationMs} ms` : ""}`,
    );
    if (event.turnId) out.push(`- Turn: ${event.turnId}`);
    if (event.role) out.push(`- Role: ${event.role}`);
    if (event.toolName) out.push(`- Tool: ${event.toolName}`);
    if (event.error) out.push(`- Error: ${event.error}`);
    if (event.text !== undefined) out.push("", event.text);
    if (event.content !== undefined)
      out.push("", "Content:", "", jsonFence(event.content));
    if (event.args !== undefined)
      out.push("", "Arguments:", "", jsonFence(event.args));
    if (event.result !== undefined)
      out.push("", "Result:", "", jsonFence(event.result));
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

export function buildSessionExport(
  session: ResearchSession,
  format: LogFormat,
): ExportResult {
  const basename = `${safePart(session.title)}-${safePart(session.id)}`;
  if (format === "jsonl")
    return {
      bytes: strToU8(jsonl(session)),
      mime: "application/x-ndjson;charset=utf-8",
      filename: `${basename}.jsonl`,
    };
  if (format === "markdown")
    return {
      bytes: strToU8(markdown(session)),
      mime: "text/markdown;charset=utf-8",
      filename: `${basename}.md`,
    };
  const transcript = markdown(session);
  const log = jsonl(session);
  const manifest = {
    schemaVersion: 1,
    session: {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
    },
    counts: {
      events: session.events.length,
      tools: session.events.filter((e) => e.kind === "tool").length,
      messages: session.events.filter((e) => e.kind === "message").length,
      approvals: session.events.filter((e) => e.kind === "approval").length,
      artifacts: session.events.filter((e) => e.kind === "artifact").length,
    },
    attachments: {
      included: false,
      note: "Attachment bytes are not stored in the session log; artifact metadata remains in session.jsonl.",
    },
  };
  const bytes = zipSync({
    "README.md": strToU8(
      `# ${session.title}\n\nScreening session export. Includes the complete event history, including tool arguments and results. Original upload bytes are kept on the local tool server and are not included in this log.\n`,
    ),
    "session.jsonl": strToU8(log),
    "transcript.md": strToU8(transcript),
    "manifest.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
  });
  return { bytes, mime: "application/zip", filename: `${basename}.zip` };
}

export function downloadSessionLog(
  session: ResearchSession,
  format: LogFormat,
): void {
  downloadExport(buildSessionExport(session, format));
}

export function downloadExport(exported: ExportResult): void {
  const buffer = new ArrayBuffer(exported.bytes.byteLength);
  new Uint8Array(buffer).set(exported.bytes);
  const blob = new Blob([buffer], { type: exported.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exported.filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Attachment references come only from declared file artifacts, never from tool paths. */
export function declaredSessionFiles(
  session: ResearchSession,
): { id: string; name: string; bytes: number }[] {
  const files = new Map<string, { id: string; name: string; bytes: number }>();
  for (const event of session.events) {
    if (
      event.kind !== "artifact" ||
      !event.result ||
      typeof event.result !== "object"
    )
      continue;
    const artifact = event.result as {
      type?: string;
      file?: { id?: unknown; name?: unknown; bytes?: unknown };
    };
    const file = artifact.file;
    if (
      artifact.type === "file" &&
      file &&
      typeof file.id === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file.id) &&
      typeof file.name === "string" &&
      typeof file.bytes === "number" &&
      Number.isSafeInteger(file.bytes) &&
      file.bytes >= 0
    )
      files.set(file.id, { id: file.id, name: file.name, bytes: file.bytes });
  }
  return [...files.values()];
}

export async function buildSessionArchive(
  session: ResearchSession,
  load: (id: string) => Promise<Uint8Array> = async (id) => {
    const response = await fetch(`/api/files/${encodeURIComponent(id)}`);
    if (!response.ok)
      throw new Error(
        "An uploaded file is no longer available on the local server. Export JSONL or Markdown to retain the event history.",
      );
    return new Uint8Array(await response.arrayBuffer());
  },
): Promise<ExportResult> {
  const files = declaredSessionFiles(session);
  if (files.reduce((n, f) => n + f.bytes, 0) > 40 * 1024 * 1024)
    throw new Error(
      "Session attachments exceed the 40 MB archive limit. Download the files separately.",
    );
  const entries: Record<string, Uint8Array> = {
    "session.jsonl": strToU8(jsonl(session)),
    "transcript.md": strToU8(markdown(session)),
  };
  const attachments = [];
  for (const file of files) {
    const bytes = await load(file.id);
    if (bytes.length !== file.bytes)
      throw new Error(
        `Attachment size changed: ${file.name}. The archive was not created.`,
      );
    const path = `attachments/${safePart(file.id)}-${safeAttachmentName(file.name)}`;
    entries[path] = bytes;
    attachments.push({ ...file, path });
  }
  entries["manifest.json"] = strToU8(
    JSON.stringify(
      {
        schemaVersion: 2,
        session: {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
        },
        counts: { events: session.events.length },
        attachments: { included: true, files: attachments },
        scope:
          "Full local session history. External subagent sessions are not connected.",
      },
      null,
      2,
    ),
  );
  entries["README.md"] = strToU8(
    `# ${session.title}\n\nComplete local session: turn and tool records, approval history, artifact data, transcript, and original declared upload bytes. Event timestamps and tool durations are recorded values. No external subagent sessions exist in this local example.\n`,
  );
  return {
    bytes: zipSync(entries),
    mime: "application/zip",
    filename: `${safePart(session.title)}-${safePart(session.id)}.zip`,
  };
}

export async function downloadCompleteSession(
  session: ResearchSession,
  format: LogFormat,
): Promise<void> {
  downloadExport(
    format === "zip"
      ? await buildSessionArchive(session)
      : buildSessionExport(session, format),
  );
}

export type { ExportResult };
