# Screening prompt writer

**ID:** screening-prompt-writer
**Description:** Draft an editable screening prompt.
**What it does:** Creates a core-business screening draft from analyst criteria and examples. Leaves final editing and approval to the analyst.
**Context:** The bridge supplies analyst criteria for prompt drafting. Send in the continuing LLM Suite conversation id, or start a new id if none exists.
**Inputs:** `{{definition}}` (required) – the business definition (the caller falls back to the analyst criteria or request when no definition exists); `{{criteria_text}}` (optional) – the analyst criteria as written, when different from the definition; `{{good_fits}}` (optional) – good-fit examples; `{{bad_fits}}` (optional) – bad-fit examples; `{{deferred}}` (optional) – deferred conditions, context only; `{{request}}` (optional) – the analyst request or the current prompt to improve; `{{output_columns}}` (optional) – the requested output columns after index, comma-separated; `{{score_columns}}` (optional) – the requested score columns, comma-separated; when present the unified score rule must be stated in the draft.
**Output:** Exactly BEGIN_PROMPT, the prompt prose, END_PROMPT and nothing else (the gateway format screening_prompt).
**Version:** 2

===@@=== STARTING ===@@===
Draft a screening prompt for an M&A analyst to edit and approve for company batches.

Business definition:
{{definition}}

{{#criteria_text}}
Analyst criteria:
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
Deferred conditions (context only; the prompt must not score on them):
{{deferred}}

{{/deferred}}
{{#request}}
Additional request:
{{request}}

{{/request}}
{{#output_columns}}
Requested output columns: {{output_columns}}.

{{/output_columns}}
Draft concise core-business fit instructions. Cite uncertainty and use examples to clarify scope. Do not filter or score on geography, revenue, ownership, size, or industry codes. The system adds the output table format.
{{#score_columns}}
Because the output includes {{score_columns}}, the prompt must state this score rule word for word: Fit Score is a number from 0 to 10, or the literal CHECK. 0–2: little evidence of fit. 3–4: weak or partial fit. 5–6: plausible fit. 7–8: strong fit. 9–10: direct, well-supported fit. Use CHECK when the supplied information is insufficient or contradictory; CHECK is not a poor fit. Retrieval scores (MID, ISCC, semantic) are not fit scores. Do not filter on financials, size, geography, ownership, or industry codes.
{{/score_columns}}
Return exactly:
BEGIN_PROMPT
<prompt prose>
END_PROMPT
No other text or JSON.
===@@=== END ===@@===
