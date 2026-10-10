# Controller loop budget notice

**ID:** controller-loop-budget
**Description:** Tell the loop to reserve its last turns for consolidation.
**What it does:** Produces the notice inserted into loop prompts once few turns remain. It stops new exploration and asks the model to confirm thresholds, drop clear misfits, and finish before the cap.
**Context:** `mna-tools/src/controller_loop.rs` renders this when the remaining turns are at most 5 and passes the text as `budget_notice` to `controller-loop` or `controller-loop-turn`.
**Inputs:** `{{remaining}}` (required) – turns left including this one; `{{final_turn}}` (required) – the last turn number; `{{unkept_queries}}` (optional) – queries that have observations but no keep decision yet.
**Output:** Plain notice text inserted into the loop prompt.
**Version:** 1

===@@=== STARTING ===@@===
TURN BUDGET: {{remaining}} turns left. Reserve them to consolidate; do not start new lines of search.
1. Give every useful query a keep threshold with keep_query_results, or leave it unkept on purpose.
2. Drop clear misfits that pass a threshold.
3. Call finish_loop by turn {{final_turn}}. If you do not, the system consolidates the decisions you have recorded so far; anything without a keep decision is left out.
{{#unkept_queries}}
Queries with observations but no keep decision yet: {{unkept_queries}}
{{/unkept_queries}}
===@@=== END ===@@===
