# Tool command repair

**ID:** tool-command-repair
**What it does:** The retry instruction returned to the screening controller when its text tool command is rejected. It states why the command failed (bounded to 240 characters and stripped of control characters by the caller), lists the allowed tool names (at most 32) and restates the command grammar. The controller decides whether another attempt is allowed; there are at most two repairs.
**Inputs:** `{{reason}}` (required) – the rejection reason; `{{allowed_names}}` (required) – the allowed tool names, comma-separated.
**Output:** Exactly one BEGIN TOOL v1 block, with no prose.
**Supplied to:** Rust service, protocol.rs repair_prompt, returned through the agent command route to the controller (LLM Suite).
**Version:** 1

===@@=== STARTING ===@@===
Your tool command was rejected: {{reason}}. Emit exactly one BEGIN TOOL v1 <name> ... END TOOL block with no prose. Allowed names: {{allowed_names}}. Each field must be path:type = value. Use text with quoted escapes or <<TAG multiline text; number, boolean, null, empty-list, and empty-map are the other types. Correct the command and retry.
===@@=== END ===@@===
