# Criteria from research

**ID:** criteria-from-research
**Description:** Revise draft criteria from selected research.
**What it does:** Uses an analyst-selected research lead to propose core-business criteria. Marks unsupported claims for review and leaves approval to the analyst.
**Context:** `POST /api/conversation/generate` purpose `criteria-from-research` calls `provider-conversation.mjs` `generate` with analyst-selected research and criteria. Send on the continuing LLM Suite conversation id, or a new id if none exists.
**Inputs:** `{{definition}}` (required) – the current business definition draft; `{{research_question}}` (required) – the question that was researched; `{{research_result}}` (required) – the research answer the analyst selected; `{{criteria_text}}` (optional) – the analyst criteria as written, when different from the definition; `{{good_fits}}` (optional) – good-fit examples; `{{bad_fits}}` (optional) – bad-fit examples; `{{deferred}}` (optional) – deferred conditions, context only; `{{request}}` (optional) – an extra analyst instruction.
**Output:** Exactly BEGIN_CRITERIA, the revised criteria prose, END_CRITERIA and nothing else (the gateway format criteria).
**Version:** 3

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
Research question:
{{research_question}}

Research result (a lead that still needs analyst review, not a verified fact):
{{research_result}}

{{#request}}
Analyst request:
{{request}}

{{/request}}
Draft core-business criteria from this analyst-selected lead: what companies sell, to whom, and how it is delivered. Use the lead to sharpen scope (offerings, customer types, adjacent businesses to exclude), not to add facts about specific companies. Research leads are not verified facts; keep unsupported claims and non-business conditions as review notes. Write 3–6 short sentences. Geography, revenue, ownership, size, and industry codes are review notes, never search filters.
Return exactly:
BEGIN_CRITERIA
<criteria prose>
END_CRITERIA
No other text or JSON.
===@@=== END ===@@===
