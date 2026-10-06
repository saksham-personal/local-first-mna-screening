# Criteria from examples

**ID:** criteria-from-examples
**What it does:** Asks LLM Suite to revise the core-business criteria so they reflect the analyst's good-fit and bad-fit examples. Deferred conditions (geography, size, ownership and similar) stay as review notes and are never turned into core-business criteria. The result is a draft for the analyst to review and approve; nothing is applied automatically.
**Inputs:** `{{definition}}` (required) – the current business definition draft (the caller falls back to the analyst criteria or request when no definition exists); `{{criteria_text}}` (optional) – the analyst criteria as written, when different from the definition; `{{good_fits}}` (optional) – good-fit examples; `{{bad_fits}}` (optional) – bad-fit examples; `{{deferred}}` (optional) – deferred conditions, context only; `{{request}}` (optional) – an extra analyst instruction (the older free-text callers put their whole request here).
**Output:** Exactly BEGIN_CRITERIA, the revised criteria prose, END_CRITERIA and nothing else (the gateway format criteria).
**Supplied to:** LLM Suite through POST /api/conversation/generate with purpose criteria-from-examples. The older purpose criteria, with a free-text request, uses this file too.
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
{{#request}}
Analyst request:
{{request}}

{{/request}}
Draft clear, analyst-editable core-business screening criteria. Describe only the core business: what the company sells, to whom, and how. When good-fit or bad-fit examples are given, adjust only the core-business criteria so they cover what the good fits have in common and leave out what the bad fits show; treat the examples as references, not as a required list. Preserve geography, revenue, ownership, size, and industry codes as analyst review notes, not core-business criteria or search filters. Do not invent facts about the examples.
Return exactly:
BEGIN_CRITERIA
<criteria prose>
END_CRITERIA
No other text or JSON.
===@@=== END ===@@===
