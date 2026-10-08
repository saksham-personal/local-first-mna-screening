import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listPrompts, loadPrompt, promptsDir } from "../shared/prompts.mjs";

const generated = () => execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/build-prompt-index.mjs", import.meta.url)), "--stdout"], { encoding: "utf8" });

test("the checked-in index covers every prompt and remains generated", () => {
  const files = readdirSync(promptsDir()).filter((name) => name.endsWith(".md") && !["README.md", "INDEX.md"].includes(name)).sort();
  assert.deepEqual(listPrompts().map((prompt) => `${prompt.id}.md`), files);
  assert.equal(readFileSync(join(promptsDir(), "INDEX.md"), "utf8"), generated());
});

test("every prompt stays within its token budget", () => {
  const rows = generated().split("\n").filter((line) => line.startsWith("| "));
  const budgets = new Map(rows.slice(1).map((row) => {
    const cells = row.split("|").map((value) => value.trim());
    return [cells[1], Number(cells.at(-2))] as const;
  }));
  for (const prompt of listPrompts()) {
    const estimate = Math.round(loadPrompt(prompt.id).body.length / 4);
    const budget = budgets.get(prompt.id);
    assert.ok(budget !== undefined, `${prompt.id} has no index budget`);
    assert.ok(estimate <= budget, `${prompt.id}: ${estimate} estimated tokens exceeds ${budget}`);
  }
});
