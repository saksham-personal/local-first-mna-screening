# Controller loop turn

**ID:** controller-loop-turn
**Description:** Send one discovery-loop turn on a continuing conversation.
**What it does:** Delivers the observations from the previous instruction set, the refreshed loop state, and, near the end, the consolidation notice. Asks for the next instruction set in the shape set by `controller-loop`.
**Context:** `mna-tools/src/controller_loop.rs` sends this for turns 2..N on the continuing LLM Suite conversation id that received `controller-loop`. After the conversation rotates, the loop sends `controller-loop` again instead.
**Inputs:** `{{turn_label}}` (required) – for example `Turn 7 of 50 (43 remaining)`; `{{loop_state}}` (required) – criteria, query table with thresholds and kept counts, consolidated count; `{{observations}}` (optional) – compact results of the last instruction set, including rejected or failed items; `{{budget_notice}}` (optional) – the consolidation instruction sent when few turns remain.
**Output:** Markdown Context, Reasoning, and Instruction set sections, with optional Notes for the analyst.
**Version:** 1

===@@=== STARTING ===@@===
{{turn_label}}. Continue the discovery loop with the same rules and response shape.
{{#observations}}

Observations from your last instruction set:
{{observations}}
{{/observations}}

Loop state:
{{loop_state}}
{{#budget_notice}}

{{budget_notice}}
{{/budget_notice}}

Decide the next instruction set. Set or adjust keep thresholds from the samples, add or narrow queries where the samples show gaps or noise, and call finish_loop once the kept set is stable.
===@@=== END ===@@===
