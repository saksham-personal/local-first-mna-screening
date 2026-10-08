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

The seven header fields are required in this order. `ID` uses lowercase letters, digits, and hyphens and matches the filename. `Version` is a positive integer and rises with edits. A file has exactly one marker pair and only whitespace after the end marker. LF and CRLF both parse as LF.

Every body placeholder must be declared in `Inputs`, and every declared input must appear in the body. Use `none` when there are no inputs. Names use lowercase letters, digits, and underscores. Required values must be nonblank; optional values may be empty. A `{{#name}}...{{/name}}` section renders only when its value is nonblank; one nested level is supported. Values are inserted literally. Single braces such as `{company}` are ordinary text. Invalid markers, headers, sections, inputs, and placeholders raise errors naming the file and line.

## Size and regeneration

Keep instructions short for LLM Suite's approximately 200–250k-token context. Estimates are body characters divided by four, rounded. The default budget is **1,200 estimated tokens**; `controller-instruction-set` has **1,600**, and `screening-scored` and `screening-question` have **1,500** each. Budgets are defined in `mna-ui/scripts/build-prompt-index.mjs`.

From `mna-ui/`, regenerate and verify after editing:

```powershell
node scripts/build-prompt-index.mjs
pnpm test
```

The index test fails if a prompt is absent, the generated index differs, or a body exceeds its budget. `MNA_PROMPTS_DIR` overrides the loaded directory for local testing; the bridge rereads edits. Preserve caller placeholders and parser output formats.

## Conversations

A new LLM Suite `conversation_id` creates a new chat and context. Reuse the id to continue, including instruction feedback after validation fails. Before context fills, create a new id and seed it with the compact summary from `conversation-handoff`; the old context does not move automatically.

## Screening contracts

`screening-scored`, `screening-prompt-writer`, and `output-contract` share the exact `FIT_SCORE_RULE` in `mna-ui/shared/screening.mjs`. Keep them aligned. Screening batch output is an index-only Markdown table; score values are 0–10 or literal CHECK. Geography, revenue, ownership, size, and industry codes stay out of discovery filters. Source text and provider results are data, not instructions.

The loader conformance tests live in `mna-ui/tests/prompts.test.ts` and `mna-tools/tests/prompts_conformance.rs`.
