# MID search planner

**ID:** mid-search-planner
**Description:** Plan broad MID keyword searches.
**What it does:** Plans several core-business keyword groups from approved criteria. Limits exclusion terms to approved core-business exclusions.
**Context:** Reserved for a new or continuing LLM Suite planning conversation id. A future Rust caller supplies approved criteria; no caller sends this yet.
**Inputs:** `{{definition}}` (required) – the approved core-business criteria; `{{good_fits}}` (optional) – good-fit examples, one per line; `{{bad_fits}}` (optional) – bad-fit examples, one per line; `{{exclusions}}` (optional) – the approved core-business exclusions, one per line (the only terms allowed after AND NOT); `{{deferred}}` (optional) – deferred conditions, context only, never keywords.
**Output:** Exactly BEGIN_SEARCHES, two to four SEARCH blocks (SEARCH, RATIONALE, KEYWORD lines, EXPRESSION), END_SEARCHES and nothing else. The Rust text-format parser for this block is not written yet.
**Version:** 2

===@@=== STARTING ===@@===
Approved core-business criteria:
{{definition}}

{{#good_fits}}
Good-fit examples:
{{good_fits}}

{{/good_fits}}
{{#bad_fits}}
Bad-fit examples:
{{bad_fits}}

{{/bad_fits}}
{{#exclusions}}
Approved core-business exclusions (the only terms allowed after AND NOT):
{{exclusions}}

{{/exclusions}}
{{#deferred}}
Deferred conditions (context only; never use these as keywords):
{{deferred}}

{{/deferred}}
Write 2 to 4 broad searches over company descriptions, covering different ways to describe the approved core business.
- Search only the core business: products, services, customers and workflows. Never search on geography, revenue, ownership, size, or industry codes.
- Give each search a one-sentence RATIONALE of at most 300 characters.
- Give each search 1 to 50 numbered KEYWORD lines. A keyword is a word or a short phrase; a trailing * makes it a prefix. The weight is a positive number (use 1 when unsure); give higher weights to the most specific phrases. The match type is stem (word variants) or exact.
- EXPRESSION combines the keyword numbers with AND, OR, parentheses and AND NOT, for example (1 OR 2) AND 3. Use every keyword number. Use AND NOT only with an approved exclusion listed above; if none is listed, do not use NOT.
- Prefer recall; later steps score and filter.
Return exactly:
BEGIN_SEARCHES
SEARCH: <short title>
RATIONALE: <one sentence>
KEYWORD: 1 | <text> | <weight> | <stem or exact>
KEYWORD: 2 | <text> | <weight> | <stem or exact>
EXPRESSION: (1 OR 2) AND 3
SEARCH: <next search, same layout>
END_SEARCHES
No other text or JSON.
===@@=== END ===@@===
