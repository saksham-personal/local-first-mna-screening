# Screening prompt writer

**ID:** screening-prompt-writer
**What it does:** Asks LLM Suite to draft a concise, analyst-editable screening prompt from the criteria, examples, deferred conditions and analyst request. The generated draft is only a starting point: the analyst edits and approves it, and the output table format is added later by output-contract.md.
**Inputs:** `{{definition}}` (required) – the business definition (the caller falls back to the analyst criteria or request when no definition exists); `{{criteria_text}}` (optional) – the analyst criteria as written, when different from the definition; `{{good_fits}}` (optional) – good-fit examples; `{{bad_fits}}` (optional) – bad-fit examples; `{{deferred}}` (optional) – deferred conditions, context only; `{{request}}` (optional) – the analyst request or the current prompt to improve; `{{output_columns}}` (optional) – the requested output columns after index, comma-separated; `{{score_columns}}` (optional) – the requested score columns, comma-separated; when present the unified score rule must be stated in the draft.
**Output:** Exactly BEGIN_PROMPT, the prompt prose, END_PROMPT and nothing else (the gateway format screening_prompt).
**Supplied to:** LLM Suite through POST /api/conversation/generate with purpose screening-prompt, from the "Generate prompt with AI" button in screening setup.
**Version:** 1

===@@=== STARTING ===@@===
You are drafting a screening prompt for an M&A analyst. The analyst will edit and approve it, and it will then be sent to an LLM that screens many companies, one batch at a time.

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
Draft a concise, analyst-editable screening prompt for qualitative core-business fit. Cite uncertainty. When examples are given, use them to explain what is in and out of scope. Geography, revenue, ownership, size, and industry codes are deferred review criteria; the prompt must say not to filter or score on them. Do not describe the output table format; the system adds it.
{{#score_columns}}
Because the output includes {{score_columns}}, the prompt must state this score rule word for word: Fit Score is a number from 0 to 10, or the literal CHECK. 0–2: little evidence of fit. 3–4: weak or partial fit. 5–6: plausible fit. 7–8: strong fit. 9–10: direct, well-supported fit. Use CHECK when the supplied information is insufficient or contradictory; CHECK is not a poor fit. Retrieval scores (MID, ISCC, semantic) are not fit scores. Do not filter on financials, size, geography, ownership, or industry codes.
{{/score_columns}}
Return exactly:
BEGIN_PROMPT
<prompt prose>
END_PROMPT
No other text or JSON.
===@@=== END ===@@===
