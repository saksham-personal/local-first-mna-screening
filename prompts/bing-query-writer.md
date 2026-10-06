# Bing query writer

**ID:** bing-query-writer
**What it does:** Asks LLM Suite to write one to five Bing search query templates that test whether a company's core business matches the criteria. Each template must read as a grammatical question or phrase about the company and carry a {company} or {website} placeholder; the criteria sentence must never be pasted in word for word.
**Inputs:** `{{definition}}` (required) – the business definition (the caller falls back to the analyst criteria or request when no definition exists); `{{criteria_text}}` (optional) – the analyst criteria as written, when different from the definition; `{{good_fits}}` (optional) – good-fit examples; `{{bad_fits}}` (optional) – bad-fit examples; `{{request}}` (optional) – an additional analyst request.
**Output:** Exactly BEGIN_QUERIES, one to five lines starting with QUERY:, END_QUERIES and nothing else (the gateway format query_templates).
**Supplied to:** LLM Suite through POST /api/conversation/generate with purpose bing-templates, from "Generate with AI" in Bing research.
**Version:** 1

===@@=== STARTING ===@@===
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
{{#request}}
Additional request:
{{request}}

{{/request}}
Create one to five distinct Bing search query templates that test whether a company's core business matches the definition above. Focus on core business, products, and customers.
- Write each query as a grammatical question or phrase about the company, for example: Does {company} sell claims management software to insurance carriers? Website: {website}
- Turn the definition into a statement about the company. Never paste the definition into a query word for word, and drop lead-ins such as "Find companies that".
- Use only the placeholders {company}, {website}, or <company>, and include at least one of them in every query.
- Geography, revenue, ownership, size, and industry codes are deferred review criteria, not search filters.
Return exactly:
BEGIN_QUERIES
QUERY: <first query>
QUERY: <next query if needed>
END_QUERIES
No other text or JSON.
===@@=== END ===@@===
