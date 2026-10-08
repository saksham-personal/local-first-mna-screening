# Criteria from examples

**ID:** criteria-from-examples
**Description:** Revise draft criteria from fit examples.
**What it does:** Uses good and bad examples to refine core-business criteria. Keeps other conditions as review notes for analyst approval.
**Context:** `POST /api/conversation/generate` purposes `criteria` and `criteria-from-examples` call `provider-conversation.mjs` `generate` with analyst criteria and examples. Send on the continuing LLM Suite conversation id, or a new id if none exists.
**Inputs:** `{{definition}}` (required) – the current business definition draft (the caller falls back to the analyst criteria or request when no definition exists); `{{criteria_text}}` (optional) – the analyst criteria as written, when different from the definition; `{{good_fits}}` (optional) – good-fit examples; `{{bad_fits}}` (optional) – bad-fit examples; `{{deferred}}` (optional) – deferred conditions, context only; `{{request}}` (optional) – an extra analyst instruction (the older free-text callers put their whole request here).
**Output:** Exactly BEGIN_CRITERIA, the revised criteria prose, END_CRITERIA and nothing else (the gateway format criteria).
**Version:** 2

===@@=== STARTING ===@@===
Business definition (current draft):
{{definition}}

{{#criteria_text}}
Analyst criteria as written:
{{criteria_text}}

{{/criteria_text}}
{{#good_fits}}
Good-fit examples:
{{good_fits}}

{{/good_fits}}
{{#bad_fits}}
Bad-fit examples:
{{bad_fits}}

{{/bad_fits}}
{{#deferred}}
Deferred conditions (keep as review notes):
{{deferred}}

{{/deferred}}
{{#request}}
Analyst request:
{{request}}

{{/request}}
Draft editable criteria describing only the core business: what companies sell, to whom, and how. Adjust the criteria to cover what the good fits share and exclude what the bad fits show; use examples as references, not a required list, and do not invent facts about them. Keep geography, revenue, ownership, size, and industry codes as review notes, never search filters.
Return exactly:
BEGIN_CRITERIA
<criteria prose>
END_CRITERIA
No other text or JSON.
===@@=== END ===@@===
