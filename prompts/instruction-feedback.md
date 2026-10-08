# Instruction feedback

**ID:** instruction-feedback
**Description:** Repair rejected controller instructions.
**What it does:** Provides validation feedback for rejected items. Requests corrected items in the same Markdown shape without repeating accepted work.
**Context:** Reserved for the future LLM Suite controller loop after instruction validation rejects items; no caller sends it yet. The future controller supplies feedback and allowed actions on the same continuing conversation id.
**Inputs:** `{{feedback}}` (required) – parser or validator messages; `{{allowed_actions}}` (required) – valid action names and fields.
**Output:** Corrected Markdown Context, Reasoning, and Instruction set sections for rejected items only.
**Version:** 1

===@@=== STARTING ===@@===
Correct only the rejected instructions below. Keep accepted instructions out of the reply. Use:
## Context
1–3 sentences.
## Reasoning
One short explanation.
## Instruction set
1. **action_name** — short title
   - field: value
Separate list values with `;`. Use only allowed actions and fields. If no valid correction is possible, write `## Instruction set` followed by `None.`. Optional `## Notes for the analyst` may explain what needs analyst input.

Feedback:
{{feedback}}

Allowed actions:
{{allowed_actions}}
===@@=== END ===@@===
