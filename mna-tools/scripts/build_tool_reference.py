"""Build the checked-in reference from reviewed prose and emitted Rust schemas."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = json.loads((ROOT / "tool-catalog.json").read_text(encoding="utf-8-sig"))
TOOLS = {t["name"]: t for t in CATALOG}
R, A, B = "R42", "100-101", "200-202"
META = {}

def tool(name, purpose, behavior, returns, example):
    META[name] = (purpose, behavior, returns, example)

tool("search_companies", "Discover businesses across the canonical imported company universe.",
     "Search core-business descriptions, products, services and concepts. Modes are lexical, semantic and hybrid. Semantic and hybrid modes use the configured local embedder when no caller vector is supplied: Rust prefixes the query with `query: `, validates the selected model identity, and retrieves matching company vectors keyed by model/version/text hash from SQLite. Rebuild the index after changing model identity. Caller-supplied and legacy vectors are explicitly unverified and not Arctic-compatible. Financial, geography, employee-size, ownership and source industry-classification fields are recorded but never filter discovery; only company_ids and approved core_business_exclusions may narrow it. Query tokens NOT, EXCLUDE and minus-prefixed terms are rejected, including when grouped in parentheses; use only approved exclude_keywords. limit defaults to 1,000 and maxes at 1,000; offset is bounded to 1,000,000. A configured Meilisearch projection may supply lexical retrieval; it does not establish verified fit.",
     "A bounded results page with company records, ranks, available lexical/semantic scores, total, query_id, search_scope, and ignored_search_filters. Saves query history and an operation_receipt_id; does not add candidates.",
     {"run_id":R,"query":"insurance AND (claims OR policy)","mode":"lexical","limit":1000,"prefer_meilisearch":False})
tool("search_mid", "Search only the MID population through the same qualitative search interface.",
     "Use this as the main MID discovery abstraction. It composes qualitative core-business retrieval, canonical identity and query provenance. Its arguments and limits match search_companies. A configured local embedder prefixes generated query text with `query: `; caller-supplied vectors remain explicitly unverified. Non-core filters never narrow discovery. ISCC-only records are excluded. Requires run_id and approved criteria. MID and ISCC searches can be run independently, then selected IDs added with add_candidates.",
     "The same result envelope as search_companies, with MID discovery provenance and a successful-operation receipt. Canonical descriptions remain source data rather than verified fit judgments.",
     {"run_id":R,"query":"policy administration software for insurance carriers","mode":"hybrid","limit":1000,"prefer_meilisearch":False})
tool("find_company", "Resolve a known external identifier or locate an analyst-mentioned example.",
     "Provide exactly one selector: company_id, ecid, cid, pbid, name, website, or linkedin_url. ECID/CID/PBId selectors resolve cross-references exactly; company_id also accepts an old key alias or a typed identifier such as CID:101. Name and website searches are bounded text lookups and can return several possibilities. They do not merge entities. This lookup is available during criteria clarification before profile approval. Supply run_id to retain the lookup in that run's history. limit defaults to 10, maximum 100.",
     "results, exact-match flags, total and query_id. An identifier that cannot be resolved is NOT_FOUND. A name match is a lead that needs identity confirmation.",
     {"run_id":R,"cid":"101"})
tool("find_similar_companies", "Retrieve neighbors of one qualitative seed embedding.",
     "Provide exactly one of company_id or query_vector. A company seed needs a stored embedding for the selected model identity; the service does not manufacture one. Cosine ranking excludes the seed company. Search the MID population and apply only company identity and approved core-business exclusions; geography, financials, size, ownership and classifications are ignored. Requires approved criteria and run_id. Caller-supplied vectors are legacy, explicitly unverified and not Arctic-compatible. limit defaults to 1,000, maximum 1,000.",
     "Canonical neighbors with rank, similarity score, basis, source, query_id and unused-filter notice. Vectors are omitted from returned hit records. Saves query history.",
     {"run_id":R,"company_id":A,"limit":100})
tool("find_similar_to_examples", "Build a broad search from positive and optional negative examples.",
     "Supply positive_company_ids and/or legacy caller-provided positive_vectors. Stored examples require real vectors for the selected local model identity. Caller-provided vectors remain explicitly unverified and are not Arctic-compatible; only an explicitly marked legacy-debug caller should send them. Optional negative examples subtract their mean vector from the positive centroid; the service ranks cosine neighbors and excludes supplied example companies. This retrieval signal does not create analyst labels. Requires approved criteria and run_id. A missing positive basis or invalid/incompatible vectors is an explicit error; non-core filters are ignored.",
     "Neighbors, scores, example-basis metadata, query_id and ignored-filter reporting. The result is a discovery set, not an automatic shortlist.",
     {"run_id":R,"positive_company_ids":[A],"negative_company_ids":["300-303"],"limit":100})
tool("get_company", "Read the canonical company and its compact enrichment.",
     "company_id can be the current derived key, an old key alias or a typed cross-reference. The common source view prefers MID when it is present. ECID, CID, PBId, identifiers, source flags, seven compact PB_ fields and ROGO fields are available without changing original source rows. This is a global company read; run-specific evidence and screening results need a scoped context tool. Stored model vectors are not included in normal company or reasoning contexts.",
     "A canonical company object. Missing entities return NOT_FOUND. Retrieval does not prove the accuracy or completeness of source descriptions.",
     {"company_id":A})
tool("get_company_identifiers", "Inspect all exact cross-references for a company.",
     "Use this after source deduplication, provisional-key promotion or PitchBook mapping. The identity model stores PK aliases plus normalized ECID, CID and PBID entries. A pair such as 100-101 can still resolve through an earlier X-101 alias. Original spelling and placeholder values remain in source rows. Website/name matching never creates an identifier bridge.",
     "The resolved company_id and registered identifier records, including historical PK aliases. Read-only apart from the common audit record.",
     {"company_id":"CID:101"})
tool("get_source_rows", "Inspect a bounded selection of original MID or ISCC observations.",
     "Optionally restrict source to MID or ISCC. limit defaults to 20, maximum 200. This explicit source-inspection tool is global and can show observations from several runs; each row carries its run/query scope. Use Full Export when the selected run's source subset must be enforced. The rows preserve original column names and values and are useful for resolving contradictory descriptions or IDs.",
     "company_id plus original source row records, source, run_scope, query_id, relevance score and import provenance. It does not flatten multiple observations into one value.",
     {"company_id":A,"source":"ISCC","limit":20})
tool("get_company_context", "Request only the company sections needed for the next reasoning step.",
     "sections is an explicit nonempty, duplicate-free list. Available sections are core, description, financials, products, services, keywords, previous_research, analyst_notes, evidence, screening_history, external_research, identifiers, enrichment and screening_results. run_id is mandatory for current-run notes, evidence, screening history, external research and screening results. previous_research is an explicit cross-run opt-in. max_chars defaults to 12,000; despite its name it limits complete serialized UTF-8 bytes, including metadata. Whole sections are omitted when they do not fit; JSON is never sliced. Financial context is available for human inspection and is not a discovery filter.",
     "Selected context sections with included/omitted metadata and serialized-byte accounting. Vectors are removed from reasoning context.",
     {"run_id":R,"company_id":A,"sections":["core","description","identifiers","enrichment","evidence","screening_results"],"max_chars":16000})
tool("get_candidate_context", "Hydrate one candidate with only its current-run research.",
     "The company must belong to run_id. The response combines canonical description/enrichment, candidate status and discovery, current-run evidence and labels, candidate research status, screening results and missing business evidence. Other runs are not included implicitly. max_chars defaults to 12,000 and counts serialized UTF-8 bytes. A small budget omits whole optional blocks rather than silently corrupting text.",
     "Bounded candidate context plus omission metadata. Missing-evidence defaults cover products, business_model and customer_segment; a gap means unknown. Read research questions separately with get_open_questions.",
     {"run_id":R,"company_id":A,"max_chars":18000})
tool("get_candidate_batch_context", "Prepare selected fields for a bounded group of candidates.",
     "company_ids contains 1–100 distinct candidates in the run. fields contains 1–32 distinct field names. Ordinary names read canonical fields; scoped fields include evidence, analyst_feedback, discovery, missing_attributes and research_status. max_per_company limits each complete serialized company block in UTF-8 bytes. Supply PB_ and ROGO field names when useful. This is a read tool; use propose_prepared_plan for the immutable approved external handoff.",
     "One bounded row/context per requested candidate with omission accounting. No hidden cross-run research or synthetic analyst labels.",
     {"run_id":R,"company_ids":[A,B],"fields":["name","description","PB_Description","ROGO","screening_results"],"max_per_company":8000})
tool("get_run_source_projection", "Preview selected source fields as a frozen, run-scoped input table.",
     "Reads all considered candidates when company_ids is empty or the exact supplied considered subset otherwise. Select identity fallbacks independently for name, website and description; custom data columns use SOURCE:Field labels in input_columns and matching {source,column} entries in selected_source_columns. RESULTS and BING are selectable saved-context sources for later passes, alongside MID, ISCC, PB and ROGO. index is supplied first and is immutable. PB LinkedIn values must be genuine /company/ pages. This is a read-only preview; propose_prepared_plan creates the authoritative immutable snapshot and digest.",
     "Projected input_columns and rows with global indices, canonical pk/PBId, source coverage, field catalog, candidate/data/input hashes, selected row hashes and retrieval configuration. No approval or execution occurs.",
     {"run_id":R,"company_ids":[A,B],"selected_source_columns":[{"source":"MID","column":"Sector"}],"identity_sources":{"name":["PB","MID","ISCC"],"website":["PB","MID","ISCC"],"description":["PB","MID","ISCC"]},"input_columns":["index","pk","PBId","Company Name","Website","Description","LinkedIn URL","MID:Sector"]})
tool("get_source_field_catalog", "List fields available for a run's source-column picker.",
     "Uses the same considered run scope and field availability counts as get_run_source_projection. Includes hydrated RESULTS and BING fields when they exist, so an analyst can choose prior model output or grounded observations as labeled input for another pass. Page through get_candidate_source_data when assembling custom input; absent source fields remain empty. The prepared-plan digest is authoritative.",
     "Run ID, field catalog by source, candidate/data hashes, profile version and executed=false. No rows are returned by the catalog projection.",
     {"run_id":R})
tool("build_context_packet", "Build a compact task packet from authoritative run state.",
     "Always includes the original criteria, task and profile/search-policy anchors. A criteria-analysis task can use subject_ids=[] before approval and gets a working_profile; it never presents that proposal as active approval. Candidate screening/review tasks require subjects and approved criteria. Up to 100 unique subjects are supported. Examples, questions, candidate details, evidence and events are optional blocks. token_budget is a historical field name: it is a serialized UTF-8 byte budget, not a tokenizer count. The implementation checks profile state again before returning and rejects a profile change during assembly.",
     "context, metadata, omitted blocks and actual byte count. If mandatory anchors cannot fit, returns INVALID_ARGUMENTS rather than losing original criteria.",
     {"run_id":R,"task_type":"SCREEN_CANDIDATES","subject_ids":[A,B],"token_budget":24000})
tool("get_run_context", "Read the run's objective, approved profile version and progress.",
     "detail_level accepts summary or full. Use this to orient a resumed agent before selecting tools. New runs are DRAFT and active_profile_version is 0 until real analyst approval. It reports candidate status counts, unresolved questions and recent meaningful decisions/events without deriving new criteria from chat.",
     "Run metadata, immutable-criteria version, active profile version, progress counts and related state. The counts are run-scoped.",
     {"run_id":R,"detail_level":"full"})
tool("get_original_criteria", "Recover the original DDI extraction or plain-text criteria unchanged.",
     "The administrator supplies original_criteria at run creation. Store raw text or extraction provenance inside that JSON if available. Profile proposals do not mutate this object, and SQLite triggers protect it from later rewrites. The Rust layer does not extract or interpret a DDI itself.",
     "The original criteria JSON, including conditions currently unused for searching. Read-only.",
     {"run_id":R})
tool("get_active_screening_profile", "Read the latest analyst-approved interpretation of the screening criteria.",
     "Only APPROVED versions qualify. A PROPOSED version remains separate until approve_screening_profile is called through the analyst-only route. A new unapproved run has no active profile and this tool returns NOT_FOUND; use get_search_policy or get_screening_profile_version for its working proposal.",
     "Profile version, content, lineage, rationale and approval metadata. No profile is activated by this read.",
     {"run_id":R})
tool("get_screening_profile_version", "Inspect a specific proposed, approved or historical profile.",
     "version is the integer version within the run. Use version 1 to inspect the initial working profile or a returned version to review a later proposal. Content, parent lineage and supporting examples are immutable after creation; approval metadata can change through the separate privileged operation.",
     "The complete version record, including status and approved_by/approved_at when present.",
     {"run_id":R,"version":2})
tool("compare_profile_versions", "Show what changed between two interpretations of the same screening criteria.",
     "Supply version_a and version_b in the same run. Comparison reads both versions and lists top-level content keys whose values differ. It is not an LLM semantic interpretation or a recursive natural-language diff. Use the result to explain a changed core-business boundary or an approved exclusion to the analyst.",
     "The compared profiles and changed content fields with before/after values. Read-only.",
     {"run_id":R,"version_a":1,"version_b":2})
tool("propose_screening_profile", "Save a revised qualitative interpretation for analyst review.",
     "content is structured JSON: recommend core_business_query, core_business_criteria, core_business_exclusions and unused_criteria with reasons. Core business exclusions are the only criteria that may filter discovery. Supply rationale and supporting_example_ids where applicable. The service allocates the next version and parent lineage atomically. It does not semantically certify arbitrary content or automatically strip financial words from a free-text query; the orchestrator must interpret the screening criteria and inform the analyst. The proposal never activates itself.",
     "A PROPOSED profile/version and lineage. Discovery keeps using the previously approved version until analyst approval; stale action plans are rejected after a new version is approved.",
     {"run_id":R,"content":{"core_business_query":"insurance claims and policy administration software","core_business_criteria":["Owns a repeatable insurer workflow product"],"unused_criteria":[{"criterion":"India headquarters","reason":"Geography is recorded but not used for discovery"}]},"rationale":"Analyst clarified that claims workflow is in scope","supporting_example_ids":[A]})
tool("get_search_policy", "Make the qualitative discovery policy visible to the analyst and agent.",
     "Before approval, returns the latest working proposal with approved=false. Afterwards, returns the active approved version. It lists allowed identity/keyword scopes, the qualitative core query, original criteria and deliberately unused conditions. It also detects common non-core keys in structured original criteria. Free text and nested form semantics still require orchestrator interpretation; do not assume this heuristic exhaustively extracts a DDI.",
     "profile_version, approved, core_business_query, core_business_criteria, unused_criteria, analyst_notice, allowed_search_filters and requires_orchestrator_interpretation=true.",
     {"run_id":R})
tool("get_criteria_history", "Read every saved criteria revision and the latest approval state.",
     "Use when an analyst returns to criteria after discovery, enrichment, or screening. Revisions keep criteria text, business definition, separate good-fit and bad-fit examples, digest, time and approver. last_criteria is the newest revision, even when unapproved. Do not infer approval from an older version; search and screening require the latest revision's approval. This read does not edit criteria or restore an old plan.",
     "run_id, ordered revisions, last_criteria and count. Each revision reports approved, approved_by and approved_at when available.",
     {"run_id":R})
tool("label_company", "Record an analyst label explicitly supplied by the caller.",
     "This legacy feedback tool is excluded from the controller model catalog; only the trusted analyst workflow can call it. label is BEST_FIT, FIT, BORDERLINE or MISFIT. Every HTTP route requires both API and analyst credentials, including /tools/call and /tools/batch; non-analyst calls are rejected with ANALYST_AUTH_REQUIRED. Persist an analyst_note to explain real feedback. One label is retained per run/company; later actual feedback updates it. The trusted controller must establish that feedback came from a human. Model assessments, retrieval/rerank scores, generated examples and research observations must not be converted into analyst labels.",
     "The stored label, note, label_id and update time; emits a COMPANY_LABELLED event. Does not approve a profile.",
     {"run_id":R,"company_id":A,"label":"BEST_FIT","analyst_note":"Analyst: this owned policy-administration product is a good example"})
tool("get_labelled_examples", "Retrieve the analyst's actual examples for this run.",
     "Optional labels or company_id restrict the returned labels. limit defaults to 50, maximum 500. Each record carries the actual label/note and a compact canonical company description. No cross-run labels are implicitly included.",
     "An array of label records and example companies. An empty array means no matching feedback has been recorded.",
     {"run_id":R,"labels":["BEST_FIT","MISFIT"],"limit":50})
tool("get_representative_examples", "Select a small balanced context sample of labelled examples.",
     "Defaults to BEST_FIT, FIT, BORDERLINE and MISFIT, with three examples per label. target_query optionally orders available labels by deterministic text overlap. It samples at most the latest 500 labels and returns at most 200 examples. It does not invent missing labels or guarantee global statistical representativeness.",
     "An array of existing labelled examples within the per-label and total caps. Use it to ground criteria discussion and context packets.",
     {"run_id":R,"target_query":"policy administration product","per_label":3,"limit":12})
tool("save_evidence", "Save a scoped claim or research observation with provenance.",
     "Provide claim, arbitrary JSON value, source_type, source_reference and evidence_confidence (low, medium or high; `confidence` is a compatibility alias). source_url, extraction_method and claim_provenance are optional. Evidence confidence rates the quality of a research lead; it is not analyst verification. New claims have verification_status=UNKNOWN until reviewed by an analyst. Examples include products, business_model and customer_segment. Serialized value is capped at 100,000 bytes. Exact duplicate claims with the same run, company, source and content are idempotent. Contradictory claims can coexist as distinct evidence; the service does not decide which is true.",
     "Evidence record with evidence_id, retrieved_at, content_hash and created flag. A failed fetch/search is an error or gap, not a negative company claim.",
     {"run_id":R,"company_id":A,"claim":"products","value":["Policy administration SaaS"],"source_type":"company_website","source_reference":"https://policynest.example/products","source_url":"https://policynest.example/products","evidence_confidence":"low","claim_provenance":{"page_title":"Products","excerpt_hash":"sha256:returned-by-controller"},"extraction_method":"Unverified research lead; analyst review is pending"})
tool("get_evidence", "Read evidence for one company in one run.",
     "Optional claims and source_types narrow the read; an omitted or empty filter does not narrow it. limit defaults to 200, maximum 1,000. Records retain source references, evidence_confidence (with confidence as a compatibility alias), claim_provenance and analyst verification status. New or unreviewed claims are UNKNOWN. They are observations rather than an automatically reconciled fact table.",
     "An array of evidence records ordered by retrieval time. Evidence from another run is not included.",
     {"run_id":R,"company_id":A,"claims":["products","customer_segment"],"limit":100})
tool("get_missing_evidence", "Find qualitative attributes that still need research.",
     "Omitted required_attributes defaults to products, business_model and customer_segment. An explicitly empty list requests no requirements. Matching uses stored evidence claims, not the existence of an arbitrary original spreadsheet field. A source description can guide discovery while these gaps remain open.",
     "Required/missing attributes and coverage information. Missing is unknown; it is not a misfit verdict.",
     {"run_id":R,"company_id":A,"required_attributes":["products","business_model","customer_segment"]})
tool("search_iscc", "Retrieve and ingest one live qualitative ISCC pull.",
     "Requires approved criteria and run_id. query must contain 1–14 whitespace-separated words; 10–12 are recommended. limit defaults to 1,000 and maximum is 1,000. Legacy non-core filters are reported as ignored and are never forwarded. The gateway request contains only query and limit. A deployment-specific CDP bridge performs the browser/API/export work and converts raw export rows to JSON. The Rust layer validates counts, derives keys, cross-references identities and retains original rows by run/query. A row with neither usable ID, a missing name or an identity collision is quarantined. Up to five variations are allowed per proposed action plan; the orchestrator controls loop budgets.",
     "query_id, canonical identity-bearing results with relevance_score, retrieved_count, result_count, ingestion metrics, score_bands and operation_receipt_id. Duplicate observations collapse into one result per canonical company, retaining the highest score; common fields prefer MID when both sources exist. retrieved_count describes raw observations and result_count describes usable unique companies. All raw observations remain in source rows. No 0.45 cutoff is applied; selecting rows for the candidate funnel remains explicit.",
     {"run_id":R,"query":"Policy administration and claims workflow software platforms built for insurance carriers","limit":1000})
tool("get_iscc_score_samples", "Inspect the broad-funnel relevance boundary without repeating ISCC research.",
     "Read a saved search_iscc query from the same run. min_score must be one of 0.3, 0.4, ..., 0.9; default 0.3. per_band is 1–4, default 3. Samples come from saved descriptions spread through each decile, rather than only its top hits. The 0.9 band includes valid 1.0 scores. Empty bands remain visible. Compare the descriptions with core business criteria and record why a lower or higher selection level is useful.",
     "score_bands, samples, counts, original query and usual_reference_cutoff=0.45 with cutoff_applied=false. This tool neither removes source rows nor changes candidates.",
     {"run_id":R,"query_id":"QRY-returned-iscc-id","per_band":4,"min_score":0.3})
tool("bing_search", "Execute one approved grounded research query.",
     "The dispatcher requires run_id, plan_id and step_id even though legacy DTO fields are optional. The plan must be approved at the current profile version and its dependencies complete. A criteria-clarification step can approve 1–5 literal queries with no company scope before final criteria approval. A company step approves 1–5 templates and company_id; the submitted query must exactly match an expanded approved template. The UI applies approved templates to every considered company, in pages of at most 100 sends with automatic continuation. max_results defaults to 20, maximum 100. Provider enablement and endpoint configuration are separate deployment prerequisites; disconnected approval is unexecuted. Company-scoped responses save bounded low-confidence bing_research_observation evidence. It is an unverified research lead until analyst review.",
     "Grounded answer/results/source provenance, query_id, retrieval/cache metadata, operation_receipt_id, and evidence_id for company research. Full normalized response stays in search history; compact company memory uses bounded Unicode-safe excerpts.",
     {"run_id":R,"plan_id":"PLAN-returned-id","step_id":"bing-fit","company_id":A,"query":"Does PolicyNest; https://policynest.example build policy administration software?","max_results":10})
tool("m365_research", "Request an approved grounded research answer from a configured M365 gateway.",
     "Requires run_id, plan_id and step_id at dispatch. The matching m365_research plan step must approve the literal question and have completed dependencies. For a company-scoped step, company_ids contains 1–100 distinct considered run candidates within the approved scope. The service derives gateway companies as preferred name; preferred website [canonical company_id]. Omit companies or supply exactly that derived list; unrelated names cannot replace the approved scope. Local run/plan/step fields and structured company_ids are not forwarded; derived text includes canonical IDs. For criteria-only steps, company_ids is empty. required_fields has at most 100 entries. Completion requires every approved company/question pair. This adapter is separate from Copilot batch screening: use propose_prepared_plan with provider=copilot for scoring. For that scoring path, genuine PB LinkedIn must be selected when available. Store research leads with save_evidence; analyst verification is separate.",
     "Normalized answer, sources, query_id, retrieval/cache metadata and a successful-operation receipt. Missing configuration or upstream failures remain explicit errors.",
     {"run_id":R,"plan_id":"PLAN-returned-id","step_id":"internal-research","question":"What policy-administration products does this company build?","company_ids":[A],"required_fields":["products","customer_segment"]})
tool("fetch_url", "Fetch a public page into a controlled local artifact cache.",
     "Needs deployment enablement through MNA_ENABLE_EXTERNAL. Uses public HTTP(S) destinations only, DNS validation/pinning, disabled proxy inheritance and no redirects. Private/local/special addresses are rejected. timeout_secs defaults to 15, maximum 30; max_bytes defaults to 1,000,000, maximum 8,000,000. use_cache defaults true. run_id attaches document provenance locally and is not sent to the site. This operation does not make a company claim automatically.",
     "Document/artifact metadata, artifact_ref, content hash, content type, retrieved time, cache indicator and document_id. No arbitrary local file access.",
     {"run_id":R,"url":"https://policynest.example/products","max_bytes":1000000,"timeout_secs":15,"use_cache":True})
tool("extract_url_context", "Extract bounded relevant text from a supplied page or fetched artifact.",
     "url records provenance. Provide artifact_ref from fetch_url, inline content, or an enabled fetch path. Artifacts must remain under the configured cache directory. Optional extraction_goal and query_terms prioritize matching page lines. max_chars defaults to 12,000 and is bounded; HTML body text is normalized and matching lines prioritized; navigation or script text can remain. This is text extraction, not LLM interpretation or evidence verification.",
     "Relevant extracted text with URL/artifact metadata and document_id. Save source-backed claims explicitly when they should support screening.",
     {"run_id":R,"url":"https://policynest.example/products","content":"<main>PolicyNest builds policy administration software for insurance carriers.</main>","extraction_goal":"Find owned software products and customer segment","query_terms":["policy","insurance"],"max_chars":6000})

tool("search_research_memory", "Find saved research before repeating a search or asking an answered question.",
     "query performs deterministic text matching within run_id. Optional company_id narrows it to one company. Searches persisted evidence, analyst notes and research-question answers, not the live web. An empty match is a memory gap and says nothing about company fit. Returned snippets retain their record identity so the caller can read the original source.",
     "Bounded memory matches and provenance from the current run. Read-only.",
     {"run_id":R,"query":"policy administration","company_id":A,"limit":20})
tool("get_previous_research", "Explicitly retrieve a company's research from earlier or other runs.",
     "This is a deliberate cross-run opt-in. Use it only when prior work is relevant and make its run/profile provenance visible. Reused observations can be stale or have answered a different set of screening criteria. This tool does not copy them into the new run, approve them or replace current evidence.",
     "Previous run-associated research, notes and evidence with source identifiers. A company alias resolves to its canonical identity first.",
     {"company_id":A,"limit":20})
tool("get_recent_agent_events", "Recover meaningful run events and decisions.",
     "Optional event_types selects event names, such as SCREENING_PROFILE_APPROVED, CANDIDATES_ADDED, EVIDENCE_SAVED or CHECKPOINT_SAVED. limit defaults to 25, maximum 500. This is domain-event history rather than a stream of the model's private reasoning. Read it alongside checkpoints and action plans during recovery.",
     "Events with event_id, type, payload, major flag and created_at, ordered newest first.",
     {"run_id":R,"event_types":["SCREENING_PROFILE_APPROVED","CANDIDATES_ADDED"],"limit":25})
tool("get_search_history", "Inspect durable query inputs, results and retrieval provenance.",
     "limit defaults to 50, maximum 500. Optional source matches the stored source label exactly; search_mid records MID while ISCC records search_iscc. ISCC history keeps a bounded score-band summary; original rows live in source_rows. MID/Bing/M365 histories retain their normalized result records. A new search invocation creates a new query observation even if a process cache served the provider response.",
     "query_id, run_id, source, query, parameters, results and created_at. Query IDs can be attached to add_candidates for exact discovery lineage.",
     {"run_id":R,"source":"search_iscc","limit":20})
tool("get_open_questions", "Read unresolved screening criteria ambiguities or company research gaps.",
     "Omit company_id for all questions in the run or provide it for company-specific questions. include_resolved defaults false; use true during recovery to check what was answered. limit defaults to 100, maximum 500. A skipped analyst question stays open; the orchestrator decides which ambiguity actually blocks approval.",
     "Question records with scope, priority, OPEN/RESOLVED state, answer and evidence IDs.",
     {"run_id":R,"company_id":A,"include_resolved":False,"limit":100})
tool("add_open_question", "Persist a relevant ambiguity without guessing an answer.",
     "Omit company_id for a screening-criteria clarification; include it for a company research question. priority is low, medium, high or critical. question is bounded to 10,000 bytes. The service records OPEN state and an event; it does not automatically stop every workflow merely because a question exists.",
     "A new question_id, question text, scope, priority and OPEN state. Keep the returned ID for resolution.",
     {"run_id":R,"question":"Do the screening criteria include claims workflow vendors or only policy administration?","priority":"high"})
tool("resolve_open_question", "Record an explicit answer and link the evidence that supports it.",
     "question_id establishes the run and optional company scope. Each supplied evidence_id must exist in that run and, for a company question, the same company. answer is bounded to 50,000 bytes. Evidence IDs may be empty for an actual analyst clarification. A resolved question cannot be silently resolved again with a different answer.",
     "The RESOLVED question with answer, evidence IDs and resolution time. Wrong-scope evidence is rejected atomically.",
     {"question_id":"QUE-returned-id","answer":"Analyst confirmed that claims workflow products are included","evidence_ids":[]})
tool("add_candidates", "Form the unique broad funnel while preserving every retrieval path.",
     "companies contains 1–1,000 distinct IDs or objects with company_id, optional retrieval_score and positive rank. All companies must exist. Provide discovery_source=MID or ISCC and the query_id returned by the search. The query must belong to the run. A repeated run/company membership is idempotent; another source/query adds another discovery observation. The entire request is transactional, so one invalid company does not partly add the batch. Chunk larger lists. It does not screen, reject or label companies.",
     "requested, added, already_present and discovery_records_added counts, along with run/source/query. Newly added candidates start DISCOVERED.",
     {"run_id":R,"companies":[{"company_id":A,"retrieval_score":0.81,"rank":1},{"company_id":B,"retrieval_score":0.62,"rank":2}],"discovery_source":"ISCC","query_id":"QRY-returned-iscc-id"})
tool("get_candidate_set", "Read a bounded page of run candidates and their discovery history.",
     "By default, reads only considered candidates. Set include_hidden=true to inspect saved companies that are outside the working scope; their considered flag and reason remain visible. Optional statuses narrows workflow state; filters.company_ids narrows identity. Legacy geography, industry classification, revenue, employee-size and ownership filter fields are ignored and reported because they must not narrow discovery. limit defaults to 100, maximum 1,000; count is the returned page count, not the full run. This tool has no cursor. Use get_shortlist_context to page all saved companies, then get_candidate_set for bounded discovery detail.",
     "candidates with considered/status/reason and discovery observations; count, search_scope, ignored_search_filters and criteria_notice. No hidden row is deleted by a read.",
     {"run_id":R,"statuses":["DISCOVERED","RESEARCH_REQUIRED"],"limit":1000})
tool("get_shortlist_context", "Page the current considered selection or complete saved candidate history.",
     "Use after discovery, PitchBook mapping, or manual shortlist review. include_hidden=false reads the active considered set; true includes hidden history with status, considered and consideration_reason. Keyset pages are ordered by company_id. Follow next_after_company_id while has_more, up to 1,000 rows per call; do not assume the first page is the whole run. Compare total, considered_count, selection_revision, criteria_revision and source_hash between pages and retry if they change. Preferred name/website and PB/ROGO/Bing coverage help decide the next action. This is a read, not an approval or a restore operation.",
     "run_id, total, considered_count, hidden_count, candidates, has_more, next_after_company_id, selection_revision, criteria_revision, source_hash, review_columns and considered-only hydration coverage.",
     {"run_id":R,"include_hidden":True,"limit":500})
tool("update_candidate_status", "Record a considered funnel state and supporting reason.",
     "status is DISCOVERED, PRE_SCREENED, RESEARCH_REQUIRED, LIKELY_FIT, LIKELY_MISFIT, HUMAN_REVIEW, FINAL_SHORTLIST or REJECTED. The company must already be a candidate in this run. Supply reason to explain the business evidence or unresolved gap. The deterministic service validates the value, not an LLM fit conclusion or a fixed state-transition graph. Status is separate from an analyst label and an external fit score.",
     "Updated status and reason with an event. A missing source result should normally leave a research gap rather than create a rejection.",
     {"run_id":R,"company_id":A,"status":"RESEARCH_REQUIRED","reason":"Source description suggests a policy product; verify that the company owns it"})
tool("get_discovery_summary", "Report the full unique funnel and the next-step default.",
     "Counts considered candidate memberships; hidden rows remain saved but do not enter active source counts. mid_only means a retained MID source record exists; iscc_only means an ISCC observation exists in this run; both means both. These measure source coverage, not the number of retrieval queries. other identifies a candidate without either raw source. total_unique = mid_only + iscc_only + both + other. Strict suggestions use considered n: PitchBook and Bing for 0<n<1000, ROGO for 500<n<2000, LLMSuite for n>2000, and M365 for 0<n<250 with PB coverage. Research opens first for n>5000, any PB/ROGO/Bing hydration, or 0<n<500. No suggestion executes work.",
     "Considered total_unique and source/status counts, saved_total, hidden_total, PB/ROGO/Bing coverage, recommended_steps and research_open. Use get_shortlist_context for all saved rows and review flags.",
     {"run_id":R})
tool("import_enrichment_files", "Classify and join a mixed analyst upload into compact company context.",
     "files contains 1–32 local files below MNA_IMPORT_DIR; relative paths are preferred. Role detection uses headers and sheets, not filenames. Mapping headers must be in row 1 and include all eight documented columns. Only Company Profile=Yes adds PBId. Explicit No or unmapped mapping rows hide that candidate without erasing history; a later eligible mapping can restore mapping-hidden rows, not manually hidden ones. Set exclude_unmapped=true with a mapping sheet to hide every still-unmapped candidate in this run; it is rejected without a mapping sheet. ROGO-only imports do not reapply an old PB exclusion. PitchBook data joins candidates through PBId, stores seven compact PB_ fields and preserves wide columns in Parquet. ROGO joins by the topmost website header, prefers a usable PB_Website, and quarantines ambiguous matches. All mappings run before PB data and ROGO regardless of upload order. The upload adds context only; it does not start screening.",
     "Mapping/PB/ROGO row counts, mapping_unique_companies, pb_unique_companies, rogo_unique_companies, hydration/unmatched counts, quarantined count, Parquet paths and operation_receipt_id. pbid_populated counts newly added IDs, so an identical re-upload returns zero there. Hydrated row counts can exceed unique company coverage. Enrichment is global company data; run-specific claims and scores remain separately scoped.",
     {"run_id":R,"files":["pitchbook-mapping.csv","pitchbook-data.xlsx","rogo.xlsx"],"exclude_unmapped":True})
tool("export_candidate_set", "Create one of the analyst's three exact workbook formats.",
     "export_type is PITCHBOOK, LLM or FULL (case-insensitive). Exports considered candidates across their statuses; hidden history stays in the run but outside the workbook. file_name is optional, must end in .xlsx and stay below MNA_EXPORT_DIR. Existing files are never overwritten; the default is a fresh UUID filename. PitchBook and LLM contain one canonical row per considered candidate and prefer MID fields for both-source entities. Full has MID and ISCC sheets with pk first and original source columns; ISCC rows are restricted to this run. Repeated source observations can make Full row counts exceed the considered company count. Formula-like text is escaped for spreadsheet safety.",
     "Artifact path, export type, company/row counts, relevant source-sheet counts and operation_receipt_id. The frontend owns the popup/download interaction.",
     {"run_id":R,"export_type":"FULL","file_name":"R42-full.xlsx"})
tool("propose_action_plan", "Turn an interpreted analyst request into a durable dependency graph.",
     "The agent writes the typed plan; Rust does not interpret natural-language instructions. steps contains 1–20 distinct step IDs, at most 2,000 company IDs per step, and no cycles or unknown dependencies. Kinds include search_mid, search_iscc, import_pitchbook, import_rogo, bing_research, llm_screening, m365_screening, m365_research and export. The llm_screening/m365_screening kinds remain for legacy compatibility; current scored screening uses propose_prepared_plan, while a direct chat question uses dispatch_provider_text through the controller. A plan can contain at most five ISCC steps. Search steps need parameters.query; import steps need parameters.files; export needs parameters.export_type. Bing steps need 1–5 query_templates; company research applies them to considered scoped IDs. M365 research needs an approved literal question. Known credential keys are rejected. Use multiple scope chunks for a larger funnel.",
     "An immutable PROPOSED plan_id tied to the current approved profile version (0 is allowed for criteria clarification). Approval remains an administrator operation. A direct analyst instruction can be recorded by the trusted controller without asking the same question twice.",
     {"run_id":R,"rationale":"Analyst requested PitchBook mapping followed by ROGO enrichment","steps":[{"step_id":"pb","kind":"import_pitchbook","parameters":{"files":["mapping.csv","pb.xlsx"]}},{"step_id":"rogo","kind":"import_rogo","depends_on":["pb"],"parameters":{"files":["rogo.xlsx"]}}]})
tool("get_action_plan", "Read a plan, its approval metadata and completed dependencies.",
     "Both run_id and plan_id are required. Approved content cannot be edited in place. completed_steps lists receipt-backed successful work. If the current profile changes, an old plan can still be read for history but its dependent handoffs/results cannot execute against the new interpretation.",
     "Plan content, profile_version, PROPOSED/APPROVED/REJECTED status, approver/times and completed-step records.",
     {"run_id":R,"plan_id":"PLAN-returned-id"})
tool("prepare_screening_batch", "Legacy compatibility handoff for scored screening batches.",
     "This older batch interface remains registered for compatibility, but the controller model catalog excludes it; use propose_prepared_plan for new screening work. The legacy path requires approved criteria, an approved matching plan step and 1–100 in-scope candidates. Hydration includes canonical/PB/ROGO data and current-run context. Only a valid PB LinkedIn company page is eligible; for Copilot it must be retained in the selected inputs when available. Legacy prompt/output limits remain in its schema. This operation does not perform model inference or approve/dispatch external work.",
     "Legacy batch ID, immutable input/prompt, plan lineage and executed=false. New version-2 plans provide a global index map, content digest, durable jobs and current approval/dispatch lifecycle.",
     {"run_id":R,"plan_id":"PLAN-returned-id","step_id":"fit","engine":"llm_suite","company_ids":[A,B],"prompt":"Score core-business fit from 0 to 10. Use CHECK when product ownership is unclear. Explain evidence and gaps. Ignore geography and company size.","output_columns":["fit_score","rationale","product_ownership"]})
tool("prepare_bing_queries", "Expand approved fit questions using the best available company identity.",
     "Requires an approved bing_research step with completed dependencies. company_ids contains 1–100 considered run candidates within the approved step scope. The UI pages every considered company into this bound and continues until all approved company/query pairs are sent. Templates support <company> as 'preferred name; preferred website', {company} as name and {website} as website. PB_Name/PB_Website are preferred when usable. The tool deterministically expands one to five analyst-approved templates; it does not invent questions or send requests. Call bing_search for each exact returned query with the same plan/step/company scope.",
     "A queries array with company_id, question_index and exact query text, plus executed=false. No network call occurs here.",
     {"run_id":R,"plan_id":"PLAN-returned-id","step_id":"bing-fit","company_ids":[A,B]})
tool("save_screening_results", "Legacy compatibility endpoint for batch scores.",
     "This older score-save interface remains registered for compatibility, but the controller model catalog excludes it. New model outputs are recorded by the prepared-plan controller after approval, lease, dispatch and strict response parsing. Legacy calls require the original run/plan/step/batch and a current approved profile. They do not create analyst labels or approve criteria; the legacy-debug example below is illustrative and must be replaced with actual adapter output.",
     "Saved result count and batch lineage plus operation_receipt_id. Records can be read through get_screening_results and scoped context tools.",
     {"run_id":R,"plan_id":"PLAN-returned-id","step_id":"fit","batch_id":"BATCH-returned-id","results":[{"company_id":A,"fit_score":"CHECK","rationale":"Legacy-debug example only; replace with the actual provider response"}]})
tool("get_screening_results", "Read a company's external screening history within the current run.",
     "company_id resolves aliases. limit defaults to 100, maximum 500. Each record retains batch, engine, prompt/profile lineage and stored result. Another run's results are excluded even when the global company has the same identifiers. Use separate passes to retain score changes rather than overwriting historical conclusions.",
     "An array of screening records with engine, profile_version, batch/step identity, result and creation time.",
     {"run_id":R,"company_id":A,"limit":100})
tool("complete_action_step", "Release dependent graph work only after successful operations are proven.",
     "receipt_ids contains 1–10,000 unique service-issued successful-operation receipts. The service checks their run, tool kind, approved parameters and time against the plan. A search_mid step accepts only search_mid receipts. Research/screening receipts also match plan and step. A receipt cannot be claimed by a different step. Screening must cover the whole approved company scope; Bing must cover every approved (company,query) pair and M365 every approved (company,question) pair. Identical company names or cache hits cannot count as another company's research. Dependencies must already be complete and the profile current. The transaction rejects incomplete/incorrect receipt sets without partly completing the step. An exact completion retry is idempotent. Receipt creation is internal, not an agent tool.",
     "COMPLETED status and recorded receipt IDs. The trusted orchestrator can now execute dependent nodes; Rust is not an autonomous DAG scheduler.",
     {"run_id":R,"plan_id":"PLAN-returned-id","step_id":"fit","receipt_ids":["OP-returned-id"]})
tool("save_checkpoint", "Persist the orchestrator's restart state with optimistic concurrency.",
     "state is arbitrary JSON capped at 1 MB. namespace defaults to default. expected_sequence optionally asserts the latest sequence (0 for the first write); a stale writer gets CONFLICT. Store run/profile version, graph node, completed query/receipt/batch IDs, pending human questions and next work. Do not store credentials or rely on chat history as authoritative state. Checkpointing does not itself execute, cancel or compensate an external side effect.",
     "checkpoint_id, increasing sequence, saved state and time. Writes are transactional and survive service restarts.",
     {"run_id":R,"namespace":"discovery","expected_sequence":0,"state":{"profile_version":1,"phase":"candidate_review","completed_query_ids":["QRY-returned-mid-id"],"next_action":"await_analyst_selection"}})
tool("get_checkpoint", "Resume from the latest or a named historical checkpoint.",
     "namespace defaults to default. Omit sequence for the latest checkpoint or supply the exact integer to read history. Compare its profile_version with get_run_context before resuming; a new approval can invalidate old plans. Verify completed actions through receipts and durable records rather than repeating them blindly.",
     "Saved state, sequence, checkpoint_id and timestamp. A namespace with no saved checkpoint returns NOT_FOUND.",
     {"run_id":R,"namespace":"discovery"})

tool("get_candidate_source_data", "Read all selectable source columns for a paged candidate scope.",
     "Requires a saved run. By default reads considered candidates only; set include_hidden=true for saved history. Keyset order is company_id ascending; limit defaults to 50 and accepts 1–100. after_company_id, if supplied, must be a candidate in that scope. MID observations are company-global; ISCC and BING research are run-scoped. Columns use the latest nonblank value per source and preserve empty source headers. PitchBook includes compact PB_ fields and wide columns from Parquet; missing or corrupt Parquet fails visibly. ROGO exposes hydrated fields. RESULTS exposes saved screening output columns for later context, and BING exposes saved grounded observations. PB/ROGO enrichment remains company-global. A page over 2 MB fails; retry a smaller page. Follow next_cursor to read the complete selected scope.",
     "run_id, total, rows containing pk, PBId, sources MID/ISCC/PB/ROGO/RESULTS/BING and source provenance, plus next_cursor. Read-only; no screening approval or execution occurs.",
     {"run_id":R,"limit":50})
tool("get_retrieval_config", "Inspect the selected local embedding and reranking configuration.",
     "Reports selected model identities and configured endpoint status without making inference calls. An endpoint is configured-but-unverified until real inference succeeds. The default embedder is Snowflake/snowflake-arctic-embed-m-v2.0 v2.0-int8-onnx at 768 dimensions. Operators must change the model version whenever model/tokenizer hashes or max_tokens change. Semantic/hybrid queries are prefixed `query: ` by Rust; document text is unprefixed, and company vectors are keyed in SQLite by model/version/text hash. Legacy caller/stored vectors are unverified and remain separate from this model identity. Retrieval defaults to and maxes at 1,000; reranking changes only the first 500 and preserves the remaining tail. No top-50 cutoff is applied.",
     "Embedder/reranker status and identities, endpoint configuration flags, retrieval/rerank limits, vector storage key policy and explicit legacy-vector status. It does not return vectors or execute inference.",
     {})
tool("embed_texts", "Request genuine vectors from the configured local embedding worker.",
     "Supply 1–32 nonempty texts of at most 16,000 UTF-8 bytes. Rust sends the configured model/version/dimensions to the localhost worker, validates identity, vector count, finite values and dimensions, and returns worker-produced vectors only. No fallback vectors are fabricated. For company indexes, rebuild_embedding_index sends unprefixed description text; search adds `query: ` to query text before calling the same worker. A configured endpoint is not verified until an actual call succeeds.",
     "Actual vectors from the selected local worker, model identity, dimensions, count and provenance. Inference failure or absent configuration is an explicit error.",
     {"texts":["Insurance policy administration and claims workflow software"]})
tool("rerank_candidates", "Rerank one source/query group while preserving the rest of the broad funnel.",
     "Accepts 1–1,000 candidates but sends at most the first 500 to the configured local reranker. All supplied candidates must belong to one source and one query_id; MID and ISCC score populations cannot be combined. The worker must return each sent company exactly once with a finite score. Remaining candidates retain their original order and retrieval_score with null rerank_score. Rerank scores never overwrite or merge MID/ISCC retrieval scores. The operation does not create analyst labels or verify evidence.",
     "Ranked results with original retrieval_score, separate rerank_score/model/version, reranked_count, untouched-tail count, preserved membership and executed=true only after successful inference.",
     {"run_id":R,"query":"insurance policy administration software","candidates":[{"company_id":A,"description":"Builds policy administration software for insurers","source":"MID","query_id":"QRY-returned-mid-id"}]})

tool("propose_prepared_plan", "Freeze an immutable version-2 screening or question handoff.",
     "Builds a content-addressed snapshot of exact selected source rows, global indices, input/output columns, compiled prompt, provider, deployment, batch size, model options and adapter/retrieval configuration. input_columns starts with immutable index; output_columns excludes index. An empty company_ids selects every considered candidate; hidden rows are excluded. Screening needs a nonempty approved scope. QUESTIONS can return an unscored company table or a direct answer when no rows and output_columns=[]. Direct chat questions use the separate controller-only dispatch_provider_text route without setup. A blank deployment in this Rust proposal is an unconfigured placeholder; the UI resolves its automatic choice to a configured provider deployment or the literal plan value automatic. Neither blank nor automatic is an external deployment. Copilot screening must include genuine PB LinkedIn URL when available; the UI locks that source input after PB hydration. Proposal status is PROPOSED, executed=false; only a trusted controller can approve and dispatch. Batch size is 1–200. Chosen RESULTS or BING fields can be inputs for a later pass.",
     "plan_id, run_id, schema_version=2, backend digest, PROPOSED status, exact spec, full immutable snapshot including rows/hashes/coverage/catalog, and executed=false. Browser previews should display only a small row sample while preserving this backend digest.",
     {"run_id":R,"mode":"screening","provider":"llm_suite","deployment":"automatic","prompt":"For each indexed company, assess core-business product fit. Return one table with Fit Score and Rationale; use CHECK when evidence is insufficient.","company_ids":[],"source_columns":[{"source":"MID","column":"Sector"}],"identity_sources":{"name":["PB","MID","ISCC"],"website":["PB","MID","ISCC"],"description":["PB","MID","ISCC"]},"input_columns":["index","pk","PBId","Company Name","Website","Description","LinkedIn URL","MID:Sector"],"output_columns":["Fit Score","Rationale"],"score_columns":["Fit Score"],"batch_size":50,"provider_options":{},"retrieval_configuration":{}})
tool("get_prepared_plan", "Read a frozen handoff, its approval state and durable batch jobs.",
     "Supply plan_id. The returned digest and immutable snapshot are the source of truth. A PROPOSED plan is not approved; an APPROVED plan is still not executed. Jobs and their states are listed without dispatching a provider call.",
     "Plan ID/run/schema version/digest/status, spec, full frozen snapshot, job IDs/states/input hashes and executed=false.",
     {"plan_id":"PPLAN-returned-id"})
tool("get_execution_job", "Inspect a durable provider batch and its parser or dispatch state.",
     "Supply the returned job_id. Reads exact immutable payload and input hash, attempt/repair count, provider response metadata, dispatch/lease state, errors and acceptance. A prepared or queued job has not necessarily been sent; inspect executed and accepted fields. A dispatch timeout is ambiguous until the controller reconciles it; provider-wide exactly-once delivery is not guaranteed.",
     "Job, plan/run identifiers, state, payload/index mapping, attempt and repair diagnostics, recorded response/error, executed and accepted flags.",
     {"job_id":"JOB-returned-id"})
tool("get_model_assessments", "Read accepted provider assessments separately from retrieval and evidence.",
     "Supply run_id and optionally plan_id or company_id. Returns accepted assessments and direct question answers for the requested scope. Keep each provider/pass score separate from MID/ISCC retrieval rank. Declared score columns can contain 0–10 or CHECK; use CHECK for further review, not as a numeric score. An analyst may select saved RESULTS columns as source context for a later prepared plan. Provider assessments are not analyst labels or verified claims and do not change considered status automatically.",
     "Assessment rows with plan/job/company/index/provider/prompt/result/time and eligible_for_current_use, plus question_answers. An empty result is not evidence of poor fit.",
     {"run_id":R,"plan_id":"PPLAN-returned-id"})

tool("inspect_enrichment_files", "Identify staged spreadsheet roles before hydration or run selection.",
     "Read-only apart from audit. Supply 1–32 import-directory relative file IDs returned by the upload endpoint. Reuse authoritative header detection on every populated sheet: PitchBook mapping headers must be on row one; PB data can follow banners; ROGO uses the first supported Website/Websites header and excludes PB identifiers. Empty sheets are ignored. A workbook containing an unknown or non-enrichment sheet stays pending instead of partly importing a guessed source. Inspection needs no run_id; eligible files may wait until discovery has a saved company set. Import eligible IDs together with import_enrichment_files so mappings precede data rows, and refresh current company context afterwards.",
     "files with file/eligible/roles/sheets/reason; import_files; pending_files; counts by source kind. Each sheet includes kind (PB_MAPPING, PB_DATA, ROGO, COMPANY or null), one-based header row, data-row count and headers. No source values or approvals are changed.",
     {"files":["upload-1.csv","upload-2.xlsx"]})
tool("get_execution_progress", "Poll approval freshness and durable batch progress without large frozen inputs.",
     "Supply plan_id. Checks current source/profile freshness once and returns ordered lightweight job records. Frozen prompts, company inputs, raw responses and private index mappings are omitted. Top-level executed=false describes the prepared handoff; inspect each job's executed flag for actual dispatch. Count SUCCEEDED batches, respect next_eligible_at, and stage eligible accepted records with get_model_assessments. Expired dispatched leases require controller reconciliation; a progress read never authorizes blind redispatch and consumes no provider message.",
     "plan_id/run_id/digest/status/fresh, compact provider/mode/deployment spec, and jobs with job_id/plan_id/ordinal/state/input_hash/attempt/error/next_eligible_at/lease_expires_at/retryable/executed. No provider call occurs.",
     {"plan_id":"PPLAN-returned-id"})

tool("get_screening_grid", "Page every candidate of a run with the fields the company grid needs.",
     "One SQL pass per page: identity, preferred name/website/HQ, combined description, source (MID, ISCC or both), considered flag and consideration_reason, current PBId, best MID and ISCC retrieval scores, PB/ROGO/Bing coverage and compact PitchBook fields. include_hidden defaults to true so the grid can show hidden companies on request. Page with after_company_id; limit defaults to 1,000, maximum 2,000.",
     "rows plus total, considered_count, hidden_count, selection_revision, criteria_revision and next_cursor (null on the last page). Read-only.",
     {"run_id":R,"include_hidden":True,"limit":1000})
tool("get_company_detail", "Read everything known about one candidate for the company drawer.",
     "Returns the canonical company, identifiers, considered flag and reason, per-source fields (MID, ISCC, PitchBook, ROGO), labelled descriptions for keyword highlighting, and a bounded activity list merging hide/restore history, research observations and model assessments.",
     "company, identifiers, considered, consideration_reason, sources, descriptions and activity. Read-only.",
     {"run_id":R,"company_id":A})
tool("get_enrichment_report", "Read a saved PitchBook or ROGO import match report.",
     "Every import saves a non-cumulative report measured against the run's current candidates (considered and hidden). PitchBook reports list matched companies with their PBId and not-matched companies with a reason: not_in_mapping, profile_not_company, blank_pbid, no_data_row or conflict. ROGO reports list matched companies, unmatched rows and ambiguous websites. Omit report_id for the latest report. Imports never hide companies; the analyst applies a decision with the apply_enrichment_review administrator operation.",
     "report_id, purpose, summary counts, matched, not_matched (PitchBook) or matched/unmatched_rows/ambiguous (ROGO), and created_at. Read-only.",
     {"run_id":R})

GROUPS = [
    ("Company discovery and retrieval",["search_mid","search_companies","find_company","find_similar_companies","find_similar_to_examples","search_iscc","get_iscc_score_samples","get_retrieval_config","embed_texts","rerank_candidates"]),
    ("Identity and source context",["get_company","get_company_identifiers","get_source_rows","get_candidate_source_data","get_run_source_projection","get_source_field_catalog"]),
    ("Scoped context",["get_company_context","get_candidate_context","get_candidate_batch_context","build_context_packet"]),
    ("Screening criteria and profile lineage",["get_run_context","get_original_criteria","get_criteria_history","get_active_screening_profile","get_screening_profile_version","compare_profile_versions","propose_screening_profile","get_search_policy"]),
    ("Analyst examples",["label_company","get_labelled_examples","get_representative_examples"]),
    ("Evidence",["save_evidence","get_evidence","get_missing_evidence"]),
    ("Research",["bing_search","m365_research","fetch_url","extract_url_context"]),
    ("Durable memory",["search_research_memory","get_previous_research","get_recent_agent_events","get_search_history","get_open_questions","add_open_question","resolve_open_question"]),
    ("Candidate funnel",["add_candidates","get_candidate_set","get_shortlist_context","get_screening_grid","get_company_detail","update_candidate_status","get_discovery_summary"]),
    ("Enrichment and exports",["inspect_enrichment_files","import_enrichment_files","get_enrichment_report","export_candidate_set"]),
    ("Approved action graphs and screening",["propose_action_plan","get_action_plan","propose_prepared_plan","get_prepared_plan","get_execution_progress","get_execution_job","get_model_assessments","prepare_screening_batch","prepare_bing_queries","save_screening_results","get_screening_results","complete_action_step"]),
    ("Recovery",["save_checkpoint","get_checkpoint"]),
]

# Runtime bounds that are stricter than, or absent from, generated JSON Schema.
# These corrections keep prose aligned with the implementation's constants.
for name, before, after in [
    ("get_source_rows","maximum 200","maximum 100"),
    ("search_iscc","defaults to 100","defaults to 1,000"),
    ("bing_search","defaults to 10","defaults to 20"),
    ("fetch_url","defaults to 15","defaults to 12"),
    ("fetch_url","maximum 8,000,000","maximum 4,000,000"),
    ("extract_url_context","defaults to 12,000","defaults to 20,000"),
    ("get_candidate_batch_context","analyst_notes, open_questions, discovery, missing_evidence","analyst_feedback, discovery, missing_attributes, research_status"),
    ("get_screening_profile_version","Content, parent lineage and supporting examples","Content and supporting examples"),
    ("propose_screening_profile","next version and parent lineage", "next version and supporting-example lineage"),
]:
    entry=list(META[name]); entry[1]=entry[1].replace(before,after); META[name]=tuple(entry)
entry=list(META["compare_profile_versions"])
entry[1]=entry[1].replace("Comparison preserves both full versions and lists", "Comparison reads both versions and lists")
entry[2]="version_a/version_b, added_preferences, removed_preferences, changed_constraints, reason_for_changes and supporting_analyst_examples. To read complete profiles, call get_screening_profile_version."
META["compare_profile_versions"]=tuple(entry)

def anchor(text):
    return text.lower().replace(" ","-")

def j(value):
    return json.dumps(value,ensure_ascii=False,indent=2)

def typename(s):
    if isinstance(s,bool): return "JSON value" if s else "forbidden"
    if "$ref" in s: return s["$ref"].split("/")[-1]
    if "anyOf" in s: return " or ".join(typename(x) for x in s["anyOf"])
    if "oneOf" in s: return " or ".join(typename(x) for x in s["oneOf"])
    if "enum" in s: return " / ".join("`"+str(x)+"`" for x in s["enum"])
    if s.get("type")=="array": return "array of "+typename(s.get("items",{}))
    if isinstance(s.get("type"),list): return " or ".join(s["type"])
    return s.get("type","JSON value")

def table(schema):
    lines=["| Argument | Required by schema | Type | Schema default |","|---|---|---|---|"]
    required=schema.get("required",[])
    for name, prop in schema.get("properties",{}).items():
        if isinstance(prop,bool): prop={} if prop else {"type":"forbidden"}
        default="`"+json.dumps(prop["default"],ensure_ascii=False)+"`" if "default" in prop else "—"
        lines.append(f"| `{name}` | {'Yes' if name in required else 'No'} | {typename(prop)} | {default} |")
    return "\n".join(lines)

INTRO = """# M&A screening and research tool reference

The agent catalog exposes the registered tools below, while analyst and controller operations use separate authenticated routes. This reference describes reviewed behavior, runtime limits, side effects and example argument objects generated from the Rust argument schemas. The live catalogs are authoritative for the currently built binary.

See [README.md](README.md) for project setup and the implementation notes for local operation. This reference is the reviewed prose companion to the live argument schemas.

## Calling the tools

The service listens on `http://127.0.0.1:7318`. Supply `Authorization: Bearer <MNA_API_KEY>`. Analyst approval routes require `X-MNA-Analyst-Key: <MNA_ANALYST_KEY>`; controller execution routes require `X-MNA-Controller-Key` instead of the analyst key. Keep credentials in headers/environment variables, never model prompts, plan parameters or checkpoints.

```json
{"tool":"get_company","arguments":{"company_id":"100-101"}}
```

The JSON envelope is the controller's Rust transport to `POST /tools/call`; models do not send JSON tool calls. For LLMSuite, the controller requests `GET /agent/tools?names=...` and presents the plain-English catalog plus a `BEGIN TOOL v1 ... END TOOL` typed-line command grammar. The model returns one text command, which the controller parses and dispatches. Parser repairs are limited to two and each repair consumes the shared LLMSuite seven-per-minute budget only when actually dispatched. Tool paths accept underscores or hyphens. `GET /tools` exposes registered descriptions/schemas; `GET /tools?names=...` filters them. [tool-catalog.json](tool-catalog.json) is the generated snapshot. `GET /admin/tools` exposes privileged schemas.

Unknown argument fields are rejected, including typed nested fields. Bodies are limited to 1 MiB. `POST /tools/batch` accepts 1–16 calls and runs them sequentially with independent success/error results; it is not atomic. Independent retrieval calls may be dispatched in parallel by the orchestrator. SQLite writes and identity promotion are transactional. Read tools also create ordinary audit records; `mutates_state` describes domain/history/artifact effects beyond that audit.

Examples use fictional companies and derived keys `100-101`, `200-202`, `300-303`. `R42` is a sample run. Replace `PLAN-returned-id`, `BATCH-returned-id`, `QRY-returned-...`, `QUE-returned-id` and `OP-returned-id` with actual returned values. Names ending in `.example` are illustrative, not live research targets. An example is not permission to invoke a provider or to record a fabricated analyst label.

## Identity and qualitative policy

| Available identifiers | Initial internal company_id / pk |
|---|---|
| ECID and CID | `ECID-CID` |
| CID only | `X-CID` |
| ECID only | `ECID-X` (provisional) |
| Neither | Excluded from companies; raw row quarantined |

Normalize whitespace, case and null markers such as blank, `-`, `0`, `NA`, `N/A`, `#N/A`, `null` and `none`; retain raw values in source rows. Literal `X` is reserved for a missing component. A complete exact identifier bridge can promote a provisional key while retaining old PK aliases and dependent references. Conflicting pairs or concatenation collisions are quarantined rather than silently merged. PBId is a later additional identifier. Company names and websites alone never merge identities.

Discovery uses descriptions, products, services, core-business keywords and examples. Financial, employee-size, geography, ownership and source industry-classification fields are **recorded but never used to search or filter**. Only approved `core_business_exclusions` may filter discovery. Accepted legacy filters are named in `ignored_search_filters`; show that notice to the analyst. The service cannot reliably infer every non-core condition from free text: the orchestrator must extract and record `unused_criteria` and keep generated queries qualitative.

A new run starts with a proposed profile. The UI also saves each criteria edit as a durable revision, including separate optional good-fit and bad-fit examples. Only the latest approved criteria revision can authorize new search or screening; a later edit requires another approval. `get_criteria_history` shows older versions without reactivating them. `find_company`, working criteria packets and an approved literal Bing clarification plan can help interpret examples. `label_company` is reserved for analyst-supplied feedback. Retrieval scores, reranker scores, provider assessments and verified evidence are separate records.

Companies, exact identifiers, source rows and compact PB/ROGO enrichment are global. Candidate status, considered/hidden selection, criteria revisions, labels, evidence, questions, screening results, plans and checkpoints are run-scoped. By default candidate readers and exports use the considered set; `get_shortlist_context` can page hidden history. `get_previous_research` and `get_source_rows` explicitly permit broader inspection; other scoped tools do not silently reuse another run's conclusions. Saved RESULTS and BING fields can be selected as labeled context for a later screening.

## Tool index

"""

TAIL = """
## Export and upload formats

| Export type | Sheets | Exact columns |
|---|---|---|
| `PITCHBOOK` | `PITCHBOOK` | `pk`, `Company Name`, `Website`, `HQ City`, `HQ State`, `Source` |
| `LLM` | `LLM` | `index`, `pk`, `Company Name`, `Website`, `Source`, `Description` |
| `FULL` | `MID`, `ISCC` | `pk` first, then all original source columns |

Exports include considered companies only; hidden rows remain in saved history and can be restored. `Source` is `MID`, `ISCC` or literal `both`; legacy records with no retained source are explicit `UNKNOWN`. LLM `index` runs from 1 to n. Full Export unions source headers in deterministic order and retains original source observations, so it can have multiple rows for one pk. Original formula-like strings are escaped in Excel cells. Exports use a consistent SQLite snapshot while holding the store connection, so a large export can briefly delay writes.

The PitchBook mapping list must contain these headers in its **first row**, in any order:

```text
pk | PBId | Firm Name from PitchBook | Website from PitchBook | Company Profile | Investor Profile | Limited Partner Profile | Service Provider Profile
```

Only `Company Profile = Yes` creates PBId. An explicit `No` or unmapped row can hide a candidate in that run; `exclude_unmapped=true` with a current mapping sheet also hides still-unmapped candidates. A later eligible mapping can restore a mapping-hidden row, but cannot restore a row manually hidden by an analyst. A ROGO-only import does not reapply an old PB mapping exclusion. The PitchBook data header contains `Company ID`, `Companies`, and at least one of `Description` or `HQ Location`; it can follow a preamble within the first 1,000 rows. Remove `© PitchBook Data, Inc. YYYY` wherever it occurs, independent of the year. These compact fields are retained:

| PitchBook source | Compact field |
|---|---|
| Website | `PB_Website` |
| Companies | `PB_Name` |
| Description | `PB_Description` |
| LinkedIn URL | `PB_LinkedIn URL` |
| HQ Location | `PB_HQ Location` |
| Active Investors | `PB_Active Investors` |
| Universe | `PB_Universe` |

Parquet preserves all PitchBook source columns as nullable UTF-8 columns, including wide fields not loaded into context. Its internal columns are `c0000`, `c0001`, ...; file metadata `original_columns` maps them back to original headers. SQLite keeps PB row hashes/Company ID/artifact locators rather than duplicating every wide value.

ROGO contains a topmost `Website`, `website` or `websites` header with variable additional columns and no PBId header. Website normalization compares hostnames and removes `www.`; it is a data join, not an entity merge. A usable different PB website suppresses fallback to the old common website. Ambiguous matches are quarantined. The upload parser supports CSV, XLSX, XLS, XLSM, XLSB and ODS, up to 32 files, 512 columns, 100 sheets per workbook and a 512 MiB file bound. Imports have an aggregate 250,000-row bound. Row materialization means real wide 150,000-company inputs still need deployment benchmarking. Uploaded files are staged under `MNA_IMPORT_DIR` (default `data/import`); output workbooks and Parquet go under `MNA_EXPORT_DIR` (default `data/export`). Paths cannot traverse those roots or escape through a symlink.

## Administrator operations

These operations are excluded from the model tool catalog. The criteria, shortlist and provider-text routes are controller-only; the UI obtains the analyst's decision before calling them. Other analyst-facing routes require service and analyst authentication. A model can propose a prepared plan but cannot approve, lease, dispatch, reconcile or fail provider work.

| Operation | Endpoint | Behavior |
|---|---|---|
| `ingest_companies` | `/admin/companies` | Legacy typed canonical upsert, maximum 1,000 rows/request. Caller supplies company_id; use MID file import for the new ECID/CID-derived source model. |
| `import_company_files` | `/admin/company-files` | Parse staged MID file(s), derive IDs, cross-reference, quarantine collisions and retain raw source rows. source defaults to MID and other values are rejected. |
| `create_run` | `/admin/runs` | Create immutable original criteria and a PROPOSED initial profile. Active approved profile remains 0 until human approval. |
| `sync_search_index` | `/admin/index` | Configure/index the optional qualitative Meilisearch projection in bounded keyset batches. No embedding inference. |
| `approve_screening_profile` | `/admin/profiles/approve` | Approve one PROPOSED version, supersede the old active version and record the approver. |
| `save_criteria_revision` | `/admin/criteria-save` | Controller-only save of text, business definition and separate good/bad example lists before discovery or after an edit. A new revision makes the last approval stale. |
| `approve_criteria_revision` | `/admin/criteria-approve` | Controller-only approval of the latest revision by exact revision number and digest; creates a new approved screening profile. |
| `review_shortlist` | `/admin/shortlist-review` | Controller-only analyst selection: keep named IDs, hide others, and save chosen result columns. Require the current selection revision when available. History is retained. |
| `approve_action_plan` | `/admin/actions/approve` | Approve or reject an immutable proposal at its original profile version; stale proposals must be rebuilt. |
| `approve_prepared_plan` | `/admin/prepared-plan-approve` | Approve a version-2 plan by its exact backend digest; creates durable jobs but leaves `executed=false`. |
| `cancel_prepared_plan` | `/admin/prepared-plan-cancel` | Cancel an undispatched prepared plan through the controller. |
| `lease_execution_job` | `/admin/execution-lease` | Controller-only lease for one eligible durable job. |
| `mark_execution_dispatch` | `/admin/execution-mark` | Controller-only record that a provider request is about to be sent. |
| `dispatch_execution_job` | `/admin/execution-dispatch` | Controller-only provider dispatch using the leased immutable payload. External execution occurs only here. |
| `dispatch_provider_text` | `/admin/provider-text` | Controller-only direct LLMSuite/M365 question or bounded draft request, without scored-screening setup. Strict output blocks, request-key replay protection, at most two repairs and the shared LLMSuite seven-send gate apply. Disconnected service returns `executed:false`. |
| `record_execution_response` | `/admin/execution-response` | Controller-only save of the actual provider response for strict parsing. |
| `reconcile_execution_job` | `/admin/execution-reconcile` | Controller-only recovery of ambiguous external outcomes. |
| `record_execution_failure` | `/admin/execution-failure` | Controller-only record of a confirmed dispatch failure. |
| `retry_execution_job` | `/admin/execution-retry` | Controller-only return of a definitively rejected FAILED attempt to READY after explicit analyst request and freshness checks. No send occurs here. |
| `reserve_llmsuite_slot` / `consume_llmsuite_slot` | `/admin/llmsuite-slot`, `/admin/llmsuite-consume` | Shared seven-per-minute LLMSuite budget; consumption tracks actual dispatch, including parser repairs. |
| `review_evidence_claim` | `/admin/evidence-review` | Record analyst verification or rejection; unreviewed claims remain `UNKNOWN`. |
| `rebuild_embedding_index` | `/admin/embedding-index` | Generate real local-worker embeddings and persist them keyed by model/version/text hash. |

For `retry_execution_job`, send `{"job_id":"JOB-returned-id","attempt":1,"reason":"Analyst requested retry of the rejected batch","analyst_requested":true}` with the ordinary bearer credential and `X-MNA-Controller-Key`. The service requires the exact failed attempt, current approval/source snapshot, and a durable definitive rejected-response marker. It preserves accepted results and prior attempts, sends nothing and consumes no slot. A later dispatch uses the shared limit normally. AMBIGUOUS, RUNNING, stale, attempt-mismatched and exhausted parser results are rejected. The response includes previous_attempt, state=READY, executed=false and automatically_redispatched=false.

The [background screening and upload flow](../mna-ui/BACKGROUND_SCREENING.md) describes the implemented controller, pause/recovery, partial staging, automatic spreadsheet detection and approved Bing grounding. Live corporate providers remain disabled unless configured and explicitly approved.

Create a run before discovery:

```json
{"run_id":"R42","objective":"Find insurance workflow product vendors","original_criteria":{"text":"Policy and claims software businesses; India preferred","geography":"India"},"initial_profile":{"core_business_query":"insurance policy administration and claims workflow software","core_business_criteria":["Owns an insurer workflow software product"],"unused_criteria":[{"criterion":"India preferred","reason":"Geography is recorded but not used for discovery"}]}}
```

Post to `/admin/runs`. Save the reviewed criteria and optional example boxes to `/admin/criteria-save`:

```json
{"run_id":"R42","criteria_text":"Policy and claims software businesses; India preferred","business_definition":"Owns insurer policy administration or claims workflow software","good_fit_examples":["A vendor with an owned policy administration product"],"bad_fit_examples":["A consulting firm that only implements other products"]}
```

After showing the saved revision to the analyst, send the exact returned revision and digest to `/admin/criteria-approve`:

```json
{"run_id":"R42","revision":1,"digest":"DIGEST-returned-by-criteria-save","approved_by":"authenticated analyst"}
```

When criteria change later, save another revision and approve that latest digest before more discovery or execution. `get_criteria_history` reads all versions. This route creates the next approved screening profile. The older `/admin/profiles/approve` route remains for a separately proposed structured profile.

MID import after files are staged:

```json
{"files":["mid.xlsx"],"source":"MID"}
```

Action approval at `/admin/actions/approve`:

```json
{"run_id":"R42","plan_id":"PLAN-returned-id","approved_by":"authenticated analyst","approve":true}
```

After reviewing scores, use `/admin/shortlist-review` to keep matches and CHECK cases, hide the rest, and select result columns for a later pass:

```json
{"run_id":"R42","keep_company_ids":["100-101","200-202"],"expected_selection_revision":3,"review_columns":{"PPLAN-returned-id":["Fit Score","Rationale"]},"reason":"Analyst kept matches and CHECK cases"}
```

For a direct chat question, the controller can call `/admin/provider-text` without a prepared screening plan:

```json
{"run_id":"R42","provider":"llm_suite","prompt":"Which product evidence is missing for the current shortlist?","request_id":"question-1","expected_format":"text","purpose":"question","attachments":[]}
```

Omit `deployment` to use the configured provider deployment. A request with no configured connection or deployment returns `executed:false`. For generated Bing query chips, use `expected_format:"query_templates"`; Rust requires one to five distinct `QUERY:` lines inside the exact `BEGIN_QUERIES`/`END_QUERIES` block. Criteria and screening-prompt drafts have their own exact blocks. Each malformed response has at most two repairs under the same LLMSuite send gate. These examples describe input shapes and do not assert that a live provider ran.

The free-text `approved_by` is audit metadata; production user authentication belongs to the controller. Do not expose the analyst key to the LLM. On migration, legacy profiles auto-approved as `system_initialization` are returned to PROPOSED, requiring actual approval; existing human approvals are retained.

## Worked orchestration example

1. Create a run from DDI extraction or plain text. Review the core business, then optional good-fit and bad-fit boxes. Save each criteria revision with `save_criteria_revision`; approve the final digest with `approve_criteria_revision`. Keep unclear terms as open questions. The local UI does not extract PDF/DOCX text automatically.
2. Read `get_criteria_history` and the approved profile before searching. A later edit creates a new revision and requires another approval. Earlier approved execution plans become stale. A separately proposed structured profile can still use `/admin/profiles/approve`.
3. Run `search_mid` and `search_iscc` independently. Use `get_iscc_score_samples` to inspect deciles 0.9–0.3 and choose broad relevant rows. Record why a threshold around 0.45 was widened or narrowed. Add selected IDs in chunks with their source/query IDs.
4. Read considered source counts from `get_discovery_summary`, then page `get_shortlist_context` with include_hidden=true to show every saved company and its review flag. Suggest PitchBook/Bing at 0<n<1000, ROGO at 500<n<2000, LLMSuite at n>2000, and M365 at 0<n<250 with PB context. Both enrichment and research accordions remain available; these suggestions do not filter or execute work.
5. Interpret “Populate PitchBook and ROGO, then screen” into the plan example above. Record the human's explicit request through the controller approval route once. Import all available files; processing mapping before PB data before ROGO can satisfy the sequence in a single import call. Preserve and claim that operation's receipt only for the plan step whose input parameters match; do not reuse one receipt to pretend two separate steps ran.
6. For retrieval, request up to 1,000 hits per query. An optional local reranker may reorder only the first 500 from one source/query group; preserve the remaining tail. A run may hold more than 1,000 candidates. For scored LLMSuite/Copilot work, propose a version-2 prepared plan with frozen considered rows, global index, columns, prompt, provider, deployment and batch size. An automatic model choice resolves to configured deployment or remains a non-dispatched placeholder. Show a bounded preview and retain the Rust digest. The controller alone may approve, lease and dispatch. A direct LLMSuite/M365 chat question instead uses `dispatch_provider_text`, with no screening setup. Genuine PB LinkedIn pages must be included for Copilot screening when available.
7. For Bing research, approve one to five fit templates such as “Does <company> build policy administration software?” The UI expands them for all considered companies, prepares and sends in bounded pages, and continues through the approved request list. Every saved observation is an unverified research lead until analyst review.
8. Review fit scores and CHECK rows, then call `review_shortlist` to keep desired IDs and hide others. Select useful RESULTS columns for another pass. Export considered rows only. Save a checkpoint after each loop boundary and check criteria revision, shortlist revision, completed receipts and saved jobs before repeating work.

## Loops, graphs and implementation boundaries

Use loops for screening-criteria clarification, purposeful MID/ISCC query variations, score-boundary calibration, analyst requests for more targets and missing-evidence research. Save loop budgets and progress in checkpoint state. Use a dependency DAG for actions such as mapping → PB hydration → ROGO join → research/screening. Independent MID/ISCC calls can run concurrently; dependent steps wait for receipts. Provider batches follow the shared LLMSuite rate gate and controller job states.

The Rust layer implements deterministic APIs, persistence, parsers, joins, Parquet/XLSX generation, policy/approval validation, local HTTP model adapters and durable execution state. The optional local embedding worker runs CPU ONNX inference only when explicitly configured with supplied model and tokenizer files; it never downloads assets. Endpoint configuration is reported as configured-but-unverified until inference succeeds. Rust does not implement DDI interpretation, chat/HITL widgets, live corporate CDP authentication, a scheduler, or LLMSuite/Copilot inference. Provider/network execution remains disabled unless explicitly enabled and is dispatched only by the controller. No live corporate integration is implied by local mock tests.

The durable job ledger, leases, dispatch records, response parser and reconciliation states are implemented in SQLite. They support recovery and auditable retries, but cannot guarantee exactly-once delivery by an external provider; ambiguous outcomes require controller reconciliation. Current shortlist revisions and selection history are durable. Full historical candidate-set snapshots, complete artifact manifests and file/sheet/row locators for every raw company row remain future extensions. Query/evidence/receipt records are durable; retrieval caches remain implementation-dependent. Default exports create fresh artifacts, so the orchestrator should reuse saved receipts/checkpoints on recovery rather than assume an export retry is automatically deduplicated.

## Errors and recovery rules

| Code | Meaning and response |
|---|---|
| `INVALID_ARGUMENTS` | Correct unknown fields, ID selectors, bounds, score values, paths or source page size. |
| `NOT_FOUND` | Resolve the identifier/run/record or import the required company. An absent approved profile needs approval. |
| `CONFLICT` | Resolve a stale profile/plan/checkpoint, identity collision, changed screening result, incomplete dependency or existing export filename. |
| `PROVIDER_UNAVAILABLE` / `PROVIDER_ERROR` | Preserve the failure and a research gap; check deployment configuration or upstream response. |
| `RATE_LIMITED` | Respect the provider budget and retry under the orchestrator's bounded policy. |
| `AUTH_REQUIRED` / `ANALYST_AUTH_REQUIRED` | The trusted application supplies the correct credentials; the agent does not escalate its role. |

Persist original observations and do not convert unknown/error conditions into negative fit evidence. Inspect omission metadata before concluding that a context packet lacks research. Approvals cannot be fabricated from model suggestions. An analyst can skip a nonblocking question; the orchestrator must carry the open question or a clearly authorized assumption into the next profile review.

## Nested argument schemas

The tables below cover typed nested objects and enums referenced by the agent argument tables. Flexible JSON values such as profile content, evidence value, checkpoint state and plan parameters have additional semantic/runtime rules described above. The live catalog remains the machine-readable authority.

"""

assert len(TOOLS)==70 and set(META)==set(TOOLS)
grouped=[name for _,names in GROUPS for name in names]
assert len(grouped)==len(TOOLS) and len(set(grouped))==len(TOOLS) and set(grouped)==set(TOOLS)
parts=[INTRO]
for group,names in GROUPS:
    parts.append(f"- [{group}](#{anchor(group)}): "+", ".join(f"`{name}`" for name in names)+"\n")
number=0
for group,names in GROUPS:
    parts.append(f"\n## {group}\n")
    for name in names:
        number+=1
        purpose,behavior,returns,example=META[name]
        parts.append(f"\n### {number}. `{name}`\n\n**Purpose:** {purpose}\n\n**How it works:** {behavior}\n\n{table(TOOLS[name]['input_schema'])}\n\n**Returned data and effects:** {returns}\n\n**Example arguments:**\n\n```json\n{j(example)}\n```\n")
parts.append(TAIL)
defs={}
for t in CATALOG:
    for name,schema in t['input_schema'].get('$defs',{}).items():
        if name in defs: assert defs[name]==schema,(name,'inconsistent nested schema')
        defs[name]=schema
for name,schema in sorted(defs.items()):
    parts.append(f"\n### `{name}`\n\n")
    if 'properties' in schema: parts.append(table(schema)+"\n")
    else: parts.append("```json\n"+j(schema)+"\n```\n")
    if schema.get('additionalProperties') is False: parts.append("\nUnknown nested fields are rejected.\n")
(ROOT/'TOOL_REFERENCE.md').write_text(''.join(parts),encoding='utf-8')
(ROOT/'docs'/'tool-examples.json').write_text(j({name:entry[3] for name,entry in META.items()})+'\n',encoding='utf-8')
print(f"Wrote reference and example arguments for {len(META)} tools; {len(defs)} nested schemas.")
