# Analyst operating instructions

These instructions use short sentences and stable terms. They are inspired by [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/STE_faq.html). They have not been checked against its approved-word dictionary and do not claim formal compliance. The UI, DDI reader, and external screening services named here are integration components. See [the workflow](WORKFLOW.md) and [the tool reference](../TOOL_REFERENCE.md) for details.

## Terms

| Term | Meaning |
|---|---|
| Run | One project with original criteria, profile versions, candidates, and research. |
| Profile | The structured criteria for a run. Discovery uses an analyst-approved version. |
| Source row | A MID or ISCC record. |
| Candidate | One company selected into a run. |
| `pk` | The internal company ID used in exports. |
| Source observation | One result from one query. |
| Deferred criterion | A screening condition recorded but unused in first-pass discovery. |
| Receipt | A successful tool operation record used to complete a plan step. |
| `CHECK` | A screening score that requires review; it is not a number. |

## A. Start and approve a run

1. The analyst supplies DDI content or plain-text criteria.
2. The controller stores the original input. A separate component extracts DDI files.
3. The agent writes the proposed core-business profile and lists unclear terms.
4. The agent lists financial, size, geographic, ownership, and classification conditions as deferred criteria.
5. The agent asks a focused question if an answer can change discovery.
6. If the analyst skips a nonblocking question, the agent keeps it open. A blocking question needs an answer or an authorized assumption.
7. The controller shows both used and deferred criteria.
8. The analyst approves the profile or requests a new proposal. The trusted controller records approval at `/admin/profiles/approve`.

**Check:** A new run starts PROPOSED/DRAFT. MID, ISCC, and similarity discovery cannot start until a real analyst approval exists. An agent proposal does not approve itself.

## B. Search MID and ISCC

1. The agent reads `get_search_policy` and makes qualitative queries from products, services, descriptions, and examples.
2. The agent calls `search_mid` for MID. It uses lexical, semantic, or hybrid mode as available. A configured local embedder and its fresh index support semantic search. Without them, semantic search reports unavailable.
3. The agent pages local search with at most 1,000 results per call and offset at most 1,000,000.
4. The agent makes up to five distinct ISCC query variants per plan.
5. Each ISCC query has at most 14 qualitative words, normally 10–12. Each call requests 1–1,000 results; the default is 1,000.
6. The agent calls `get_iscc_score_samples` and reads about three or four descriptions near each available band from 0.9 through 0.3.
7. The agent chooses broad candidate coverage from the sampled descriptions. It does not use 0.45 as a fixed cutoff.

**Check:** Each search has query and source provenance. Non-core filters are ignored and reported. A score does not state that a company fits.

## C. Resolve IDs and add candidates

1. The service normalizes ECID and CID and retains the raw source row.
2. Both IDs give `ECID-CID`. CID alone gives `X-CID`. ECID alone gives provisional `ECID-X`.
3. The service excludes and reports a row with neither ID.
4. The service promotes an alias only with an exact identifier bridge. It quarantines conflicts. Name or website alone does not merge companies.
5. The agent adds selected IDs with `add_candidates` and their search provenance.
6. The agent reads `get_discovery_summary` and shows unique total, MID-only, ISCC-only, both-source, and `other` counts.
7. If the analyst requests more targets, the agent repeats the searches and adds new IDs.

**Check:** Each company occurs once in the run's candidate list. Original source JSON and query/run provenance remain available through `get_source_rows`. File/sheet/row locators are not persisted in that record.

## D. Select and approve next work

1. The controller shows the approved profile, deferred criteria, counts, and known gaps.
2. Below 2,000 unique candidates, it recommends PitchBook enrichment. At 2,000 or more, it recommends LLM screening.
3. The analyst selects an action or gives a natural-language instruction.
4. The agent proposes a typed action plan with 1–20 steps, dependencies, and scopes of at most 2,000 companies.
5. The trusted controller records the analyst's direct request as the plan approval. It does not ask the same question again.
6. If the agent suggested an external research action, the controller obtains a human decision before approval.
7. The executor runs a step after its dependencies succeed. It calls `complete_action_step` with the matching successful receipts.

**Check:** A failed call cannot complete a step. A profile change makes a prepared plan stale. The companion UI supports this local review.

## E. Import enrichment files

1. The analyst stages one or more CSV/XLSX files. The import call accepts at most 250,000 aggregate rows.
2. The importer classifies file roles by headers, not names.
3. A PitchBook mapping CSV must have all eight required columns in row 1. It adds PBId only when `Company Profile` is `Yes`.
4. The importer detects the real PitchBook data header and ignores a copyright cell with any four-digit year.
5. It joins data by eligible PBId, stores seven compact `PB_` fields, and writes wide columns to Parquet.
6. The importer finds the topmost ROGO website header across sheets.
7. It tries a usable `PB_Website`. If it differs from the original website and has no match, it does not retry the original website.
8. It uses the original website only if the PB website is absent or normalizes to the same value. It quarantines ambiguous matches.

**Check:** Review rows read and distinct companies covered separately. `pbid_populated` counts newly added IDs only. A mixed upload runs mapping, then PitchBook data, then ROGO.

## F. Export

1. The analyst selects PitchBook, LLM, or Full Export.
2. The controller calls `export_candidate_set`. The service includes all candidate statuses and creates a new XLSX file without overwriting a file.
3. For PitchBook, check sheet `PITCHBOOK`: `pk`, `Company Name`, `Website`, `HQ City`, `HQ State`, `Source`.
4. For LLM, check sheet `LLM`: `index`, `pk`, `Company Name`, `Website`, `Source`, `Description`. `index` runs from 1 through N.
5. For Full, check sheets `MID` and `ISCC`. Each starts with `pk` and then original columns. ISCC rows come from the current run.

**Check:** Compact exports have one row per unique candidate. Full Export keeps selected source rows. Keep the returned artifact reference for recovery; there is no formal candidate-set version or manifest.

## G. Screen or research

1. The agent calls `propose_prepared_plan` for scored screening or a general question. Keep index first. Choose source fields, output fields, deployment and batch size from 1 through 200.
2. The controller shows actual selected values and the complete execution prompt. Use PB name and website independently when available. Combine labeled source descriptions. For M365, include genuine PB LinkedIn if it exists; missing LinkedIn does not block a plan.
3. The analyst approves the exact digest. The service stores immutable inputs, global index maps, jobs and outbox records. The handoff shows `executed:false`. An upload or edit requires a new preview and approval.
4. The trusted executor leases a job and consumes provider capacity immediately before sending. LLMSuite shares seven sends per rolling minute. The model returns index plus requested columns. Rust validates every row and joins with the frozen map. It quarantines invalid output and permits at most two parsing repairs. Read [the execution contract](EXECUTION_CONTRACT.md).
5. For Bing, the agent proposes three to five fit questions. After approval, `prepare_bing_queries` makes each company/query pair.
6. The controller calls the exact approved pairs and keeps successful receipts. It saves important claims as evidence.
7. For M365, local company IDs derive the allowed name/website/ID list. The gateway receives only the question, derived companies, and required fields.

**Check:** Repeated identical screening results are safe; changed results conflict. Screening does not add analyst labels or update candidate status. A missing research answer is unknown.

## H. Resume

1. The executor loads the active profile, plan, checkpoint, receipts, imports, exports, and saved batches.
2. It compares profile versions. If the version changed, it proposes a new plan for affected work.
3. It resumes confirmed-unsent or missing work. It reconciles ambiguous provider attempts before any resend. It reports open questions and failures.
4. It uses saved results and receipts to avoid repeated local work.

**Check:** Do not claim provider-wide exactly-once execution. Record analyst labels only from actual analyst feedback.
