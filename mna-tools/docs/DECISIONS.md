# Decisions and delivery boundaries

This ledger separates confirmed screening rules from implementation choices. The current tool behavior is in [the tool reference](../TOOL_REFERENCE.md). A workflow rule here does not imply that an analyst UI or corporate provider connection is deployed.

| Area | Decision | Basis |
|---|---|---|
| Discovery | Search what a business does; keep the initial funnel broad. | Analyst rule |
| Deferred criteria | Record financial, size, geography, ownership, and classification conditions; do not use them in initial search or filtering. Report ignored legacy filters. | Analyst rule and implemented compatibility |
| Profile | A new run starts PROPOSED/DRAFT. Real analyst approval is required for discovery. Legacy `system_initialization` auto-approvals are invalidated on migration; true analyst approvals remain. | Approval boundary |
| Identity | Both IDs: `ECID-CID`; CID only: `X-CID`; ECID only: provisional `ECID-X`; neither: exclude and report. | Analyst rule, including ECID-only clarification |
| Merge | Promote only with exact identifier evidence; preserve aliases. A name or website alone does not merge companies. | Safe identity design |
| MID | Search descriptions and other core-business text by lexical, semantic, hybrid, or example similarity. A configured replaceable worker embeds the query; the index verifies model/version/text hash. | Analyst rule and tool boundary |
| Search bounds | Local default/maximum limit 1,000 and offset at most 1,000,000. ISCC query at most 14 words, default limit 1,000 and maximum 1,000; up to five plan variants. | Implemented bounds |
| ISCC score | Sample about three or four descriptions per available 0.9–0.3 band. Around 0.45 is a guide, never a hard cutoff or fit verdict. | Analyst rule |
| ISCC bridge | Rust sends only query and limit to a configured JSON gateway. Corporate browser/CDP and raw export conversion are external. | Available integration boundary |
| Candidate union | One candidate per company per run; keep separate source observations. Report MID-only, ISCC-only, both, `other` (no matching MID or current-run ISCC row), and unique total. Prefer usable MID common fields. | Analyst rule and implementation |
| Recommendation | Below 2,000 unique candidates: PitchBook. At 2,000 or more: LLM screening. | Analyst rule |
| Exports | Export all candidates across statuses. Use exact PITCHBOOK, LLM, MID, and ISCC sheet layouts. A new artifact never overwrites an old one. | Analyst rule and implementation |
| PitchBook mapping | Require full eight-column mapping header in row 1. Populate PBId only for `Company Profile = Yes`. | Analyst rule |
| PitchBook data | Detect real header, accept any four-digit copyright year, retain seven compact `PB_` fields and all wide columns in Parquet. | Analyst rule and implementation |
| ROGO | Prefer usable PB website. If it differs from the original, a miss cannot fall back to the original. Original fallback is allowed only when PB is absent or equivalent. Quarantine ambiguity. | Implemented safe join |
| Mixed uploads | Classify by headers and process mapping → PB data → ROGO; cap aggregate import at 250,000 rows. Count distinct-company coverage separately from rows. | Implemented contract |
| Plans | Use immutable graphs with 1–20 steps, dependencies, approved profile version, and scopes of at most 2,000 companies. Complete only with matching successful receipts. | Implemented contract |
| Human action | A direct analyst option or natural-language instruction can be recorded as approval without a second question. Agent-suggested external action needs a human decision. | Analyst rule and approval boundary |
| Labels | `label_company` remains available only for actual feedback and requires both API and analyst credentials on every HTTP route. | Implemented boundary |
| Screening | LLMSuite/Copilot are external. The v2 batch size is 1–200; a prepared plan reports `executed:false`. LinkedIn is optional for Copilot; a valid genuine PitchBook URL is included when available. Scores are 0–10 or `CHECK` with rationale; results do not label or change status. | Analyst rule and implementation |
| Bing | Use three to five approved fit questions. Completion needs a successful receipt for every scoped company/query pair. | Analyst rule and implementation |
| M365 | Company IDs stay local and derive the gateway company list. Completion checks every company/question pair; criteria-only research is supported. | Implemented contract |

## Current boundary

The service has 63 agent tools and 18 privileged operations. It implements the deterministic domain, source projection, typed-text and Markdown parsers, prepared-plan v2 approval, durable jobs/outbox/leases, the shared LLMSuite send gate, evidence verification, model-specific vector index, CPU embedding worker and generic provider transport. The companion UI prepares/approves actual backend jobs without dispatching corporate requests. Real model assets and corporate connections remain unverified; the production scheduler and LangGraph ports/checkpointer remain planned. See [the architecture](BACKEND_ARCHITECTURE.md) and [validation record](../IMPLEMENTATION.md).

Source-row records retain original JSON and source/query/run provenance, but not file/sheet/row locators. Prepared plans bind candidate/data hashes; candidate sets do not have a separate formal version entity. Exports do not have formal manifests or stable version-based reuse. Successful receipts aid recovery but do not give provider-wide exactly-once behavior. These remain possible future extensions; do not describe them as current guarantees.

## Integration questions

1. Confirm real MID columns, ECID/CID formats, search scale, and embedding source against representative files.
2. Test the corporate ISCC browser/export bridge and its JSON normalization against real responses, scores, and failures.
3. Validate PitchBook and ROGO header variants, repeated sheets, and conflicting websites with representative deliveries.
4. Connect the external LLMSuite/Copilot contracts and test score, rationale, custom-column, and LinkedIn handling.
5. Connect an authenticated analyst identity system to profile, plan, and label operations in the controller.

Missing research or a provider failure remains unknown. It must not become a negative investment conclusion.
