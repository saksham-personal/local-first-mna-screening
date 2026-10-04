//! Local inference contracts. A worker is responsible for tokenization and ONNX execution.
//! This module validates identity and output; it never synthesizes vectors or scores.
use crate::error::{Error, Result};
use futures_util::StreamExt;
use reqwest::Client;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;
use url::Url;

pub fn document_text(company: &Value) -> String {
    company["description"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_owned()
}
pub fn text_hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub const DEFAULT_MODEL: &str = "Snowflake/snowflake-arctic-embed-m-v2.0";
pub const DEFAULT_VERSION: &str = "v2.0-int8-onnx";
pub const DEFAULT_DIMENSIONS: usize = 768;
pub const MAX_RERANK: usize = 500;
pub const MAX_CANDIDATES: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelIdentity {
    pub model: String,
    pub version: String,
    pub dimensions: usize,
}

impl ModelIdentity {
    pub fn from_env() -> Result<Self> {
        let identity = Self {
            model: std::env::var("MNA_EMBED_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into()),
            version: std::env::var("MNA_EMBED_VERSION").unwrap_or_else(|_| DEFAULT_VERSION.into()),
            dimensions: std::env::var("MNA_EMBED_DIMENSIONS")
                .ok()
                .map(|v| v.parse::<usize>())
                .transpose()
                .map_err(|_| Error::Validation("MNA_EMBED_DIMENSIONS must be an integer".into()))?
                .unwrap_or(DEFAULT_DIMENSIONS),
        };
        if identity.model.trim().is_empty()
            || identity.version.trim().is_empty()
            || !(1..=4096).contains(&identity.dimensions)
        {
            return Err(Error::Validation(
                "embedding model, version and 1..=4096 dimensions are required".into(),
            ));
        }
        Ok(identity)
    }
}

#[derive(Debug, Clone)]
pub struct RetrievalConfig {
    pub embedder: ModelIdentity,
    pub embed_endpoint: Option<String>,
    pub rerank_model: Option<String>,
    pub rerank_version: Option<String>,
    pub rerank_endpoint: Option<String>,
}

impl RetrievalConfig {
    pub fn from_env() -> Result<Self> {
        let embed_endpoint = endpoint_env("MNA_EMBED_ENDPOINT")?;
        let rerank_endpoint = endpoint_env("MNA_RERANK_ENDPOINT")?;
        let rerank_model = std::env::var("MNA_RERANK_MODEL")
            .ok()
            .filter(|v| !v.trim().is_empty());
        let rerank_version = std::env::var("MNA_RERANK_VERSION")
            .ok()
            .filter(|v| !v.trim().is_empty());
        Ok(Self {
            embedder: ModelIdentity::from_env()?,
            embed_endpoint,
            rerank_model,
            rerank_version,
            rerank_endpoint,
        })
    }

    pub fn status(&self) -> Value {
        json!({
            "discovery_limit_default":1000,"discovery_limit_max":1000,
            "rerank_first":MAX_RERANK,"candidate_membership_preserved":true,
            "embedder":{"identity":self.embedder,"adapter":"localhost_http",
                "status":if self.embed_endpoint.is_some() {"configured_but_unverified"} else {"planned"},
                "endpoint_configured":self.embed_endpoint.is_some(),"executed":false},
            "reranker":{"model":self.rerank_model,"version":self.rerank_version,
                "adapter":"localhost_http","status":if self.rerank_endpoint.is_some() && self.rerank_model.is_some() && self.rerank_version.is_some() {"configured_but_unverified"} else {"planned"},
                "endpoint_configured":self.rerank_endpoint.is_some(),"executed":false},
            "stored_vectors":{"status":"implemented","model_identity_verified":true,
                "storage":"model_version_text_hash_keyed_float32","legacy_vectors":"unverified_and_separate"},
        })
    }
}

fn endpoint_env(key: &str) -> Result<Option<String>> {
    let Some(raw) = std::env::var(key).ok().filter(|v| !v.trim().is_empty()) else {
        return Ok(None);
    };
    let url = Url::parse(&raw)
        .map_err(|_| Error::Validation(format!("{key} must be a localhost HTTP URL")))?;
    if url.scheme() != "http"
        || !matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        )
        || url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::Validation(format!(
            "{key} must be a localhost HTTP URL without credentials"
        )));
    }
    Ok(Some(raw))
}

pub fn validate_vector(vector: &[f32], identity: &ModelIdentity) -> Result<()> {
    if vector.len() != identity.dimensions || vector.iter().any(|value| !value.is_finite()) {
        return Err(Error::Validation(format!(
            "embedding quarantined: expected {} finite dimensions for {}@{}",
            identity.dimensions, identity.model, identity.version
        )));
    }
    let norm = vector
        .iter()
        .map(|v| (*v as f64) * (*v as f64))
        .sum::<f64>()
        .sqrt();
    if !norm.is_finite() || norm <= f64::EPSILON {
        return Err(Error::Validation(
            "embedding quarantined: zero or invalid norm".into(),
        ));
    }
    Ok(())
}

pub fn validate_identity(actual: &ModelIdentity, expected: &ModelIdentity) -> Result<()> {
    if actual != expected {
        return Err(Error::Conflict(format!("embedding quarantined: worker model identity {}@{} ({}D) differs from selected {}@{} ({}D)", actual.model, actual.version, actual.dimensions, expected.model, expected.version, expected.dimensions)));
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RerankCandidate {
    pub company_id: String,
    pub description: String,
    pub source: String,
    #[serde(default)]
    pub retrieval_score: Option<f64>,
    #[serde(default)]
    pub query_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RerankArgs {
    #[serde(default)]
    pub run_id: Option<String>,
    pub query: String,
    pub candidates: Vec<RerankCandidate>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EmbedArgs {
    pub texts: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct EmbedResponse {
    model: String,
    version: String,
    dimensions: usize,
    vectors: Vec<Vec<f32>>,
}

#[derive(Debug, Deserialize)]
struct RerankResponse {
    model: String,
    version: String,
    results: Vec<RerankResult>,
}

#[derive(Debug, Deserialize)]
struct RerankResult {
    company_id: String,
    score: f64,
}

pub type AdapterFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;
pub trait Embedder: Send + Sync {
    fn embed<'a>(&'a self, texts: &'a [String]) -> AdapterFuture<'a, Vec<Vec<f32>>>;
}
pub trait Reranker: Send + Sync {
    fn rerank<'a>(
        &'a self,
        query: &'a str,
        candidates: &'a [RerankCandidate],
    ) -> AdapterFuture<'a, Vec<(String, f64)>>;
}

#[derive(Clone)]
pub struct LocalHttpAdapter {
    client: Client,
    config: RetrievalConfig,
}

impl LocalHttpAdapter {
    pub fn new(config: RetrievalConfig) -> Result<Self> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(Self { client, config })
    }

    pub fn config(&self) -> &RetrievalConfig {
        &self.config
    }
}

async fn worker_json<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> Result<T> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err(Error::ProviderUnavailable(
                "local model response exceeds 4 MB".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| Error::ProviderUnavailable("local model worker returned invalid JSON".into()))
}

impl Embedder for LocalHttpAdapter {
    fn embed<'a>(&'a self, texts: &'a [String]) -> AdapterFuture<'a, Vec<Vec<f32>>> {
        Box::pin(async move {
            let endpoint = self.config.embed_endpoint.as_ref().ok_or_else(|| {
                Error::ProviderUnavailable(
                    "local embedder is not configured; set MNA_EMBED_ENDPOINT".into(),
                )
            })?;
            if texts.is_empty()
                || texts.len() > 32
                || texts
                    .iter()
                    .any(|text| text.trim().is_empty() || text.len() > 16_000)
            {
                return Err(Error::Validation(
                    "embed_texts requires 1..=32 nonempty texts of at most 16000 bytes".into(),
                ));
            }
            let response = self.client.post(endpoint).json(&json!({"model":self.config.embedder.model,"version":self.config.embedder.version,"dimensions":self.config.embedder.dimensions,"texts":texts})).send().await?;
            if !response.status().is_success() {
                return Err(Error::ProviderUnavailable(format!(
                    "local embedder returned HTTP {}",
                    response.status().as_u16()
                )));
            }
            let payload: EmbedResponse = worker_json(response).await?;
            validate_identity(
                &ModelIdentity {
                    model: payload.model,
                    version: payload.version,
                    dimensions: payload.dimensions,
                },
                &self.config.embedder,
            )?;
            if payload.vectors.len() != texts.len() {
                return Err(Error::ProviderUnavailable(
                    "local embedder returned wrong vector count".into(),
                ));
            }
            for vector in &payload.vectors {
                validate_vector(vector, &self.config.embedder)?;
            }
            Ok(payload.vectors)
        })
    }
}

impl Reranker for LocalHttpAdapter {
    fn rerank<'a>(
        &'a self,
        query: &'a str,
        candidates: &'a [RerankCandidate],
    ) -> AdapterFuture<'a, Vec<(String, f64)>> {
        Box::pin(async move {
            let endpoint = self.config.rerank_endpoint.as_ref().ok_or_else(|| {
                Error::ProviderUnavailable(
                    "local reranker is not configured; set MNA_RERANK_ENDPOINT".into(),
                )
            })?;
            let model = self.config.rerank_model.as_ref().ok_or_else(|| {
                Error::ProviderUnavailable(
                    "local reranker model is not configured; set MNA_RERANK_MODEL".into(),
                )
            })?;
            let version = self.config.rerank_version.as_ref().ok_or_else(|| {
                Error::ProviderUnavailable(
                    "local reranker version is not configured; set MNA_RERANK_VERSION".into(),
                )
            })?;
            let response = self
                .client
                .post(endpoint)
                .json(
                    &json!({"model":model,"version":version,"query":query,"candidates":candidates}),
                )
                .send()
                .await?;
            if !response.status().is_success() {
                return Err(Error::ProviderUnavailable(format!(
                    "local reranker returned HTTP {}",
                    response.status().as_u16()
                )));
            }
            let payload: RerankResponse = worker_json(response).await?;
            if payload.model != *model || payload.version != *version {
                return Err(Error::Conflict(
                    "reranker response model/version differs from selected model".into(),
                ));
            }
            validate_rerank_results(candidates, &payload.results)?;
            Ok(payload
                .results
                .into_iter()
                .map(|r| (r.company_id, r.score))
                .collect())
        })
    }
}

fn validate_rerank_results(candidates: &[RerankCandidate], ranked: &[RerankResult]) -> Result<()> {
    if candidates.len() != ranked.len() {
        return Err(Error::ProviderUnavailable(
            "reranker must return every input candidate exactly once".into(),
        ));
    }
    let expected: HashSet<_> = candidates.iter().map(|c| c.company_id.as_str()).collect();
    let mut observed = HashSet::new();
    for result in ranked {
        if !result.score.is_finite()
            || !expected.contains(result.company_id.as_str())
            || !observed.insert(result.company_id.as_str())
        {
            return Err(Error::ProviderUnavailable(
                "reranker returned duplicate, unknown or invalid scored candidate".into(),
            ));
        }
    }
    Ok(())
}

pub async fn rerank_preserving_tail<R: Reranker>(
    adapter: &R,
    query: &str,
    candidates: &[RerankCandidate],
    model: &str,
    version: &str,
) -> Result<Value> {
    if query.trim().is_empty()
        || query.len() > 4000
        || candidates.is_empty()
        || candidates.len() > MAX_CANDIDATES
    {
        return Err(Error::Validation(
            "rerank requires a query and 1..=1000 candidates".into(),
        ));
    }
    let ids: HashSet<_> = candidates.iter().map(|c| c.company_id.as_str()).collect();
    if ids.len() != candidates.len()
        || candidates.iter().any(|c| {
            c.company_id.trim().is_empty()
                || c.description.trim().is_empty()
                || c.source.trim().is_empty()
                || c.description.len() > 16_000
                || c.retrieval_score.is_some_and(|score| !score.is_finite())
        })
    {
        return Err(Error::Validation("rerank candidates require unique IDs, nonempty source/description and finite retrieval scores".into()));
    }
    let head_len = candidates.len().min(MAX_RERANK);
    if candidates
        .iter()
        .any(|c| c.source != candidates[0].source || c.query_id != candidates[0].query_id)
    {
        return Err(Error::Validation("rerank one source/query group at a time; MID and ISCC retrieval scores cannot be combined".into()));
    }
    let mut scored = adapter.rerank(query, &candidates[..head_len]).await?;
    if scored.len() != head_len {
        return Err(Error::ProviderUnavailable(
            "reranker returned incomplete candidate set".into(),
        ));
    }
    let mut used = HashSet::new();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let mut results = Vec::with_capacity(candidates.len());
    for (id, score) in scored {
        if !score.is_finite() || !used.insert(id.clone()) {
            return Err(Error::ProviderUnavailable(
                "reranker returned invalid or duplicate score".into(),
            ));
        }
        let original = candidates[..head_len]
            .iter()
            .find(|c| c.company_id == id)
            .ok_or_else(|| {
                Error::ProviderUnavailable("reranker returned unknown candidate".into())
            })?;
        results.push(json!({"rank":results.len()+1,"company_id":id,"description":original.description,"source":original.source,"query_id":original.query_id,"retrieval_score":original.retrieval_score,"rerank_score":score,"rerank_model":model,"rerank_version":version}));
    }
    for original in &candidates[head_len..] {
        results.push(json!({"rank":results.len()+1,"company_id":original.company_id,"description":original.description,"source":original.source,"query_id":original.query_id,"retrieval_score":original.retrieval_score,"rerank_score":null,"rerank_model":null,"rerank_version":null}));
    }
    Ok(
        json!({"query":query,"results":results,"result_count":results.len(),"reranked_count":head_len,"tail_untouched_count":candidates.len()-head_len,"candidate_membership_preserved":true,"executed":true}),
    )
}
