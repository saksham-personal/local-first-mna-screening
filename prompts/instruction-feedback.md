# Instruction feedback

**ID:** instruction-feedback
**Description:** Repair rejected controller instructions.
**What it does:** Provides validation feedback for rejected items. Requests corrected items in the same Markdown shape without repeating accepted work.
**Context:** `mna-tools/src/controller.rs` sends this on the same continuing conversation id after validation rejects items (at most two rounds per turn), with the validator messages and allowed actions.
**Inputs:** `{{feedback}}` (required) – parser or validator messages; `{{allowed_actions}}` (required) – valid action names and fields.
**Output:** Corrected Markdown Context, Reasoning, and Instruction set sections for rejected items only.
**Version:** 2

===@@=== STARTING ===@@===
Correct only the rejected instructions below. Accepted instructions already ran; do not repeat them. Fix the named field or action, keep the original intent, and drop an item rather than guess when it cannot be made valid. Use:
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
