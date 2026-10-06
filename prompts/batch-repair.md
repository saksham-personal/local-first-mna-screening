# Batch repair

**ID:** batch-repair
**What it does:** The retry instruction sent when a provider's batch response fails strict parsing. It quotes the parser error, restates what a valid reply looks like for the kind of job (table rows for a screening batch, a nonempty answer for a direct question) and repeats the rejected response, cut to 20,000 characters, so the model can correct it. Retries use the shared LLM Suite rate gate and stop after two repairs.
**Inputs:** `{{error}}` (required) – the parser's error message; `{{table_answer}}` (optional) – any non-empty text (for example yes) for a screening batch that must return table rows; set exactly one of table_answer and direct_answer; `{{direct_answer}}` (optional) – any non-empty text (for example yes) for a direct question that must return a nonempty answer; `{{original_response}}` (optional) – the rejected response, at most 20,000 characters (it may be empty).
**Output:** A corrected response in the same format as the original request: one Markdown row for each requested index, or a nonempty answer to the question.
**Supplied to:** Rust service, execution.rs (response recording for execution jobs), re-sent to LLM Suite or M365 Copilot.
**Version:** 1

===@@=== STARTING ===@@===
The previous response failed strict parsing: {{error}}. {{#table_answer}}Return exactly one Markdown row for each requested index, in any order, with only the requested columns and no extra rows.{{/table_answer}}{{#direct_answer}}Return a nonempty answer to the original frozen question using only its approved context. Attribute claims and state unknown information explicitly.{{/direct_answer}} Original response:
{{original_response}}
===@@=== END ===@@===
