# Format repair

**ID:** format-repair
**What it does:** The retry prompt for generated drafts (screening prompts, Bing query templates, criteria and direct text answers). When the provider's reply does not match the required block format, the original prompt is sent again with the format error appended. The gateway repeats this at most twice, each time through the shared LLM Suite rate gate.
**Inputs:** `{{prompt}}` (required) – the original prompt text exactly as first sent; `{{format_error}}` (required) – the validation message describing what was wrong with the reply.
**Output:** A corrected reply in the format the original prompt asked for.
**Supplied to:** Rust service, gateway.rs text dispatch (dispatch_provider_text), re-sent to LLM Suite or M365 Copilot.
**Version:** 1

===@@=== STARTING ===@@===
{{prompt}}

Correct the output format: {{format_error}}
===@@=== END ===@@===
