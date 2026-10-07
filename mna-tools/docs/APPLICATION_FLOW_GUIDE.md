# Application flow: analyst experience, data, memory, and LangGraph

Prepared 6 October 2026. This guide consolidates your requested workflow and explains how it maps to the current application. It covers the business process first, then the developer design.

## 1. What the application is doing

The application helps an analyst move from a qualitative business description to a researched, reviewable shortlist. It is an iterative screening workspace. The analyst can change the criteria, add information, run another assessment, hide weak matches, restore a company, and export the current shortlist.

Three things must stay separate:

1. **What is saved:** all discovered companies, source observations, criteria versions, research, assessments, and review decisions.
2. **What is considered now:** the companies whose run-scoped considered flag is true.
3. **What is sent for a particular task:** the selected companies, source fields, attachments, criteria revision, and prompt captured for that task.

Hiding a company changes the second item. Selecting input columns changes the third. Neither action deletes the first.

Your intended lead orchestrator is **LLM Suite**. Its subagents also use LLM Suite and share its seven-message-per-minute allowance. M365 Copilot is a separate optional analysis, question, and screening provider. Bing supplies grounding research. The local models are an embedder and an optional reranker; they do not replace LLM Suite as the reasoning agent.

### Implementation status

| Path | Status in the current repository |
|---|---|
| Chat/workspace, criteria review, optional examples, shortlist review, source uploads, setup dialogs, background controls, exports | Implemented locally |
| Rust/SQLite identity, revisions, source projections, prepared plans, parser, execution records, rate gate | Implemented and tested with local fixtures |
| MID lexical retrieval | Working local path; example uses fictional records |
| Build Index, keyword Match %, semantic score, score grid and rounds | Implemented locally; 150,000-row throughput and real embedding-model recall unverified |
| Development simulation | `SCREENING_SIMULATE=1` supplies labelled deterministic ISCC, LLM Suite/M365 and Bing output; it is not a live provider test |
| Arctic M v2 INT8 ONNX 768D embedding | Replaceable adapter and worker implemented; real weights/runtime assets and population recall unverified |
| Reranking | Replaceable contract implemented; production model not selected |
| Live ISCC, LLM Suite, M365, and Bing | Transport boundaries exist; corporate connections are unconfigured and unverified |
| PDF/DOCX attachment text for direct questions | Bounded extraction implemented in the bridge |
| Intake Form PDF pre-fill | PDF opens and label matches pre-fill fields; check each field. Full parsing is deferred. |
| Python LangGraph | Tested offline scaffold; not wired to the running UI/bridge/Rust service |

The intended flow below describes connected operation. A disconnected operation must remain visibly unexecuted. A prepared or approved job is not a completed model assessment.

### Phase 2 path through this flow

Before MID discovery, the analyst can open **Build Index** and select a staged MID XLSX. `mna-tools/config/mid-index.json` defines searchable, description, FTS and identifier columns plus weights. The build window shows eight durable steps: read workbook, check columns, match company IDs, store rows, build keyword index, semantic embeddings, verify and activate. The embedding step is honestly **skipped** until `MNA_EMBED_ENDPOINT` is configured. A completed bundle can be selected again for rollback. Large 150,000-row timing and real model quality are still unverified.

After criteria approval, build core-business keyword groups with a saved rationale. `search_mid` v2 supports stem/exact terms, positive weights and `AND`, `OR` and approved-exclusion `AND NOT` expressions. Its Match % divides matched positive weights by all positive weights. The legacy query form still works. Aiming for roughly 4,000–5,000 MID companies is a broad-review goal, not a search guarantee. With ready vectors, `score_mid_semantic` gives a separate 0–10 score; otherwise it returns **skipped**. Optional semantic-only search can add candidates.

ISCC Relevancy Score stays on its own 0–1 scale. Merge exact ECID or ECI first, then CID or Crescendo ID (the same identifier). The Companies view has All, MID and ISCC tabs, separate score columns, histograms and bucket filters. Numeric screening filters include `CHECK` by default, with CHECK shown last. Approved scored LLM Suite and M365 plans are R1, R2 and so on; the Overview timeline and grid show saved results by round, without implying that an approved but disconnected plan ran. Keep or hide after review, restore when needed, then hydrate, screen and filter again.

For development only, `SCREENING_SIMULATE=1` supplies labelled deterministic ISCC rows, LLM Suite/M365 tables and Bing leads. The UI marks simulated rows and runs. Standard exports refuse simulated rows; `allow_simulated` on the export tool produces a labelled workbook. This path does not validate corporate provider connections.

## 2. The full analyst flow

~~~mermaid
flowchart TD
    A[Name screening and provide criteria or Intake Form] --> B[Draft core-business criteria]
    B --> C[Review business criteria]
    C --> D{Accept business interpretation?}
    D -- Revise --> B
    D -- Yes --> E[Optional good-fit and bad-fit examples]
    E --> F[Review final criteria revision]
    F --> G{Approve final criteria?}
    G -- Revise --> B
    G -- Approve --> H[Discover broadly in MID and ISCC]
    H --> I[Review saved companies and source coverage]
    I -- Find more --> H
    I --> J[Choose next step]
    J --> K[PitchBook or ROGO hydration]
    J --> L[Bing research]
    J --> M[LLM Suite or M365 screening]
    K --> N[Refresh selected company context]
    L --> N
    M --> N
    N --> O[Review results and considered flags]
    O -- Add data or screen again --> J
    O -- Revise criteria --> B
    O -- Finish --> P[Export considered companies]
~~~

### Step 1 — Start and name the screening

**Analyst:** Click New screening, enter a name, and describe the business or attach an Intake Form. Example: “Find companies that sell policy administration and claims-management software to insurers.”

**Application:** Create a run that owns the criteria history, candidate membership, approvals, research, and assessments. Stage attached files with their purpose. Keep the original supplied material available for audit.

A file being uploaded, previewed, extracted, and used in a model task are four separate events. The interface should communicate each one accurately.

### Step 2 — Understand the core business

**Analyst:** Review the assistant's interpretation. Answer useful questions, add clarifications, or leave non-blocking questions unanswered.

**Intended agent behavior:** Extract products, services, customer workflows, business models, and approved business exclusions. If examples are named without explanation, research them to understand why they may fit. Optional M365 analysis can provide another separately attributed interpretation; LLM Suite can synthesize the differences.

Revenue, headcount, geography, ownership, and imperfect industry classifications remain **deferred analyst review conditions**. They are visible in the screening context, but they do not narrow the initial discovery search.

For example:

| Supplied criterion | Discovery treatment |
|---|---|
| Builds insurance claims software | Use as core-business text |
| Exclude companies that only provide outsourced claims services | Use only after the analyst approves this business exclusion |
| US headquarters | Keep for later review; do not filter retrieval |
| Revenue above a threshold | Keep for later review; do not filter retrieval |
| Founder-owned | Keep for later review; do not filter retrieval |
| A particular industry code | Keep as a reference; do not require a perfect classification match |

The current offline draft uses deterministic text handling. It is not evidence that live LLM Suite/M365 criteria analysis has run.

### Step 3 — Accept the business interpretation

**Analyst:** Accept the initial business interpretation or edit it.

**Application:** This first acceptance advances the review flow. It does not authorize provider screening or replace the final criteria approval.

This is the first clarification loop: draft → review → revise → draft. The agent should ask questions that affect the business definition, rather than blocking progress over every missing financial or geographic detail.

### Step 4 — Add optional good-fit and bad-fit examples

The same component contains two textboxes:

- **Good-fit examples:** companies or descriptions showing what belongs.
- **Bad-fit examples:** companies or descriptions showing what should be excluded.

**Analyst:** Fill either box, fill both, or skip them.

**Application:** Save the examples with the criteria revision. Use them to refine the business definition and, later, prompt generation and example-based discovery. The current UI saves another revision even when this step is skipped.

Examples are supplied analyst feedback. A model must not invent an analyst label because it predicts that a company is a good fit. The label_company operation records a label supplied by the caller; orchestration should invoke it only for actual analyst feedback.

### Step 5 — Approve the final criteria revision

**Analyst:** Review the combined definition and examples, then approve the final revision.

**Application:** Record approval of that exact revision. The next discovery step uses the approved criteria.

Criteria can be changed at any later stage. An edit creates a new revision and requires another approval. “Last criteria” means the immediately preceding version in the interface; the database still retains the complete history.

Changing criteria does not erase companies or previous results. It changes which definition is current and whether previously prepared work still matches it.

### Step 6 — Discover a broad company set

**Intended agent:** Break the approved business definition into meaningful product/service themes. Try appropriate keyword, semantic, hybrid, and example-similarity searches in MID and short qualitative queries in ISCC. Use LLM Suite subagents for bounded search work when connected.

- MID is the ingested internal population.
- ISCC is a live source and must add its returned rows to the same identity/source model.
- Legacy MID and ISCC queries return up to **1,000 per call**; MID keyword v2 defaults to 5,000 and allows up to 20,000. These are not whole-screening limits.
- ISCC queries normally use 10–12 qualitative words, at most 14, and at most five distinct variants in an approved plan.
- The reranker contract reranks the first 500 in a source/query group and preserves the remaining tail. It does not delete the other retrieved companies.
- Keep approved core-business exclusions separate from deferred conditions.

For ISCC, the agent can inspect a few descriptions around relevance levels 0.9, 0.8, and so on down toward 0.3. The purpose is to assess how broad a useful pull should be. A customary 0.45 relevance level is a retrieval judgment, not a final fit verdict.

MID and ISCC scores must remain separate. A MID score of 0.6 and an ISCC score of 0.6 do not mean the same thing and must not be averaged into a single screening score.

**Analyst:** See the unique total, MID-only count, ISCC-only count, and overlap. Ask for more targets or proceed.

**Current limitation:** The local “find more” action reruns approved discovery. Its broader argument is not currently transmitted as a distinct search strategy. Adaptive query variation and multi-agent broadening are intended connected-orchestrator behavior, not demonstrated by that button alone.

### Step 7 — Briefly review the company list

**Analyst:** Inspect descriptions and sources. Hide obvious unwanted companies or restore a previously hidden company.

**Application:** Save the decision on the candidate's membership in this run. A company can be considered in one screening and hidden in another. Candidate status, analyst labels, model scores, and considered membership are different records.

From this point onward, company research, screening scope, recommendation counts, and standard exports use the **considered** set.

### Step 8 — Choose enrichment, research, or screening

One component contains two independently expandable groups:

1. **Company enrichment:** PitchBook and ROGO.
2. **Research and screening:** LLM Suite, M365 Copilot, and Bing.

Recommendations are suggestions. They do not prohibit another choice, execute anything automatically, or mean the provider is connected.

Current rules use considered count **n**:

| Condition | Recommended action |
|---|---|
| 1–999 companies | PitchBook and Bing |
| 501–1,999 companies | ROGO as well |
| More than 2,000 companies | LLM Suite screening |
| 1–249 companies and PitchBook hydration exists | M365 Copilot as well |
| More than 5,000 companies | Enrichment remains available, but PB/ROGO are not recommended by these count rules |

The research group opens first if there are more than 5,000 companies, any PB/ROGO/Bing hydration exists, or there are 1–499 companies. Otherwise the enrichment group opens first. The analyst can toggle both.

Two details matter:

- A hydration count above zero does not mean every company has that source. Coverage is per company and per field.
- The active policy uses strict comparisons. Exactly 2,000 currently receives no count-based LLM Suite recommendation. Your earlier answer preferred LLM Suite at exactly 2,000; the later flow used “>2,000.” This guide records the active code without silently changing that boundary.

### Step 9 — Add more company information

**Analyst:** Drop files into the PitchBook or ROGO component. Inspect import results, mapping problems, and coverage.

**Application:** Identify sheets by headers, stage the files in the source card, parse and join them, refresh company context, and report counts. It should not duplicate raw upload lists in the right drawer or send these files to a provider merely because they were uploaded.

The right panel should summarize useful state: current criteria/approval, shortlist size, source coverage, open questions, and running work. The full updated company data appears through **/data** as an AG Grid table in chat.

Hydration is described in detail in section 4.

### Step 10 — Ask a question, or prepare a scored screening

These are different actions:

| Direct question | Scored/company-table screening |
|---|---|
| Choose LLM Suite or M365 Copilot for a direct question | Choose screening and review its setup |
| No screening setup modal | Inputs, prompt, outputs, model, and batch size are reviewable |
| Answer shown in chat | Results join back to individual companies |
| No automatic fit score or shortlist change | Declared score columns accept 0–10 or CHECK |
| Can include enabled chat attachments | Uses the approved source projection and frozen index mapping |

Direct Ask currently receives a bounded context with criteria, coverage, and up to five considered company projections, with truncation information. It is not an implicit assessment of every shortlisted company. A request to evaluate the complete shortlist belongs on the batch-screening path.

If both question providers are selected, preserve their separately attributed answers. The current UI awaits them sequentially; simultaneous execution is not implemented there.

### Step 11 — Run work in the background

**Analyst:** Approve a prepared screening, continue chatting or reviewing companies, and inspect the bottom-right progress control when needed.

The expanded panel shows progress, batch states, errors, and controls for pausing, resuming, safe retry, and staging accepted partial output.

Pause stops future dispatch. It does not assume an already-sent provider request was cancelled. Retry is safe only for a definitive failure or a reconciled attempt confirmed not sent. A timeout that may have reached the provider needs reconciliation.

Accepted partial output may be staged. Unfinished companies remain unknown; they do not receive a fabricated zero score.

All actual LLM Suite messages share one rolling-minute allowance of seven sends: orchestration, subagents, questions, criteria/prompt/template generation, screening, and parsing repairs. Parallel user activity does not create another allowance.

### Step 12 — Review results and decide what remains considered

**Analyst:** Inspect the results table. Choose the score/output columns to use, keep numeric matches and selected CHECK cases, hide other rows, or make manual exceptions.

**Application:** Persist a review record and considered flags. Preserve all source data and assessments, including hidden-company history.

Selecting a result column for the next pass is independent of keeping a company. You can keep a company but omit an old model score from its next prompt. You can preserve a rationale without including the prior score.

A model assessment is not an analyst label and is not verified evidence. CHECK means insufficient or conflicting information, not “poor fit.”

### Step 13 — Repeat or finish

After review, recommendations recalculate from the new considered count and available hydration. The analyst can:

- Add another source.
- Run Bing with different business questions.
- Screen again using selected new context.
- Switch provider or prompt.
- Find more companies.
- Revise and reapprove criteria.
- Restore hidden companies.
- Export the current considered set.

The user chooses when the evidence and shortlist are sufficient. There is no mandatory number of iterations or target count.

## 3. The example you gave, worked through

The numbers below are illustrative analyst decisions, not automatic reductions.

| Stage | Considered set | Analyst action | Context for the next pass |
|---|---:|---|---|
| Broad discovery | 2,500 | Review initial pull | MID/ISCC descriptions and source provenance |
| First LLM Suite screening | Still 2,500 until review | Keep scores above 4 and CHECK | Analyst applies the review, leaving about 400 |
| Bing hydration | 400 | Approve criteria-derived business queries | Source-linked research added for matched companies |
| Second LLM Suite screening | 400 | Include Bing and selected useful prior outputs; keep scores at least 6 and CHECK | About 150 remain considered |
| PitchBook hydration | Around 150 | Upload mapping/data and inspect exclusions | PB fields and genuine PB LinkedIn added where matched |
| M365 screening | Current considered set after PB mapping | Keep scores at least 7 and CHECK | About 55 remain considered |
| Export | 55 | Download the required workbook(s) | Hidden records remain saved |

PitchBook mapping may itself reduce the considered count, so the real sequence need not retain exactly 150 before M365. Screening output alone also does not shrink the list: the analyst applies the review.

At 2,500, LLM Suite is recommended even though the unhydrated default accordion is enrichment. At 400, research opens first and PB/Bing are recommended. At 150 with PB coverage, M365 is also recommended.

Scores from different passes remain separately attributed. Raising the threshold does not erase the earlier assessment, and a later score is not automatically comparable if the criteria, model, prompt, or evidence changed.

## 4. Data hydration: how messy sources become useful context

### 4.1 Identity and cross-references

An internal company key is created from normalized ECID and CID:

| Available identifiers | Internal key |
|---|---|
| ECID E123 and CID C456 | E123-C456 |
| CID C456 only | X-C456 |
| ECID E123 only | E123-X, a provisional key |
| Neither | Do not add the row as a company; retain/quarantine the invalid observation |

Blank values, hyphens, zero markers, NA/N/A/#N/A, null-like markers, and whitespace are normalized. Real identifiers remain text.

MID and ISCC share one company representation. Identifiers and aliases retain the cross-reference to each source. A later exact identifier bridge can promote a provisional identity without rewriting a historical job's frozen mapping.

Similar names or websites do not alone prove two company records are the same. Conflicting identity claims require quarantine/review.

### 4.2 Source observations remain separate

The shared company record is not a replacement for original source rows. Keep:

- The original MID/ISCC observation.
- Source/run/query provenance.
- Description and source-specific fields.
- Retrieval score and rank for that source/query.
- Import timestamps and row hashes.

For a company found in both sources, show source overlap and prefer MID for the original compact discovery/export representation. For screening inputs, the independent PB/MID/ISCC preference rules below apply.

### 4.3 PitchBook import

1. Inspect files and sheets by headers, not filenames.
2. Recognize a mapping sheet with the required first-row fields: pk, PBId, Firm Name from PitchBook, Website from PitchBook, Company Profile, Investor Profile, Limited Partner Profile, and Service Provider Profile.
3. Process mapping before data workbooks, even if files arrive together.
4. Add PBId only from eligible Company Profile = Yes rows with a resolvable company and PBId.
5. Find the actual header row in each PB data sheet. It may not be the first row.
6. Remove PitchBook copyright/footer text regardless of its year.
7. Join Company ID in the data sheet to the mapped PBId.
8. Hydrate compact PB fields: website, name, description, LinkedIn company URL, HQ location, active investors, and universe.
9. Preserve wide source columns in Parquet with SQLite references for later selection.
10. Report matched, unmatched, ambiguous, and hidden counts.

An explicit mapping row with a non-Yes Company Profile or missing PBId automatically hides that company for this run. When exclude_unmapped=true, the import additionally hides still-considered candidates lacking a PBId, including candidates absent from the mapping file. A partial mapping with that flag false does not hide candidates merely because they are absent. Blank/no profile values do not populate PBId. A valid later mapping can restore a company hidden for the mapping reason; it must not overwrite an analyst's unrelated manual hide decision.

The analyst can restore a mapping-hidden company. Uploading ROGO later must not replay an older PB exclusion and hide the restored company again.

### 4.4 ROGO import

1. Locate a Website/website/websites header row from the sheet contents.
2. Retain the additional columns on that row, even when their names are not predetermined.
3. Normalize the website and match it to an existing candidate.
4. Prefer PB website where available. If PB website conflicts with the original MID/ISCC website, use the PB website for this join.
5. Require a unique match. Quarantine ambiguous hosts rather than guessing.
6. Retain unmatched observations for review; do not invent a company join.
7. Hydrate matched ROGO fields without replacing unrelated PB/MID/ISCC information.

Website matching enriches an existing company; it is not permission to merge two separate identities. A shared group domain can be ambiguous.

### 4.5 Preferred name, website, and descriptions

Name and website fall back independently:

- Company Name: PB name → MID name → ISCC name.
- Website: PB website → MID website → ISCC website.

A PB name does not require a PB website. A blank PB website falls back normally.

Description is a labeled combination, not a fallback:

~~~text
PitchBook Latest Description: <PB description>

MID Description: <MID description>

ISCC Description: <ISCC description>
~~~

Omit absent sections. Preserve differences instead of having one source silently overwrite another.

Canonical identity sources are selected by default for these fields. The analyst can choose explicit source columns as well. A field absent for a company remains empty/null; selecting an ISCC-only column does not manufacture it for a MID-only company.

PBId and the provider-input LinkedIn URL remain blank until the relevant PB data is hydrated. M365 does not require LinkedIn for general questions or unhydrated screening. When a genuine PB company LinkedIn URL is present, include/use it for M365 screening. The URL remains in backend context without an editable textbox in company review.

### 4.6 Bing hydration

Bing research writes source-linked observations for a run/company, with URLs, excerpts, and claim provenance. Verification initially remains UNKNOWN. A model confidence or search result does not make a claim analyst-verified.

Current BING projection contains up to the latest five research observations, with up to three source references each, bounded to 11,000 bytes. The complete evidence history stays separately retrievable. This is another example of storage being larger than the selected model context.

### 4.7 Screening-result hydration

A valid provider response becomes immutable company assessments attributed to provider, plan, prompt, job, batch, and attempt. Analyst-selected output columns become the RESULTS source for a future pass.

The source projection uses the selected plan's latest accepted assessment for a company; missing values remain null. It retains provenance. A historical assessment can be deliberately reused as context, but that does not mean the company was assessed under today's criteria.

Assessment readers expose current-use eligibility. The current RESULTS selector does not automatically reject historical plans solely because they are stale, so consumers must preserve the historical attribution instead of presenting the result as a new current assessment.

### 4.8 File-drop purpose

| Drop point | What happens | Provider default |
|---|---|---|
| Main chat composer | Stage a chat attachment; expose preview and per-file include switch | Included in the next applicable provider question by default |
| Add PitchBook data | Stage/inspect/import company source data | Not passed as a provider attachment |
| Add ROGO data | Stage/inspect/import company source data | Not passed as a provider attachment |

Dropping a file does not by itself send it to a model. A source file can be added separately as a chat attachment if the analyst also wants to ask a provider about the document.

Files can arrive before discovery. The enrichment pipeline stages them and waits until there is candidate scope to join against. Reprocessing should preserve purpose and existing manual review decisions.

## 5. Preparing a screening job

The setup lets the analyst review:

- Provider: LLM Suite or M365 Copilot.
- Model/deployment choice.
- Batch size.
- Input columns and their sources.
- Prompt, including scoring logic.
- Output columns as editable chips.

The input-column picker shows MID, ISCC, PB, ROGO, BING, and saved RESULTS where available. Empty sources show their missing coverage and allow an upload to populate them. Refresh the picker after hydration.

Default canonical inputs are index, pk, PBId, Company Name, Website, Description, and LinkedIn URL. The index is server-owned. Output chips contain index permanently plus the requested columns; comma-separated entry creates individual chips.

Natural-language requests can suggest an output schema, but interpretation must be visible and editable. Rich arbitrary output-schema inference remains integration work. Do not hide an inferred column or score rule from approval.

The AI button drafts a prompt from current criteria and supplied examples. It is a provider-backed drafting action when connected, not an automatic replacement for the analyst's editable prompt or approval. Offline operation must say generation did not execute.

### Freeze, approve, then send

~~~mermaid
sequenceDiagram
    participant U as Analyst
    participant UI as Chat setup
    participant R as Rust domain service
    participant DB as SQLite and source store
    participant W as Background controller
    participant P as Provider
    U->>UI: Choose columns and edit prompt
    UI->>R: Prepare selected projection
    R->>DB: Read consistent revisions and source values
    R-->>UI: Frozen rows, compiled prompt, digest
    U->>UI: Approve exact plan
    UI->>R: Record approval
    R->>DB: Commit jobs, index maps, outbox
    W->>R: Lease and recheck freshness
    W->>R: Consume shared send capacity if applicable
    W->>P: Send approved request
    P-->>W: Response
    W->>R: Preserve raw receipt and validate
    R->>DB: Join valid indexes and save assessments
    R-->>UI: Progress and attributed results
~~~

A versioned prepared-plan digest binds all execution-affecting fields: criteria/profile revision, selected candidates, source/data hashes, selected rows, input/output schema, scoring rules, compiled prompt, provider/model/options, batching, and adapter/retrieval configuration.

Changes after preview require a fresh projection and approval. Empty model choice resolves to configured deployment when connected; disconnected drafts can record automatic, but that literal is not an external deployment name.

Approval creates durable work records. It does not claim the provider ran. Until dispatch, the artifact remains executed:false.

### Output parsing and identity protection

The model returns one Markdown table, exactly index plus approved output columns. It does not choose the authoritative company key.

Example for a batch whose global indexes are 51 and 52:

~~~text
| index | Fit Score | Rationale |
| --- | --- | --- |
| 51 | 8 | Evidence supports the requested core business |
| 52 | CHECK | Product scope is unclear |
~~~

Rust checks the complete response against that job's frozen index → pk map. Reject duplicate/missing/foreign indexes, extra headers, extra prose, malformed tables, and invalid scores. Declared scores must be finite numbers from 0 through 10 or CHECK.

A rejected attempt is quarantined as a whole. It is not partially joined to whatever companies happen to match. A format failure can trigger at most two repair prompts, each consuming a real LLM Suite send when that provider is used.

Tool decisions also have a deterministic Rust text protocol, rather than model-native JSON calls:

~~~text
BEGIN TOOL v1 search_mid
run_id:text = "run-42"
query:text = "insurance claims software products"
mode:text = "hybrid"
limit:number = 1000
END TOOL
~~~

The controller supplies allowed tools and argument descriptions, validates the text, checks schemas/scope/authority, and executes the parsed command. Internal HTTP JSON is transport data; it is not a demand that the model emit JSON tool calls. See the [protocol](LLMSUITE_PROTOCOL.md).

## 6. Bing research and general questions

For company Bing research:

1. Use the current considered set automatically.
2. Draft roughly four useful questions from criteria/examples, or let the analyst enter them.
3. Present editable/removable query templates; support one to five and a plus control.
4. Substitute preferred company name and website into approved placeholders.
5. Preview the exact number of requests and a sample.
6. Approve those exact queries.
7. Execute in bounded pages when connected.
8. Save source-linked findings and refresh context.

With 400 companies and four templates, there are 1,600 queries. A 100-query page is transport pagination, not a 100-company selection cap. Current preview shows at most 20 samples with the total count.

Agent-proposed and manually started Bing research use the same approval and provenance path. Grounding findings remain leads until reviewed.

For a general Bing query, the text is used literally rather than expanded per company. **Include findings in screening criteria** is off by default. If selected, approved findings can produce a new criteria revision that requires approval. Otherwise the result is research shown to the analyst, not a silent criteria edit.

Direct LLM Suite/M365 chat answers also do not silently rewrite criteria. The analyst can explicitly use an answer when editing criteria. The currently exposed criteria-inclusion switch is on the general Bing flow.

## 7. Context and durable memory

A chat transcript is not the application's durable brain. The service assembles context from authoritative records.

| Memory layer | Contents | Scope/purpose |
|---|---|---|
| Company identity | Company key, ECID/CID/PBId aliases | Shared entity resolution |
| Source observations | Original MID/ISCC rows, source/query hashes and ranks | Reusable MID; run-scoped ISCC observations |
| Enrichment | Compact PB/ROGO fields, wide-row references | Currently company-global; shared across runs using that company |
| Criteria/profile lineage | Supplied text, business definition, examples, revisions, approvals | Run-scoped |
| Candidate membership | Considered flag, status, reasons, discovery links | Run-scoped |
| Evidence/questions | Claims, URLs, confidence, verification, unanswered questions | Run/company-scoped |
| Model assessments | Immutable outputs and frozen input/provenance references | Plan/job/batch/run-scoped |
| Prepared work | Approved schema, prompt, source hashes, index maps, outbox/jobs | Execution snapshot |
| Agent events/checkpoints | Tool activity, stored progress and decisions | Durable recovery and investigation |
| Chat/session log | Messages, UI artifacts, displayed activity | Presentation state; not a substitute for the above |
| LangGraph checkpoint | Which node is next and referenced domain revisions | Workflow cursor; production saver not yet wired |

PB/ROGO sharing is an important current architecture choice: uploading newer enrichment for a shared company can change the context visible in another run. Frozen jobs preserve what they actually used. A future per-run source-version pinning policy would provide stronger isolation; current projection is run-scoped, but enrichment storage is not fully run-private.

### How context is built

Before a task, resolve the run, current criteria, considered companies, requested source columns, selected historical outputs, examples, relevant evidence, and open questions. Use bounded context tools rather than dumping the whole database.

Useful tools include get_run_context, get_company_context, get_candidate_context, get_candidate_batch_context, build_context_packet, get_run_source_projection, and get_source_field_catalog.

Context packets are assembled views, not permanent blobs that replace source truth. Tool responses report selected/omitted sections and bounds. Direct-question context and full batch-screening context are different readers with different limits.

A missing source value stays missing. A company with no Bing coverage is not “Bing verified.” A company with no score is not scored zero.

### Reuse without confusing provenance

Keep three measures separate:

1. Retrieval relevance per source/query.
2. Model assessment per prompt/provider/batch.
3. Evidence confidence and verification per claim/source.

Past research can be retrieved explicitly with get_previous_research. That cross-run history must retain its original attribution and does not automatically become a current-run assessment.

Open-question tools preserve unresolved issues. Search-history tools help the agent avoid repeating identical discovery blindly. Memory search retrieves evidence, labels, and research questions; it is not proof that the whole store is embedded and semantically searched.

### Freshness and background work

Source uploads, criteria edits, or analyst selection changes can make an approved plan stale. Reprepare and reapprove affected work. A late provider response is still stored under the old job and remains historical.

Normal completion of batch 1 does not automatically stale batch 2 merely because a new assessment was stored. The shortlist mutation counter helps paged readers detect changes; execution compares the actual bound snapshot. New result columns only enter future projection when selected as context.

If the analyst changes that selection while a job is running, pending work must respect freshness checks. Already-sent work retains its original input snapshot; its output cannot silently be presented as if it used the newer context.

## 8. Developer responsibilities

| Component | What it should own |
|---|---|
| assistant-ui frontend | Chat, artifacts, attachments, review controls, tables, progress, rendering and user decisions |
| Node bridge | File staging/inspection, bounded extraction, route adaptation, local background controller and UI-facing responses |
| Rust domain service | IDs, joins, revisions, considered flags, source projections, approvals, rate capacity, leases, parsing, evidence and results |
| SQLite | Durable domain truth and execution audit |
| Parquet/original files | Wide payloads and source artifacts for later joins/selection |
| LLM Suite | Interpretation, bounded search planning, subagent reasoning, prompt/template generation and model assessments |
| M365 Copilot | Optional independent criteria analysis, direct answers and screening |
| LangGraph | Ordering, branching, approval waits, bounded loops and references to durable work |
| Background worker/controller | Dispatch eligible jobs, respect pause/rate/freshness, ingest results, reconcile uncertain attempts |

Do not put dataset joins or company identity decisions into model reasoning when deterministic Rust code can do them. Do not put whole spreadsheets into LangGraph state. Do not let the graph maintain a second authoritative candidate table.

The local controller can work while the user navigates the app. Production coordination across multiple workers/hosts is separate integration work.

For example, 2,500 companies with batches of 50 require 50 initial screening messages. Orchestration, questions, and repairs share the same seven-per-minute budget, so UI progress must reflect actual jobs and eligibility rather than promising a fixed completion time.

## 9. Where the loops belong

| Loop | Trigger and return point | Control |
|---|---|---|
| Criteria clarification | Business ambiguity or analyst edit → new draft/review | Analyst approval of exact final revision |
| Example refinement | Good/bad examples → revised criteria | Optional input; no manufactured analyst labels |
| Discovery coverage | Analyst wants more coverage → plan/search again | Saved search history and finite query/round budgets |
| Enrichment resolution | Unmatched or ambiguous rows → correction/reimport | Deterministic joins, quarantine, preserved manual decisions |
| Screening preparation | Change prompt/columns/model/batch/context → fresh preview | Exact plan digest approval |
| Format repair | Invalid provider text/table → constrained re-prompt | At most two repairs; shared send gate |
| Evidence/shortlist refinement | Results → keep/hide/context selection → enrich/research/screen again | Analyst decisions; changing recommendations |
| Criteria revision after research | Explicit incorporation → new criteria | Reapproval; prior work retained historically |
| Recovery/retry | Definitive error or reconciled uncertain attempt → eligible retry | Durable attempts; no blind replay after possible send |

A graph is useful for the branches and approval boundaries. Ordinary deterministic code is better for spreadsheet parsing, identifier normalization, exact joins, hashing, and schema validation. Durable job records are better for tracking independent batches than keeping a reasoning node open until every request finishes.

## 10. LangGraph: current scaffold versus complete design

### Current source graph

The actual Python graph in [graph.py](../../mna-orchestrator/src/mna_orchestrator/graph.py) contains these screening nodes:

~~~text
criteria
→ m365 (optional provider analysis)
→ synthesis
→ review_profile [interrupt]
→ commit_profile
→ plan_search
→ mid
→ iscc
→ union
→ coverage [interrupt]
→ select
→ prepare
→ plan_review [interrupt]
→ enqueue
→ settle
→ END
~~~

Its direct-question branch is question → answers → END.

Existing loops are:

- Profile revise → criteria.
- Coverage broaden → plan_search.
- Plan edit → select.

The default search budget is three rounds including the initial search. It is separate from the maximum five ISCC query variants in a plan.

The scaffold currently executes MID and ISCC sequentially. It does not implement parallel subagents, separate initial/final criteria reviews, optional-example nodes, hydration routing, Bing approval, recommendations, post-result considered review, export, or an explicit background completion-wait node. The UI/Rust flow implements many of those behaviors elsewhere.

Its ports delegate interpretation, searches, preparation, enqueueing, and result persistence. Default ports are disabled. Tests inject fake ports and an in-memory checkpointer. The graph is not the live application scheduler.

### The complete target graph for your workflow

The following is a design map, not a claim that these node names already exist in Python:

~~~mermaid
flowchart TD
    S[Load run and classify request] --> Q{Request type}
    Q -- General question --> ASK[LLM Suite or M365 answer]
    ASK --> USE{Explicitly use findings in criteria?}
    USE -- No --> SHOW[Show answer and keep attribution]
    USE -- Yes --> DRAFT[Draft new criteria revision]
    Q -- Criteria edit or new screening --> DRAFT
    DRAFT --> BREV[Business review interrupt]
    BREV -- Revise --> DRAFT
    BREV -- Accept --> EX[Optional examples interrupt]
    EX --> FINAL[Final criteria approval interrupt]
    FINAL -- Revise --> DRAFT
    FINAL -- Approve --> PLAN[Build bounded discovery plan]
    PLAN --> MID[MID search branch]
    PLAN --> ISCC[ISCC search branch]
    MID --> UNION[Union identities and preserve source scores]
    ISCC --> UNION
    UNION --> COV[Coverage review interrupt]
    COV -- Broaden --> PLAN
    COV -- Proceed --> NEXT[Calculate next-step recommendations]
    NEXT --> ACT{Analyst chooses action}
    ACT -- Upload --> HYDRATE[Inspect and import source data]
    HYDRATE --> REFRESH[Refresh context and coverage]
    ACT -- Bing --> BPREP[Prepare exact queries]
    BPREP --> BAPP[Bing approval interrupt]
    BAPP --> BJOBS[Enqueue research jobs]
    ACT -- Screening --> PREP[Freeze source projection and prompt]
    PREP --> APP[Plan approval interrupt]
    APP -- Edit --> PREP
    APP -- Approve --> JOBS[Enqueue durable screening jobs]
    BJOBS --> WAIT[Wait for durable completion events]
    JOBS --> WAIT
    WAIT --> VALIDATE[Validate and hydrate attributed results]
    VALIDATE --> REVIEW[Shortlist and context review interrupt]
    REFRESH --> REVIEW
    REVIEW -- Repeat --> NEXT
    REVIEW -- Edit criteria --> DRAFT
    REVIEW -- Export --> EXPORT[Export considered companies]
~~~

A background controller consumes the jobs. The graph resumes from completion events/references; it does not independently bypass the shared provider gate.

MID and ISCC fan-out/fan-in in this target map is a proposed concurrency design. It needs deterministic union behavior, per-branch references, idempotent writes, and clear failure handling before being enabled.

The full design can be organized into criteria, discovery, hydration, research, screening, and review subgraphs. These are workflow boundaries; they do not require six separate databases or six independent reasoning models.

### State and interruption

Keep graph state small: run/task IDs, criteria revision/digest, profile version, candidate/selection hash, source snapshot reference, search round, plan/job IDs, result references, pending review, and analyst decision reference.

Store rows, files, assessments, and evidence in the domain store; reference them from graph state.

A persistent saver and stable thread_id let the workflow pause for analyst input and later resume. LangGraph restarts the interrupted node on resume, so work before an interrupt must be replay-safe. These behaviors follow [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) and [persistence](https://docs.langchain.com/oss/python/langgraph/persistence).

The model's non-JSON tool protocol does not prevent the application from using structured internal resume data. Authenticated UI decisions, database records, and HTTP payloads are deterministic controller data.

### What must be connected for production

1. Implement concrete Rust-backed ports instead of DisabledPorts.
2. Inject a durable LangGraph saver and stable task thread IDs.
3. Map graph interrupts to UI approval/review cards and authenticated resume endpoints.
4. Add the missing examples, enrichment, Bing, shortlist-review, repeat, export, and completion-event stages.
5. Map Python's m365 provider label to the UI/controller's copilot label.
6. Route every LLM Suite send through the one Rust rate gate.
7. Make searches, job creation, approval, and receipt handling replay-safe.
8. Preserve exact revisions/digests at approval and dispatch.
9. Integrate worker completion/error events and truthful progress.
10. Keep raw receipts, strict parsing, provenance, and ambiguous-send reconciliation.
11. Add representative retrieval and corporate-adapter validation before claiming connected operation.

Normal public scored-plan proposals currently pass through the runtime's latest-criteria approval guard. Old plans become stale after an edit. Production ports must preserve that authority boundary. A trusted in-process call directly into ExecutionService can bypass the runtime-only guard, and the current guard precedes the proposal transaction. Moving/checking latest-criteria authorization within the domain transaction is a hardening requirement for new ports/concurrent integration; no public sequential bypass was established in the source review.

## 11. Export, session history, and recovery

Standard company exports use considered companies:

- **PitchBook export:** one sheet with pk, Company Name, Website, HQ City, HQ State, and Source.
- **LLM Suite export:** one sheet with sequential export index, pk, Company Name, Website, Source, and Description.
- **Full data export:** original selected MID and ISCC rows in separate sheets, each with pk first.

Full data here means the original MID/ISCC export format. It is not a complete database archive and does not automatically include all PB/ROGO/model history. Session-log exports are separate from company exports.

Previous exports remain separate artifacts. Hidden companies and their context remain available for restoration and investigation.

Recovery uses criteria/profile versions, candidate decisions, checkpoints, jobs, index maps, receipts, and accepted results. A graph checkpoint says where to resume; domain records determine what has already happened.

Current local discovery UI jobs are process-local. Rust provider execution jobs are durable. Do not present these as having identical restart guarantees.

## 12. The analyst's experience in one pass

“I name my screening and describe the business. I check the interpretation, add examples if useful, and approve the final criteria. I review a broad pull and choose the next action. I add source information or run an approved research/screening pass. I inspect the results, decide which companies and context remain relevant, and repeat until I am ready to export. I can change my criteria or restore a company without losing the earlier work.”

The developer's equivalent is:

“Persist each decision, preserve source identity and provenance, build a bounded selected projection, approve an exact execution snapshot, dispatch through durable jobs and shared limits, strictly validate output against frozen indexes, then let the analyst update considered membership and context selection.”

## 13. Source and review record

This explanation was checked against the attachment, the current UI policy/state machine, Rust identity/import/projection/context/review/execution code, and the actual offline graph. GPT-6 Sol traced hydration/memory; GPT-6.1 Sol independently checked graph behavior and authorization caveats. No DeepSeek/Terra agents or corporate calls were used. This documentation task did not change application behavior or rerun the full test suite.

All three Mermaid diagrams were parsed and rendered in an isolated browser. Local reference checks passed across 14 tool-documentation Markdown files and 60 links; the existing 67 tool examples, 23 administrator schemas, and three saved export workbooks also passed their checks. Mermaid's initial Node-only validation lacked a browser DOM; browser validation resolved that environment limitation. No unresolved documentation validation failure remains.

Related references:

- [Tool schemas and examples](../TOOL_REFERENCE.md)
- [Short operational workflow](WORKFLOW.md)
- [Backend architecture](BACKEND_ARCHITECTURE.md)
- [Prepared-plan execution contract](EXECUTION_CONTRACT.md)
- [LLM Suite text protocol](LLMSUITE_PROTOCOL.md)
- [Implementation and prior validation](../IMPLEMENTATION.md)
- [Offline graph integration requirements](../../mna-orchestrator/README.md)
