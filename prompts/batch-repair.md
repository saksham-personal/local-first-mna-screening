# Batch repair

**ID:** batch-repair
**Description:** Repair a rejected provider response.
**What it does:** Repeats the parser error and rejected reply. Requests the original output shape on a retry.
**Context:** `mna-tools/src/execution.rs` `record_inner` supplies the parse error and original reply after a batch fails. Retry on the same continuing LLM Suite conversation id or original M365 Copilot request.
**Inputs:** `{{error}}` (required) – the parser's error message; `{{table_answer}}` (optional) – any non-empty text (for example yes) for a screening batch that must return table rows; set exactly one of table_answer and direct_answer; `{{direct_answer}}` (optional) – any non-empty text (for example yes) for a direct question that must return a nonempty answer; `{{original_response}}` (optional) – the rejected response, at most 20,000 characters (it may be empty).
**Output:** A corrected response in the same format as the original request: one Markdown row for each requested index, or a nonempty answer to the question.
**Version:** 2

===@@=== STARTING ===@@===
The response failed parsing: {{error}}. {{#table_answer}}Return exactly one Markdown row for each requested index, in any order, with only the requested columns and no extra rows.{{/table_answer}}{{#direct_answer}}Return a nonempty answer to the original frozen question using only its approved context. Attribute claims and state unknown information explicitly.{{/direct_answer}} Original response:
{{original_response}}
===@@=== END ===@@===
