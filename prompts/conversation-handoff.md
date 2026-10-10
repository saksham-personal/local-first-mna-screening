# Conversation hand-off

**ID:** conversation-handoff
**Description:** Carry screening state into a new controller conversation.
**What it does:** Summarizes the run state and recent decisions compactly. Distinguishes approved facts from unverified leads and work still pending.
**Context:** `mna-tools/src/controller.rs` (and the discovery loop) sends this on the old conversation id when the context budget is reached; the returned summary seeds the new conversation id.
**Inputs:** `{{run_summary}}` (required) – criteria revision, approvals, counts, recent results, and pending work; `{{recent_decisions}}` (required) – recent analyst decisions and controller outcomes; `{{loop_state}}` (optional) – the discovery loop's query table, thresholds, and turn budget when a loop is running.
**Output:** A concise Markdown state summary for the new conversation.
**Version:** 2

===@@=== STARTING ===@@===
Summarize this screening state for a new conversation. Use concise Markdown with headings `## Approved state`, `## Results and open work`, and `## Recent decisions`. Preserve exact criteria revision, approval status, counts, and known outcomes. Mark research leads as unverified. Do not invent results, approvals, actions, or a new analyst decision. Keep the summary under 150 words.{{#loop_state}} Add `## Loop state` and copy the loop state below exactly; the system also resends it, so do not summarize it.{{/loop_state}}

Run state:
{{run_summary}}

Recent decisions:
{{recent_decisions}}
{{#loop_state}}

Loop state:
{{loop_state}}
{{/loop_state}}
===@@=== END ===@@===
