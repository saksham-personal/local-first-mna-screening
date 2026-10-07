# Prompts

Every prompt the app sends to a model lives here as one Markdown file. Edit the wording in the file; the app reads it. No code change is needed unless you add or remove an input.

## File format

```
# <Title>

**ID:** screening-scored
**What it does:** What the prompt is for, in plain words.
**Inputs:** `{{definition}}` (required) – what it holds; `{{good_fits}}` (optional) – what it holds
**Output:** What the model should return.
**Supplied to:** Which provider and which call receives it.
**Version:** 1

===@@=== STARTING ===@@===
The prompt text, with {{placeholders}}.
===@@=== END ===@@===
```

- The file starts with a `# Title` line, then the six description fields, then the prompt between the two marker lines. The six fields are ID, What it does, Inputs, Output, Supplied to and Version, and nothing else is allowed in that block. A field may continue on the next lines until a blank line.
- **ID** is lowercase letters, digits and hyphens, and must equal the file name without `.md`.
- **Inputs** lists every placeholder as `` `{{name}}` (required) `` or `` `{{name}}` (optional) ``, then a dash and a description. Write `none` when the prompt has no inputs. A placeholder that is used in the prompt but not listed is an error, and so is a listed input that is never used.
- **Version** is a whole number. Raise it when the meaning of the prompt changes.
- Only the text strictly between the marker lines is the prompt. One leading and one trailing newline are trimmed, nothing else, so do not leave blank lines just inside the markers. A file has exactly one start marker and one end marker, and nothing but whitespace after the end marker.
- Files may use LF or CRLF line endings; both are read as LF. `prompts/.gitattributes` keeps them LF in the working tree.

## Placeholders

- `{{name}}` is replaced by the input's value. Names use lowercase letters, digits and underscores.
- `{{#name}} ... {{/name}}` is an optional section. It is kept only when `name` has a value (not empty and not just spaces); inside it, `{{name}}` is that value. A section may hold one more section, and no deeper. A section cannot hold a section of the same name.
- A section tag that sits alone on its line is removed together with its line break, so a skipped section leaves no blank line behind. A tag with other text on its line is replaced in place.
- A required input must be supplied and not blank. An optional input may be missing or blank (it renders as empty). An input that is not listed is rejected. Values are inserted as they are and are never read as placeholders themselves, so analyst text containing `{{x}}` is safe.
- Single braces such as `{company}` and `{website}` are ordinary text. A literal `{{` cannot appear in a prompt.
- Any breakage (a missing marker, a placeholder that is not declared, an unclosed section, a missing required input) raises an error that names the file and line.

## How to edit

1. Open the `.md` file and change the text between the markers. Keep every `{{placeholder}}` you still need.
2. To add a placeholder, add it to the Inputs line (required or optional) and use it in the text. Code that supplies the input must be changed to match; to remove an input, remove it from both.
3. The bridge re-reads a file when its modification time changes, so a running bridge picks the edit up on the next request. Set `MNA_PROMPTS_DIR` to use a different folder.
4. Run `pnpm test` in `mna-ui`. If a rendered prompt changed on purpose, refresh the shared conformance fixtures with `UPDATE_PROMPT_FIXTURES=1 pnpm test` and review the diff of `mna-ui/tests/fixtures/prompt-conformance.json`.

## One score definition

Three prompts state the same score rule word for word: `screening-scored.md`, `screening-prompt-writer.md` and `output-contract.md`. It is kept in `FIT_SCORE_RULE` in `mna-ui/shared/screening.mjs`, and a test fails if the files drift apart. If you change the rule, change it in all four places.

> Fit Score is a number from 0 to 10, or the literal CHECK. 0–2: little evidence of fit. 3–4: weak or partial fit. 5–6: plausible fit. 7–8: strong fit. 9–10: direct, well-supported fit. Use CHECK when the supplied information is insufficient or contradictory; CHECK is not a poor fit. Retrieval scores (MID, ISCC, semantic) are not fit scores. Do not filter on financials, size, geography, ownership, or industry codes.

## Prompt catalog

| ID | What it is | Supplied to |
|---|---|---|
| `screening-scored` | Scored screening prompt: criteria, examples, deferred conditions, input glossary, request, score rule, output format | LLM Suite and M365 Copilot screening setup, rendered by the bridge |
| `screening-question` | Question prompt, optionally answered per company | LLM Suite and M365 Copilot screening setup (question mode), rendered by the bridge |
| `screening-prompt-writer` | Asks LLM Suite to draft a screening prompt | LLM Suite, `POST /api/conversation/generate` (purpose `screening-prompt`) |
| `output-contract` | Strict Markdown table contract appended to every approved screening prompt | Rust prepared plan (loaded by `mna-tools/src/prompts.rs`; override with `MNA_PROMPTS_DIR`) |
| `batch-repair` | Retry instruction after a batch response fails parsing | Rust execution (loaded by `mna-tools/src/prompts.rs`; override with `MNA_PROMPTS_DIR`) |
| `format-repair` | Retry prompt after a generated draft has the wrong block format | Rust gateway (loaded by `mna-tools/src/prompts.rs`; override with `MNA_PROMPTS_DIR`) |
| `tool-command-repair` | Retry instruction after a rejected tool command | Rust protocol (loaded by `mna-tools/src/prompts.rs`; override with `MNA_PROMPTS_DIR`) |
| `controller-tools` | Standing instructions and command grammar for the screening controller | Rust agent commands (loaded by `mna-tools/src/prompts.rs`; override with `MNA_PROMPTS_DIR`) |
| `direct-question` | Wrapper for a free-form analyst question | LLM Suite or M365 Copilot, `POST /api/conversation/ask` |
| `bing-query-writer` | Asks LLM Suite for Bing query templates | LLM Suite, `POST /api/conversation/generate` (purpose `bing-templates`) |
| `criteria-from-examples` | Revises the criteria using good-fit and bad-fit examples | LLM Suite, `POST /api/conversation/generate` (purposes `criteria-from-examples` and the older `criteria`) |
| `criteria-from-research` | Revises the criteria using a research answer the analyst chose | LLM Suite, `POST /api/conversation/generate` (purpose `criteria-from-research`) |
| `intake-form-extraction` | Reserved: LLM extraction of Intake Form fields from PDF text | Not supplied yet |
| `mid-search-planner` | Reserved for Phase 2: plans MID keyword searches (rationale, weighted keywords, expression) | Not supplied yet |

The bridge lists the catalog at `GET /api/prompts`. A browser may render only `screening-scored`, `screening-question`, `bing-query-writer`, `criteria-from-examples` and `criteria-from-research`, through `POST /api/prompts/render`; the generated screening prompt has its own route, `POST /api/prompts/screening-draft`. The browser never reads these files.

## Notes for another loader (the Rust one)

The rules above are the whole contract. `mna-ui/tests/fixtures/prompt-conformance.json` holds `{ name, id, vars, expected }` cases rendered from the real files, and `mna-ui/tests/fixtures/prompt-engine-conformance.json` holds small prompt files with the exact output, or the error `code`, a loader must give. Error codes are `bad_marker`, `missing_marker`, `duplicate_marker`, `bad_header`, `bad_inputs`, `bad_placeholder`, `undeclared_placeholder`, `unused_input`, `unbalanced_section`, `section_depth`, `missing_input`, `unknown_input`, `bad_value`, `bad_id` and `not_found`. The content hash is the SHA-256 of the prompt text between the markers, with LF line endings.
