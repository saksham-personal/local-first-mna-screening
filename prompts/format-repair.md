# Format repair

**ID:** format-repair
**Description:** Repair a generated draft's format.
**What it does:** Repeats the original prompt and its format error. Requests a corrected reply in the original format.
**Context:** `mna-tools/src/gateway.rs` `provider_text` supplies the original request and parse error after a rejected draft. Retry on the same continuing LLM Suite conversation id or M365 Copilot request.
**Inputs:** `{{prompt}}` (required) – the original prompt text exactly as first sent; `{{format_error}}` (required) – the validation message describing what was wrong with the reply.
**Output:** A corrected reply in the format the original prompt asked for.
**Version:** 2

===@@=== STARTING ===@@===
{{prompt}}

Correct the output format: {{format_error}}
===@@=== END ===@@===
