# Bing query writer

**ID:** bing-query-writer
**Description:** Draft Bing search templates for a business fit check.
**What it does:** Turns criteria into short queries about a company's products and customers. Preserves single-brace company placeholders.
**Context:** `POST /api/conversation/generate` purpose `bing-templates` calls `provider-conversation.mjs` `generate` with analyst criteria. Send on the continuing LLM Suite conversation id, or a new id if none exists.
**Inputs:** `{{definition}}` (required) – the business definition (the caller falls back to the analyst criteria or request when no definition exists); `{{criteria_text}}` (optional) – the analyst criteria as written, when different from the definition; `{{good_fits}}` (optional) – good-fit examples; `{{bad_fits}}` (optional) – bad-fit examples; `{{request}}` (optional) – an additional analyst request.
**Output:** Exactly BEGIN_QUERIES, one to five lines starting with QUERY:, END_QUERIES and nothing else (the gateway format query_templates).
**Version:** 3

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
Write one to five distinct Bing queries about the company's core products, services, and customers. Give each query its own angle (what it sells, who buys it, how it is delivered, or the closest adjacent business to rule out) so the answers can confirm or reject a fit.
- Write each query as a grammatical question or phrase about the company, for example: Does {company} sell claims management software to insurance carriers? Website: {website}
- Phrase the definition about the company. Never paste the definition into a query word for word, and drop lead-ins such as "Find companies that".
- Use only the placeholders {company}, {website}, or <company>, and include at least one of them in every query.
- Do not search on geography, revenue, ownership, size, or industry codes.
Return exactly:
BEGIN_QUERIES
QUERY: <first query>
QUERY: <next query if needed>
END_QUERIES
No other text or JSON.
===@@=== END ===@@===
