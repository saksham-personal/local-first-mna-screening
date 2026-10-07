# Local screening tools

This Rust/Axum service supplies deterministic tools for qualitative discovery, identity resolution, source hydration, evidence, exports and approved provider jobs. SQLite is domain truth; Parquet stores wide source data. The companion assistant-ui frontend uses the same prepared-plan approvals. Corporate services are disconnected by default.

Read [the tool reference](TOOL_REFERENCE.md), [backend architecture](docs/BACKEND_ARCHITECTURE.md), [correction status](docs/ARCHITECTURE_CRITIQUE.md), [workflow](docs/WORKFLOW.md) and [operating instructions](docs/OPERATING_INSTRUCTIONS.md).

The [detailed application flow guide](docs/APPLICATION_FLOW_GUIDE.md) explains the analyst journey, iterative shortlist review, hydration, durable memory, and current/target LangGraph design.

## Start

Build with Rust and a native C compiler for bundled SQLite, or use the delivered Windows executable:

```powershell
cargo build --locked
$env:MNA_API_KEY = '<random service secret of at least 24 characters>'
$env:MNA_ANALYST_KEY = '<different random analyst secret of at least 24 characters>'
$env:MNA_CONTROLLER_KEY = '<different random controller secret of at least 24 characters>'
cargo run --locked
```

The default bind is `127.0.0.1:7318`, loopback only. `MNA_DB_PATH` defaults to `data/agent.db`. Set `MNA_IMPORT_DIR`, `MNA_EXPORT_DIR` and `MNA_ARTIFACT_DIR` for staged local files/artifacts. Store credentials in environment variables, never prompts or plan content. Analyst approval/labels require the analyst key. Provider dispatch, job leases and gate operations require the controller key. New runs start with a proposed profile; discovery needs actual analyst approval.

## HTTP surface

Every route except `/health` requires `Authorization: Bearer <MNA_API_KEY>`. Analyst writes require `X-MNA-Analyst-Key`; controller operations require `X-MNA-Controller-Key`.

| Route | Purpose |
|---|---|
| `GET /health` | Readiness |
| `GET /tools`, `GET /tools?names=search_mid,get_company_context` | All/selected agent schemas |
| `POST /tools/call`, `POST /tools/<name>`, `POST /tools/batch` | Deterministic calls; batches are sequential, 1–16 calls |
| `GET /agent/tools`, `POST /agent/commands` | Natural-language catalog and strict typed text command execution |
| `GET /providers/status` | Honest provider/retrieval configuration status |
| `GET /admin/tools` | Privileged operation catalog |
| `POST /admin/companies`, `/admin/company-files`, `/admin/runs`, `/admin/index` | Ingest MID/create run/sync optional Meilisearch |
| `POST /admin/labels`, `/admin/profiles/approve`, `/admin/actions/approve` | Actual analyst labels and profile/action approval |
| `POST /admin/embedding-index` | Build a model/version/text-hash embedding index |
| `POST /admin/index-build-start`, `/admin/index-build-cancel`, `/admin/mid-bundle-activate`, `/admin/mid-bundle-delete` | Build and manage MID index bundles from staged workbooks |
| `POST /admin/prepared-plan-approve`, `/admin/prepared-plan-cancel` | Approve exact prepared digest or cancel unsent work |
| `POST /admin/evidence-review` | Verify/reject a claim with analyst reason |
| Controller execution routes | Leases, dispatch, responses, reconciliation and shared LLMSuite slots; see [execution contract](docs/EXECUTION_CONTRACT.md) |

The service exposes **76 agent tools and 28 privileged operations**. Unknown arguments fail. HTTP bodies are bounded at 1 MiB; at most eight tool calls execute concurrently. Batch calls are not one transaction. Schemas are in [tool-catalog.json](tool-catalog.json) and [admin-tool-catalog.json](admin-tool-catalog.json). Export them without starting a server:

```powershell
mna-tools.exe --print-tool-schemas
mna-tools.exe --print-admin-schemas
```

## Discovery and data

**Build Index** in the UI starts an eight-step MID workbook build using [config/mid-index.json](config/mid-index.json): read, validate columns, normalize IDs, store rows, build keyword index, embed descriptions, verify and activate. Its progress and bundle history are durable. With no `MNA_EMBED_ENDPOINT`, the embedding step is labelled **skipped**. The new `search_mid` form uses weighted stem/exact keyword groups, a rationale and a Boolean expression; its Match % counts matched positive weights over all positive weights. It defaults to 5,000 results and allows 20,000. The legacy query form and ISCC remain capped at 1,000 per call. `score_mid_semantic` stores a separate 0–10 score when compatible vectors exist, while ISCC Relevancy Score remains 0–1. Exact ECID/ECI links are preferred, then CID/Crescendo ID. The grid and drawer display source scores separately from R1, R2 and later approved screening rounds.

For development, `SCREENING_SIMULATE=1` on the UI bridge enables deterministic simulated ISCC, LLM Suite/M365 and Bing output. It is visibly labelled. Export refuses simulated data unless the caller sets `allow_simulated`, which marks the workbook. This does not validate real corporate providers. Neither 150,000-row throughput nor a real embedding model has been verified.

Find core products/services/workflows in descriptions. Geography, financials, size, ownership and classification fields are deferred criteria, ignored as discovery filters and reported to the caller. Only approved core-business exclusions may narrow the funnel. The legacy MID query form and ISCC default/max result counts are **1,000 per call**. ISCC normally uses 10–12 qualitative words, at most 14; an action plan allows five variants. Score-band sampling helps judge breadth without a hard 0.45 cutoff. MID and ISCC scores remain separate.

MID supports lexical search and configured model-specific hybrid/semantic search. The replaceable local embedder defaults to Arctic M v2 INT8 ONNX 768D. Rebuild its index with the privileged embedding operation. The optional CPU worker and exact setup are in [RETRIEVAL.md](docs/RETRIEVAL.md). Real weights are not bundled. A replaceable reranker scores the first 500 per source/query and keeps the remaining tail; model choice is planned. No local generative model is used.

Normalize ECID/CID into ECID-CID, X-CID or provisional ECID-X. Drop/report rows with neither. Exact cross-references promote aliases; names/websites do not merge companies. Eligible PitchBook mapping adds PBId. Header-based mixed imports process mapping, PB data, then ROGO, retain compact PB fields and wide Parquet payloads, and quarantine ambiguous joins.

The run projection independently prefers PB/MID/ISCC name and website, combines labeled descriptions, includes genuine PB LinkedIn, and binds coverage/selected row hashes. Full preparation retains every selected company up to an explicit 64 MB snapshot cap. Oversize scopes fail without silently losing rows. The UI recommends PitchBook for 0<n<1000 and LLM Suite for n>2000, using considered count n. Exact PitchBook/LLM/Full XLSX exports remain available.

## Approvals, execution and trust

`propose_prepared_plan` supports scored screening and general questions. The full compiled prompt, deployment, source/identity/input/output columns, score rules, batch size, options and data/configuration revisions are included in schema-v2 approval. The analyst sees the exact preview. Approval creates durable jobs/outbox/frozen global index maps and returns `executed:false`. Relevant edits/uploads require a new preview/approval.

LLMSuite model actions use [typed text blocks](docs/LLMSUITE_PROTOCOL.md), not JSON tool calls. Company outputs use an exact index-only Markdown table. Strict Rust parsing joins against the server map or quarantines the complete response; at most two repairs are allowed. Research claims remain UNKNOWN until analyst verification. Retrieval scores, prompt/batch assessments and claim confidence/provenance are separate.

LLMSuite orchestration, subagents, screening, questions and repairs share a durable **seven actual sends per rolling minute** gate. The controller consumes a reservation at dispatch. Leases, attempts, raw response receipts and explicit ambiguity reconciliation survive restart. An in-flight response after an upload is saved historically but is not eligible for the changed plan. No provider-wide exactly-once claim is made.

External execution requires `MNA_ENABLE_EXTERNAL=true` plus approved jobs and provider endpoint/token configuration: `MNA_LLMSUITE_*`, `MNA_M365_*`, `MNA_ISCC_*`, `MNA_BING_*`. [Gateway contracts](docs/gateways.md) cover research/discovery adapters; [EXECUTION_CONTRACT.md](docs/EXECUTION_CONTRACT.md) covers provider jobs. Corporate/CDP protocols remain unverified. The UI intentionally prepares jobs without sending them. General questions need no LinkedIn; M365 must include genuine PB LinkedIn when present.

## Validation

```powershell
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo build --release --locked
py -3 -m unittest discover -s tests -p test_local_embed_worker.py -v
```

Refresh catalogs from the release executable and run `python scripts/build_tool_reference.py` after schema changes. [IMPLEMENTATION.md](IMPLEMENTATION.md) records checks, independent review and remaining integration limits. The [LangGraph package](../mna-orchestrator/README.md) is an offline scaffold; production ports, durable graph saver, corporate deployment testing and large-corpus model validation remain work for deployment.
