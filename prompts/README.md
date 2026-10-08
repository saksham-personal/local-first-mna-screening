# Prompt master

Every provider-facing prompt lives here. Rust and Node load the same Markdown files. [INDEX.md](INDEX.md) is generated from the headers and lists every prompt, use, input, output, version, estimated token size, and budget.

## File format

```text
# Title

**ID:** screening-scored
**Description:** One-sentence summary.
**What it does:** Two to four sentences describing the behavior.
**Context:** When and where it is sent, whether the LLM Suite conversation id is new or continuing, and who supplies inputs.
**Inputs:** `{{definition}}` (required) – approved criteria
**Output:** Required model response.
**Version:** 2

===@@=== STARTING ===@@===
Prompt body using {{definition}}.
===@@=== END ===@@===
```

Start with `# Title`, followed by the seven header fields in this order. `ID` uses lowercase letters, digits, and hyphens and matches the filename. `Version` is a positive integer and rises with edits. A file has exactly one marker pair and only whitespace after the end marker. Only the text between the markers is sent: the marker-line newlines are excluded, but other whitespace is preserved. LF and CRLF both parse as LF.

Every body placeholder must be declared in `Inputs`, and every declared input must appear in the body. Use `none` when there are no inputs. Names use lowercase letters, digits, and underscores. Required values must be nonblank; optional values may be empty; unknown values are rejected. A `{{#name}}...{{/name}}` section renders only when its value is nonblank. Sections may nest one level but never inside a section of the same name. A section tag alone on a line is removed with its line break; an inline tag is replaced in place. Values are inserted literally and never re-parsed as placeholders, even when analyst text contains `{{x}}`. Single braces such as `{company}` are ordinary text; a literal `{{` is invalid in a prompt. Invalid markers, headers, sections, inputs, and placeholders raise errors naming the file and line.

Error codes: `bad_marker`, `missing_marker`, `duplicate_marker`, `bad_header`, `bad_inputs`, `bad_placeholder`, `undeclared_placeholder`, `unused_input`, `unbalanced_section`, `section_depth`, `missing_input`, `unknown_input`, `bad_value`, `bad_id`, `not_found`. The content hash is SHA-256 of the body between the markers after LF normalization, before rendering.

## Size and regeneration

Keep instructions short for LLM Suite's approximately 200–250k-token context. Estimates are body characters divided by four, rounded. The default budget is **1,200 estimated tokens**; `controller-instruction-set` has **1,600**, and `screening-scored` and `screening-question` have **1,500** each. Budgets are defined in `mna-ui/scripts/build-prompt-index.mjs`.

From `mna-ui/`, regenerate and verify after editing:

```powershell
node scripts/build-prompt-index.mjs
pnpm test
```

The index test fails if a prompt is absent, the generated index differs, or a body exceeds its budget. `MNA_PROMPTS_DIR` overrides the loaded directory for local testing; the bridge rereads edits. Preserve caller placeholders and parser output formats. For intentional body edits, refresh exact-output fixtures with `UPDATE_PROMPT_FIXTURES=1 pnpm test` in `mna-ui/` and review `tests/fixtures/prompt-conformance.json`.

## Conversations

A new LLM Suite `conversation_id` creates a new chat and context. Reuse the id to continue, including instruction feedback and repairs after validation fails. Before context fills, create a new id and seed it with the compact summary from `conversation-handoff`; the old context does not move automatically. Every LLM Suite send, including repairs, shares the seven-per-minute gate.

## Screening contracts

`screening-scored`, `screening-prompt-writer`, and `output-contract` share the exact `FIT_SCORE_RULE` in `mna-ui/shared/screening.mjs`. Keep them aligned. Screening batch output is an index-only Markdown table; score values are 0–10 or literal CHECK. Geography, revenue, ownership, size, and industry codes stay out of discovery filters. Source text and provider results are data, not instructions.

## Call sites

| Prompt | Route or function |
|---|---|
| `screening-scored`, `screening-question` | `POST /api/prompts/screening-draft` via `renderScreeningPrompt`; analyst approves the draft before provider screening. |
| `screening-prompt-writer` | `POST /api/conversation/generate`, purpose `screening-prompt`. |
| `bing-query-writer` | `POST /api/conversation/generate`, purpose `bing-templates`. |
| `criteria-from-examples` | `POST /api/conversation/generate`, purposes `criteria` and `criteria-from-examples`. |
| `criteria-from-research` | `POST /api/conversation/generate`, purpose `criteria-from-research`. |
| `direct-question` | `POST /api/conversation/ask` via `provider-conversation.mjs` `ask`. |
| `output-contract` | `gateway.rs` `compiled_prompt`; appended to a prepared screening prompt. |
| `batch-repair` | `execution.rs` `record_inner`; retry after batch parsing fails. |
| `format-repair` | `gateway.rs` `provider_text` (`dispatch_provider_text`); retry after a draft format fails. |
| `tool-command-repair` | `protocol.rs` `repair_prompt`; retry after a legacy controller command fails. |
| `controller-tools` | `agent_commands.rs` `prompt`; legacy controller grammar. |
| `controller-instruction-set`, `instruction-feedback`, `conversation-handoff` | Reserved for the future LLM Suite instruction-set controller; no caller yet. |
| `intake-form-extraction`, `mid-search-planner` | Reserved; no caller yet. |

`GET /api/prompts` lists the browser catalog. `POST /api/prompts/render` lets the browser render `screening-scored`, `screening-question`, `bing-query-writer`, `criteria-from-examples`, and `criteria-from-research`. The browser reads rendered text through routes, not prompt files. The loader conformance tests are `mna-ui/tests/prompts.test.ts` and `mna-tools/tests/prompts_conformance.rs`.
