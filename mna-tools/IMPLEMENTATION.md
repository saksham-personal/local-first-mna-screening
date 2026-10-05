# Implementation and review record

Updated 5 October 2026. This record describes the delivered backend and its local UI bridge, not a claim of connected corporate services.

## Result and decisions

The service exposes **65 agent tools and 19 privileged operations**. [TOOL_REFERENCE.md](TOOL_REFERENCE.md) covers every schema, behavior and example. [ARCHITECTURE_CRITIQUE.md](docs/ARCHITECTURE_CRITIQUE.md) records the status of each required correction; [BACKEND_ARCHITECTURE.md](docs/BACKEND_ARCHITECTURE.md) and [EXECUTION_CONTRACT.md](docs/EXECUTION_CONTRACT.md) define the final design. [BACKGROUND_SCREENING.md](../mna-ui/BACKGROUND_SCREENING.md) describes background controls, automatic source imports, and approved Bing grounding.

- Discovery is core-business only. Non-core filters are ignored/reported. Only approved core-business exclusions can narrow discovery, and query negation cannot bypass them. Retrieval defaults/maxes to 1,000 per query. The replaceable reranker preserves all candidates and the tail after its first 500 per source/query.
- A replaceable Arctic M v2 INT8 ONNX 768D adapter, CPU worker and model/version/text-hash SQLite vector index are implemented. Real model files and corpus recall are unverified. Legacy unversioned vectors stay explicitly separate.
- Run-scoped projections independently prefer PB name/website, concatenate labeled descriptions, include genuine PB LinkedIn and retain selected coverage/hashes. SQLite owns domain truth; Parquet stores wide source payloads. Full preparation fails explicitly above 64 MB rather than dropping companies.
- Schema-v2 approval binds the full compiled prompt, inputs/outputs/score rules, provider/deployment/options, batching, source/data/profile revisions, and actual adapter/retrieval configuration. Approval atomically creates durable jobs/outbox/global index manifests. Uploads or edits require fresh preview and approval.
- Typed text commands and exact index-only Markdown results are parsed in Rust. Foreign/missing/duplicate indexes or invalid tables/scores quarantine the whole response. Parsing repairs are capped at two. Model output cannot create analyst labels or verified evidence.
- Durable leases, send audit, seven shared LLMSuite sends per rolling minute, original-byte response receipts and explicit ambiguous-attempt reconciliation are implemented. Reservations are consumed at actual send. In-flight responses after source edits remain historical; frozen PKs survive identity promotion and database upgrades.
- Retrieval scores, prompt/batch assessments and claim confidence/provenance are separate. Research claims begin UNKNOWN and need privileged analyst verification. The frontend uses actual backend proposal/approval traces and prepared artifacts with executed:false.
- A local background controller runs approved provider jobs independently of chat and discovery. Progress reads compact durable records. Pause stops future dispatch, expired dispatched attempts require reconciliation, and only definitive rejected attempts can be explicitly retried. Accepted partial results can be staged while a provider is offline.
- Header inspection identifies spreadsheet sources before chat submission. Imports wait for companies, process mapping before PitchBook data, refresh saved context, and replay when the candidate scope changes. The side panel retains short source coverage summaries; `/data` opens the current AG Grid table in chat.
- Manual and agent-proposed Bing research share exact-query approval and registered tools. Company results retain URLs, excerpts, and unverified claim provenance. Disconnected approval creates an honest handoff without provider calls.

## Files and ownership

The main new modules are `src/protocol.rs`, `src/result_parser.rs`, `src/retrieval.rs`, `src/projection.rs`, `src/execution.rs`, `src/gateway.rs`, `src/trust.rs` and `src/agent_commands.rs`. Integration changes are in store/search/data/runtime/lib/main and migrations 004–006. Tests cover those boundaries. Optional worker source is in `scripts/local_embed_worker.py`; schemas and the tool reference are generated from the release executable.

The UI changes include `server/durable-screening.mjs`, `server/background-screening.mjs`, `server/bing-research.mjs`, bridge wiring, the shared positive discovery-query builder, automatic import pipeline, chat data tables, background dock and research/setup dialogs. Backend additions are read-only enrichment inspection and compact execution progress, plus controller-only safe retry. Architecture, catalogs, tool examples, and operating documentation were updated. SQLite remains domain truth; the offline LangGraph README delegates production gate/jobs to the service.

GPT-6 Sol owned backend/upload work, GPT-6 Luna contributed bounded UI work, and the integration owner completed and tested the combined change. GPT-6.1 Sol independently reviewed recovery, approvals, replay, discovery queries, and final UI integration. No DeepSeek or Terra agents were used in this iteration.

An independent review examined the integrated backend, including approval,
rate limits, recovery, parsing, and provenance. It found no remaining blocker
in the reviewed scope. The validation results below were run against the
delivered source and local fixtures.

## Validation

| Check | Result |
|---|---|
| `cargo fmt --check` | Passed |
| `cargo test --locked --offline` | **107 passed**, zero failed |
| `cargo clippy --locked --offline --all-targets -- -D warnings` | Passed |
| `cargo build --release --locked --offline` | Passed; delivered Windows executable refreshed |
| UI `npm test` | **100 passed**, zero failed |
| UI `npm run build` | Passed; existing large-chunk warning for chart/grid/diagram bundles |
| Local embed worker unittest discovery | **5 passed**, mocked ONNX sessions; Python compilation passed |
| Offline LangGraph unittest discovery | **14 passed**, deterministic ports/checkpointer |
| Release executable HTTP smoke | Passed: 65/19 catalogs, missing-approval/role denial, MID imports, PB/ROGO hydration, text command, exact exports, full v2 projection, global later-batch indexes, approval and jobs after restart |
| Real UI bridge HTTP smoke | Passed: local discovery of seven fictional companies, source/proposal/approval traces, full compiled prompt preview, v2 jobs, stale-edit rejection and general Copilot question with no company context |
| Generated examples and artifacts | All 65 examples and 19 privileged schemas valid; local Markdown links/fences and three workbook layouts checked |
| Browser integration | Header-detected uploads before discovery, seven-company search, automatic PB/ROGO joins, `/data`, separate LLMSuite/M365 prepared background runs, and exact Bing approval verified in the local UI |

Commands used the portable Windows GNU toolchain with its explicit target. Release/mock tests made **no corporate provider calls**. Local gateway integration tests use loopback mock services; worker tests do not load actual Arctic weights. The release smoke's old compatibility result path uses explicitly fictional returned scores, not model-generated results. UI prepared plans remain executed:false.

Important regressions exercised: 2,001 candidates remain complete across batches; immutable global indexes reject model identity substitution; stale uploads cannot lose a late provider response; old v5 databases preserve historical PKs/results on identity promotion; expired reservations cannot create a send burst; exclusions cannot sneak through Boolean syntax; controller routes reject agent-only credentials.

## Corrections and remaining limits

Intermediate checks caught stale catalog counts, incorrect fixture source-query IDs and evidence argument names, parser lint issues, legacy migration fields, an in-flight response race, exclusion-syntax bypass and lossy-byte receipt hashing. Those were corrected and final relevant checks passed. There is no unresolved failed validation in the delivered fixture-tested scope. A prior Windows memory limitation did not recur in the final release pipeline.

Live LLMSuite/M365/Bing/ISCC deployment contracts and credentials, the corporate ISCC browser/CDP bridge, real Arctic tokenizer/ONNX assets, reranker choice and representative recall/throughput benchmarks remain **configured-but-unverified or planned**. The local background scheduler is implemented; production multi-worker scheduling, durable LangGraph ports/checkpointer, PDF/DOCX text extraction, richer natural-language output-schema inference, multi-user authentication and streaming preparation beyond 64 MB remain integration work.

UI background discovery jobs remain process-local and the browser session ledger is presentation state. Provider execution jobs are durable; local controller controls and original-file references persist beside them. Corporate dispatch is disabled by default and was not invoked during validation. Loopback mocks cover connected success, failure, pause/retry, and partial staging. Crash-held PENDING agent commands need operator reconciliation; they are not replayed automatically. No provider-wide exactly-once guarantee or population recall claim is made.
