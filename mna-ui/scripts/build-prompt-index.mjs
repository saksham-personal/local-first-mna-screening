import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listPrompts, loadPrompt, promptsDir } from "../shared/prompts.mjs";
import { join, resolve } from "node:path";

export const DEFAULT_BUDGET = 1200;
export const PROMPT_BUDGETS = Object.freeze({
  "controller-instruction-set": 1600,
  "screening-scored": 1500,
  "screening-question": 1500,
});

export const estimatedTokens = (body) => Math.round(body.length / 4);
const cell = (value) => String(value).replaceAll("|", "\\|").replace(/\s+/g, " ").trim();

export function buildPromptIndex() {
  const rows = listPrompts().map((prompt) => {
    const source = loadPrompt(prompt.id);
    const inputs = prompt.inputs.length
      ? prompt.inputs.map((input) => `\`{{${input.name}}}\` (${input.required ? "required" : "optional"})`).join("; ")
      : "none";
    return `| ${[prompt.id, prompt.summary, prompt.context, inputs, prompt.output, prompt.version, estimatedTokens(source.body), PROMPT_BUDGETS[prompt.id] ?? DEFAULT_BUDGET].map(cell).join(" | ")} |`;
  });
  return [
    "# Prompt index",
    "",
    "Generated from the prompt master. Run `node scripts/build-prompt-index.mjs` in `mna-ui/` after editing prompts.",
    "Estimated tokens are prompt body characters divided by four, rounded to the nearest whole token.",
    "",
    "| ID | Description | Context | Inputs | Output | Version | est. tokens | budget |",
    "|---|---|---|---|---|---:|---:|---:|",
    ...rows,
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--stdout")) process.stdout.write(buildPromptIndex());
  else writeFileSync(join(promptsDir(), "INDEX.md"), buildPromptIndex(), "utf8");
}
