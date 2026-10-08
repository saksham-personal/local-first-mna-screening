# Format repair

**ID:** format-repair
**Description:** Repair a generated draft's format.
**What it does:** Repeats the original prompt and its format error. Requests a corrected reply in the original format.
**Context:** The Rust gateway supplies the original request and error after a rejected draft. Send to the same continuing LLM Suite conversation id or M365 Copilot request.
**Inputs:** `{{prompt}}` (required) – the original prompt text exactly as first sent; `{{format_error}}` (required) – the validation message describing what was wrong with the reply.
**Output:** A corrected reply in the format the original prompt asked for.
**Version:** 2

===@@=== STARTING ===@@===
{{prompt}}

Fix the output format: {{format_error}}
===@@=== END ===@@===
