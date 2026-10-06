/** Bridge routes for prompts. The browser never reads the prompts/ files; it asks for rendered prompts here.
 *
 *   GET  /api/prompts                  catalog metadata for every prompt file
 *   POST /api/prompts/screening-draft  the generated screening or question prompt
 *   POST /api/prompts/render           one of a short list of public prompts, rendered from inputs
 */
import { listPrompts, renderPromptResult, renderScreeningPrompt, PromptError } from "../shared/prompts.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_PROMPT = 60_000;
const MAX_TEXT = 32_000;
const MAX_REQUEST = 20_000;
const MAX_EXAMPLE = 4_000;
const MAX_EXAMPLES = 100;
const MAX_COLUMNS = 100;
const MAX_VARS = 40;
/** Prompts a browser may render. Rust-side prompts (contracts, repairs, controller) stay private. */
export const PUBLIC_PROMPTS = new Set(["screening-scored", "screening-question", "bing-query-writer", "criteria-from-examples", "criteria-from-research"]);

const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
const reject = (message) => {
  throw new Error(message);
};

function text(value, label, { max = MAX_TEXT, required = false } = {}) {
  if (value == null || value === "") {
    if (required) reject(`${label} is required.`);
    return "";
  }
  if (typeof value !== "string" || value.length > max) reject(`${label} must be text under ${max.toLocaleString("en-US")} characters.`);
  if (required && !value.trim()) reject(`${label} is required.`);
  return value;
}

function list(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_EXAMPLES) reject(`${label} must be a list of at most ${MAX_EXAMPLES} items.`);
  return value.map((item) => {
    if (typeof item !== "string" || item.length > MAX_EXAMPLE) reject(`Each ${label} item must be text under ${MAX_EXAMPLE.toLocaleString("en-US")} characters.`);
    return item;
  });
}

function columns(value, label) {
  if (value == null) return undefined;
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > MAX_COLUMNS ||
    value.some((name) => typeof name !== "string" || !name.trim() || name.length > 160 || /[\r\n|]/.test(name) || ["__proto__", "prototype", "constructor"].includes(name))
  )
    reject(`${label} must be 1 to ${MAX_COLUMNS} column names without pipes or line breaks.`);
  return value;
}

/** The body of POST /api/prompts/screening-draft, checked and ready for renderScreeningPrompt. */
export function screeningDraftInput(input) {
  if (!plain(input)) reject("Send a JSON object.");
  if (input.sessionId != null && (typeof input.sessionId !== "string" || !SAFE_ID.test(input.sessionId))) reject("Use a valid session ID.");
  if (!["screening", "question"].includes(input.mode)) reject("Choose the screening or question task.");
  return {
    mode: input.mode,
    definition: text(input.definition, "The criteria", { required: input.mode === "screening" }),
    goodFits: list(input.goodFits, "Good-fit example"),
    badFits: list(input.badFits, "Bad-fit example"),
    deferred: list(input.deferred, "Deferred condition"),
    inputColumns: columns(input.inputColumns, "Input columns"),
    outputColumns: columns(input.outputColumns, "Output columns"),
    request: text(input.request, "The request", { max: MAX_REQUEST }),
  };
}

function renderInput(input) {
  if (!plain(input)) reject("Send a JSON object.");
  if (typeof input.id !== "string" || !PUBLIC_PROMPTS.has(input.id)) reject("This prompt is not available to the browser.");
  const vars = input.vars ?? {};
  if (!plain(vars) || Object.keys(vars).length > MAX_VARS) reject("Inputs must be an object with at most 40 entries.");
  for (const [name, value] of Object.entries(vars)) {
    if (value != null && (typeof value !== "string" || value.length > MAX_TEXT)) reject(`Input "${name}" must be text under ${MAX_TEXT.toLocaleString("en-US")} characters.`);
  }
  return { id: input.id, vars };
}

function withinLimit(result) {
  if (Buffer.byteLength(result.prompt, "utf8") > MAX_PROMPT) reject("The prompt is too long. Shorten the criteria, examples or request.");
  return result;
}

/** Route a request. Returns { status, payload }, or undefined when the path is not a prompt route. */
export function routePrompt({ method, pathname, input }) {
  if (pathname !== "/api/prompts" && !pathname.startsWith("/api/prompts/")) return undefined;
  const allow = (expected, run) => {
    if (method !== expected) return { status: 405, payload: { error: `Use ${expected} for this endpoint.` } };
    try {
      return { status: 200, payload: run() };
    } catch (error) {
      return { status: 400, payload: { error: error instanceof Error ? error.message : String(error), ...(error instanceof PromptError ? { code: error.code } : {}) } };
    }
  };
  if (pathname === "/api/prompts") return allow("GET", () => ({ prompts: listPrompts() }));
  if (pathname === "/api/prompts/screening-draft") return allow("POST", () => withinLimit(renderScreeningPrompt(screeningDraftInput(input))));
  if (pathname === "/api/prompts/render") return allow("POST", () => {
    const { id, vars } = renderInput(input);
    return withinLimit(renderPromptResult(id, vars));
  });
  return { status: 404, payload: { error: "Endpoint not found." } };
}

/** Registered once from bridge.mjs. Returns true when it answered the request. */
export async function handlePromptRoute(req, res, url, { respond, body }) {
  if (url.pathname !== "/api/prompts" && !url.pathname.startsWith("/api/prompts/")) return false;
  let input;
  if (req.method === "POST") {
    if (!req.headers["content-type"]?.startsWith("application/json")) {
      respond(res, 400, { error: "Use a JSON request." });
      return true;
    }
    input = await body(req);
  }
  const result = routePrompt({ method: req.method, pathname: url.pathname, input });
  respond(res, result.status, result.payload);
  return true;
}
