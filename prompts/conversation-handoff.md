# Conversation hand-off

**ID:** conversation-handoff
**Description:** Carry screening state into a new controller conversation.
**What it does:** Summarizes the run state and recent decisions compactly. Distinguishes approved facts from unverified leads and work still pending.
**Context:** Sent when rotating to a new LLM Suite controller conversation id before context fills; the caller supplies saved state and decisions, then seeds the new conversation with the summary.
**Inputs:** `{{run_summary}}` (required) – criteria revision, approvals, counts, recent results, and pending work; `{{recent_decisions}}` (required) – recent analyst decisions and controller outcomes.
**Output:** A concise Markdown state summary for the new conversation.
**Version:** 1

===@@=== STARTING ===@@===
Summarize this screening state for a new conversation. Use concise Markdown with headings `## Approved state`, `## Results and open work`, and `## Recent decisions`. Preserve exact criteria revision, approval status, counts, and known outcomes. Mark research leads as unverified. Do not invent results, approvals, actions, or a new analyst decision. Keep the summary under 150 words.

Run state:
{{run_summary}}

Recent decisions:
{{recent_decisions}}
===@@=== END ===@@===
