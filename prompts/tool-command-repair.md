# Tool command repair

**ID:** tool-command-repair
**Description:** Repair a rejected legacy controller command.
**What it does:** States the rejection reason and allowed command names. Requests one corrected command in the same grammar.
**Context:** Rust protocol supplies the reason and allowed names after a rejected command. Send to the same continuing LLM Suite controller conversation id.
**Inputs:** `{{reason}}` (required) – the rejection reason; `{{allowed_names}}` (required) – the allowed tool names, comma-separated.
**Output:** Exactly one BEGIN TOOL v1 block, with no prose.
**Version:** 2

===@@=== STARTING ===@@===
Your tool command was rejected: {{reason}}. Emit exactly one BEGIN TOOL v1 <name> ... END TOOL block with no prose. Allowed names: {{allowed_names}}. Each field must be path:type = value. Use text with quoted escapes or <<TAG multiline text; number, boolean, null, empty-list, and empty-map are the other types. Return the corrected command.
===@@=== END ===@@===
