# Implementation and review record

Updated 5 October 2026. This record describes the delivered backend and its local UI bridge, not a claim of connected corporate services.

Phase 2 adds durable MID Build Index bundles, weighted keyword Match %, optional semantic scores, ISCC relevancy, separate screening rounds, score filters and labelled development simulation. The catalogs below were refreshed from the Phase 2 debug binary; the older release, browser and test results in the validation table are historical and do not verify 150,000-row throughput, real embedding weights or live corporate providers.

## Result and decisions

The service exposes **76 agent tools and 28 privileged operations**. [TOOL_REFERENCE.md](TOOL_REFERENCE.md) covers their schemas, behavior and examples. [ARCHITECTURE_CRITIQUE.md](docs/ARCHITECTURE_CRITIQUE.md) records the status of each required correction; [BACKEND_ARCHITECTURE.md](docs/BACKEND_ARCHITECTURE.md) and [EXECUTION_CONTRACT.md](docs/EXECUTION_CONTRACT.md) define the design. [BACKGROUND_SCREENING.md](../mna-ui/BACKGROUND_SCREENING.md) describes background controls, source imports, and approved Bing grounding.

- Discovery is core-business only. Non-core filters are ignored/reported. Only approved core-business exclusions can narrow discovery, and query negation cannot bypass them. Legacy MID and ISCC calls max at 1,000; MID keyword v2 defaults to 5,000 and maxes at 20,000. The replaceable reranker preserves all candidates and the tail after its first 500 per source/query.
- A replaceable Arctic M v2 INT8 ONNX 768D adapter, CPU worker and model/version/text-hash SQLite vector index are implemented. Real model files and corpus recall are unverified. Legacy unversioned vectors stay explicitly separate.
- Run-scoped projections independently prefer PB name/website, concatenate labeled descriptions, include genuine PB LinkedIn and retain selected coverage/hashes. SQLite owns domain truth; Parquet stores wide source payloads. Full preparation fails explicitly above 64 MB rather than dropping companies.
- Initial criteria are saved in a backend run before discovery. The analyst reviews business criteria, can enter separate good-fit and bad-fit examples or skip them, then approves the final revision. Edits at any later point persist a new revision; only approval of the latest revision authorizes discovery or execution. Shortlist review preserves hidden companies and their data. An analyst can keep strong matches and `CHECK` cases, hide others, restore them, select saved RESULTS columns as later inputs, and repeat screening or discovery.
- For example, an analyst can review 2,500 considered companies to 400, then 150, then 55. These are analyst shortlist decisions, not automatic filters or run-size limits. Each provider/query assessment stays separate; the 55 considered rows can be exported to new PitchBook, LLM, or Full XLSX workbooks while hidden rows remain in history.
- Schema-v2 approval binds the full compiled prompt, inputs/outputs/score rules, provider/deployment/options, batching, criteria, shortlist, source/data/profile revisions, and actual adapter/retrieval configuration. Approval atomically creates durable jobs/outbox/global index manifests. Changes require fresh preview and approval. An empty UI model choice resolves to a configured deployment when present; otherwise preparation records `automatic`, leaves `executed:false`, and does not dispatch that literal as a deployment.
- Typed text commands and exact index-only Markdown results are parsed in Rust. Foreign/missing/duplicate indexes or invalid tables/scores quarantine the whole response. Parsing repairs are capped at two. Model output cannot create analyst labels or verified evidence.
- Durable leases, send audit, seven shared LLMSuite sends per rolling minute, original-byte response receipts and explicit ambiguous-attempt reconciliation are implemented. Reservations are consumed at actual send. In-flight responses after source edits remain historical; frozen PKs survive identity promotion and database upgrades.
- Retrieval scores, prompt/batch assessments and claim confidence/provenance are separate. Research claims begin UNKNOWN and need privileged analyst verification. The frontend uses actual backend proposal/approval traces and prepared artifacts with `executed:false` while providers are disconnected. Bing research applies one to five approved query templates to every considered company, continues in bounded pages, and stores unverified leads.
- A local background controller runs approved provider jobs independently of chat and discovery. Progress reads compact durable records. Pause stops future dispatch, expired dispatched attempts require reconciliation, and only definitive rejected attempts can be explicitly retried. Accepted partial results can be staged while a provider is offline.
- Each upload has a purpose. Chat attachments remain available for direct LLM Suite or M365 Copilot questions, with a per-file include switch; the direct-question path can extract bounded TXT, CSV, DOCX, XLSX, and PDF text. Company-data uploads are inspected by spreadsheet headers, wait for a discovered candidate set, import mappings before PitchBook data, refresh saved context, and replay when the candidate scope changes. A new PitchBook mapping can hide unmapped or explicit `No` matches while preserving history and manual restore; a ROGO-only upload does not reapply an old mapping. The side panel retains short source coverage summaries; `/data` opens the current AG Grid table in chat. PDF/DOCX criteria extraction remains unconnected.
- Direct questions to LLM Suite or M365 Copilot (chosen in the composer's runtime selector) use the Rust gateway's durable provider-text adapter without a screening setup. Generation of editable criteria, screening prompts, and Bing templates uses the same adapter. Connected text responses must follow the Rust format contract; LLMSuite purposes share seven actual sends per rolling minute and at most two format repairs. Corporate connections are unconfigured and were not exercised in this release.
- Manual and agent-proposed Bing research share exact-query approval and registered tools. Company results retain URLs, excerpts, and unverified claim provenance. Disconnected approval creates an honest handoff without provider calls.

## Files and ownership

The main new modules are `src/protocol.rs`, `src/result_parser.rs`, `src/retrieval.rs`, `src/projection.rs`, `src/execution.rs`, `src/gateway.rs`, `src/trust.rs`, `src/review.rs` and `src/agent_commands.rs`. Integration changes are in store/search/data/runtime/lib/main and migrations 004–007. Tests cover those boundaries. Optional worker source is in `scripts/local_embed_worker.py`; schemas and the tool reference are generated from the release executable.

The UI changes include `server/durable-screening.mjs`, `server/background-screening.mjs`, `server/bing-research.mjs`, `server/provider-conversation.mjs`, bridge wiring, the shared positive discovery-query builder, purpose-scoped upload pipeline, chat data tables, background dock and research/setup dialogs. Backend additions include criteria revisions, shortlist review/history, paged shortlist context, read-only enrichment inspection, compact execution progress, controller-only safe retry, and durable provider-text dispatch. Architecture, catalogs, tool examples, and operating documentation were updated. SQLite remains domain truth; the offline LangGraph README delegates production gate/jobs to the service.

GPT-6 Sol owned backend/upload work, GPT-6 Luna contributed bounded UI work, and the integration owner completed and tested the combined change. GPT-6.1 Sol independently reviewed recovery, approvals, replay, discovery queries, and final UI integration. No DeepSeek or Terra agents were used in this iteration.

An independent review examined the integrated backend, including approval,
rate limits, recovery, parsing, and provenance. It found no remaining blocker
in the reviewed scope. The validation results below were run against the
delivered source and local fixtures.

## Validation

| Check | Result |
|---|---|
| `cargo fmt --check` | Passed |
| `cargo test --locked --offline` | **120 passed**, zero failed |
| `cargo clippy --locked --offline --all-targets -- -D warnings` | Passed |
| `cargo build --release --locked --offline` | Passed; delivered Windows executable refreshed |
| UI `npm test` | **119 passed**, zero failed |
| UI `npm run build` | Passed; existing large-chunk warning for chart/grid/diagram bundles |
| Local embed worker unittest discovery | **5 passed**, mocked ONNX sessions; Python compilation passed |
| Offline LangGraph unittest discovery | **14 passed**, deterministic ports/checkpointer |
| Release executable and UI bridge smoke | Passed with eight fictional MID rows, database restart, saved criteria lineage, PB mapping hide/restore, all three XLSX exports, and prepared `executed:false` plans |
| Catalogs and generated examples | Phase 2 debug binary emitted 76 agent tools and 28 privileged schemas; this supersedes the older release-artifact count |
| Browser integration | Two-stage criteria approval and good/bad examples; seven-company fictional discovery; PB hide/restore and ROGO preservation; six-company selection and MID/ISCC filters; direct questions; output chips; PDF preview controls; separate chat/source file drops; exact Bing approval and opt-in general-query criteria verified |
| Responsive and theme checks | Expanded background progress and two pending attachments tested at 1440×980, 390×330, 844×390, and 1100×330 workspace/expanded side chat; the send control stayed above the panel. Loaded light/dark views inspected |

Commands used the portable Windows GNU toolchain with its explicit target. Release/mock tests and the fresh eight-row smoke made **no corporate provider calls**. Local gateway integration tests use loopback mock services; worker tests do not load actual Arctic weights. The unchanged embed-worker and offline LangGraph suites were last validated on 4 October. Fictional fixture scores are not model-generated results. UI prepared plans remained `executed:false`. Final Bing browser verification expanded four templates over six considered companies to 24 exact queries; approval saved a disconnected handoff, and a general query added no criteria unless its opt-in switch was selected.

Important regressions exercised: 2,001 candidates remain complete across batches; immutable global indexes reject model identity substitution; stale uploads cannot lose a late provider response; old v5 databases preserve historical PKs/results on identity promotion; expired reservations cannot create a send burst; exclusions cannot sneak through Boolean syntax; controller routes reject agent-only credentials.

## Corrections and remaining limits

Intermediate checks caught stale catalog counts, incorrect fixture source-query IDs and evidence argument names, parser lint issues, legacy migration fields, an in-flight response race, exclusion-syntax bypass and lossy-byte receipt hashing. Browser checks also caught an unbound AG Grid selection method and progress-panel overlap in short viewports. Those were corrected and final relevant checks passed. GPT-6.1 Sol's final source review found no remaining P1/P2 correctness blockers in its reviewed scope. There is no unresolved failed validation in the delivered fixture-tested scope. A prior Windows memory limitation did not recur in the final release pipeline.

LLMSuite, M365, Bing, and ISCC adapters and the gateway's durable provider-text path are implemented, but corporate endpoints, credentials, and end-to-end connections remain **unconfigured and unverified**. The corporate ISCC browser/CDP bridge, real Arctic tokenizer/ONNX runtime assets, reranker choice and representative recall/throughput benchmarks remain planned or unverified. The local background scheduler is implemented; production multi-worker scheduling, durable LangGraph ports/checkpointer, PDF/DOCX **criteria** extraction, richer natural-language output-schema inference, multi-user authentication and streaming preparation beyond 64 MB remain integration work. Direct provider questions already support bounded PDF/DOCX attachment text extraction.

UI background discovery jobs remain process-local and the browser session ledger is presentation state. Provider execution jobs are durable; local controller controls and original-file references persist beside them. Corporate dispatch is disabled by default and was not invoked during validation. Loopback mocks cover connected success, failure, pause/retry, and partial staging. Crash-held PENDING agent commands need operator reconciliation; they are not replayed automatically. No provider-wide exactly-once guarantee or population recall claim is made.
