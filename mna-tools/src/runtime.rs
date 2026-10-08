use crate::{
    context::ContextService,
    data::DataService,
    error::{Error, Result},
    execution::ExecutionService,
    search::SearchEngine,
    store::Store,
    workflow::WorkflowService,
};
use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct Runtime {
    store: Store,
    search: Arc<SearchEngine>,
    space: Arc<crate::search_space::SearchSpace>,
    context: ContextService,
    concurrency: Arc<Semaphore>,
    exports: crate::export_jobs::ExportJobs,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCall {
    pub tool: String,
    pub arguments: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Batch {
    calls: Vec<ToolCall>,
}

#[derive(Clone, Serialize)]
pub struct ToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    pub mutates_state: bool,
    pub input_schema: Value,
}

pub fn tool_definitions() -> Vec<ToolDefinition> {
    let groups: &[(&str, &str, &str, bool)] = &[
        ("space_sync_status", "Read active MID Meilisearch sync status", "search", false),
        ("space_browse", "Browse all active MID companies without a run", "search", false),
        ("space_search_lexical", "Search the MID population using keyword sets and Boolean expressions", "search", true),
        ("space_search_semantic", "Search all compatible active MID vectors using free text", "search", true),
        ("space_search_iscc", "Search ISCC and hydrate companies without a run", "search", true),
        ("space_recent", "Read recent Search Space searches", "search", false),
        ("get_shortlist_context", "Read considered companies, hidden count, source coverage and chosen results for this screening run", "review", false),
        ("get_criteria_history", "Read every criteria revision with its Intake Form, exclusions, validity period (created_at to superseded_at) and analyst approval; last_criteria is the newest revision", "review", false),
        (
            "search_companies",
            "Search canonical core-business descriptions; report non-core filters as unused",
            "search",
            false,
        ),
        (
            "find_company",
            "Resolve canonical company identity",
            "search",
            false,
        ),
        (
            "find_similar_companies",
            "Find companies similar to a stored seed vector",
            "search",
            false,
        ),
        (
            "find_similar_to_examples",
            "Find companies using positive and negative example centroids",
            "search",
            false,
        ),
        (
            "get_company",
            "Read the canonical company record",
            "state",
            false,
        ),
        (
            "get_company_context",
            "Compose selected company sections within a character budget",
            "context",
            false,
        ),
        (
            "get_candidate_context",
            "Compose candidate context scoped to a screening run",
            "context",
            false,
        ),
        (
            "get_candidate_batch_context",
            "Compose selected candidate fields for batch screening",
            "context",
            false,
        ),
        (
            "build_context_packet",
            "Build prioritized, bounded context from authoritative state",
            "context",
            false,
        ),
        (
            "get_run_context",
            "Read run objective, progress, questions and decisions",
            "state",
            false,
        ),
        (
            "get_original_criteria",
            "Read immutable original mandate criteria",
            "state",
            false,
        ),
        (
            "get_active_screening_profile",
            "Read the current approved screening profile",
            "state",
            false,
        ),
        (
            "get_screening_profile_version",
            "Read a historical profile version",
            "state",
            false,
        ),
        (
            "compare_profile_versions",
            "Compare profile versions and their lineage",
            "state",
            false,
        ),
        (
            "propose_screening_profile",
            "Persist a profile proposal for analyst approval",
            "state",
            true,
        ),
        (
            "get_labelled_examples",
            "Read analyst labels and canonical company examples",
            "state",
            false,
        ),
        (
            "get_representative_examples",
            "Select relevant examples per analyst label",
            "state",
            false,
        ),
        (
            "label_company",
            "Record actual analyst feedback; requires analyst credentials on every route",
            "state",
            true,
        ),
        (
            "search_iscc",
            "Query a configured ISCC gateway with normalized results",
            "provider",
            false,
        ),
        (
            "bing_search",
            "Query a configured grounded Bing gateway",
            "provider",
            false,
        ),
        (
            "m365_research",
            "Research approved questions for scoped company IDs through a configured M365 gateway",
            "provider",
            false,
        ),
        (
            "fetch_url",
            "Cache a public URL and return artifact metadata",
            "provider",
            false,
        ),
        (
            "extract_url_context",
            "Extract bounded page text relevant to an extraction goal",
            "provider",
            false,
        ),
        (
            "get_evidence",
            "Read evidence with provenance, scoped to run and company",
            "state",
            false,
        ),
        (
            "save_evidence",
            "Persist a claim with source provenance and confidence",
            "state",
            true,
        ),
        (
            "get_missing_evidence",
            "Identify attributes still lacking evidence",
            "state",
            false,
        ),
        (
            "search_research_memory",
            "Search persisted research in a run",
            "state",
            false,
        ),
        (
            "get_previous_research",
            "Explicitly retrieve company research across runs",
            "state",
            false,
        ),
        (
            "get_recent_agent_events",
            "Read recent meaningful workflow events",
            "state",
            false,
        ),
        (
            "get_search_history",
            "Read discovery queries and their provenance",
            "state",
            false,
        ),
        (
            "get_open_questions",
            "Read unresolved research questions",
            "state",
            false,
        ),
        ("add_open_question", "Persist a research gap", "state", true),
        (
            "resolve_open_question",
            "Resolve a question using scoped evidence IDs",
            "state",
            true,
        ),
        (
            "add_candidates",
            "Deduplicate candidates and retain discovery provenance",
            "state",
            true,
        ),
        (
            "update_candidate_status",
            "Persist a classification and supporting reason",
            "state",
            true,
        ),
        (
            "get_candidate_set",
            "Read run candidates by status or identity; report non-core filters as unused",
            "state",
            false,
        ),
        (
            "save_checkpoint",
            "Persist orchestrator state for restart recovery",
            "state",
            true,
        ),
        (
            "get_checkpoint",
            "Read the latest durable orchestrator checkpoint",
            "state",
            false,
        ),
        (
            "search_mid",
            "Search the imported MID universe by qualitative business concepts",
            "search",
            true,
        ),
        ("score_mid_semantic", "Score MID candidates against approved criteria using stored embeddings", "search", true),
        ("search_mid_semantic", "Discover additional MID companies using stored embeddings", "search", true),
        (
            "get_iscc_score_samples",
            "Inspect description samples across saved ISCC relevance bands",
            "search",
            false,
        ),
        (
            "inspect_enrichment_files",
            "Inspect uploaded sheet headers and identify PitchBook mapping, PitchBook data, and ROGO files without importing; an optional purpose_hint rejects files dropped in the wrong zone",
            "data",
            false,
        ),
        (
            "import_enrichment_files",
            "Detect and join user-supplied PitchBook and ROGO files, never changing which companies are considered; saves and returns a match report",
            "data",
            true,
        ),
        (
            "get_enrichment_report",
            "Read the saved PitchBook or ROGO match report of an import: matched companies, unmatched companies with a reason, unmatched and ambiguous ROGO rows",
            "data",
            false,
        ),
        (
            "get_screening_grid",
            "Page a run's MID, ISCC or merged grid with a column catalog, separate scores, banker coverage and PitchBook/ROGO/Bing hydration",
            "data",
            false,
        ),
        (
            "get_grid_descriptions",
            "Read per-column MID and ISCC descriptions for up to 500 visible companies in a run",
            "data",
            false,
        ),
        (
            "get_company_detail",
            "Read one company's identifiers, every source field grouped by MID, ISCC, PitchBook and ROGO, labelled descriptions and recent activity",
            "data",
            false,
        ),
        (
            "export_candidate_set",
            "Export PitchBook, LLM, or full source workbooks for selected candidates",
            "data",
            true,
        ),
        (
            "get_discovery_summary",
            "Report unique candidates, MID/ISCC overlap and the recommended next step",
            "data",
            false,
        ),
        (
            "get_company_identifiers",
            "Read ECID, CID, PBId and historical key cross-references",
            "data",
            false,
        ),
        (
            "get_source_rows",
            "Read bounded original MID and ISCC source rows",
            "data",
            false,
        ),
        (
            "get_candidate_source_data",
            "Read paged candidate source columns with MID history, current-run ISCC, PitchBook and ROGO provenance",
            "data",
            false,
        ),
        ("get_run_source_projection", "Build a run-scoped input table with independent PB/MID/ISCC name and website fallbacks, labeled descriptions, coverage and row hashes", "projection", false),
        ("get_mid_index_status", "Read the active MID index and running build", "data", false),
        ("get_export", "Read background export progress", "data", false),
        ("list_exports", "List background exports for a run", "data", false),
        ("get_index_build", "Read durable index build steps and progress", "data", false),
        ("list_index_builds", "List recent MID index builds and bundles", "data", false),
        ("get_source_field_catalog", "List available MID, ISCC, PitchBook and ROGO fields and missing-data counts for this run", "projection", false),
        ("get_retrieval_config", "Show the selected Arctic 768D INT8 embedder, replaceable reranker, 1000-result retrieval and top-500 reranking policy", "search", false),
        ("embed_texts", "Obtain validated vectors from the configured local embedder; unconfigured inference returns an explicit unavailable state", "search", false),
        ("rerank_candidates", "Reorder only the first 500 retrieved companies using a configured local reranker and preserve the remaining companies and source scores", "search", true),
        ("propose_prepared_plan", "Freeze a version-2 screening or question proposal with exact input rows, prompt, columns, deployment and batch size; requires later analyst approval and does not execute a provider", "execution", true),
        ("get_prepared_plan", "Read a frozen version-2 proposal, approval status and durable jobs; never infer that a prepared handoff has executed", "execution", false),
        ("get_execution_progress", "Read lightweight plan and batch progress without resending frozen inputs; includes safe retry eligibility and source freshness", "execution", false),
        ("get_execution_job", "Read durable batch state, immutable index mapping, repair diagnostics and recorded provider status", "execution", false),
        ("get_model_assessments", "Read accepted provider assessments by prompt and batch, independently of retrieval scores and verified evidence", "execution", false),
        ("get_screening_rounds", "Read approved screening rounds with provider, job progress and per-score distributions", "execution", false),
        (
            "get_search_policy",
            "Show core-business criteria and criteria deliberately unused for discovery",
            "workflow",
            false,
        ),
        (
            "propose_action_plan",
            "Record a bounded dependency graph for analyst review",
            "workflow",
            true,
        ),
        (
            "get_action_plan",
            "Read an action plan and its approval metadata",
            "workflow",
            false,
        ),
        (
            "prepare_screening_batch",
            "Legacy scored handoff; prefer propose_prepared_plan for index-only results and complete execution approval; genuine PB LinkedIn is included when available",
            "workflow",
            true,
        ),
        (
            "prepare_bing_queries",
            "Expand three to five approved research templates using preferred company identity",
            "workflow",
            false,
        ),
        (
            "save_screening_results",
            "Persist external screening scores or CHECK without inventing analyst labels",
            "workflow",
            true,
        ),
        (
            "get_screening_results",
            "Read run-scoped external screening results and their profile lineage",
            "workflow",
            false,
        ),
        (
            "complete_action_step",
            "Mark a plan step complete using service-issued successful-operation receipts",
            "workflow",
            true,
        ),
    ];
    groups
        .iter()
        .map(
            |&(name, description, category, mutates_state)| ToolDefinition {
                name,
                description,
                category,
                mutates_state: mutates_state
                    || matches!(
                        name,
                        "search_companies"
                            | "find_company"
                            | "find_similar_companies"
                            | "find_similar_to_examples"
                            | "search_iscc"
                            | "bing_search"
                            | "m365_research"
                            | "fetch_url"
                            | "extract_url_context"
                    ),
                input_schema: crate::store::input_schema(name)
                    .or_else(|| crate::search_space::input_schema(name))
                    .or_else(|| crate::context::input_schema(name))
                    .or_else(|| crate::search::input_schema(name))
                    .or_else(|| crate::data::input_schema(name))
                    .or_else(|| crate::export_jobs::input_schema(name))
                    .or_else(|| crate::index_build::input_schema(name))
                    .or_else(|| crate::workflow::input_schema(name))
                    .or_else(|| crate::projection::input_schema(name))
                    .or_else(|| crate::execution::input_schema(name))
                    .or_else(|| crate::review::input_schema(name))
                    .unwrap_or_else(|| json!({"type":"object","additionalProperties":false})),
            },
        )
        .collect()
}

fn canonical_tool(name: &str) -> Result<String> {
    if name.is_empty()
        || name.len() > 80
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b == b'_' || b == b'-')
    {
        return Err(Error::Validation("Invalid tool name".into()));
    }
    let tool = name.replace('-', "_");
    if !tool_definitions().iter().any(|d| d.name == tool) {
        return Err(Error::Validation(format!(
            "Tool is not allowlisted: {tool}"
        )));
    }
    Ok(tool)
}

impl Runtime {
    pub fn new(store: Store) -> Result<Self> {
        crate::index_build::recover_interrupted(&store)?;
        Ok(Self {
            search: Arc::new(SearchEngine::new(store.clone())?),
            space: Arc::new(crate::search_space::SearchSpace::new(store.clone())?),
            exports: crate::export_jobs::ExportJobs::new(&store)?,
            context: ContextService::new(store.clone()),
            store,
            concurrency: Arc::new(Semaphore::new(8)),
        })
    }

    pub async fn execute(&self, call: ToolCall) -> Result<Value> {
        self.execute_with_feedback_authorization(call, false).await
    }

    async fn execute_with_feedback_authorization(
        &self,
        call: ToolCall,
        analyst: bool,
    ) -> Result<Value> {
        let tool = canonical_tool(&call.tool)?;
        let feedback = tool == "label_company" && analyst;
        self.dispatch(&tool, call.arguments, feedback).await
    }

    async fn dispatch(&self, tool: &str, arguments: Value, admin: bool) -> Result<Value> {
        if !arguments.is_object() {
            return Err(Error::Validation(
                "Tool arguments must be a JSON object".into(),
            ));
        }
        let mut arguments = self.store.normalize_company_references(&arguments);
        let _permit = self
            .concurrency
            .acquire()
            .await
            .map_err(|_| Error::Internal("Runtime shutting down".into()))?;
        let category = tool_definitions()
            .into_iter()
            .find(|d| d.name == tool)
            .map(|d| d.category);
        let workflow = WorkflowService::new(self.store.clone());
        let authorization = if (tool == "label_company"
            || matches!(tool, "space_sync" | "space_add_to_run" | "space_export"))
            && !admin
        {
            Err(Error::AnalystAuthRequired)
        } else if [
            "search_companies",
            "search_mid",
            "score_mid_semantic",
            "search_mid_semantic",
            "search_iscc",
            "find_similar_companies",
            "find_similar_to_examples",
            "rerank_candidates",
        ]
        .contains(&tool)
        {
            match arguments["run_id"].as_str() {
                Some(run_id) => workflow.require_approved_criteria(run_id).map(|_| ()),
                None => Err(Error::Validation("run_id is required for discovery".into())),
            }
        } else if tool == "propose_prepared_plan" && arguments["mode"] == "screening" {
            match arguments["run_id"].as_str() {
                Some(run_id) => workflow.require_approved_criteria(run_id).map(|_| ()),
                None => Err(Error::Validation("run_id is required for screening".into())),
            }
        } else if tool == "m365_research" {
            workflow
                .normalize_m365_arguments(&mut arguments)
                .and_then(|_| workflow.authorize_provider(tool, &arguments))
        } else {
            workflow.authorize_provider(tool, &arguments)
        };
        let mut result = if let Err(error) = authorization {
            Err(error)
        } else if crate::search_space::input_schema(tool).is_some() {
            self.space.execute(tool, &arguments).await
        } else if category == Some("search")
            || category == Some("provider")
            || tool == "sync_search_index"
            || tool == "rebuild_embedding_index"
        {
            self.search.execute(tool, &arguments).await
        } else {
            let store = self.store.clone();
            let context = self.context.clone();
            let exports = self.exports.clone();
            let data = DataService::new(store.clone());
            let workflow = WorkflowService::new(store.clone());
            let owned_tool = tool.to_owned();
            let owned_arguments = arguments.clone();
            tokio::task::spawn_blocking(move || {
                if crate::export_jobs::input_schema(&owned_tool).is_some() {
                    exports.execute(&store, &owned_tool, &owned_arguments)
                } else if crate::index_build::input_schema(&owned_tool).is_some() {
                    crate::index_build::execute(&store, &owned_tool, &owned_arguments)
                } else if owned_tool == "get_grid_descriptions" {
                    crate::grid::grid_descriptions(&store, &owned_arguments)
                } else if category == Some("context") {
                    context.execute(&owned_tool, &owned_arguments)
                } else if category == Some("data") || owned_tool == "import_company_files" {
                    data.execute(&owned_tool, &owned_arguments)
                } else if category == Some("workflow") || owned_tool == "approve_action_plan" {
                    workflow.execute(&owned_tool, &owned_arguments)
                } else if category == Some("projection") {
                    crate::projection::execute(&store, &owned_tool, &owned_arguments)
                } else if category == Some("execution")
                    || crate::execution::input_schema(&owned_tool).is_some()
                {
                    ExecutionService::new(store).execute(&owned_tool, &owned_arguments)
                } else if owned_tool == "review_evidence_claim" {
                    crate::trust::review(&store, &owned_arguments)
                } else {
                    store.execute(&owned_tool, &owned_arguments)
                }
            })
            .await
            .map_err(|e| Error::Internal(format!("Worker failed: {e}")))?
        };
        if tool == "bing_search" {
            if let Ok(payload) = &mut result {
                if let Err(error) = workflow.hydrate_bing_observation(&arguments, payload) {
                    result = Err(error);
                }
            }
        }
        if [
            "search_mid",
            "search_mid_semantic",
            "search_companies",
            "search_iscc",
            "import_enrichment_files",
            "export_candidate_set",
            "bing_search",
            "m365_research",
            "save_screening_results",
        ]
        .contains(&tool)
        {
            if let Ok(payload) = &mut result {
                match workflow.record_receipt(tool, &arguments, payload) {
                    Ok(receipt) => {
                        payload["operation_receipt_id"] = json!(receipt);
                    }
                    Err(error) => {
                        result = Err(error);
                    }
                }
            }
        }
        let status = if result.is_ok() {
            "SUCCEEDED"
        } else {
            "FAILED"
        };
        let audit_result = match &result {
            Ok(value) => {
                json!({"result_bytes":serde_json::to_vec(value)?.len(), "actor":if admin {"analyst"} else {"agent"}})
            }
            Err(error) => {
                json!({"error_code":error.code(), "actor":if admin {"analyst"} else {"agent"}})
            }
        };
        let store = self.store.clone();
        let audit_tool = tool.to_owned();
        tokio::task::spawn_blocking(move || {
            store.audit(&audit_tool, &arguments, status, &audit_result)
        })
        .await
        .map_err(|e| Error::Internal(format!("Audit worker failed: {e}")))??;
        result
    }
}

#[derive(Clone)]
struct ApiState {
    runtime: Runtime,
    api_key: Arc<str>,
    analyst_key: Option<Arc<str>>,
    controller_key: Option<Arc<str>>,
}

fn same_key(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |different, (x, y)| different | (x ^ y))
        == 0
}

fn authenticated(headers: &HeaderMap, state: &ApiState, analyst: bool) -> bool {
    let api_ok = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .is_some_and(|key| same_key(key, &state.api_key));
    if !api_ok {
        return false;
    }
    if !analyst {
        return true;
    }
    match &state.analyst_key {
        Some(expected) => headers
            .get("x-mna-analyst-key")
            .and_then(|h| h.to_str().ok())
            .is_some_and(|key| same_key(key, expected)),
        None => false,
    }
}

fn unauthorized(analyst: bool) -> Response {
    (if analyst {StatusCode::FORBIDDEN} else {StatusCode::UNAUTHORIZED}, Json(json!({"error":{"code":if analyst {"ANALYST_AUTH_REQUIRED"} else {"AUTH_REQUIRED"},"message":"Valid service credentials required"}}))).into_response()
}

pub fn router(runtime: Runtime, api_key: String, analyst_key: Option<String>) -> Result<Router> {
    if api_key.len() < 24
        || analyst_key
            .as_ref()
            .is_some_and(|k| k.len() < 24 || same_key(k, &api_key))
    {
        return Err(Error::Validation("Service keys must contain at least 24 characters; analyst key must differ from API key".into()));
    }
    let state = ApiState {
        runtime,
        api_key: Arc::from(api_key),
        analyst_key: analyst_key.map(Arc::from),
        controller_key: std::env::var("MNA_CONTROLLER_KEY")
            .ok()
            .filter(|key| key.len() >= 24)
            .map(Arc::from),
    };
    Ok(Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"status":"ok","service":"mna-tools"})) }),
        )
        .route("/tools", get(discover))
        .route("/tools/call", post(call))
        .route("/agent/tools", get(agent_tools))
        .route("/agent/commands", post(agent_command))
        .route("/tools/batch", post(batch))
        .route("/tools/{tool}", post(direct))
        .route(
            "/admin/{operation}",
            post(admin).layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
        .route("/admin/tools", get(admin_discover))
        .route("/admin/profiles/approve", post(approve))
        .route("/admin/actions/approve", post(approve_action))
        .route("/providers/status", get(provider_status))
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .with_state(state))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiscoveryQuery {
    names: Option<String>,
}

async fn discover(
    State(state): State<ApiState>,
    Query(query): Query<DiscoveryQuery>,
    headers: HeaderMap,
) -> Response {
    if !authenticated(&headers, &state, false) {
        return unauthorized(false);
    }
    let mut definitions = tool_definitions();
    if let Some(names) = query.names {
        if names.len() > 1600 {
            return Error::Validation("Tool filter is too long".into()).into_response();
        }
        let selected: Result<Vec<_>> = names.split(',').map(canonical_tool).collect();
        let selected = match selected {
            Ok(names) => names,
            Err(error) => return error.into_response(),
        };
        definitions.retain(|d| selected.iter().any(|s| s == d.name));
    }
    Json(json!({"tools":definitions,"max_batch_calls":16,"max_request_bytes":1048576,"profile_approval":"analyst_only"})).into_response()
}

type JsonInput<T> = std::result::Result<Json<T>, JsonRejection>;
fn parse_body<T>(payload: JsonInput<T>) -> Result<T> {
    payload
        .map(|Json(value)| value)
        .map_err(|error| Error::Validation(error.body_text()))
}

async fn call(
    State(state): State<ApiState>,
    headers: HeaderMap,
    payload: JsonInput<ToolCall>,
) -> Response {
    if !authenticated(&headers, &state, false) {
        return unauthorized(false);
    }
    let call = match parse_body(payload) {
        Ok(call) => call,
        Err(error) => return error.into_response(),
    };
    let tool = call.tool.clone();
    match state
        .runtime
        .execute_with_feedback_authorization(call, authenticated(&headers, &state, true))
        .await
    {
        Ok(result) => Json(json!({"tool":tool,"ok":true,"result":result})).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn direct(
    State(state): State<ApiState>,
    Path(tool): Path<String>,
    headers: HeaderMap,
    payload: JsonInput<Value>,
) -> Response {
    if !authenticated(&headers, &state, false) {
        return unauthorized(false);
    }
    let arguments = match parse_body(payload) {
        Ok(arguments) => arguments,
        Err(error) => return error.into_response(),
    };
    match state
        .runtime
        .execute_with_feedback_authorization(
            ToolCall { tool, arguments },
            authenticated(&headers, &state, true),
        )
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn batch(
    State(state): State<ApiState>,
    headers: HeaderMap,
    payload: JsonInput<Batch>,
) -> Response {
    if !authenticated(&headers, &state, false) {
        return unauthorized(false);
    }
    let batch = match parse_body(payload) {
        Ok(batch) => batch,
        Err(error) => return error.into_response(),
    };
    if batch.calls.is_empty() || batch.calls.len() > 16 {
        return Error::Validation("A batch must contain 1..=16 calls".into()).into_response();
    }
    for call in &batch.calls {
        if let Err(error) = canonical_tool(&call.tool) {
            return error.into_response();
        }
        if !call.arguments.is_object() {
            return Error::Validation("Tool arguments must be objects".into()).into_response();
        }
    }
    let mut results = Vec::with_capacity(batch.calls.len());
    for call in batch.calls {
        let tool = call.tool.clone();
        match state.runtime.execute_with_feedback_authorization(call,authenticated(&headers,&state,true)).await {
            Ok(result) => results.push(json!({"tool":tool,"ok":true,"result":result})),
            Err(error) => results.push(json!({"tool":tool,"ok":false,"error":{"code":error.code(),"message":public_error(&error)}})),
        }
    }
    Json(json!({"results":results,"atomic":false})).into_response()
}

fn public_error(error: &Error) -> String {
    match error {
        Error::Database(_) | Error::Http(_) | Error::Io(_) | Error::Internal(_) => {
            "Operation failed; inspect service logs".into()
        }
        _ => error.to_string(),
    }
}

async fn admin(
    State(state): State<ApiState>,
    Path(operation): Path<String>,
    headers: HeaderMap,
    payload: JsonInput<Value>,
) -> Response {
    let controller_operation = matches!(
        operation.as_str(),
        "execution-lease"
            | "execution-mark"
            | "execution-response"
            | "execution-reconcile"
            | "execution-failure"
            | "execution-retry"
            | "execution-dispatch"
            | "llmsuite-slot"
            | "llmsuite-consume"
            | "provider-text"
            | "shortlist-review"
            | "criteria-save"
            | "criteria-approve"
            | "enrichment-review"
    );
    if if controller_operation {
        !authenticated_controller(&headers, &state)
    } else {
        !authenticated(&headers, &state, true)
    } {
        return unauthorized(true);
    }
    let arguments = match parse_body(payload) {
        Ok(arguments) => arguments,
        Err(error) => return error.into_response(),
    };
    if operation == "execution-dispatch" {
        let args = match serde_json::from_value(arguments) {
            Ok(args) => args,
            Err(e) => return Error::Validation(e.to_string()).into_response(),
        };
        return match crate::gateway::dispatch(state.runtime.store.clone(), args).await {
            Ok(result) => Json(result).into_response(),
            Err(error) => error.into_response(),
        };
    }
    if operation == "provider-text" {
        let args = match serde_json::from_value(arguments) {
            Ok(args) => args,
            Err(error) => return Error::Validation(error.to_string()).into_response(),
        };
        return match crate::gateway::provider_text(state.runtime.store.clone(), args).await {
            Ok(result) => Json(result).into_response(),
            Err(error) => error.into_response(),
        };
    }
    let tool = match operation.as_str() {
        "companies" => "ingest_companies",
        "runs" => "create_run",
        "index" => "sync_search_index",
        "space-sync" => "space_sync",
        "space-add-to-run" => "space_add_to_run",
        "space-export" => "space_export",
        "labels" => "label_company",
        "company-files" => "import_company_files",
        "export-start" => "start_export",
        "index-build-start" => "start_index_build",
        "index-build-cancel" => "cancel_index_build",
        "mid-bundle-activate" => "activate_mid_bundle",
        "mid-bundle-delete" => "delete_mid_bundle",
        "prepared-plan-approve" => "approve_prepared_plan",
        "prepared-plan-cancel" => "cancel_prepared_plan",
        "execution-lease" => "lease_execution_job",
        "execution-mark" => "mark_execution_dispatch",
        "execution-response" => "record_execution_response",
        "execution-reconcile" => "reconcile_execution_job",
        "execution-failure" => "record_execution_failure",
        "execution-retry" => "retry_execution_job",
        "llmsuite-slot" => "reserve_llmsuite_slot",
        "llmsuite-consume" => "consume_llmsuite_slot",
        "embedding-index" => "rebuild_embedding_index",
        "evidence-review" => "review_evidence_claim",
        "shortlist-review" => "review_shortlist",
        "criteria-save" => "save_criteria_revision",
        "criteria-approve" => "approve_criteria_revision",
        "enrichment-review" => "apply_enrichment_review",
        _ => return Error::NotFound("Unknown admin operation".into()).into_response(),
    };
    match state.runtime.dispatch(tool, arguments, true).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn approve(
    State(state): State<ApiState>,
    headers: HeaderMap,
    payload: JsonInput<Value>,
) -> Response {
    if !authenticated(&headers, &state, true) {
        return unauthorized(true);
    }
    let arguments = match parse_body(payload) {
        Ok(arguments) => arguments,
        Err(error) => return error.into_response(),
    };
    match state
        .runtime
        .dispatch("approve_screening_profile", arguments, true)
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn approve_action(
    State(state): State<ApiState>,
    headers: HeaderMap,
    payload: JsonInput<Value>,
) -> Response {
    if !authenticated(&headers, &state, true) {
        return unauthorized(true);
    }
    let arguments = match parse_body(payload) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    match state
        .runtime
        .dispatch("approve_action_plan", arguments, true)
        .await
    {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn admin_discover(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    if !authenticated(&headers, &state, true) {
        return unauthorized(true);
    }
    Json(json!({"tools":administrator_definitions()})).into_response()
}

pub fn administrator_definitions() -> Vec<Value> {
    let tools: Vec<_> = [
        ("ingest_companies", "/admin/companies"), ("create_run", "/admin/runs"),
        ("approve_screening_profile", "/admin/profiles/approve"), ("sync_search_index", "/admin/index"),
        ("space_sync", "/admin/space-sync"), ("space_add_to_run", "/admin/space-add-to-run"), ("space_export", "/admin/space-export"),
        ("import_company_files", "/admin/company-files"), ("approve_action_plan", "/admin/actions/approve"),
        ("approve_prepared_plan", "/admin/prepared-plan-approve"), ("cancel_prepared_plan", "/admin/prepared-plan-cancel"),
        ("review_evidence_claim", "/admin/evidence-review"),
        ("lease_execution_job", "/admin/execution-lease"), ("mark_execution_dispatch", "/admin/execution-mark"),
        ("record_execution_response", "/admin/execution-response"), ("reserve_llmsuite_slot", "/admin/llmsuite-slot"),
        ("reconcile_execution_job", "/admin/execution-reconcile"), ("record_execution_failure", "/admin/execution-failure"), ("retry_execution_job", "/admin/execution-retry"),
        ("consume_llmsuite_slot", "/admin/llmsuite-consume"), ("dispatch_execution_job", "/admin/execution-dispatch"),
        ("rebuild_embedding_index", "/admin/embedding-index"),
        ("review_shortlist", "/admin/shortlist-review"),
        ("save_criteria_revision", "/admin/criteria-save"),
        ("approve_criteria_revision", "/admin/criteria-approve"),
        ("apply_enrichment_review", "/admin/enrichment-review"),
        ("dispatch_provider_text", "/admin/provider-text"),
        ("start_export", "/admin/export-start"),
        ("start_index_build", "/admin/index-build-start"),
        ("cancel_index_build", "/admin/index-build-cancel"),
        ("activate_mid_bundle", "/admin/mid-bundle-activate"),
        ("delete_mid_bundle", "/admin/mid-bundle-delete"),
    ].into_iter().map(|(name, endpoint)| json!({"name":name,"endpoint":endpoint,"controller_only":matches!(name,"lease_execution_job"|"mark_execution_dispatch"|"record_execution_response"|"reserve_llmsuite_slot"|"consume_llmsuite_slot"|"reconcile_execution_job"|"record_execution_failure"|"retry_execution_job"|"dispatch_execution_job"|"dispatch_provider_text"|"review_shortlist"|"save_criteria_revision"|"approve_criteria_revision"|"apply_enrichment_review"),"input_schema":if name=="dispatch_execution_job"{Some(crate::gateway::input_schema())}else if name=="dispatch_provider_text"{Some(crate::gateway::text_input_schema())}else{crate::store::input_schema(name).or_else(||crate::search_space::input_schema(name)).or_else(||crate::search::input_schema(name)).or_else(||crate::data::input_schema(name)).or_else(||crate::export_jobs::input_schema(name)).or_else(||crate::index_build::input_schema(name)).or_else(||crate::workflow::input_schema(name)).or_else(||crate::execution::input_schema(name)).or_else(||crate::trust::input_schema(name)).or_else(||crate::review::input_schema(name))}})).collect();
    tools
}

fn authenticated_controller(headers: &HeaderMap, state: &ApiState) -> bool {
    authenticated(headers, state, false)
        && state.controller_key.as_ref().is_some_and(|expected| {
            headers
                .get("x-mna-controller-key")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|actual| same_key(actual, expected))
        })
}

async fn agent_tools(
    State(state): State<ApiState>,
    Query(query): Query<DiscoveryQuery>,
    headers: HeaderMap,
) -> Response {
    if !authenticated(&headers, &state, false) {
        return unauthorized(false);
    }
    let names=query.names.unwrap_or_else(|| "get_search_policy,search_mid,search_iscc,get_iscc_score_samples,add_candidates,get_discovery_summary,get_retrieval_config,rerank_candidates".into());
    let names: Vec<String> = names.split(',').map(str::to_owned).collect();
    match crate::agent_commands::prompt(&names) {
        Ok(prompt) => (
            [(
                axum::http::header::CONTENT_TYPE,
                "text/plain; charset=utf-8",
            )],
            prompt,
        )
            .into_response(),
        Err(error) => error.into_response(),
    }
}

async fn agent_command(
    State(state): State<ApiState>,
    headers: HeaderMap,
    payload: JsonInput<crate::agent_commands::CommandRequest>,
) -> Response {
    if !authenticated(&headers, &state, false) {
        return unauthorized(false);
    }
    let request = match parse_body(payload) {
        Ok(value) => value,
        Err(e) => return e.into_response(),
    };
    let store = state.runtime.store.clone();
    match crate::agent_commands::claim(&store, &request) {
        Ok(Some(value)) => return Json(value).into_response(),
        Err(error) => return error.into_response(),
        Ok(None) => {}
    }
    let parsed = crate::agent_commands::parse(&request);
    let (tool, result) = match parsed {
        Ok(call) => {
            let tool = call.tool.clone();
            let result = match crate::agent_commands::validate_scope(&store, &request, &call) {
                Ok(()) => state.runtime.execute(call).await,
                Err(e) => Err(e),
            };
            (Some(tool), result)
        }
        Err(error) => (None, Err(error)),
    };
    match crate::agent_commands::finish(&store, &request, tool.as_deref(), result) {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn provider_status(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    if !authenticated(&headers, &state, false) {
        return unauthorized(false);
    }
    let simulated = crate::simulate::enabled();
    let enabled = std::env::var("MNA_ENABLE_EXTERNAL").ok().as_deref() == Some("true");
    let paths:Vec<_>=[("llm_suite","LLMSUITE"),("copilot","M365"),("bing_grounding","BING"),("iscc","ISCC")].into_iter().map(|(name,prefix)|{
        let configured=std::env::var(format!("MNA_{prefix}_ENDPOINT")).is_ok_and(|v|!v.trim().is_empty());
        json!({"path":name,"simulated":simulated,"implementation_status":if simulated {"simulated"} else if configured {"configured_but_unverified"} else {"planned"},"adapter_implemented":true,"endpoint_configured":configured,"execution_enabled":enabled || simulated,"executed":false})
    }).collect();
    Json(json!({"simulated":simulated,"paths":paths,"local_preparation":{"implementation_status":"implemented","executed":false},"local_retrieval":crate::retrieval::RetrievalConfig::from_env().map(|c|c.status()).unwrap_or_else(|_|json!({"implementation_status":"planned","configuration_error":true,"executed":false}))})).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allowlist_excludes_approval_and_sql() {
        assert!(canonical_tool("get-company").is_ok());
        assert!(canonical_tool("execute_sql").is_err());
        assert!(canonical_tool("approve_screening_profile").is_err());
        assert!(canonical_tool("../get_company").is_err());
    }
    #[test]
    fn typed_call_rejects_unknown_envelope_fields() {
        assert!(serde_json::from_value::<ToolCall>(
            json!({"tool":"get_company","arguments":{},"sql":"DROP TABLE companies"})
        )
        .is_err());
    }
}
