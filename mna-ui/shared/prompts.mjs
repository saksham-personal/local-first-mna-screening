/** Prompt files: parse, load and render the Markdown files in the repository's prompts/ directory.
 *
 * This module reads files (node:fs), so it is for Node only: the bridge and the tsx tests.
 * The browser never imports it; it receives rendered prompts from the bridge instead.
 * The format and the rendering rules are documented in prompts/README.md. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { screeningPromptRequest } from "./screening.mjs";

export const START_MARKER = "===@@=== STARTING ===@@===";
export const END_MARKER = "===@@=== END ===@@===";
const FIELDS = ["ID", "What it does", "Inputs", "Output", "Supplied to", "Version"];
const NAME = "[a-z][a-z0-9_]*";
const TOKEN = new RegExp(`\\{\\{([#/]?)(${NAME})\\}\\}`, "y");
// A line that holds only a section tag is removed together with its newline.
const STANDALONE = new RegExp(`^[ \\t]*(\\{\\{[#/]${NAME}\\}\\})[ \\t]*(?:\\n|$)`, "gm");
const PROMPT_ID = /^[a-z][a-z0-9-]*$/;
const MAX_SECTION_DEPTH = 2;

/** Every failure carries a stable `code` so other loaders (Rust) can mirror the categories. */
export class PromptError extends Error {
  constructor(code, message, { file, line } = {}) {
    super(`${file ? `${file}${line ? `:${line}` : ""}: ` : ""}${message}`);
    this.name = "PromptError";
    this.code = code;
    if (file) this.file = file;
    if (line) this.line = line;
  }
}

function tokenize(source, onMalformed) {
  const tokens = [];
  let last = 0;
  let at;
  while ((at = source.indexOf("{{", last)) !== -1) {
    TOKEN.lastIndex = at;
    const match = TOKEN.exec(source);
    if (!match) onMalformed(at);
    if (at > last) tokens.push({ type: "text", text: source.slice(last, at), at: last });
    tokens.push({ type: match[1] === "#" ? "open" : match[1] === "/" ? "close" : "var", name: match[2], at });
    last = at + match[0].length;
  }
  if (last < source.length) tokens.push({ type: "text", text: source.slice(last), at: last });
  return tokens;
}

function buildTree(tokens, fail) {
  const root = [];
  const stack = [{ name: null, children: root, at: 0 }];
  for (const token of tokens) {
    const top = stack.at(-1);
    if (token.type === "text") top.children.push({ type: "text", text: token.text });
    else if (token.type === "var") top.children.push({ type: "var", name: token.name });
    else if (token.type === "open") {
      if (stack.some((frame) => frame.name === token.name))
        fail("unbalanced_section", `Section {{#${token.name}}} is nested inside itself.`, token.at);
      if (stack.length > MAX_SECTION_DEPTH)
        fail("section_depth", "Sections can be nested one level deep at most.", token.at);
      const node = { type: "section", name: token.name, children: [] };
      top.children.push(node);
      stack.push({ name: token.name, children: node.children, at: token.at });
    } else {
      if (top.name !== token.name)
        fail(
          "unbalanced_section",
          top.name
            ? `Closing tag {{/${token.name}}} does not match the open section {{#${top.name}}}.`
            : `Closing tag {{/${token.name}}} has no matching {{#${token.name}}}.`,
          token.at,
        );
      stack.pop();
    }
  }
  if (stack.length > 1) fail("unbalanced_section", `Section {{#${stack.at(-1).name}}} is never closed.`, stack.at(-1).at);
  return root;
}

function parseInputs(raw, fail, line) {
  if (/^none\.?$/i.test(raw)) return [];
  const matches = [...raw.matchAll(new RegExp(`\`\\{\\{(${NAME})\\}\\}\`\\s*\\((required|optional)\\)`, "g"))];
  if (!matches.length)
    fail("bad_inputs", 'Inputs must be "none" or a list such as `{{name}}` (required) – what it holds.', line);
  if (raw.slice(0, matches[0].index).trim()) fail("bad_inputs", "Unexpected text before the first input.", line);
  const inputs = [];
  matches.forEach((match, index) => {
    const end = index + 1 < matches.length ? matches[index + 1].index : raw.length;
    const description = raw
      .slice(match.index + match[0].length, end)
      .replace(/^\s*[–—-]+\s*/, "")
      .replace(/[\s;]+$/, "")
      .trim();
    if (inputs.some((input) => input.name === match[1])) fail("bad_inputs", `Input "${match[1]}" is listed twice.`, line);
    if (!description) fail("bad_inputs", `Describe input "${match[1]}" after its (required) or (optional) mark.`, line);
    inputs.push({ name: match[1], required: match[2] === "required", description });
  });
  return inputs;
}

/** Parse one prompt file. Strict: exactly one marker pair, a complete description block,
 * and every placeholder declared in Inputs (and every declared input used). */
export function parsePromptFile(text, file = "prompt file") {
  const failAt = (code, message, line) => {
    throw new PromptError(code, message, { file, line });
  };
  if (typeof text !== "string") failAt("bad_header", "The prompt file text must be a string.");
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const starts = [];
  const ends = [];
  lines.forEach((line, index) => {
    const trimmed = line.trimEnd();
    if (trimmed === START_MARKER) starts.push(index);
    else if (trimmed === END_MARKER) ends.push(index);
    else if (trimmed.includes("===@@===")) failAt("bad_marker", `Malformed marker. Use exactly "${START_MARKER}" and "${END_MARKER}".`, index + 1);
  });
  if (!starts.length) failAt("missing_marker", `Missing the start marker "${START_MARKER}".`);
  if (!ends.length) failAt("missing_marker", `Missing the end marker "${END_MARKER}".`);
  if (starts.length > 1) failAt("duplicate_marker", "More than one start marker; a file holds exactly one prompt.", starts[1] + 1);
  if (ends.length > 1) failAt("duplicate_marker", "More than one end marker; a file holds exactly one prompt.", ends[1] + 1);
  if (ends[0] < starts[0]) failAt("missing_marker", "The end marker comes before the start marker.", ends[0] + 1);
  const trailing = lines.findIndex((line, index) => index > ends[0] && line.trim());
  if (trailing !== -1) failAt("bad_header", "Text after the end marker. Only the text between the markers is the prompt.", trailing + 1);

  const header = lines.slice(0, starts[0]);
  const titleIndex = header.findIndex((line) => line.trim());
  if (titleIndex === -1 || !/^# \S/.test(header[titleIndex]))
    failAt("bad_header", 'The file must begin with a "# Title" line.', titleIndex === -1 ? 1 : titleIndex + 1);
  const title = header[titleIndex].slice(2).trim();
  const fields = new Map();
  let current = null;
  for (let index = titleIndex + 1; index < header.length; index++) {
    const line = header[index];
    if (!line.trim()) {
      current = null;
      continue;
    }
    const field = /^\*\*([^*:]+):\*\*\s*(.*)$/.exec(line);
    if (field) {
      const name = field[1].trim();
      if (!FIELDS.includes(name)) failAt("bad_header", `Unknown description field "${name}". Use: ${FIELDS.join(", ")}.`, index + 1);
      if (fields.has(name)) failAt("bad_header", `The description field "${name}" appears twice.`, index + 1);
      current = { value: field[2].trim(), line: index + 1 };
      fields.set(name, current);
    } else if (current) current.value += ` ${line.trim()}`;
    else failAt("bad_header", "Unexpected text in the description block. Use **Field:** lines only.", index + 1);
  }
  for (const name of FIELDS) {
    if (!fields.get(name)?.value) failAt("bad_header", `Missing or empty description field "${name}".`, fields.get(name)?.line);
  }
  const id = fields.get("ID").value;
  if (!PROMPT_ID.test(id)) failAt("bad_header", `The ID "${id}" must use lowercase letters, digits and hyphens.`, fields.get("ID").line);
  if (!/^[1-9][0-9]{0,5}$/.test(fields.get("Version").value))
    failAt("bad_header", "The Version must be a whole number of 1 or more.", fields.get("Version").line);
  const inputs = parseInputs(fields.get("Inputs").value, failAt, fields.get("Inputs").line);

  const body = lines.slice(starts[0] + 1, ends[0]).join("\n");
  const bodyLine = starts[0] + 2;
  const lineAt = (offset) => bodyLine + (body.slice(0, offset).match(/\n/g)?.length ?? 0);
  const failBody = (code, message, offset) => failAt(code, message, lineAt(offset ?? 0));
  // First pass on the text as written, so errors point at the real line.
  const written = tokenize(body, (offset) =>
    failBody("bad_placeholder", "Malformed placeholder. Use {{name}}, {{#name}} or {{/name}} with lowercase letters, digits and underscores.", offset),
  );
  buildTree(written, failBody);
  const declared = new Map(inputs.map((input) => [input.name, input]));
  const used = new Set();
  for (const token of written) {
    if (token.type === "text") continue;
    if (!declared.has(token.name)) failBody("undeclared_placeholder", `The placeholder "${token.name}" is not declared in Inputs.`, token.at);
    used.add(token.name);
  }
  for (const input of inputs) {
    if (!used.has(input.name)) failAt("unused_input", `Input "${input.name}" is declared in Inputs but never used in the prompt.`, fields.get("Inputs").line);
  }
  // Second pass on the text with standalone section lines removed; this tree is what renders.
  const tree = buildTree(tokenize(body.replace(STANDALONE, "$1"), (offset) => failBody("bad_placeholder", "Malformed placeholder.", offset)), failBody);

  const prompt = {
    id,
    title,
    description: fields.get("What it does").value,
    inputs,
    output: fields.get("Output").value,
    suppliedTo: fields.get("Supplied to").value,
    version: Number(fields.get("Version").value),
    body,
    contentHash: createHash("sha256").update(body).digest("hex"),
    file,
  };
  Object.defineProperty(prompt, "tree", { value: tree, enumerable: false });
  return prompt;
}

/** Render a parsed prompt. Required inputs must be non-blank strings; optional inputs may be
 * missing or blank; unknown inputs are rejected. Values are inserted as is and never re-scanned. */
export function renderParsedPrompt(prompt, vars = {}) {
  const fail = (code, message) => {
    throw new PromptError(code, message, { file: prompt.file });
  };
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) fail("bad_value", "Prompt inputs must be an object of strings.");
  const declared = new Map(prompt.inputs.map((input) => [input.name, input]));
  for (const key of Object.keys(vars)) {
    if (!declared.has(key))
      fail("unknown_input", `Unknown input "${key}" for prompt "${prompt.id}". Declared inputs: ${prompt.inputs.map((input) => input.name).join(", ") || "none"}.`);
  }
  const values = new Map();
  for (const input of prompt.inputs) {
    let value = vars[input.name];
    if (value === undefined || value === null) value = "";
    else if (typeof value === "number" && Number.isFinite(value)) value = String(value);
    else if (typeof value !== "string") fail("bad_value", `Input "${input.name}" for prompt "${prompt.id}" must be a string.`);
    if (!value.trim()) {
      if (input.required) fail("missing_input", `Required input "${input.name}" for prompt "${prompt.id}" is missing or blank.`);
      value = "";
    }
    values.set(input.name, value);
  }
  const render = (nodes) =>
    nodes
      .map((node) => (node.type === "text" ? node.text : node.type === "var" ? values.get(node.name) : values.get(node.name) ? render(node.children) : ""))
      .join("");
  return render(prompt.tree);
}

/** The prompts directory: MNA_PROMPTS_DIR when set, otherwise <repo>/prompts. */
export function promptsDir() {
  const override = process.env.MNA_PROMPTS_DIR?.trim();
  return override ? resolve(override) : fileURLToPath(new URL("../../prompts/", import.meta.url));
}

const cache = new Map();
export function clearPromptCache() {
  cache.clear();
}

function readPrompt(path) {
  const label = basename(path);
  let info;
  try {
    info = statSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new PromptError("not_found", `Prompt file not found: ${path}`, { file: label });
    throw error;
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.prompt;
  const prompt = parsePromptFile(readFileSync(path, "utf8"), label);
  if (`${prompt.id}.md` !== label) throw new PromptError("bad_header", `The ID "${prompt.id}" must match the file name.`, { file: label });
  cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, prompt });
  return prompt;
}

/** Load (and cache) one prompt by id. A file edited on disk is re-read on the next call. */
export function loadPrompt(id) {
  if (typeof id !== "string" || !PROMPT_ID.test(id)) throw new PromptError("bad_id", `"${String(id)}" is not a valid prompt id.`);
  return readPrompt(join(promptsDir(), `${id}.md`));
}

export function renderPrompt(id, vars = {}) {
  return renderParsedPrompt(loadPrompt(id), vars);
}

/** Render and report which prompt text produced it. */
export function renderPromptResult(id, vars = {}) {
  const prompt = loadPrompt(id);
  return { prompt: renderParsedPrompt(prompt, vars), promptId: prompt.id, promptVersion: prompt.version, promptHash: prompt.contentHash };
}

/** The generated screening or question prompt: screening-scored.md or screening-question.md rendered
 * from the approved criteria, examples, deferred conditions, columns and analyst request. */
export function renderScreeningPrompt(input) {
  const { id, vars } = screeningPromptRequest(input);
  return renderPromptResult(id, vars);
}

const metadata = (prompt) => ({
  id: prompt.id,
  title: prompt.title,
  description: prompt.description,
  inputs: prompt.inputs.map((input) => ({ ...input })),
  output: prompt.output,
  suppliedTo: prompt.suppliedTo,
  version: prompt.version,
  file: prompt.file,
});

/** Metadata for every prompt file, sorted by id. One unreadable file fails the listing, naming the file. */
export function listPrompts() {
  const dir = promptsDir();
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md")
    .sort()
    .map((name) => metadata(readPrompt(join(dir, name))));
}
