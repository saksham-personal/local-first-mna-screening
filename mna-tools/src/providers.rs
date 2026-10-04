use crate::error::{Error, Result};
use crate::identity::{field_text, get_field};
use futures_util::StreamExt;
use reqwest::{header, Client, RequestBuilder, Url};
use schemars::JsonSchema;
use scraper::{Html, Selector};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DEFAULT_MAX_BODY_BYTES: usize = 1_000_000;
const HARD_MAX_BODY_BYTES: usize = 4_000_000;
const DEFAULT_TIMEOUT_SECS: u64 = 12;
const MAX_TIMEOUT_SECS: u64 = 30;
const MAX_QUERY_CHARS: usize = 4_000;
const MAX_RESULTS: usize = 100;
const MAX_ISCC_RESULTS: usize = 1_000;
const MAX_ISCC_BODY_BYTES: usize = 16_000_000;

#[derive(Clone)]
pub struct Providers {
    config: ProviderConfig,
    client: Client,
    cache: Arc<Mutex<HashMap<String, CachedValue>>>,
    limiter: Arc<Mutex<HashMap<String, VecDeque<Instant>>>>,
}

#[derive(Clone)]
struct ProviderConfig {
    external_enabled: bool,
    iscc: EndpointConfig,
    bing: EndpointConfig,
    m365: EndpointConfig,
    cache_ttl: Duration,
}

#[derive(Clone, Default)]
struct EndpointConfig {
    endpoint: Option<String>,
    token: Option<String>,
    requests_per_minute: usize,
}

#[derive(Clone)]
struct CachedValue {
    inserted: Instant,
    value: Value,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct IsccSearchArgs {
    run_id: String,
    query: String,
    #[serde(default = "default_iscc_limit")]
    limit: usize,
    // Accepted for compatibility. These fields are intentionally not sent to
    // ISCC: discovery is based on the qualitative business query only.
    #[serde(default)]
    filters: Map<String, Value>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct BingSearchArgs {
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    plan_id: Option<String>,
    #[serde(default)]
    step_id: Option<String>,
    #[serde(default)]
    company_id: Option<String>,
    query: String,
    #[serde(default = "default_limit")]
    max_results: usize,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct M365ResearchArgs {
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    plan_id: Option<String>,
    #[serde(default)]
    step_id: Option<String>,
    question: String,
    #[serde(default)]
    company_ids: Vec<String>,
    #[serde(default)]
    companies: Vec<String>,
    #[serde(default)]
    required_fields: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct FetchUrlArgs {
    #[serde(default)]
    run_id: Option<String>,
    url: String,
    #[serde(default = "default_max_body")]
    max_bytes: usize,
    #[serde(default = "default_timeout")]
    timeout_secs: u64,
    #[serde(default = "default_true")]
    use_cache: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ExtractContextArgs {
    #[serde(default)]
    run_id: Option<String>,
    url: String,
    #[serde(default)]
    artifact_ref: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    extraction_goal: String,
    #[serde(default)]
    query_terms: Vec<String>,
    #[serde(default = "default_context_chars")]
    max_chars: usize,
}

fn default_limit() -> usize {
    20
}

fn default_iscc_limit() -> usize {
    1_000
}

fn default_max_body() -> usize {
    DEFAULT_MAX_BODY_BYTES
}

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_SECS
}

fn default_true() -> bool {
    true
}

fn default_context_chars() -> usize {
    20_000
}

pub fn input_schema(tool: &str) -> Option<Value> {
    let schema = match tool {
        "search_iscc" => schemars::schema_for!(IsccSearchArgs),
        "bing_search" => schemars::schema_for!(BingSearchArgs),
        "m365_research" => schemars::schema_for!(M365ResearchArgs),
        "fetch_url" => schemars::schema_for!(FetchUrlArgs),
        "extract_url_context" => schemars::schema_for!(ExtractContextArgs),
        _ => return None,
    };
    serde_json::to_value(schema).ok()
}

impl Providers {
    pub fn new() -> Result<Self> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(MAX_TIMEOUT_SECS))
            .user_agent("mna-tools/0.1")
            .build()?;
        Ok(Self {
            config: ProviderConfig::from_env(),
            client,
            cache: Arc::new(Mutex::new(HashMap::new())),
            limiter: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub async fn execute(&self, tool: &str, arguments: &Value) -> Result<Value> {
        match tool {
            "search_iscc" => {
                let mut result = self.search_provider("iscc", arguments).await?;
                let ignored = arguments
                    .get("filters")
                    .and_then(Value::as_object)
                    .map(|filters| filters.keys().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                result["ignored_search_filters"] = json!(ignored);
                result["search_scope"] = json!("qualitative_core_business");
                Ok(result)
            }
            "bing_search" => self.search_provider("bing", arguments).await,
            "m365_research" => self.search_provider("m365", arguments).await,
            "fetch_url" => self.fetch_url(arguments).await,
            "extract_url_context" => self.extract_url_context(arguments).await,
            _ => Err(Error::NotFound(format!("unknown provider tool: {tool}"))),
        }
    }

    async fn search_provider(&self, provider: &str, arguments: &Value) -> Result<Value> {
        let (query, limit, payload) = match provider {
            "iscc" => {
                let args: IsccSearchArgs = parse(arguments)?;
                if args.run_id.trim().is_empty() {
                    return Err(Error::Validation("ISCC search requires run_id".into()));
                }
                if args.filters.len() > 32 {
                    return Err(Error::Validation(
                        "ISCC accepts at most 32 ignored criteria fields for reporting".into(),
                    ));
                }
                validate_query(&args.query)?;
                let word_count = args.query.split_whitespace().count();
                if word_count > 14 {
                    return Err(Error::Validation(
                        "ISCC query must contain at most 14 qualitative words (10 to 12 recommended)".into(),
                    ));
                }
                let payload = json!({"query": args.query, "limit": args.limit});
                (args.query, args.limit, payload)
            }
            "bing" => {
                let args: BingSearchArgs = parse(arguments)?;
                let _ = args.run_id.as_deref();
                let _ = args.plan_id.as_deref();
                let _ = args.step_id.as_deref();
                let _ = args.company_id.as_deref();
                validate_query(&args.query)?;
                let payload = json!({"query": args.query, "max_results": args.max_results});
                (args.query, args.max_results, payload)
            }
            "m365" => {
                let args: M365ResearchArgs = parse(arguments)?;
                let _ = args.run_id.as_deref();
                let _ = args.plan_id.as_deref();
                let _ = args.step_id.as_deref();
                let _ = &args.company_ids; // Local approval scope; never forwarded.
                validate_query(&args.question)?;
                validate_string_list(&args.companies, "companies", 100, 500)?;
                validate_string_list(&args.required_fields, "required_fields", 100, 200)?;
                let payload = json!({
                    "question": args.question,
                    "companies": args.companies,
                    "required_fields": args.required_fields,
                });
                (args.question, 100, payload)
            }
            _ => return Err(Error::Internal(format!("unknown provider: {provider}"))),
        };
        let max_results = if provider == "iscc" {
            MAX_ISCC_RESULTS
        } else {
            MAX_RESULTS
        };
        if limit == 0 || limit > max_results {
            return Err(Error::Validation(format!(
                "limit must be between 1 and {max_results}"
            )));
        }
        if !self.config.external_enabled {
            return Err(Error::ProviderUnavailable(
                "external providers are disabled; set MNA_ENABLE_EXTERNAL=true to enable configured adapters"
                    .into(),
            ));
        }
        let endpoint = self.endpoint(provider)?;
        let endpoint_url = endpoint.endpoint.as_deref().ok_or_else(|| {
            Error::ProviderUnavailable(format!("{provider} endpoint is not configured"))
        })?;
        // The same URL policy is used for configured endpoints. Corporate hosts may be
        // private, so administrators must explicitly opt into them.
        validate_provider_endpoint(endpoint_url)?;

        let cache_key = format!(
            "provider:{provider}:{}",
            hex_digest(&serde_json::to_vec(&payload)?)
        );
        if let Some(value) = self.cache_get(&cache_key) {
            return Ok(mark_cached(value));
        }
        self.check_rate_limit(provider, endpoint.requests_per_minute)?;

        let response = self
            .build_provider_request(endpoint_url, endpoint.token.as_deref(), &payload)?
            .send()
            .await?;
        let status = response.status();
        if status.as_u16() == 429 {
            return Err(Error::RateLimited(format!("{provider} returned HTTP 429")));
        }
        if !status.is_success() {
            return Err(Error::ProviderUnavailable(format!(
                "{provider} returned HTTP {}",
                status.as_u16()
            )));
        }
        let bytes = read_bounded(
            response,
            if provider == "iscc" {
                MAX_ISCC_BODY_BYTES
            } else {
                DEFAULT_MAX_BODY_BYTES
            },
        )
        .await?;
        let raw: Value = serde_json::from_slice(&bytes).map_err(|error| {
            Error::ProviderUnavailable(format!("{provider} returned invalid JSON: {error}"))
        })?;
        let value = normalize_provider_response(provider, &Value::String(query), raw, limit)?;
        self.cache_put(cache_key, value.clone());
        Ok(value)
    }

    async fn fetch_url(&self, arguments: &Value) -> Result<Value> {
        let args: FetchUrlArgs = parse(arguments)?;
        let _ = args.run_id.as_deref();
        if !self.config.external_enabled {
            return Err(Error::ProviderUnavailable(
                "URL fetching is disabled; set MNA_ENABLE_EXTERNAL=true to enable it".into(),
            ));
        }
        if args.max_bytes == 0 || args.max_bytes > HARD_MAX_BODY_BYTES {
            return Err(Error::Validation(format!(
                "max_bytes must be between 1 and {HARD_MAX_BODY_BYTES}"
            )));
        }
        if args.timeout_secs == 0 || args.timeout_secs > MAX_TIMEOUT_SECS {
            return Err(Error::Validation(format!(
                "timeout_secs must be between 1 and {MAX_TIMEOUT_SECS}"
            )));
        }
        let (url, addresses) = validate_public_url(&args.url).await?;
        let cache_key = format!("url:{}:{}", normalized_url(&url), args.max_bytes);
        if args.use_cache {
            if let Some(value) = self.cache_get(&cache_key) {
                return Ok(mark_cached(value));
            }
        }
        self.check_rate_limit("fetch_url", 30)?;
        let host = url.host_str().expect("validated URL has host");
        let builder = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .resolve_to_addrs(host, &addresses)
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(args.timeout_secs))
            .user_agent("mna-tools/0.1");
        let pinned_client = builder.build()?;
        let response = pinned_client
            .get(url.clone())
            .timeout(Duration::from_secs(args.timeout_secs))
            .header(header::ACCEPT, "text/html,text/plain,application/xhtml+xml")
            .send()
            .await?;
        let status = response.status();
        if status.is_redirection() {
            return Err(Error::Validation(
                "redirects are refused; validate and fetch the destination URL explicitly".into(),
            ));
        }
        if !status.is_success() {
            return Err(Error::ProviderUnavailable(format!(
                "URL returned HTTP {}",
                status.as_u16()
            )));
        }
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        if !is_textual_content_type(&content_type) {
            return Err(Error::Validation(format!(
                "unsupported content type: {content_type}"
            )));
        }
        let bytes = read_bounded(response, args.max_bytes).await?;
        std::str::from_utf8(&bytes)
            .map_err(|_| Error::Validation("URL body is not valid UTF-8 text".into()))?;
        let digest = hex_digest(&bytes);
        let artifact_dir = artifact_directory()?;
        std::fs::create_dir_all(&artifact_dir)?;
        let extension = if content_type.contains("html") {
            "html"
        } else {
            "txt"
        };
        let artifact_ref = format!("{digest}.{extension}");
        let artifact_path = artifact_dir.join(&artifact_ref);
        std::fs::write(&artifact_path, &bytes)?;
        let value = json!({
            "url": normalized_url(&url),
            "status": status.as_u16(),
            "content_type": content_type,
            "byte_count": bytes.len(),
            "sha256": digest,
            "artifact_ref": artifact_ref,
            "cached": false,
            "retrieved_at": chrono::Utc::now().to_rfc3339(),
        });
        if args.use_cache {
            self.cache_put(cache_key, value.clone());
        }
        Ok(value)
    }

    async fn extract_url_context(&self, arguments: &Value) -> Result<Value> {
        let args: ExtractContextArgs = parse(arguments)?;
        let provenance_url =
            Url::parse(&args.url).map_err(|_| Error::Validation("Invalid source URL".into()))?;
        if !matches!(provenance_url.scheme(), "http" | "https")
            || !provenance_url.username().is_empty()
            || provenance_url.password().is_some()
        {
            return Err(Error::Validation(
                "Source URL must use HTTP(S) and omit credentials".into(),
            ));
        }
        let _ = args.run_id.as_deref();
        if args.url.len() > 8_192
            || args
                .content
                .as_ref()
                .is_some_and(|value| value.len() > HARD_MAX_BODY_BYTES)
        {
            return Err(Error::Validation(
                "URL or content exceeds the allowed size".into(),
            ));
        }
        if args.max_chars == 0 || args.max_chars > 100_000 {
            return Err(Error::Validation(
                "max_chars must be between 1 and 100000".into(),
            ));
        }
        if args.query_terms.len() > 50
            || args
                .query_terms
                .iter()
                .any(|term| term.trim().is_empty() || term.len() > 200)
        {
            return Err(Error::Validation(
                "query_terms must contain at most 50 non-empty terms of at most 200 characters"
                    .into(),
            ));
        }

        let (content, artifact_ref) = if let Some(content) = args.content {
            (content, args.artifact_ref)
        } else {
            let reference = match args.artifact_ref {
                Some(reference) => reference,
                None => {
                    let fetched = self
                        .fetch_url(&json!({"url": args.url, "max_bytes": HARD_MAX_BODY_BYTES}))
                        .await?;
                    fetched
                        .get("artifact_ref")
                        .and_then(Value::as_str)
                        .ok_or_else(|| Error::Internal("fetch result omitted artifact_ref".into()))?
                        .to_string()
                }
            };
            let path = resolve_artifact(&reference)?;
            if std::fs::metadata(&path)?.len() > HARD_MAX_BODY_BYTES as u64 {
                return Err(Error::Validation(
                    "cached artifact exceeds size limit".into(),
                ));
            }
            let bytes = std::fs::read(&path)?;
            if bytes.len() > HARD_MAX_BODY_BYTES {
                return Err(Error::Validation(
                    "cached artifact exceeds size limit".into(),
                ));
            }
            let content = String::from_utf8(bytes)
                .map_err(|_| Error::Validation("cached artifact is not valid UTF-8".into()))?;
            (content, Some(reference))
        };
        let document = Html::parse_document(&content);
        let root = Selector::parse("body").expect("static selector is valid");
        let title_selector = Selector::parse("title").expect("static selector is valid");
        let title = document
            .select(&title_selector)
            .next()
            .map(|node| normalize_whitespace(&node.text().collect::<Vec<_>>().join(" ")))
            .filter(|value| !value.is_empty());
        let raw_text = document
            .select(&root)
            .next()
            .map(|node| node.text().collect::<Vec<_>>().join("\n"))
            .unwrap_or_else(|| content.clone());
        let mut terms = args.query_terms;
        if !args.extraction_goal.trim().is_empty() {
            terms.extend(
                args.extraction_goal
                    .split_whitespace()
                    .map(ToOwned::to_owned),
            );
        }
        let text = extract_passages(&raw_text, &terms, args.max_chars);
        Ok(json!({
            "url": args.url,
            "artifact_ref": artifact_ref,
            "extraction_goal": args.extraction_goal,
            "title": title,
            "text": text,
            "char_count": text.chars().count(),
            "matched_terms": matched_terms(&text, &terms),
            "content_sha256": hex_digest(content.as_bytes()),
        }))
    }

    fn endpoint(&self, provider: &str) -> Result<&EndpointConfig> {
        match provider {
            "iscc" => Ok(&self.config.iscc),
            "bing" => Ok(&self.config.bing),
            "m365" => Ok(&self.config.m365),
            _ => Err(Error::Internal(format!("unknown provider: {provider}"))),
        }
    }

    fn build_provider_request(
        &self,
        endpoint: &str,
        token: Option<&str>,
        payload: &Value,
    ) -> Result<RequestBuilder> {
        let mut request = self.client.post(endpoint).json(payload);
        if let Some(token) = token.filter(|value| !value.is_empty()) {
            request = request.bearer_auth(token);
        }
        Ok(request)
    }

    fn check_rate_limit(&self, key: &str, limit: usize) -> Result<()> {
        if limit == 0 {
            return Err(Error::ProviderUnavailable(format!(
                "{key} is disabled by its rate-limit configuration"
            )));
        }
        let mut guards = self
            .limiter
            .lock()
            .map_err(|_| Error::Internal("rate limiter lock poisoned".into()))?;
        let entries = guards.entry(key.to_string()).or_default();
        let now = Instant::now();
        while entries
            .front()
            .is_some_and(|instant| now.duration_since(*instant) >= Duration::from_secs(60))
        {
            entries.pop_front();
        }
        if entries.len() >= limit {
            return Err(Error::RateLimited(format!(
                "{key} local rate limit of {limit} requests/minute reached"
            )));
        }
        entries.push_back(now);
        Ok(())
    }

    fn cache_get(&self, key: &str) -> Option<Value> {
        let mut cache = self.cache.lock().ok()?;
        let entry = cache.get(key)?;
        if entry.inserted.elapsed() <= self.config.cache_ttl {
            return Some(entry.value.clone());
        }
        cache.remove(key);
        None
    }

    fn cache_put(&self, key: String, value: Value) {
        if let Ok(mut cache) = self.cache.lock() {
            if cache.len() >= 512 {
                cache.retain(|_, entry| entry.inserted.elapsed() <= self.config.cache_ttl);
                if cache.len() >= 512 {
                    cache.clear();
                }
            }
            cache.insert(
                key,
                CachedValue {
                    inserted: Instant::now(),
                    value,
                },
            );
        }
    }
}

impl ProviderConfig {
    fn from_env() -> Self {
        Self {
            external_enabled: env_bool("MNA_ENABLE_EXTERNAL"),
            iscc: endpoint_config("ISCC", 30),
            bing: endpoint_config("BING", 10),
            m365: endpoint_config("M365", 7),
            cache_ttl: Duration::from_secs(env_usize("MNA_PROVIDER_CACHE_TTL_SECS", 900) as u64),
        }
    }
}

fn endpoint_config(prefix: &str, default_rpm: usize) -> EndpointConfig {
    EndpointConfig {
        endpoint: std::env::var(format!("MNA_{prefix}_ENDPOINT")).ok(),
        token: std::env::var(format!("MNA_{prefix}_TOKEN")).ok(),
        requests_per_minute: env_usize(&format!("MNA_{prefix}_RPM"), default_rpm).min(600),
    }
}

fn env_bool(name: &str) -> bool {
    std::env::var(name)
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn parse<T: DeserializeOwned>(arguments: &Value) -> Result<T> {
    serde_json::from_value(arguments.clone()).map_err(|error| Error::Validation(error.to_string()))
}

fn validate_query(query: &str) -> Result<()> {
    if query.trim().is_empty() || query.len() > MAX_QUERY_CHARS {
        return Err(Error::Validation(format!(
            "query must contain 1 to {MAX_QUERY_CHARS} characters"
        )));
    }
    Ok(())
}

fn validate_string_list(
    values: &[String],
    label: &str,
    max_items: usize,
    max_chars: usize,
) -> Result<()> {
    if values.len() > max_items
        || values
            .iter()
            .any(|value| value.trim().is_empty() || value.len() > max_chars)
    {
        return Err(Error::Validation(format!(
            "{label} must contain at most {max_items} non-empty values of at most {max_chars} characters"
        )));
    }
    Ok(())
}

fn artifact_directory() -> Result<PathBuf> {
    let configured = std::env::var("MNA_ARTIFACT_DIR").unwrap_or_else(|_| "data/web".into());
    let path = PathBuf::from(configured);
    if path.as_os_str().is_empty() {
        return Err(Error::Validation(
            "MNA_ARTIFACT_DIR must not be empty".into(),
        ));
    }
    Ok(path)
}

fn resolve_artifact(reference: &str) -> Result<PathBuf> {
    let valid = reference.split_once('.').is_some_and(|(hash, extension)| {
        hash.len() == 64
            && hash.bytes().all(|b| b.is_ascii_hexdigit())
            && matches!(extension, "html" | "txt")
    });
    if !valid {
        return Err(Error::Validation("invalid artifact_ref".into()));
    }
    let directory = artifact_directory()?;
    let path = directory.join(reference);
    if path.parent() != Some(Path::new(&directory)) {
        return Err(Error::Validation(
            "artifact_ref escapes artifact directory".into(),
        ));
    }
    if path.exists() && !path.canonicalize()?.starts_with(directory.canonicalize()?) {
        return Err(Error::Validation(
            "artifact_ref resolves outside artifact directory".into(),
        ));
    }
    Ok(path)
}

fn validate_provider_endpoint(endpoint: &str) -> Result<()> {
    let url = Url::parse(endpoint)
        .map_err(|error| Error::Validation(format!("invalid provider endpoint: {error}")))?;
    if url.scheme() != "https" && !is_loopback_host(&url) {
        return Err(Error::Validation(
            "provider endpoints must use HTTPS (HTTP is allowed only for loopback development)"
                .into(),
        ));
    }
    if url.username() != "" || url.password().is_some() {
        return Err(Error::Validation(
            "provider endpoint must not contain credentials".into(),
        ));
    }
    Ok(())
}

async fn validate_public_url(input: &str) -> Result<(Url, Vec<std::net::SocketAddr>)> {
    if input.len() > 8_192 {
        return Err(Error::Validation("URL is too long".into()));
    }
    let url =
        Url::parse(input).map_err(|error| Error::Validation(format!("invalid URL: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Error::Validation("only HTTP(S) URLs are allowed".into()));
    }
    if url.username() != "" || url.password().is_some() {
        return Err(Error::Validation(
            "URLs must not contain credentials".into(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| Error::Validation("URL must include a host".into()))?;
    validate_host_name(host)?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| Error::Validation("URL has no usable port".into()))?;
    let addresses: Vec<_> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| Error::ProviderUnavailable(format!("DNS resolution failed: {error}")))?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|addr| !is_public_ip(addr.ip())) {
        return Err(Error::Validation(
            "URL resolves to a non-public or unavailable address".into(),
        ));
    }
    Ok((url, addresses))
}

fn validate_host_name(host: &str) -> Result<()> {
    let lower = host.trim_end_matches('.').to_ascii_lowercase();
    if lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
        || lower.ends_with(".home")
        || lower.ends_with(".lan")
    {
        return Err(Error::Validation("local host names are not allowed".into()));
    }
    if let Ok(ip) = lower.parse::<IpAddr>() {
        if !is_public_ip(ip) {
            return Err(Error::Validation(
                "non-public IP addresses are not allowed".into(),
            ));
        }
    }
    Ok(())
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_unspecified()
        || ip.is_multicast()
        || a == 0
        || a == 100 && (64..=127).contains(&b)
        || a == 192 && b == 0
        || a == 198 && (b == 18 || b == 19)
        || a == 198 && b == 51 && ip.octets()[2] == 100
        || a == 203 && b == 0 && ip.octets()[2] == 113
        || a >= 240)
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }
    let segments = ip.segments();
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xe000) != 0x2000
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

fn is_loopback_host(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        host == "localhost" || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
    })
}

pub(crate) async fn read_bounded(response: reqwest::Response, max_bytes: usize) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(Error::Validation(format!(
            "response exceeds {max_bytes} bytes"
        )));
    }
    let mut stream = response.bytes_stream();
    let mut output = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if output.len().saturating_add(chunk.len()) > max_bytes {
            return Err(Error::Validation(format!(
                "response exceeds {max_bytes} bytes"
            )));
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn normalize_provider_response(
    provider: &str,
    query: &Value,
    raw: Value,
    limit: usize,
) -> Result<Value> {
    if provider == "iscc" {
        return normalize_iscc_response(query, raw, limit);
    }
    if !raw.is_object() || raw.get("error").is_some_and(|v| !v.is_null()) {
        return Err(Error::ProviderUnavailable(format!(
            "{provider} returned a malformed or error response"
        )));
    }
    if !["answer", "response", "summary", "text"]
        .iter()
        .any(|key| raw.get(*key).is_some_and(Value::is_string))
        && !["results", "companies", "value", "citations", "sources"]
            .iter()
            .any(|key| raw.get(*key).is_some_and(Value::is_array))
        && !raw
            .get("webPages")
            .and_then(|v| v.get("value"))
            .is_some_and(Value::is_array)
    {
        return Err(Error::ProviderUnavailable(format!(
            "{provider} response has no recognized answer or result array"
        )));
    }
    let items = raw
        .pointer("/webPages/value")
        .or_else(|| raw.get("results"))
        .or_else(|| raw.get("companies"))
        .or_else(|| raw.get("value"))
        .or_else(|| raw.get("citations"))
        .or_else(|| raw.get("sources"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let results: Vec<Value> = items
        .into_iter()
        .take(limit)
        .enumerate()
        .map(|(index, item)| {
            json!({
                "rank": index + 1,
                "title": first_string(&item, &["title", "company_name", "name", "displayName"]),
                "company_name": first_string(&item, &["company_name", "name", "title"]),
                "company_id": first_string(&item, &["company_id", "companyId"]),
                "source": provider.to_ascii_uppercase(),
                "url": first_string(&item, &["url", "link", "sourceUrl"]),
                "snippet": first_string(&item, &["snippet", "description", "summary", "text"]),
                "score": item.get("score").or_else(|| item.get("relevance_score")).cloned(),
                "metadata": item,
            })
        })
        .collect();
    Ok(json!({
        "provider": provider,
        "query": query,
        "answer": first_string(&raw, &["answer", "response", "summary", "text"]),
        "results": results,
        "sources": raw.get("sources").or_else(||raw.get("citations")).cloned().unwrap_or_else(||json!([])),
        "retrieved_at": chrono::Utc::now().to_rfc3339(),
        "result_count": results.len(),
        "cached": false,
    }))
}

fn normalize_iscc_response(query: &Value, raw: Value, limit: usize) -> Result<Value> {
    if !raw.is_object() || raw.get("error").is_some_and(|value| !value.is_null()) {
        return Err(Error::ProviderUnavailable(
            "ISCC returned a malformed or error response".into(),
        ));
    }
    let rows = ["rows", "results", "companies", "value"]
        .iter()
        .find_map(|key| raw.get(*key).and_then(Value::as_array))
        .ok_or_else(|| {
            Error::ProviderUnavailable(
                "ISCC bridge must return a JSON object with a rows array".into(),
            )
        })?;
    if rows.len() > limit {
        return Err(Error::ProviderUnavailable(format!(
            "ISCC returned {} rows above the requested limit of {limit}",
            rows.len()
        )));
    }
    if rows.iter().any(|row| !row.is_object()) {
        return Err(Error::ProviderUnavailable(
            "ISCC rows must be JSON objects".into(),
        ));
    }
    let score_bands = iscc_score_bands(rows);
    Ok(json!({
        "provider": "iscc",
        "query": query,
        "raw_rows": rows,
        "result_count": rows.len(),
        "score_bands": score_bands,
        "usual_reference_cutoff": 0.45,
        "cutoff_applied": false,
        "retrieved_at": chrono::Utc::now().to_rfc3339(),
        "cached": false,
    }))
}

fn iscc_score_bands(rows: &[Value]) -> Vec<Value> {
    (3..=9).rev().map(|band| {
        let lower = band as f64 / 10.0;
        let upper = (band + 1) as f64 / 10.0;
        let mut selected: Vec<&Value> = rows.iter().filter(|row| {
            iscc_score(row).is_some_and(|score| score >= lower && (score < upper || (band == 9 && score <= 1.0)))
        }).collect();
        selected.sort_by(|left, right| {
            iscc_score(right).unwrap_or_default()
                .partial_cmp(&iscc_score(left).unwrap_or_default())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let sample_count = selected.len().min(4);
        let samples: Vec<Value> = (0..sample_count).map(|position| {
            let index = if sample_count == 1 { 0 } else { position * (selected.len()-1) / (sample_count-1) };
            let row = selected[index];
            json!({
                "company_name": field_text(row, &["Company Name", "name"]),
                "description": field_text(row, &["Description", "Descriptions", "Business Description"]),
            "relevance_score": iscc_score(row),
            })
        }).collect();
        json!({
            "score_from_inclusive": lower,
            "score_to": upper,
            "score_to_inclusive": band == 9,
            "count": selected.len(),
            "samples": samples,
        })
    }).collect()
}

fn iscc_score(row: &Value) -> Option<f64> {
    get_field(row, &["Relevance Score", "Relevance", "Score"])
        .and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str()?.trim().parse().ok())
        })
        .filter(|score| score.is_finite() && (0.0..=1.0).contains(score))
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

fn mark_cached(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.insert("cached".into(), Value::Bool(true));
    }
    value
}

fn is_textual_content_type(value: &str) -> bool {
    let media_type = value.split(';').next().unwrap_or_default().trim();
    media_type.starts_with("text/")
        || matches!(
            media_type,
            "application/xhtml+xml" | "application/json" | "application/xml"
        )
}

fn normalized_url(url: &Url) -> String {
    let mut normalized = url.clone();
    normalized.set_fragment(None);
    normalized.to_string()
}

fn extract_passages(content: &str, query_terms: &[String], max_chars: usize) -> String {
    let terms: Vec<String> = query_terms
        .iter()
        .map(|term| term.trim().to_lowercase())
        .filter(|term| !term.is_empty())
        .collect();
    let mut passages: Vec<(bool, usize, String)> = content
        .lines()
        .map(normalize_whitespace)
        .filter(|line| !line.is_empty())
        .enumerate()
        .map(|(index, line)| {
            let lower = line.to_lowercase();
            let matched = terms.is_empty() || terms.iter().any(|term| lower.contains(term));
            (matched, index, line)
        })
        .collect();
    if !terms.is_empty() {
        passages.sort_by_key(|(matched, index, _)| (!*matched, *index));
    }
    let mut selected: Vec<(usize, String)> = Vec::new();
    let mut chars = 0usize;
    for (_, index, line) in passages {
        let additional = line.chars().count() + usize::from(!selected.is_empty());
        if chars.saturating_add(additional) > max_chars {
            continue;
        }
        chars += additional;
        selected.push((index, line));
    }
    selected.sort_by_key(|(index, _)| *index);
    selected
        .into_iter()
        .map(|(_, line)| line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn matched_terms(text: &str, query_terms: &[String]) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut output = Vec::new();
    for term in query_terms {
        let normalized = term.trim().to_lowercase();
        if !normalized.is_empty() && lower.contains(&normalized) && !output.contains(&normalized) {
            output.push(normalized);
        }
    }
    output
}

fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_errors_never_become_successful_empty_search_results() {
        assert!(normalize_provider_response(
            "iscc",
            &json!("insurance"),
            json!({"error":"access denied"}),
            5
        )
        .is_err());
        assert!(normalize_provider_response(
            "bing",
            &json!("insurance"),
            json!({"unexpected":"payload"}),
            5
        )
        .is_err());
        let result = normalize_provider_response(
            "iscc",
            &json!("insurance"),
            json!({"rows":[{"CID":"C1","Company Name":"Carrier Cloud","Description":"Insurance software","Relevance Score":0.8}]}),
            5,
        )
        .unwrap();
        assert_eq!(result["raw_rows"][0]["CID"], "C1");
        assert_eq!(
            result["score_bands"][1]["samples"][0]["company_name"],
            "Carrier Cloud"
        );
        assert!(result["retrieved_at"].is_string());
    }

    #[tokio::test]
    async fn iscc_enforces_query_and_result_bounds_before_any_external_call() {
        let providers = Providers::new().unwrap();
        let long_query = (0..15).map(|_| "business").collect::<Vec<_>>().join(" ");
        let error = providers
            .execute(
                "search_iscc",
                &json!({"run_id":"R1","query":long_query,"limit":100}),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("14 qualitative words"));
        let error = providers
            .execute(
                "search_iscc",
                &json!({"run_id":"R1","query":"claims software","limit":1001}),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("1000"));
    }

    #[test]
    fn iscc_score_bands_sample_across_each_decile_without_cutting_the_result_set() {
        let rows: Vec<Value> = (0..10)
            .map(|index| {
                json!({
                    "CID":format!("C{index}"),
                    "Company Name":format!("Target {index}"),
                    "Description":"Qualitative claims business",
                    "Relevance Score":0.81 + index as f64 * 0.008,
                })
            })
            .collect();
        let normalized =
            normalize_iscc_response(&json!("claims"), json!({"rows":rows}), 10).unwrap();
        assert_eq!(normalized["result_count"], 10);
        assert_eq!(normalized["score_bands"][1]["count"], 10);
        assert_eq!(
            normalized["score_bands"][1]["samples"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        assert_eq!(normalized["cutoff_applied"], false);
    }

    #[tokio::test]
    async fn disabled_provider_and_url_tools_make_no_network_calls() {
        let mut providers = Providers::new().unwrap();
        providers.config.external_enabled = false;
        assert!(matches!(
            providers
                .execute("bing_search", &json!({"query":"insurance","max_results":5}))
                .await,
            Err(Error::ProviderUnavailable(_))
        ));
        assert!(matches!(
            providers
                .execute("fetch_url", &json!({"url":"http://127.0.0.1/"}))
                .await,
            Err(Error::ProviderUnavailable(_))
        ));
        let extracted = providers.execute("extract_url_context", &json!({"url":"https://example.com","content":"<html><body>Insurance software</body></html>","extraction_goal":"Insurance","max_chars":100})).await.unwrap();
        assert!(extracted["text"]
            .as_str()
            .unwrap()
            .contains("Insurance software"));
    }

    #[tokio::test]
    async fn gateway_adapter_cache_and_rate_limit_work_with_local_mock() {
        use axum::{routing::post, Json, Router};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route("/search", post(|Json(payload): Json<Value>| async move { Json(json!({"answer":payload["query"],"sources":[{"title":"Source","url":"https://example.com"}]})) }));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut providers = Providers::new().unwrap();
        providers.config.external_enabled = true;
        providers.config.bing = EndpointConfig {
            endpoint: Some(format!("http://{address}/search")),
            token: None,
            requests_per_minute: 1,
        };
        let args = json!({"query":"insurance","max_results":5});
        let first = providers.execute("bing_search", &args).await.unwrap();
        assert_eq!(first["answer"], "insurance");
        assert_eq!(first["sources"][0]["title"], "Source");
        assert_eq!(
            providers.execute("bing_search", &args).await.unwrap()["cached"],
            true
        );
        assert!(matches!(
            providers
                .execute("bing_search", &json!({"query":"new search"}))
                .await,
            Err(Error::RateLimited(_))
        ));
        server.abort();
    }

    #[test]
    fn rejects_private_and_special_addresses() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "192.168.1.1",
            "::1",
            "fd00::1",
            "2001:db8::1",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "accepted {ip}");
        }
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
        assert!(validate_host_name("localhost").is_err());
        assert!(validate_host_name("service.internal").is_err());
    }

    #[test]
    fn provider_request_includes_json_and_bearer_token() {
        let providers = Providers::new().unwrap();
        let request = providers
            .build_provider_request(
                "https://example.com/search",
                Some("secret"),
                &json!({"query":"insurance"}),
            )
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(
            request.headers().get(header::AUTHORIZATION).unwrap(),
            "Bearer secret"
        );
        assert!(request.body().and_then(|body| body.as_bytes()).is_some());
    }

    #[test]
    fn extraction_is_deterministic_and_prioritizes_matching_lines() {
        let input = "boilerplate\nInsurance workflow platform\nfooter\nClaims software";
        let terms = vec!["insurance".to_string(), "claims".to_string()];
        let one = extract_passages(input, &terms, 60);
        let two = extract_passages(input, &terms, 60);
        assert_eq!(one, two);
        assert!(one.contains("Insurance workflow platform"));
        assert!(one.contains("Claims software"));
    }

    #[test]
    fn normalizes_common_provider_shapes() {
        let value = normalize_provider_response(
            "bing",
            &json!("vertical saas"),
            json!({"webPages":{"value":[{"name":"Acme","url":"https://acme.test","snippet":"x"}]}}),
            10,
        )
        .unwrap();
        assert_eq!(value["result_count"], 1);
        assert_eq!(value["results"][0]["title"], "Acme");
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let result: std::result::Result<FetchUrlArgs, _> =
            serde_json::from_value(json!({"url":"https://example.com","unexpected":true}));
        assert!(result.is_err());
    }

    #[test]
    fn artifact_references_cannot_escape_cache() {
        assert!(resolve_artifact(&format!("{}.html", "a".repeat(64))).is_ok());
        assert!(resolve_artifact("../secret").is_err());
        assert!(resolve_artifact("folder/secret").is_err());
    }
}
