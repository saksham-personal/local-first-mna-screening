use crate::data::DataService;
use crate::error::{Error, Result};
use crate::providers::Providers;
use crate::retrieval::{self, Embedder, LocalHttpAdapter};
use crate::store::Store;
use reqwest::{header, Client};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::time::Duration;

const MAX_QUERY_CHARS: usize = 4_000;
const MAX_LIMIT: usize = 1_000;
const MAX_VECTOR_DIMENSIONS: usize = 4_096;

#[derive(Clone)]
pub struct SearchEngine {
    store: Store,
    data: DataService,
    providers: Providers,
    meili: Option<MeiliConfig>,
    client: Client,
}

#[derive(Clone)]
struct MeiliConfig {
    url: String,
    api_key: Option<String>,
    index: String,
    embedder: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SearchMode {
    Lexical,
    Semantic,
    #[default]
    Hybrid,
}

impl SearchMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Lexical => "lexical",
            Self::Semantic => "semantic",
            Self::Hybrid => "hybrid",
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SearchFilters {
    #[serde(default)]
    company_ids: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_vec")]
    country: Vec<String>,
    city: Option<String>,
    industry: Option<String>,
    sub_industry: Option<String>,
    ownership: Option<String>,
    #[serde(default)]
    exclude_industries: Vec<String>,
    revenue_min: Option<f64>,
    revenue_max: Option<f64>,
    employees_min: Option<u64>,
    employees_max: Option<u64>,
    #[serde(default)]
    any_keywords: Vec<String>,
    #[serde(default)]
    all_keywords: Vec<String>,
    #[serde(default)]
    exclude_keywords: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SearchCompaniesArgs {
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    query: String,
    #[serde(default)]
    mode: SearchMode,
    #[serde(default)]
    filters: SearchFilters,
    #[serde(default = "default_limit")]
    limit: usize,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    query_vector: Option<Vec<f32>>,
    #[serde(default = "default_true")]
    prefer_meilisearch: bool,
    #[serde(default = "default_lexical_weight")]
    lexical_weight: f64,
    #[serde(default = "default_semantic_weight")]
    semantic_weight: f64,
    #[serde(default)]
    semantic_ratio: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct FindCompanyArgs {
    #[serde(default)]
    run_id: Option<String>,
    company_id: Option<String>,
    ecid: Option<String>,
    cid: Option<String>,
    pbid: Option<String>,
    name: Option<String>,
    website: Option<String>,
    linkedin_url: Option<String>,
    #[serde(default = "default_find_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct FindSimilarArgs {
    #[serde(default)]
    run_id: Option<String>,
    company_id: Option<String>,
    query_vector: Option<Vec<f32>>,
    #[serde(default)]
    filters: SearchFilters,
    #[serde(default = "default_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct FindSimilarExamplesArgs {
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    positive_company_ids: Vec<String>,
    #[serde(default)]
    negative_company_ids: Vec<String>,
    #[serde(default)]
    positive_vectors: Vec<Vec<f32>>,
    #[serde(default)]
    negative_vectors: Vec<Vec<f32>>,
    #[serde(default)]
    filters: SearchFilters,
    #[serde(default = "default_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SyncIndexArgs {
    #[serde(default)]
    full_rebuild: bool,
    #[serde(default = "default_sync_limit")]
    limit: usize,
    #[serde(default = "default_batch_size")]
    batch_size: usize,
    #[serde(default = "default_true")]
    wait_for_completion: bool,
    #[serde(default = "default_task_timeout")]
    task_timeout_secs: u64,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RebuildEmbeddingsArgs {
    #[serde(default)]
    after_company_id: Option<String>,
    #[serde(default = "default_limit")]
    limit: usize,
    #[serde(default = "default_embed_batch")]
    batch_size: usize,
}
fn default_embed_batch() -> usize {
    16
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct IsccScoreSamplesArgs {
    run_id: String,
    query_id: String,
    #[serde(default = "default_samples_per_band")]
    per_band: usize,
    #[serde(default = "default_sample_min_score")]
    min_score: f64,
}

fn default_samples_per_band() -> usize {
    3
}
fn default_sample_min_score() -> f64 {
    0.3
}

fn default_limit() -> usize {
    1_000
}
fn default_find_limit() -> usize {
    10
}
fn default_sync_limit() -> usize {
    200_000
}
fn default_batch_size() -> usize {
    500
}
fn default_true() -> bool {
    true
}
fn default_lexical_weight() -> f64 {
    0.45
}
fn default_semantic_weight() -> f64 {
    0.55
}
fn default_task_timeout() -> u64 {
    30
}

pub fn input_schema(tool: &str) -> Option<Value> {
    let schema = match tool {
        "search_companies" | "search_mid" => schemars::schema_for!(SearchCompaniesArgs),
        "find_company" => schemars::schema_for!(FindCompanyArgs),
        "find_similar_companies" => schemars::schema_for!(FindSimilarArgs),
        "find_similar_to_examples" => schemars::schema_for!(FindSimilarExamplesArgs),
        "sync_search_index" => schemars::schema_for!(SyncIndexArgs),
        "rebuild_embedding_index" => schemars::schema_for!(RebuildEmbeddingsArgs),
        "get_iscc_score_samples" => schemars::schema_for!(IsccScoreSamplesArgs),
        "rerank_candidates" => schemars::schema_for!(retrieval::RerankArgs),
        "embed_texts" => schemars::schema_for!(retrieval::EmbedArgs),
        "get_retrieval_config" => {
            return Some(json!({"type":"object","properties":{},"additionalProperties":false}))
        }
        _ => return crate::providers::input_schema(tool),
    };
    serde_json::to_value(schema).ok()
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct EmptyArgs {}

impl SearchEngine {
    pub fn new(store: Store) -> Result<Self> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(20))
            .build()?;
        let meili = std::env::var("MNA_MEILI_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|url| MeiliConfig {
                url: url.trim_end_matches('/').to_string(),
                api_key: std::env::var("MNA_MEILI_API_KEY").ok(),
                index: std::env::var("MNA_MEILI_INDEX").unwrap_or_else(|_| "companies".into()),
                embedder: std::env::var("MNA_MEILI_EMBEDDER").ok(),
            });
        Ok(Self {
            data: DataService::new(store.clone()),
            store,
            providers: Providers::new()?,
            meili,
            client,
        })
    }

    pub async fn execute(&self, tool: &str, arguments: &Value) -> Result<Value> {
        if let Some(run_id) = arguments.get("run_id").filter(|v| !v.is_null()) {
            let run_id = run_id
                .as_str()
                .ok_or_else(|| Error::Validation("run_id must be a string".into()))?;
            self.store
                .execute("get_original_criteria", &json!({"run_id":run_id}))?;
        }
        match tool {
            "search_companies" => self.search_companies(arguments, false).await,
            "search_mid" => self.search_companies(arguments, true).await,
            "find_company" => self.find_company(arguments),
            "find_similar_companies" => self.find_similar(arguments),
            "find_similar_to_examples" => self.find_similar_examples(arguments),
            "get_iscc_score_samples" => self.get_iscc_score_samples(arguments),
            "sync_search_index" => self.sync_search_index(arguments).await,
            "rebuild_embedding_index" => self.rebuild_embedding_index(arguments).await,
            "get_retrieval_config" => {
                let _: EmptyArgs = parse(arguments)?;
                Ok(retrieval::RetrievalConfig::from_env()?.status())
            }
            "rerank_candidates" => self.rerank_candidates(arguments).await,
            "embed_texts" => self.embed_texts(arguments).await,
            "search_iscc" | "bing_search" | "m365_research" => {
                self.execute_provider_search(tool, arguments).await
            }
            "fetch_url" | "extract_url_context" => {
                let mut result = self.providers.execute(tool, arguments).await?;
                let record = self
                    .store
                    .record_document(arguments.get("run_id").and_then(Value::as_str), &result)?;
                result["document_id"] = record["document_id"].clone();
                Ok(result)
            }
            _ => Err(Error::NotFound(format!("unknown search tool: {tool}"))),
        }
    }

    async fn embed_texts(&self, arguments: &Value) -> Result<Value> {
        let args: retrieval::EmbedArgs = parse(arguments)?;
        let adapter = LocalHttpAdapter::new(retrieval::RetrievalConfig::from_env()?)?;
        let vectors = adapter.embed(&args.texts).await?;
        let count = vectors.len();
        Ok(
            json!({"model":adapter.config().embedder.model,"version":adapter.config().embedder.version,
            "dimensions":adapter.config().embedder.dimensions,"vectors":vectors,"count":count,
            "status":"implemented","executed":true,"provenance":"local_http_worker"}),
        )
    }

    async fn rebuild_embedding_index(&self, arguments: &Value) -> Result<Value> {
        let args: RebuildEmbeddingsArgs = parse(arguments)?;
        if !(1..=1000).contains(&args.limit) || !(1..=32).contains(&args.batch_size) {
            return Err(Error::Validation(
                "embedding index page limit must be 1..1000 and batch_size 1..32".into(),
            ));
        }
        let adapter = LocalHttpAdapter::new(retrieval::RetrievalConfig::from_env()?)?;
        let page = self
            .store
            .company_page_after(args.after_company_id.as_deref(), args.limit)?;
        let next = if page.len() == args.limit {
            page.last().and_then(company_id_of).map(str::to_owned)
        } else {
            None
        };
        let mut entries = Vec::new();
        let mut skipped = 0;
        for company in &page {
            let text = retrieval::document_text(company);
            if text.is_empty() || text.len() > 16_000 {
                skipped += 1;
                continue;
            }
            entries.push((
                company_id_of(company)
                    .ok_or_else(|| Error::Internal("company id missing".into()))?
                    .to_owned(),
                text,
            ));
        }
        let mut saved = 0;
        for batch in entries.chunks(args.batch_size) {
            let texts: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
            let vectors = adapter.embed(&texts).await?;
            let records: Vec<_> = batch
                .iter()
                .zip(vectors)
                .map(|((id, text), vector)| (id.clone(), retrieval::text_hash(text), vector))
                .collect();
            saved += self
                .store
                .save_model_embeddings(&adapter.config().embedder, &records)?;
        }
        Ok(
            json!({"identity":adapter.config().embedder,"rows_scanned":page.len(),"vectors_saved":saved,"rows_skipped":skipped,"changed_during_inference":entries.len()-saved,"next_cursor":next,"executed":true,"implementation_status":"implemented"}),
        )
    }

    async fn rerank_candidates(&self, arguments: &Value) -> Result<Value> {
        let args: retrieval::RerankArgs = parse(arguments)?;
        let adapter = LocalHttpAdapter::new(retrieval::RetrievalConfig::from_env()?)?;
        let model = adapter
            .config()
            .rerank_model
            .as_deref()
            .unwrap_or("unconfigured");
        let version = adapter
            .config()
            .rerank_version
            .as_deref()
            .unwrap_or("unconfigured");
        let mut result = retrieval::rerank_preserving_tail(
            &adapter,
            &args.query,
            &args.candidates,
            model,
            version,
        )
        .await?;
        let record = self.store.record_search(
            args.run_id.as_deref(),
            "local_reranker",
            &args.query,
            arguments,
            &result,
        )?;
        attach_query_id(&mut result, &record);
        Ok(result)
    }

    async fn execute_provider_search(&self, tool: &str, arguments: &Value) -> Result<Value> {
        let mut result = self.providers.execute(tool, arguments).await?;
        let run_id = arguments.get("run_id").and_then(Value::as_str);
        let query = arguments
            .get("query")
            .or_else(|| arguments.get("question"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        // Keep the history bounded. The original ISCC rows are persisted by the data
        // service, including their source columns, rather than copied into history.
        let history_result = if tool == "search_iscc" {
            json!({
                "provider": "iscc",
                "query": query,
                "result_count": result["result_count"],
                "score_bands": result["score_bands"],
                "retrieved_at": result["retrieved_at"],
            })
        } else {
            result.clone()
        };
        let record = self
            .store
            .record_search(run_id, tool, query, arguments, &history_result)?;
        attach_query_id(&mut result, &record);
        if tool == "search_iscc" {
            let raw_rows = result
                .get_mut("raw_rows")
                .and_then(Value::as_array_mut)
                .map(std::mem::take)
                .ok_or_else(|| Error::ProviderUnavailable("ISCC response omitted rows".into()))?;
            result
                .as_object_mut()
                .expect("provider result object")
                .remove("raw_rows");
            let hydrated =
                self.data
                    .ingest_iscc_rows(run_id, record["query_id"].as_str(), &raw_rows)?;
            result["retrieved_count"] = result["result_count"].clone();
            result["results"] = hydrated["companies"].clone();
            result["result_count"] = json!(result["results"].as_array().map_or(0, Vec::len));
            let mut ingestion = hydrated;
            ingestion
                .as_object_mut()
                .expect("ingestion object")
                .remove("companies");
            result["ingestion"] = ingestion;
        }
        Ok(result)
    }

    fn get_iscc_score_samples(&self, arguments: &Value) -> Result<Value> {
        let args: IsccScoreSamplesArgs = parse(arguments)?;
        if args.per_band == 0 || args.per_band > 4 {
            return Err(Error::Validation("per_band must be between 1 and 4".into()));
        }
        let band_number = (args.min_score * 10.0).round();
        if !args.min_score.is_finite()
            || !(3.0..=9.0).contains(&band_number)
            || (args.min_score * 10.0 - band_number).abs() > 0.000_001
        {
            return Err(Error::Validation(
                "min_score must be a 0.1 band boundary from 0.3 to 0.9".into(),
            ));
        }
        let record = self.store.get_search_query(&args.query_id)?;
        if record["run_id"] != args.run_id || record["source"] != "search_iscc" {
            return Err(Error::NotFound(format!(
                "ISCC search query not found in run: {}",
                args.query_id
            )));
        }
        let mut bands = record["results"]["score_bands"]
            .as_array()
            .cloned()
            .ok_or_else(|| Error::Internal("ISCC score samples are missing from history".into()))?;
        bands.retain(|band| {
            band["score_from_inclusive"]
                .as_f64()
                .is_some_and(|lower| lower + 0.000_001 >= args.min_score)
        });
        for band in &mut bands {
            if let Some(samples) = band["samples"].as_array_mut() {
                samples.truncate(args.per_band);
            }
        }
        Ok(json!({
            "run_id": args.run_id,
            "query_id": args.query_id,
            "query": record["query"],
            "min_score": args.min_score,
            "per_band": args.per_band,
            "score_bands": bands,
            "total_results_before_cutoff": record["results"]["result_count"],
            "usual_reference_cutoff": 0.45,
            "cutoff_applied": false,
        }))
    }

    async fn search_companies(&self, arguments: &Value, mid_only: bool) -> Result<Value> {
        let mut args: SearchCompaniesArgs = parse(arguments)?;
        validate_search_args(&args)?;
        if query_tokens(&args.query)?
            .iter()
            .any(|token| matches!(token, QueryToken::Not))
        {
            return Err(Error::Validation("discovery query exclusions require an approved core_business_exclusions profile; use exclude_keywords after approval".into()));
        }
        let mut identity = None;
        if args.mode != SearchMode::Lexical && args.query_vector.is_none() {
            let config = retrieval::RetrievalConfig::from_env()?;
            if config.embed_endpoint.is_some() {
                let adapter = LocalHttpAdapter::new(config)?;
                let vectors = adapter
                    .embed(&[format!("query: {}", args.query.trim())])
                    .await?;
                args.query_vector = vectors.into_iter().next();
                identity = Some(adapter.config().embedder.clone());
            } else if args.mode == SearchMode::Semantic {
                return Err(Error::ProviderUnavailable("semantic search requires the local embedding worker and a model-specific index; configure MNA_EMBED_ENDPOINT and rebuild_embedding_index".into()));
            }
        }
        // Discovery is a description query. Caller-side filters may describe
        // analyst criteria, but only approved core-business exclusions may
        // remove candidates from this funnel.
        let ignored = self.apply_discovery_policy(&mut args.filters, args.run_id.as_deref())?;
        let source;
        let mut result = if identity.is_none()
            && args.prefer_meilisearch
            && self.meili.is_some()
            && !has_local_only_filters(&args.filters)
            && !query_tokens(&args.query)?
                .iter()
                .any(|t| !matches!(t, QueryToken::Term(_)))
        {
            source = "meilisearch";
            self.search_meili(&args, mid_only).await?
        } else {
            source = "sqlite_local";
            self.search_local(&args, mid_only, identity.as_ref())?
        };
        result["search_scope"] = json!("qualitative_core_business");
        result["ignored_search_filters"] = json!(ignored);
        result["applied_core_business_exclusions"] = json!(args.filters.exclude_keywords);
        result["embedding_provenance"] = if let Some(identity) = &identity {
            json!({"identity":identity,"provenance":"local_http_worker","query_prefix":"query: "})
        } else if args.query_vector.is_some() {
            json!("caller_supplied_legacy_unverified")
        } else {
            json!("none")
        };
        if !ignored.is_empty() {
            result["criteria_notice"] = json!("Ignored criteria did not narrow discovery; only approved core-business exclusions were applied.");
        }
        if mid_only {
            result["discovery_source"] = json!("MID");
        }
        let record = self.store.record_search(
            args.run_id.as_deref(),
            if mid_only { "MID" } else { source },
            &args.query,
            arguments,
            &result,
        )?;
        attach_query_id(&mut result, &record);
        Ok(result)
    }

    fn apply_discovery_policy(
        &self,
        filters: &mut SearchFilters,
        run_id: Option<&str>,
    ) -> Result<Vec<String>> {
        let mut ignored: Vec<String> = ignored_non_business_filters(filters)
            .into_iter()
            .map(str::to_owned)
            .collect();
        if !filters.company_ids.is_empty() {
            ignored.push("company_ids".into());
        }
        if !filters.any_keywords.is_empty() {
            ignored.push("any_keywords".into());
        }
        if !filters.all_keywords.is_empty() {
            ignored.push("all_keywords".into());
        }
        filters.company_ids.clear();
        filters.any_keywords.clear();
        filters.all_keywords.clear();
        let approved = if let Some(run_id) = run_id {
            match self
                .store
                .execute("get_active_screening_profile", &json!({"run_id":run_id}))
            {
                Ok(profile) => profile["content"]["core_business_exclusions"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|v| v.as_str().map(|s| s.trim().to_lowercase()))
                    .collect::<HashSet<_>>(),
                Err(Error::NotFound(_)) => HashSet::new(),
                Err(error) => return Err(error),
            }
        } else {
            HashSet::new()
        };
        let original_count = filters.exclude_keywords.len();
        filters
            .exclude_keywords
            .retain(|keyword| approved.contains(&keyword.trim().to_lowercase()));
        if filters.exclude_keywords.len() != original_count {
            ignored.push("exclude_keywords_unapproved".into());
        }
        Ok(ignored)
    }

    fn search_local(
        &self,
        args: &SearchCompaniesArgs,
        mid_only: bool,
        identity: Option<&retrieval::ModelIdentity>,
    ) -> Result<Value> {
        let parsed_query = ParsedQuery::new(&args.query)?;
        let mut matches = BinaryHeap::<RankedHit>::new();
        let mut total = 0usize;
        let retain_count = args.offset.saturating_add(args.limit);
        let mut semantic_available = false;
        let visitor = |mut company: Value| {
            if mid_only && !is_mid_searchable(&company) {
                return Ok(());
            }
            if !matches_filters(&company, &args.filters) {
                return Ok(());
            }
            let searchable = searchable_text(&company);
            if parsed_query
                .expression
                .as_ref()
                .is_some_and(|expr| !expr.matches(&searchable))
            {
                return Ok(());
            }
            let lexical = lexical_score(&searchable, &parsed_query);
            if args.mode == SearchMode::Lexical && lexical.is_none() {
                return Ok(());
            }
            let semantic_value = args.query_vector.as_ref().and_then(|query_vector| {
                company_vector(&company).and_then(|vector| cosine_similarity(query_vector, &vector))
            });
            semantic_available |= semantic_value.is_some();
            if args.mode == SearchMode::Semantic && semantic_value.is_none() {
                return Ok(());
            }
            if args.mode == SearchMode::Hybrid
                && !args.query.trim().is_empty()
                && lexical.is_none()
                && semantic_value.is_none()
            {
                return Ok(());
            }
            let lexical = lexical.unwrap_or(0.0);
            let semantic = semantic_value.unwrap_or(0.0);
            let score = match args.mode {
                SearchMode::Lexical => lexical,
                SearchMode::Semantic => semantic,
                SearchMode::Hybrid => {
                    if args.query_vector.is_some() {
                        let (lexical_weight, semantic_weight) = effective_weights(args);
                        lexical * lexical_weight + semantic * semantic_weight
                    } else {
                        lexical
                    }
                }
            };
            total += 1;
            strip_embedding(&mut company);
            let hit = RankedHit(SearchHit {
                company,
                score,
                lexical_score: (args.mode != SearchMode::Semantic).then_some(lexical),
                semantic_score: semantic_value,
            });
            retain_ranked_hit(&mut matches, hit, retain_count);
            Ok(())
        };
        if let Some(identity) = identity {
            self.store.visit_embedding_companies(identity, visitor)?;
        } else {
            self.store
                .visit_companies(args.query_vector.is_some(), visitor)?;
        }
        if args.mode == SearchMode::Semantic && args.query_vector.is_none() {
            return Err(Error::Validation(
                "semantic mode requires query_vector; this service never fabricates embeddings"
                    .into(),
            ));
        }
        let results: Vec<Value> = matches
            .into_sorted_vec()
            .into_iter()
            .skip(args.offset)
            .take(args.limit)
            .enumerate()
            .map(|(index, hit)| hit.0.into_value(args.offset + index + 1, "sqlite_local"))
            .collect();
        Ok(json!({
            "source": "sqlite_local",
            "mode": args.mode.as_str(),
            "query": args.query,
            "total": total,
            "offset": args.offset,
            "results": results,
            "semantic_available": semantic_available,
            "vector_index_identity": identity.map(|i|json!(i)).unwrap_or(json!("legacy_unverified")),
            "semantic_index_has_coverage":semantic_available,
        }))
    }

    async fn search_meili(&self, args: &SearchCompaniesArgs, mid_only: bool) -> Result<Value> {
        let config = self
            .meili
            .as_ref()
            .ok_or_else(|| Error::ProviderUnavailable("Meilisearch is not configured".into()))?;
        if args.mode == SearchMode::Semantic && args.query_vector.is_none() {
            return Err(Error::Validation(
                "semantic mode requires query_vector; this service never fabricates embeddings"
                    .into(),
            ));
        }
        let mut payload = json!({
            "q": args.query,
            "limit": args.limit,
            "offset": args.offset,
            "showRankingScore": true,
            "attributesToRetrieve": ["*"],
        });
        let filter = meili_filter(&args.filters);
        if mid_only {
            payload["filter"] = Value::String(match filter {
                Some(filter) => format!("mid_searchable = true AND {filter}"),
                None => "mid_searchable = true".into(),
            });
        } else if let Some(filter) = filter {
            payload["filter"] = Value::String(filter);
        }
        if args.mode != SearchMode::Lexical {
            if let Some(vector) = &args.query_vector {
                validate_vector(vector)?;
                let embedder = config.embedder.as_deref().ok_or_else(|| {
                    Error::ProviderUnavailable(
                        "MNA_MEILI_EMBEDDER is required for vector or hybrid search".into(),
                    )
                })?;
                payload["vector"] = serde_json::to_value(vector)?;
                payload["hybrid"] = json!({
                    "semanticRatio": if args.mode == SearchMode::Semantic { 1.0 } else { effective_weights(args).1 },
                    "embedder": embedder,
                });
            }
        }
        let url = format!(
            "{}/indexes/{}/search",
            config.url,
            encode_path_segment(&config.index)
        );
        let response = self
            .meili_request(reqwest::Method::POST, &url)
            .json(&payload)
            .send()
            .await?;
        if !response.status().is_success() {
            let status = response.status();
            return Err(Error::ProviderUnavailable(format!(
                "Meilisearch returned HTTP {}",
                status.as_u16()
            )));
        }
        let raw = meili_json(response).await?;
        let hits = raw
            .get("hits")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| Error::ProviderUnavailable("Meilisearch omitted hits array".into()))?;
        let mut results = Vec::new();
        let mut stale_ids = Vec::new();
        for (index, company) in hits.into_iter().enumerate() {
            let score = company
                .get("_rankingScore")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let id = company_id_of(&company).ok_or_else(|| {
                Error::ProviderUnavailable("Meilisearch hit omitted company_id".into())
            })?;
            let mut canonical = match self.store.execute("get_company", &json!({"company_id":id})) {
                Ok(company) => company,
                Err(Error::NotFound(_)) => {
                    stale_ids.push(id.to_owned());
                    continue;
                }
                Err(error) => return Err(error),
            };
            strip_embedding(&mut canonical);
            results.push(json!({
                "rank": args.offset + index + 1,
                "score": score,
                "source": "meilisearch",
                "company": canonical,
            }));
        }
        Ok(json!({
            "source": "meilisearch",
            "mode": args.mode.as_str(),
            "query": args.query,
            "total": raw.get("estimatedTotalHits").cloned().unwrap_or(json!(results.len())),
            "offset": args.offset,
            "results": results,
            "semantic_available": args.query_vector.is_some(),
            "vector_index_identity": "legacy_unverified",
            "stale_index_company_ids": stale_ids,
        }))
    }

    fn find_company(&self, arguments: &Value) -> Result<Value> {
        let args: FindCompanyArgs = parse(arguments)?;
        if args.limit == 0 || args.limit > 100 {
            return Err(Error::Validation("limit must be between 1 and 100".into()));
        }
        let supplied = usize::from(args.company_id.is_some())
            + usize::from(args.ecid.is_some())
            + usize::from(args.cid.is_some())
            + usize::from(args.pbid.is_some())
            + usize::from(args.name.is_some())
            + usize::from(args.website.is_some())
            + usize::from(args.linkedin_url.is_some());
        if supplied != 1 {
            return Err(Error::Validation(
                "provide exactly one of company_id, ecid, cid, pbid, name, website, or linkedin_url".into(),
            ));
        }
        let query = args
            .company_id
            .as_deref()
            .or(args.ecid.as_deref())
            .or(args.cid.as_deref())
            .or(args.pbid.as_deref())
            .or(args.name.as_deref())
            .or(args.website.as_deref())
            .or(args.linkedin_url.as_deref())
            .unwrap();
        validate_short_string(query, "lookup", 500)?;
        if args.company_id.is_some()
            || args.ecid.is_some()
            || args.cid.is_some()
            || args.pbid.is_some()
        {
            let identifier = if args.ecid.is_some() {
                format!("ECID:{query}")
            } else if args.cid.is_some() {
                format!("CID:{query}")
            } else if args.pbid.is_some() {
                format!("PBID:{query}")
            } else {
                query.to_owned()
            };
            let canonical_id = self.store.resolve_company_id(&identifier)?;
            let mut company = self
                .store
                .execute("get_company", &json!({"company_id": canonical_id}))?;
            strip_embedding(&mut company);
            let mut result = json!({
                "query": query,
                "identifier_type": if args.ecid.is_some() {"ECID"} else if args.cid.is_some() {"CID"} else if args.pbid.is_some() {"PBID"} else {"PK"},
                "results": [{"exact":true,"company":company}],
                "total": 1,
            });
            let record = self.store.record_search(
                args.run_id.as_deref(),
                "sqlite_find_company",
                query,
                arguments,
                &result,
            )?;
            attach_query_id(&mut result, &record);
            return Ok(result);
        }
        let query_normalized = normalize_identity(query);
        let mut matches = Vec::new();
        let mut total = 0usize;
        self.store.visit_companies(false, |mut company| {
            let candidate = if args.name.is_some() {
                field_string(&company, &["name", "company_name"])
            } else if args.website.is_some() {
                field_string(&company, &["website", "website_url", "domain"])
            } else {
                field_string(&company, &["linkedin_url", "linkedin"])
            };
            if let Some(candidate) = candidate {
                let candidate_normalized = normalize_identity(candidate);
                let exact = candidate_normalized == query_normalized;
                let contains = candidate_normalized.contains(&query_normalized)
                    || query_normalized.contains(&candidate_normalized);
                if exact || contains {
                    total += 1;
                    strip_embedding(&mut company);
                    matches.push((exact, company));
                    matches.sort_by_key(|(exact, company)| {
                        (
                            !*exact,
                            field_string(company, &["name", "company_name"])
                                .unwrap_or_default()
                                .to_ascii_lowercase(),
                        )
                    });
                    matches.truncate(args.limit);
                }
            }
            Ok(())
        })?;
        let results: Vec<Value> = matches
            .into_iter()
            .map(|(exact, company)| json!({"exact": exact, "company": company}))
            .collect();
        let mut result = json!({"query": query, "results": results, "total": total});
        let record = self.store.record_search(
            args.run_id.as_deref(),
            "sqlite_find_company",
            query,
            arguments,
            &result,
        )?;
        attach_query_id(&mut result, &record);
        Ok(result)
    }

    fn find_similar(&self, arguments: &Value) -> Result<Value> {
        let mut args: FindSimilarArgs = parse(arguments)?;
        validate_limit(args.limit)?;
        validate_filters(&args.filters)?;
        let ignored = self.apply_discovery_policy(&mut args.filters, args.run_id.as_deref())?;
        if let Some(id) = &mut args.company_id {
            *id = self.store.resolve_company_id(id)?;
        }
        if usize::from(args.company_id.is_some()) + usize::from(args.query_vector.is_some()) != 1 {
            return Err(Error::Validation(
                "provide exactly one of company_id or query_vector".into(),
            ));
        }
        let config = retrieval::RetrievalConfig::from_env()?;
        let mut identity = None;
        let (vector, excluded_id) = if let Some(company_id) = &args.company_id {
            let company = self
                .store
                .execute("get_company", &json!({"company_id":company_id}))?;
            let current = self.store.model_embedding(&config.embedder, company_id)?;
            if config.embed_endpoint.is_some() && current.is_none() {
                return Err(Error::NotFound("example needs a current model-specific embedding; rebuild_embedding_index first".into()));
            }
            if current.is_some() {
                identity = Some(config.embedder.clone());
            }
            let vector = current
                .or_else(|| company_vector(&company))
                .ok_or_else(|| {
                    Error::NotFound(format!("company has no stored embedding: {company_id}"))
                })?;
            (vector, Some(company_id.as_str()))
        } else {
            let vector = args.query_vector.as_ref().unwrap();
            validate_vector(vector)?;
            (vector.clone(), None)
        };
        let results = rank_by_vector(
            &self.store,
            &vector,
            &args.filters,
            excluded_id.into_iter().collect(),
            args.limit,
            identity.as_ref(),
        )?;
        let mut result = json!({
            "source": "sqlite_stored_vectors",
            "discovery_source": "MID",
            "basis": if args.company_id.is_some() { "company_embedding" } else { "caller_vector" },
            "vector_index_identity":identity.as_ref().map(|i|json!(i)).unwrap_or(json!("legacy_unverified")),
            "results": results,
            "result_count": results.len(),
        });
        result["search_scope"] = json!("qualitative_core_business");
        result["ignored_search_filters"] = json!(ignored);
        result["applied_core_business_exclusions"] = json!(args.filters.exclude_keywords);
        let record = self.store.record_search(
            args.run_id.as_deref(),
            "sqlite_vector",
            args.company_id.as_deref().unwrap_or("caller_vector"),
            arguments,
            &result,
        )?;
        attach_query_id(&mut result, &record);
        Ok(result)
    }

    fn find_similar_examples(&self, arguments: &Value) -> Result<Value> {
        let mut args: FindSimilarExamplesArgs = parse(arguments)?;
        validate_limit(args.limit)?;
        validate_filters(&args.filters)?;
        let ignored = self.apply_discovery_policy(&mut args.filters, args.run_id.as_deref())?;
        for id in args
            .positive_company_ids
            .iter_mut()
            .chain(args.negative_company_ids.iter_mut())
        {
            *id = self.store.resolve_company_id(id)?;
        }
        if args.positive_company_ids.len() + args.positive_vectors.len() == 0 {
            return Err(Error::Validation(
                "at least one positive company or vector is required".into(),
            ));
        }
        if args.positive_company_ids.len()
            + args.negative_company_ids.len()
            + args.positive_vectors.len()
            + args.negative_vectors.len()
            > 200
        {
            return Err(Error::Validation("at most 200 examples are allowed".into()));
        }
        let mut positive = args.positive_vectors.clone();
        let mut negative = args.negative_vectors.clone();
        let config = retrieval::RetrievalConfig::from_env()?;
        let has_caller_vectors = !positive.is_empty() || !negative.is_empty();
        let mut selected_embeddings = HashMap::new();
        if !has_caller_vectors {
            for id in args
                .positive_company_ids
                .iter()
                .chain(&args.negative_company_ids)
            {
                if let Some(vector) = self.store.model_embedding(&config.embedder, id)? {
                    selected_embeddings.insert(id.clone(), vector);
                }
            }
        }
        let use_selected = !has_caller_vectors
            && selected_embeddings.len()
                == args
                    .positive_company_ids
                    .iter()
                    .chain(&args.negative_company_ids)
                    .collect::<HashSet<_>>()
                    .len();
        if !has_caller_vectors && config.embed_endpoint.is_some() && !use_selected {
            return Err(Error::NotFound("all examples need current model-specific embeddings; rebuild_embedding_index first".into()));
        }
        let identity = use_selected.then_some(&config.embedder);
        for (ids, destination, label) in [
            (&args.positive_company_ids, &mut positive, "positive"),
            (&args.negative_company_ids, &mut negative, "negative"),
        ] {
            for id in ids {
                let company = self
                    .store
                    .execute("get_company", &json!({"company_id":id}))
                    .map_err(|error| match error {
                        Error::NotFound(_) => {
                            Error::NotFound(format!("{label} company not found: {id}"))
                        }
                        other => other,
                    })?;
                let vector = if use_selected {
                    selected_embeddings.get(id).cloned()
                } else {
                    company_vector(&company)
                }
                .ok_or_else(|| {
                    Error::NotFound(format!("{label} company has no stored embedding: {id}"))
                })?;
                destination.push(vector);
            }
        }
        let target = positive_negative_centroid(&positive, &negative)?;
        let excluded: HashSet<&str> = args
            .positive_company_ids
            .iter()
            .chain(args.negative_company_ids.iter())
            .map(String::as_str)
            .collect();
        let results = rank_by_vector(
            &self.store,
            &target,
            &args.filters,
            excluded,
            args.limit,
            identity,
        )?;
        let mut result = json!({
            "source": "sqlite_stored_vectors",
            "discovery_source": "MID",
            "basis": "positive_negative_centroid",
            "vector_index_identity":identity.map(|i|json!(i)).unwrap_or(json!("legacy_unverified")),
            "positive_count": positive.len(),
            "negative_count": negative.len(),
            "dimensions": target.len(),
            "results": results,
            "result_count": results.len(),
        });
        result["search_scope"] = json!("qualitative_core_business");
        result["ignored_search_filters"] = json!(ignored);
        result["applied_core_business_exclusions"] = json!(args.filters.exclude_keywords);
        let record = self.store.record_search(
            args.run_id.as_deref(),
            "sqlite_centroid_vector",
            "positive-negative examples",
            arguments,
            &result,
        )?;
        attach_query_id(&mut result, &record);
        Ok(result)
    }

    async fn sync_search_index(&self, arguments: &Value) -> Result<Value> {
        let args: SyncIndexArgs = parse(arguments)?;
        if args.limit == 0 || args.limit > 1_000_000 {
            return Err(Error::Validation(
                "limit must be between 1 and 1000000".into(),
            ));
        }
        if args.batch_size == 0 || args.batch_size > 5_000 {
            return Err(Error::Validation(
                "batch_size must be between 1 and 5000".into(),
            ));
        }
        if args.task_timeout_secs == 0 || args.task_timeout_secs > 300 {
            return Err(Error::Validation(
                "task_timeout_secs must be between 1 and 300".into(),
            ));
        }
        let config = self
            .meili
            .as_ref()
            .ok_or_else(|| Error::ProviderUnavailable("Meilisearch is not configured".into()))?;
        let dimensions: HashSet<usize> = self
            .store
            .stored_embedding_dimensions()?
            .into_iter()
            .collect();
        if dimensions.len() > 1 {
            return Err(Error::Validation(
                "Meilisearch index vectors must have one consistent dimension".into(),
            ));
        }
        let index_url = format!(
            "{}/indexes/{}",
            config.url,
            encode_path_segment(&config.index)
        );
        let existing = self
            .meili_request(reqwest::Method::GET, &index_url)
            .send()
            .await?;
        let index_exists = existing.status().is_success();
        let index_key = format!("{}#{}", config.url, config.index);
        let hashes = if index_exists && !args.full_rebuild {
            self.store.index_hashes(&index_key)?
        } else {
            Default::default()
        };
        let setup_timeout = Duration::from_secs(args.task_timeout_secs);
        if existing.status() == reqwest::StatusCode::NOT_FOUND {
            let response = self
                .meili_request(reqwest::Method::POST, &format!("{}/indexes", config.url))
                .json(&json!({"uid":config.index,"primaryKey":"company_id"}))
                .send()
                .await?;
            let task = meili_json(response).await?;
            self.wait_for_meili_tasks(&[json!(checked_task_uid(&task)?)], setup_timeout)
                .await?;
        } else if !existing.status().is_success() {
            return Err(Error::ProviderUnavailable(format!(
                "Meilisearch index lookup returned HTTP {}",
                existing.status()
            )));
        }
        let mut settings = json!({
            "filterableAttributes":["company_id","mid_searchable"],
            "searchableAttributes":["description"],
        });
        if let (Some(embedder), Some(dimension)) =
            (config.embedder.as_deref(), dimensions.iter().next())
        {
            settings["embedders"] =
                json!({embedder:{"source":"userProvided","dimensions":dimension}});
        }
        let response = self
            .meili_request(reqwest::Method::PATCH, &format!("{index_url}/settings"))
            .json(&settings)
            .send()
            .await?;
        let settings_task = meili_json(response).await?;
        self.wait_for_meili_tasks(&[json!(checked_task_uid(&settings_task)?)], setup_timeout)
            .await?;
        let mut task_uids = Vec::new();
        let mut statuses = Vec::new();
        let mut scanned = 0usize;
        let mut submitted = 0usize;
        let mut after_id: Option<String> = None;
        let page_size = args.batch_size.min(500);
        while scanned < args.limit {
            let page = self
                .store
                .company_page_after(after_id.as_deref(), page_size.min(args.limit - scanned))?;
            if page.is_empty() {
                break;
            }
            scanned += page.len();
            after_id = page.last().and_then(company_id_of).map(ToOwned::to_owned);
            let mut documents = Vec::with_capacity(page.len());
            let mut records = Vec::with_capacity(page.len());
            for company in page {
                let document = meili_document(company, config.embedder.as_deref())?;
                let company_id = company_id_of(&document).unwrap_or_default().to_owned();
                let hash = document_hash(&document);
                if hashes.get(&company_id) != Some(&hash) {
                    documents.push(document);
                    records.push((company_id, hash));
                }
            }
            if documents.is_empty() {
                continue;
            }
            let url = format!(
                "{}/indexes/{}/documents?primaryKey=company_id",
                config.url,
                encode_path_segment(&config.index)
            );
            let response = self
                .meili_request(reqwest::Method::POST, &url)
                .json(&documents)
                .send()
                .await?;
            if !response.status().is_success() {
                let status = response.status();
                return Err(Error::ProviderUnavailable(format!(
                    "Meilisearch sync returned HTTP {}",
                    status.as_u16()
                )));
            }
            let body = meili_json(response).await?;
            let task_uid = json!(checked_task_uid(&body)?);
            if args.wait_for_completion {
                let batch_status = self
                    .wait_for_meili_tasks(
                        std::slice::from_ref(&task_uid),
                        Duration::from_secs(args.task_timeout_secs),
                    )
                    .await?;
                self.store.mark_indexed(&index_key, &records)?;
                statuses.extend(batch_status);
            }
            task_uids.push(task_uid);
            submitted += documents.len();
        }
        let completed = submitted == 0 || args.wait_for_completion;
        Ok(json!({
            "index": config.index,
            "companies_scanned": scanned,
            "documents_submitted": submitted,
            "batches": task_uids.len(),
            "task_uids": task_uids,
            "completed": completed,
            "unchanged": submitted == 0,
            "settings_verified": true,
            "task_statuses": statuses,
            "note": if submitted == 0 { "all scanned company documents are already indexed" } else if args.wait_for_completion { "task terminal states returned" } else { "Meilisearch indexes asynchronously; inspect task_uids for completion" },
        }))
    }

    fn meili_request(&self, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        let mut request = self.client.request(method, url);
        if let Some(key) = self
            .meili
            .as_ref()
            .and_then(|config| config.api_key.as_deref())
        {
            request = request.header(header::AUTHORIZATION, format!("Bearer {key}"));
        }
        request
    }

    async fn wait_for_meili_tasks(
        &self,
        task_uids: &[Value],
        timeout: Duration,
    ) -> Result<Vec<Value>> {
        let config = self
            .meili
            .as_ref()
            .expect("Meili configured before task wait");
        let deadline = tokio::time::Instant::now() + timeout;
        let mut pending: HashSet<u64> = task_uids.iter().filter_map(Value::as_u64).collect();
        let mut statuses = HashMap::new();
        while !pending.is_empty() {
            if tokio::time::Instant::now() >= deadline {
                return Err(Error::ProviderUnavailable(format!(
                    "timed out waiting for {} Meilisearch task(s)",
                    pending.len()
                )));
            }
            for uid in pending.clone() {
                let url = format!("{}/tasks/{uid}", config.url);
                let response = self
                    .meili_request(reqwest::Method::GET, &url)
                    .send()
                    .await?;
                if !response.status().is_success() {
                    return Err(Error::ProviderUnavailable(format!(
                        "Meilisearch task {uid} returned HTTP {}",
                        response.status().as_u16()
                    )));
                }
                let value = meili_json(response).await?;
                match value.get("status").and_then(Value::as_str) {
                    Some("succeeded") => {
                        pending.remove(&uid);
                        statuses.insert(uid, value);
                    }
                    Some("failed") | Some("canceled") => {
                        return Err(Error::ProviderUnavailable(format!(
                            "Meilisearch task {uid} ended with status {}: {}",
                            value["status"],
                            value.get("error").unwrap_or(&Value::Null)
                        )));
                    }
                    _ => {}
                }
            }
            if !pending.is_empty() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        let mut values: Vec<(u64, Value)> = statuses.into_iter().collect();
        values.sort_by_key(|(uid, _)| *uid);
        Ok(values.into_iter().map(|(_, value)| value).collect())
    }
}

struct SearchHit {
    company: Value,
    score: f64,
    lexical_score: Option<f64>,
    semantic_score: Option<f64>,
}

struct RankedHit(SearchHit);

impl PartialEq for RankedHit {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for RankedHit {}
impl PartialOrd for RankedHit {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for RankedHit {
    fn cmp(&self, other: &Self) -> Ordering {
        compare_hits(&self.0, &other.0)
    }
}

fn retain_ranked_hit(heap: &mut BinaryHeap<RankedHit>, hit: RankedHit, max_len: usize) {
    if max_len == 0 {
        return;
    }
    if heap.len() < max_len {
        heap.push(hit);
    } else if heap
        .peek()
        .is_some_and(|worst| hit.cmp(worst) == Ordering::Less)
    {
        heap.pop();
        heap.push(hit);
    }
}

fn strip_embedding(company: &mut Value) {
    if let Some(object) = company.as_object_mut() {
        object.remove("embedding");
        object.remove("_vectors");
    }
}

async fn meili_json(response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    if !status.is_success() {
        return Err(Error::ProviderUnavailable(format!(
            "Meilisearch returned HTTP {status}"
        )));
    }
    let body = crate::providers::read_bounded(response, 16_000_000).await?;
    serde_json::from_slice(&body)
        .map_err(|_| Error::ProviderUnavailable("Meilisearch returned invalid JSON".into()))
}

fn checked_task_uid(task: &Value) -> Result<u64> {
    task.get("taskUid")
        .and_then(Value::as_u64)
        .ok_or_else(|| Error::ProviderUnavailable("Meilisearch omitted taskUid".into()))
}

fn document_hash(document: &Value) -> String {
    format!("{:x}", Sha256::digest(document.to_string().as_bytes()))
}

fn meili_document(mut company: Value, embedder: Option<&str>) -> Result<Value> {
    let vector = company_vector(&company);
    let mid_searchable = is_mid_searchable(&company);
    let embedding_text = company["description"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let object = company
        .as_object_mut()
        .ok_or_else(|| Error::Internal("company must be an object".into()))?;
    object.remove("embedding");
    object.remove("_vectors");
    object.remove("created_at");
    object.remove("updated_at");
    object.insert("embedding_text".into(), json!(embedding_text));
    object.insert("mid_searchable".into(), json!(mid_searchable));
    if let (Some(embedder), Some(vector)) = (embedder, vector) {
        validate_vector(&vector)?;
        object.insert("_vectors".into(), json!({embedder:vector}));
    }
    Ok(company)
}

impl SearchHit {
    fn into_value(self, rank: usize, source: &str) -> Value {
        json!({
            "rank": rank,
            "score": self.score,
            "lexical_score": self.lexical_score,
            "semantic_score": self.semantic_score,
            "source": source,
            "company": self.company,
        })
    }
}

fn compare_hits(left: &SearchHit, right: &SearchHit) -> Ordering {
    right
        .score
        .partial_cmp(&left.score)
        .unwrap_or(Ordering::Equal)
        .then_with(|| company_id_of(&left.company).cmp(&company_id_of(&right.company)))
}

#[derive(Default, Debug)]
struct ParsedQuery {
    positive: Vec<String>,
    expression: Option<BooleanExpr>,
}

impl ParsedQuery {
    fn new(query: &str) -> Result<Self> {
        let tokens = query_tokens(query)?;
        if tokens.iter().all(|t| matches!(t, QueryToken::Term(_))) {
            return Ok(Self {
                positive: tokens
                    .into_iter()
                    .filter_map(|t| match t {
                        QueryToken::Term(term) => Some(term),
                        _ => None,
                    })
                    .collect(),
                expression: None,
            });
        }
        let mut parser = QueryParser {
            tokens: &tokens,
            position: 0,
        };
        let expression = parser.parse_or(0)?;
        if parser.position != tokens.len() {
            return Err(Error::Validation("Unexpected Boolean query token".into()));
        }
        let mut positive = Vec::new();
        expression.positive_terms(false, &mut positive);
        Ok(Self {
            positive,
            expression: Some(expression),
        })
    }
}

#[derive(Debug)]
enum BooleanExpr {
    Term(String),
    Not(Box<Self>),
    And(Box<Self>, Box<Self>),
    Or(Box<Self>, Box<Self>),
}
impl BooleanExpr {
    fn matches(&self, text: &str) -> bool {
        match self {
            Self::Term(term) => text.contains(term),
            Self::Not(child) => !child.matches(text),
            Self::And(a, b) => a.matches(text) && b.matches(text),
            Self::Or(a, b) => a.matches(text) || b.matches(text),
        }
    }
    fn positive_terms(&self, negated: bool, out: &mut Vec<String>) {
        match self {
            Self::Term(term) if !negated => out.push(term.clone()),
            Self::Not(child) => child.positive_terms(!negated, out),
            Self::And(a, b) | Self::Or(a, b) => {
                a.positive_terms(negated, out);
                b.positive_terms(negated, out);
            }
            _ => {}
        }
    }
}
#[derive(Debug)]
enum QueryToken {
    Term(String),
    And,
    Or,
    Not,
    Open,
    Close,
}
fn query_tokens(query: &str) -> Result<Vec<QueryToken>> {
    let mut tokens = Vec::new();
    let mut chars = query.chars().peekable();
    while let Some(character) = chars.next() {
        if character.is_whitespace() {
            continue;
        }
        let token = match character {
            '(' => QueryToken::Open,
            ')' => QueryToken::Close,
            '-' => QueryToken::Not,
            '"' => {
                let mut term = String::new();
                let mut closed = false;
                for c in chars.by_ref() {
                    if c == '"' {
                        closed = true;
                        break;
                    }
                    term.push(c);
                }
                if !closed || term.trim().is_empty() {
                    return Err(Error::Validation("Unclosed or empty quoted phrase".into()));
                }
                QueryToken::Term(term.to_lowercase())
            }
            _ => {
                let mut word = character.to_string();
                while chars
                    .peek()
                    .is_some_and(|c| !c.is_whitespace() && !matches!(c, '(' | ')' | '"'))
                {
                    word.push(chars.next().expect("peeked character"));
                }
                match word.to_ascii_uppercase().as_str() {
                    "AND" => QueryToken::And,
                    "OR" => QueryToken::Or,
                    "NOT" | "EXCLUDE" => QueryToken::Not,
                    _ => QueryToken::Term(normalize_token(&word)),
                }
            }
        };
        if matches!(&token, QueryToken::Term(t) if t.is_empty()) {
            continue;
        }
        tokens.push(token);
        if tokens.len() > 128 {
            return Err(Error::Validation(
                "Boolean query exceeds 128 terms/operators".into(),
            ));
        }
    }
    Ok(tokens)
}
struct QueryParser<'a> {
    tokens: &'a [QueryToken],
    position: usize,
}
impl QueryParser<'_> {
    fn parse_or(&mut self, depth: usize) -> Result<BooleanExpr> {
        let mut expression = self.parse_and(depth)?;
        while matches!(self.tokens.get(self.position), Some(QueryToken::Or)) {
            self.position += 1;
            expression = BooleanExpr::Or(Box::new(expression), Box::new(self.parse_and(depth)?));
        }
        Ok(expression)
    }
    fn parse_and(&mut self, depth: usize) -> Result<BooleanExpr> {
        let mut expression = self.parse_atom(depth)?;
        loop {
            if matches!(self.tokens.get(self.position), Some(QueryToken::And)) {
                self.position += 1;
            } else if !matches!(
                self.tokens.get(self.position),
                Some(QueryToken::Term(_) | QueryToken::Not | QueryToken::Open)
            ) {
                break;
            }
            expression = BooleanExpr::And(Box::new(expression), Box::new(self.parse_atom(depth)?));
        }
        Ok(expression)
    }
    fn parse_atom(&mut self, depth: usize) -> Result<BooleanExpr> {
        if depth > 32 {
            return Err(Error::Validation(
                "Boolean query nesting exceeds 32 levels".into(),
            ));
        }
        let token = self.tokens.get(self.position);
        self.position += 1;
        match token {
            Some(QueryToken::Term(term)) => Ok(BooleanExpr::Term(term.clone())),
            Some(QueryToken::Not) => Ok(BooleanExpr::Not(Box::new(self.parse_atom(depth + 1)?))),
            Some(QueryToken::Open) => {
                let expression = self.parse_or(depth + 1)?;
                if !matches!(self.tokens.get(self.position), Some(QueryToken::Close)) {
                    return Err(Error::Validation("Unbalanced Boolean parentheses".into()));
                }
                self.position += 1;
                Ok(expression)
            }
            _ => Err(Error::Validation(
                "Boolean query expected a term or group".into(),
            )),
        }
    }
}

fn lexical_score(text: &str, query: &ParsedQuery) -> Option<f64> {
    let text = text.to_lowercase();
    if query
        .expression
        .as_ref()
        .is_some_and(|expression| !expression.matches(&text))
    {
        return None;
    }
    if query.positive.is_empty() {
        return Some(1.0);
    }
    let matched = query
        .positive
        .iter()
        .filter(|term| text.contains(term.as_str()))
        .count();
    if matched == 0 && query.expression.is_none() {
        return None;
    }
    Some(matched as f64 / query.positive.len() as f64)
}

fn searchable_text(company: &Value) -> String {
    let mut values = Vec::new();
    if let Some(value) = company.get("description") {
        collect_strings(value, &mut values);
    }
    values.join(" ").to_lowercase()
}

fn is_mid_searchable(company: &Value) -> bool {
    let source = company
        .pointer("/metadata/preferred_source")
        .or_else(|| company.pointer("/metadata/source"))
        .and_then(Value::as_str);
    !source.is_some_and(|source| source.eq_ignore_ascii_case("ISCC"))
}

fn collect_strings<'a>(value: &'a Value, output: &mut Vec<&'a str>) {
    match value {
        Value::String(value) => output.push(value),
        Value::Array(values) => {
            for value in values {
                collect_strings(value, output);
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                collect_strings(value, output);
            }
        }
        _ => {}
    }
}

fn matches_filters(company: &Value, filters: &SearchFilters) -> bool {
    if !filters.company_ids.is_empty()
        && !company_id_of(company)
            .is_some_and(|id| filters.company_ids.iter().any(|item| item == id))
    {
        return false;
    }
    let text = searchable_text(company);
    if !filters.any_keywords.is_empty()
        && !filters
            .any_keywords
            .iter()
            .any(|word| text.contains(&word.to_lowercase()))
    {
        return false;
    }
    if !filters
        .all_keywords
        .iter()
        .all(|word| text.contains(&word.to_lowercase()))
    {
        return false;
    }
    if filters
        .exclude_keywords
        .iter()
        .any(|word| text.contains(&word.to_lowercase()))
    {
        return false;
    }
    true
}

fn ignored_non_business_filters(filters: &SearchFilters) -> Vec<&'static str> {
    let mut ignored = Vec::new();
    if !filters.country.is_empty() {
        ignored.push("country");
    }
    if filters.city.is_some() {
        ignored.push("city");
    }
    if filters.industry.is_some() {
        ignored.push("industry");
    }
    if filters.sub_industry.is_some() {
        ignored.push("sub_industry");
    }
    if filters.ownership.is_some() {
        ignored.push("ownership");
    }
    if !filters.exclude_industries.is_empty() {
        ignored.push("exclude_industries");
    }
    if filters.revenue_min.is_some() {
        ignored.push("revenue_min");
    }
    if filters.revenue_max.is_some() {
        ignored.push("revenue_max");
    }
    if filters.employees_min.is_some() {
        ignored.push("employees_min");
    }
    if filters.employees_max.is_some() {
        ignored.push("employees_max");
    }
    ignored
}

fn has_local_only_filters(filters: &SearchFilters) -> bool {
    !filters.any_keywords.is_empty()
        || !filters.all_keywords.is_empty()
        || !filters.exclude_keywords.is_empty()
}

fn validate_search_args(args: &SearchCompaniesArgs) -> Result<()> {
    if args.query.trim().is_empty() || args.query.len() > MAX_QUERY_CHARS {
        return Err(Error::Validation(format!(
            "query must contain 1 to {MAX_QUERY_CHARS} characters"
        )));
    }
    validate_limit(args.limit)?;
    if args.offset > 1_000_000 {
        return Err(Error::Validation("offset must be at most 1000000".into()));
    }
    validate_filters(&args.filters)?;
    if let Some(vector) = &args.query_vector {
        validate_vector(vector)?;
    }
    if args.mode == SearchMode::Hybrid {
        let (lexical_weight, semantic_weight) = effective_weights(args);
        if !lexical_weight.is_finite()
            || !semantic_weight.is_finite()
            || lexical_weight < 0.0
            || semantic_weight < 0.0
            || (lexical_weight + semantic_weight - 1.0).abs() > 0.000_001
        {
            return Err(Error::Validation(
                "hybrid weights must be finite, non-negative, and sum to 1".into(),
            ));
        }
    }
    Ok(())
}

fn effective_weights(args: &SearchCompaniesArgs) -> (f64, f64) {
    if let Some(semantic_ratio) = args.semantic_ratio {
        (1.0 - semantic_ratio, semantic_ratio)
    } else {
        (args.lexical_weight, args.semantic_weight)
    }
}

fn deserialize_string_or_vec<'de, D>(deserializer: D) -> std::result::Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StringOrVec {
        One(String),
        Many(Vec<String>),
    }
    Ok(match StringOrVec::deserialize(deserializer)? {
        StringOrVec::One(value) => vec![value],
        StringOrVec::Many(values) => values,
    })
}

fn attach_query_id(result: &mut Value, record: &Value) {
    if let (Some(object), Some(query_id)) = (result.as_object_mut(), record.get("query_id")) {
        object.insert("query_id".into(), query_id.clone());
    }
}

fn validate_limit(limit: usize) -> Result<()> {
    if limit == 0 || limit > MAX_LIMIT {
        return Err(Error::Validation(format!(
            "limit must be between 1 and {MAX_LIMIT}"
        )));
    }
    Ok(())
}

fn validate_filters(filters: &SearchFilters) -> Result<()> {
    if filters.company_ids.len() > 10_000
        || filters.any_keywords.len() > 100
        || filters.all_keywords.len() > 100
        || filters.exclude_keywords.len() > 100
    {
        return Err(Error::Validation("filter list is too large".into()));
    }
    for value in filters
        .company_ids
        .iter()
        .chain(filters.any_keywords.iter())
        .chain(filters.all_keywords.iter())
        .chain(filters.exclude_keywords.iter())
    {
        validate_short_string(value, "filter value", 500)?;
    }
    Ok(())
}

fn validate_short_string(value: &str, label: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max {
        return Err(Error::Validation(format!(
            "{label} must contain 1 to {max} characters"
        )));
    }
    Ok(())
}

fn validate_vector(vector: &[f32]) -> Result<()> {
    if vector.is_empty()
        || vector.len() > MAX_VECTOR_DIMENSIONS
        || vector.iter().any(|v| !v.is_finite())
    {
        return Err(Error::Validation(format!(
            "vectors must have 1 to {MAX_VECTOR_DIMENSIONS} finite components"
        )));
    }
    if vector.iter().all(|value| *value == 0.0) {
        return Err(Error::Validation(
            "vectors must have non-zero magnitude".into(),
        ));
    }
    Ok(())
}

fn company_vector(company: &Value) -> Option<Vec<f32>> {
    if let Some(vector) = company.get("embedding").and_then(Value::as_array) {
        return json_vector(vector);
    }
    if let Some(vectors) = company.get("_vectors").and_then(Value::as_object) {
        for value in vectors.values() {
            if let Some(array) = value.as_array() {
                return json_vector(array);
            }
            if let Some(array) = value.get("embeddings").and_then(Value::as_array) {
                if let Some(first) = array.first().and_then(Value::as_array) {
                    return json_vector(first);
                }
            }
        }
    }
    None
}

fn json_vector(vector: &[Value]) -> Option<Vec<f32>> {
    let values: Vec<f32> = vector
        .iter()
        .map(|value| value.as_f64().map(|number| number as f32))
        .collect::<Option<_>>()?;
    validate_vector(&values).ok()?;
    Some(values)
}

fn cosine_similarity_f32(left: &[f32], right: &[f32]) -> Option<f64> {
    if left.len() != right.len() {
        return None;
    }
    let mut dot = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;
    for (left, right) in left.iter().zip(right.iter()) {
        let left = *left as f64;
        let right = *right as f64;
        dot += left * right;
        left_norm += left * left;
        right_norm += right * right;
    }
    if left_norm == 0.0 || right_norm == 0.0 {
        None
    } else {
        Some(dot / (left_norm.sqrt() * right_norm.sqrt()))
    }
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> Option<f64> {
    cosine_similarity_f32(left, right)
}

fn positive_negative_centroid(positive: &[Vec<f32>], negative: &[Vec<f32>]) -> Result<Vec<f32>> {
    for vector in positive.iter().chain(negative.iter()) {
        validate_vector(vector)?;
    }
    let dimensions = positive
        .first()
        .map(Vec::len)
        .ok_or_else(|| Error::Validation("at least one positive vector is required".into()))?;
    if positive
        .iter()
        .chain(negative.iter())
        .any(|vector| vector.len() != dimensions)
    {
        return Err(Error::Validation(
            "all example vectors must have the same dimensions".into(),
        ));
    }
    let mut output = vec![0.0f32; dimensions];
    for vector in positive {
        for (target, value) in output.iter_mut().zip(vector) {
            *target += *value / positive.len() as f32;
        }
    }
    if !negative.is_empty() {
        for vector in negative {
            for (target, value) in output.iter_mut().zip(vector) {
                *target -= *value / negative.len() as f32;
            }
        }
    }
    validate_vector(&output)?;
    Ok(output)
}

fn rank_by_vector(
    store: &Store,
    vector: &[f32],
    filters: &SearchFilters,
    excluded: HashSet<&str>,
    limit: usize,
    identity: Option<&retrieval::ModelIdentity>,
) -> Result<Vec<Value>> {
    let mut scores = BinaryHeap::<RankedHit>::new();
    let visitor = |mut company: Value| {
        if !is_mid_searchable(&company)
            || !matches_filters(&company, filters)
            || company_id_of(&company).is_some_and(|id| excluded.contains(id))
        {
            return Ok(());
        }
        let Some(score) = company_vector(&company)
            .and_then(|candidate| cosine_similarity_f32(vector, &candidate))
        else {
            return Ok(());
        };
        strip_embedding(&mut company);
        retain_ranked_hit(
            &mut scores,
            RankedHit(SearchHit {
                company,
                score,
                lexical_score: None,
                semantic_score: Some(score),
            }),
            limit,
        );
        Ok(())
    };
    if let Some(identity) = identity {
        store.visit_embedding_companies(identity, visitor)?;
    } else {
        store.visit_companies(true, visitor)?;
    }
    Ok(scores
        .into_sorted_vec()
        .into_iter()
        .enumerate()
        .map(|(index, hit)| {
            json!({
                "rank": index + 1,
                "score": hit.0.score,
                "source": "sqlite_stored_vectors",
                "company": hit.0.company,
            })
        })
        .collect())
}

fn field_string<'a>(company: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| company.get(*key).and_then(Value::as_str))
}

fn company_id_of(company: &Value) -> Option<&str> {
    field_string(company, &["company_id", "id"])
}

fn normalize_identity(value: &str) -> String {
    value
        .trim()
        .trim_end_matches('/')
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("www.")
        .to_ascii_lowercase()
}

fn normalize_token(value: &str) -> String {
    value
        .trim_matches(|character: char| !character.is_alphanumeric())
        .to_lowercase()
}

fn meili_filter(filters: &SearchFilters) -> Option<String> {
    let mut conditions = Vec::new();
    if !filters.company_ids.is_empty() {
        conditions.push(format!(
            "company_id IN [{}]",
            filters
                .company_ids
                .iter()
                .map(|value| format!("'{}'", meili_escape(value)))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    (!conditions.is_empty()).then(|| conditions.join(" AND "))
}

fn meili_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

fn encode_path_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn parse<T: DeserializeOwned>(arguments: &Value) -> Result<T> {
    serde_json::from_value(arguments.clone()).map_err(|error| Error::Validation(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_boolean_expressions_respect_precedence_phrases_and_exclusion() {
        let query = ParsedQuery::new(
            "insurance AND (SaaS OR \"policy administration\") AND NOT consulting",
        )
        .unwrap();
        assert!(lexical_score("insurance policy administration platform", &query).is_some());
        assert!(lexical_score("insurance SaaS software", &query).is_some());
        assert!(lexical_score("insurance SaaS consulting", &query).is_none());
        assert!(lexical_score("policy administration", &query).is_none());
        let conditional = ParsedQuery::new("insurance OR NOT consulting").unwrap();
        assert!(lexical_score("insurance consulting", &conditional).is_some());
        assert!(ParsedQuery::new("insurance AND (").is_err());
        assert!(ParsedQuery::new("insurance OR").is_err());
    }

    #[test]
    fn meili_projection_uses_user_provided_vectors_and_normalized_text() {
        let document = meili_document(json!({"company_id":"C1","name":"Policy Suite","description":"Carrier SaaS","embedding":[1.0,0.0],"products":["claims"]}), Some("company_embedding")).unwrap();
        assert!(document.get("embedding").is_none());
        assert_eq!(document["_vectors"]["company_embedding"], json!([1.0, 0.0]));
        assert!(document["embedding_text"]
            .as_str()
            .unwrap()
            .contains("Carrier SaaS"));
        assert!(checked_task_uid(&json!({"accepted":true})).is_err());
    }

    #[tokio::test]
    async fn meili_mock_verifies_sync_tasks_incremental_hashes_and_canonical_results() {
        use axum::{
            extract::State,
            http::StatusCode,
            routing::{get, post},
            Json, Router,
        };
        use std::sync::{Arc, Mutex};
        let captured = Arc::new(Mutex::new(
            json!({"created":false,"documents":[],"settings":{}}),
        ));
        let app = Router::new()
            .route("/indexes/companies", get(|State(state):State<Arc<Mutex<Value>>>| async move { if state.lock().unwrap()["created"] == true { StatusCode::OK } else { StatusCode::NOT_FOUND } }))
            .route("/indexes", post(|State(state):State<Arc<Mutex<Value>>>| async move { state.lock().unwrap()["created"]=json!(true); Json(json!({"taskUid":1})) }))
            .route("/indexes/companies/settings", axum::routing::patch(|State(state):State<Arc<Mutex<Value>>>,Json(payload):Json<Value>| async move {state.lock().unwrap()["settings"]=payload; Json(json!({"taskUid":2}))}))
            .route("/indexes/companies/documents", post(|State(state):State<Arc<Mutex<Value>>>,Json(payload):Json<Value>| async move {state.lock().unwrap()["documents"]=payload; Json(json!({"taskUid":3}))}))
            .route("/tasks/{uid}", get(|| async {Json(json!({"status":"succeeded"}))}))
            .route("/indexes/companies/search", post(|| async {Json(json!({"hits":[{"company_id":"C1","name":"Stale index name","_rankingScore":0.9}],"estimatedTotalHits":1}))}))
            .with_state(captured.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let store = Store::open(":memory:").unwrap();
        store.execute("ingest_companies", &json!({"companies":[{"company_id":"C1","name":"Canonical Company","country":"India","embedding":[1.0,0.0]}]})).unwrap();
        let mut engine = SearchEngine::new(store).unwrap();
        engine.meili = Some(MeiliConfig {
            url: format!("http://{address}"),
            api_key: None,
            index: "companies".into(),
            embedder: Some("company_embedding".into()),
        });
        let synced = engine
            .execute("sync_search_index", &json!({}))
            .await
            .unwrap();
        assert_eq!(synced["completed"], true);
        assert_eq!(synced["documents_submitted"], 1);
        assert_eq!(
            captured.lock().unwrap()["documents"][0]["_vectors"]["company_embedding"],
            json!([1.0, 0.0])
        );
        assert_eq!(
            captured.lock().unwrap()["settings"]["embedders"]["company_embedding"]["source"],
            "userProvided"
        );
        assert_eq!(
            engine
                .execute("sync_search_index", &json!({}))
                .await
                .unwrap()["documents_submitted"],
            0
        );
        assert_eq!(
            engine
                .execute("sync_search_index", &json!({"full_rebuild":true}))
                .await
                .unwrap()["documents_submitted"],
            1
        );
        let search = engine
            .execute(
                "search_companies",
                &json!({"query":"company","mode":"lexical"}),
            )
            .await
            .unwrap();
        assert_eq!(search["results"][0]["company"]["name"], "Canonical Company");
        assert!(search["query_id"].is_string());
        server.abort();
    }

    #[test]
    fn qualitative_filters_ignore_structured_fields_and_use_business_keywords() {
        let company = json!({
            "company_id":"C1", "country":"India", "industry":"Software",
            "revenue": 125.0, "employees": 20,
            "description":"Claims automation for insurance carriers"
        });
        let filters = SearchFilters {
            country: vec!["france".into()],
            industry: Some("Retail".into()),
            revenue_min: Some(9999.0),
            employees_max: Some(1),
            all_keywords: vec!["claims".into(), "insurance".into()],
            exclude_keywords: vec!["consulting".into()],
            ..SearchFilters::default()
        };
        assert!(matches_filters(&company, &filters));
        assert_eq!(
            ignored_non_business_filters(&filters),
            vec!["country", "industry", "revenue_min", "employees_max"]
        );
        assert!(!searchable_text(&company).contains("software"));
        let excluded = SearchFilters {
            exclude_keywords: vec!["automation".into()],
            ..filters
        };
        assert!(!matches_filters(&company, &excluded));
    }

    #[test]
    fn boolean_lexical_query_honors_and_and_not() {
        let query = ParsedQuery::new("insurance AND software NOT consulting").unwrap();
        assert!(lexical_score("insurance software platform", &query).is_some());
        assert!(lexical_score("insurance services", &query).is_none());
        assert!(lexical_score("insurance software consulting", &query).is_none());
    }

    #[test]
    fn centroid_subtracts_negative_examples() {
        let target =
            positive_negative_centroid(&[vec![1.0, 1.0], vec![3.0, 1.0]], &[vec![1.0, 2.0]])
                .unwrap();
        assert_eq!(target, vec![1.0, -1.0]);
    }

    #[test]
    fn cosine_rejects_dimension_mismatch() {
        assert!(cosine_similarity(&[1.0, 0.0], &[1.0]).is_none());
        let score = cosine_similarity(&[1.0, 0.0], &[1.0, 0.0]).unwrap();
        assert!((score - 1.0).abs() < 1e-9);
    }

    #[test]
    fn meili_filter_only_uses_explicit_company_ids() {
        let filters = SearchFilters {
            country: vec!["Cote d'Ivoire".into()],
            revenue_min: Some(10.0),
            company_ids: vec!["X-ABC'1".into()],
            ..SearchFilters::default()
        };
        let filter = meili_filter(&filters).unwrap();
        assert_eq!(filter, "company_id IN ['X-ABC\\'1']");
    }

    #[test]
    fn dto_rejects_unknown_fields_and_bad_weights() {
        let parsed: std::result::Result<SearchCompaniesArgs, _> = serde_json::from_value(json!({
            "query":"test", "bogus": true
        }));
        assert!(parsed.is_err());
        let args: SearchCompaniesArgs = serde_json::from_value(json!({
            "query":"test", "lexical_weight":0.8, "semantic_weight":0.8
        }))
        .unwrap();
        assert!(validate_search_args(&args).is_err());
    }
}
