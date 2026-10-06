# Criteria from research

**ID:** criteria-from-research
**What it does:** Asks LLM Suite to propose revised core-business criteria using a research answer the analyst chose to add. Research is a lead that still needs analyst review: unsupported claims and non-business conditions stay as review notes. The result is a draft for the analyst to review and approve; nothing is applied automatically.
**Inputs:** `{{definition}}` (required) – the current business definition draft; `{{research_question}}` (required) – the question that was researched; `{{research_result}}` (required) – the research answer the analyst selected; `{{criteria_text}}` (optional) – the analyst criteria as written, when different from the definition; `{{good_fits}}` (optional) – good-fit examples; `{{bad_fits}}` (optional) – bad-fit examples; `{{deferred}}` (optional) – deferred conditions, context only; `{{request}}` (optional) – an extra analyst instruction.
**Output:** Exactly BEGIN_CRITERIA, the revised criteria prose, END_CRITERIA and nothing else (the gateway format criteria).
**Supplied to:** LLM Suite through POST /api/conversation/generate with purpose criteria-from-research.
**Version:** 1

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
Propose revised core-business criteria using this analyst-selected research. Keep unsupported claims and non-business conditions as review notes. Do not treat research leads as verified facts. Preserve geography, revenue, ownership, size, and industry codes as analyst review notes, not core-business criteria or search filters.
Return exactly:
BEGIN_CRITERIA
<criteria prose>
END_CRITERIA
No other text or JSON.
===@@=== END ===@@===
