//! Run-independent exploration of the active MID population.
//!
//! Sync metadata lives in MNA_EXPORT_DIR/../meili-sync.json, not SQLite. It contains
//! no credentials. A bundle-specific Meili index is published only after every task
//! succeeds; searches refuse an incomplete or stale sync. The bridge triggers sync
//! after activation and on successful Build Index completion polling.
use crate::{
    data::DataService,
    error::{Error, Result},
    mid_search,
    retrieval::{self, Embedder, LocalHttpAdapter, RetrievalConfig},
    search::{meili_json_with_limit, SearchEngine},
    Store,
};
use calamine::{Reader, Xlsx};
use reqwest::Method;
use rusqlite::{params, OptionalExtension};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    cmp::{Ordering, Reverse},
    collections::{BTreeMap, BTreeSet, BinaryHeap},
    io::Cursor,
    path::PathBuf,
    time::Duration,
};

#[derive(Clone)]
pub struct SearchSpace {
    store: Store,
    search: SearchEngine,
    sync_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
    sync_running: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Empty {}
fn page_size() -> usize {
    100
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Direction {
    Asc,
    Desc,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Sort {
    column: String,
    direction: Direction,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct BrowseArgs {
    #[serde(default)]
    offset: usize,
    #[serde(default = "page_size")]
    limit: usize,
    sort: Option<Sort>,
}
#[derive(Clone, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Match {
    #[default]
    Stem,
    Exact,
}
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Keyword {
    id: Option<String>,
    text: String,
    #[serde(default)]
    r#match: Match,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct LexicalArgs {
    #[serde(default)]
    keywords: Vec<Keyword>,
    expression: Option<String>,
    #[serde(default)]
    offset: usize,
    #[serde(default = "page_size")]
    limit: usize,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SemanticArgs {
    text: String,
    #[serde(default)]
    offset: usize,
    #[serde(default = "page_size")]
    limit: usize,
    min_score: Option<f64>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct IsccArgs {
    query: String,
    count: usize,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RecentArgs {
    #[serde(default = "page_size")]
    limit: usize,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct AddArgs {
    run_id: String,
    company_ids: Vec<String>,
    query_id: Option<String>,
}
// The search object is the same object accepted by a read tool: query+count,
// text, browse offset/limit/sort (or {}), or keywords/expression. No second DSL.
#[derive(Deserialize, JsonSchema)]
#[serde(untagged)]
enum SearchArgs {
    Iscc(IsccArgs),
    Semantic(SemanticArgs),
    Browse(BrowseArgs),
    Lexical(LexicalArgs),
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Format {
    Xlsx,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ExportArgs {
    search: SearchArgs,
    format: Format,
    #[serde(default)]
    allow_simulated: bool,
}
pub fn input_schema(tool: &str) -> Option<Value> {
    let schema = match tool {
        "space_sync" | "space_sync_status" => schemars::schema_for!(Empty),
        "space_browse" => schemars::schema_for!(BrowseArgs),
        "space_search_lexical" => schemars::schema_for!(LexicalArgs),
        "space_search_semantic" => schemars::schema_for!(SemanticArgs),
        "space_search_iscc" => schemars::schema_for!(IsccArgs),
        "space_recent" => schemars::schema_for!(RecentArgs),
        "space_add_to_run" => schemars::schema_for!(AddArgs),
        "space_export" => schemars::schema_for!(ExportArgs),
        _ => return None,
    };
    let mut value = serde_json::to_value(schema).ok()?;
    if matches!(tool, "space_sync" | "space_sync_status") {
        value["properties"] = json!({});
    }
    Some(value)
}
fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}
fn parse<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).map_err(|e| invalid(e.to_string()))
}
fn text(value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.chars().count() > max {
        return Err(invalid(format!("Text must contain 1..{max} characters")));
    }
    Ok(())
}
fn page(offset: usize, limit: usize) -> Result<()> {
    if !(1..=200).contains(&limit) || offset > 200_000 {
        return Err(invalid("limit must be 1..200 and offset at most 200000"));
    }
    Ok(())
}
struct Bundle {
    id: String,
    index: String,
    columns: Vec<String>,
    search_columns: Vec<String>,
    categories: Vec<String>,
    numbers: Vec<String>,
    semantic: String,
}
fn active(store: &Store) -> Result<Bundle> {
    store.with_connection(|c| {
        let row = c.query_row("SELECT bundle_id,fts_id,config_json,semantic_status FROM mid_bundles WHERE status='active'", [], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).optional()?;
        let (id,fts,raw,semantic) = row.ok_or_else(|| invalid("Build and activate a MID bundle before using Search Space."))?;
        if fts < 1 { return Err(invalid("Invalid MID index identifier")); }
        let config: Value = serde_json::from_str(&raw)?;
        let strings = |key: &str| config[key].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
        let typed = |kind: &str| config["column_types"].as_object().into_iter().flatten().filter(|(_,v)| *v == kind).map(|(k,_)|k.clone()).collect();
        Ok(Bundle { id, index:format!("mid_{fts}"), columns:strings("workbook_columns"), search_columns:strings("search_columns"), categories:typed("category"), numbers:typed("number"), semantic })
    })
}
fn export_dir() -> PathBuf {
    std::env::var_os("MNA_EXPORT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data/export"))
}
fn sync_path() -> PathBuf {
    export_dir()
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("meili-sync.json")
}
fn sync_state() -> Result<Value> {
    match std::fs::read(sync_path()) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.into()),
    }
}
fn write_sync(value: &Value) -> Result<()> {
    let path = sync_path();
    std::fs::create_dir_all(path.parent().expect("sync parent"))?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, serde_json::to_vec(value)?)?;
    if let Err(e) = std::fs::rename(&temp, &path) {
        let _ = std::fs::remove_file(temp);
        return Err(e.into());
    }
    Ok(())
}
fn count(store: &Store, bundle: &Bundle) -> Result<usize> {
    store.with_connection(|c| {
        Ok(c.query_row(
            "SELECT COUNT(*) FROM mid_rows WHERE bundle_id=?",
            [&bundle.id],
            |r| r.get::<_, i64>(0),
        )? as usize)
    })
}
fn row_page(store: &Store, bundle: &Bundle, after: i64, limit: usize) -> Result<Vec<(i64, Value)>> {
    store.with_connection(|c| {
        let mut stmt = c.prepare("SELECT r.row_no,r.company_id,c.name,c.website,r.row_json FROM mid_rows r JOIN companies c USING(company_id) WHERE r.bundle_id=? AND r.row_no>? ORDER BY r.row_no LIMIT ?")?;
        let rows = stmt.query_map(params![bundle.id,after,limit as i64], |r| Ok((r.get::<_,i64>(0)?,json!({"company_id":r.get::<_,String>(1)?,"name":r.get::<_,String>(2)?,"website":r.get::<_,Option<String>>(3)?,"values":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).unwrap_or(Value::Null)}))))?.collect::<std::result::Result<Vec<_>,_>>()?;
        Ok(rows)
    })
}
fn hydrate(store: &Store, bundle: &Bundle, id: &str) -> Result<Value> {
    store.with_connection(|c| {
        let (name,website,raw): (String,Option<String>,String) = c.query_row("SELECT c.name,c.website,r.row_json FROM mid_rows r JOIN companies c USING(company_id) WHERE r.bundle_id=? AND r.company_id=?", params![bundle.id,id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        Ok(json!({"company_id":id,"name":name,"website":website,"values":serde_json::from_str::<Value>(&raw)?}))
    })
}
impl SearchSpace {
    pub fn new(store: Store) -> Result<Self> {
        Ok(Self {
            search: SearchEngine::new(store.clone())?,
            store,
            sync_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            sync_running: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }
    pub async fn execute(&self, tool: &str, arguments: &Value) -> Result<Value> {
        let bundle = active(&self.store)?;
        match tool {
            "space_sync_status" => {
                let _: Empty = parse(arguments)?;
                self.status(&bundle).await
            }
            "space_sync" => {
                let _: Empty = parse(arguments)?;
                self.sync(&bundle).await
            }
            "space_browse" => self.browse(&bundle, &parse(arguments)?),
            "space_search_lexical" => {
                let args = parse(arguments)?;
                let mut result = self.lexical(&bundle, &args).await?;
                if first_page(arguments) {
                    self.save(
                        "SPACE_LEXICAL",
                        args.expression.as_deref().unwrap_or("keywords"),
                        arguments,
                        &mut result,
                    )?;
                }
                Ok(result)
            }
            "space_search_semantic" => {
                let args: SemanticArgs = parse(arguments)?;
                let mut result = self.semantic(&bundle, &args).await?;
                if first_page(arguments) {
                    self.save("SPACE_SEMANTIC", &args.text, arguments, &mut result)?;
                }
                Ok(result)
            }
            "space_search_iscc" => self.iscc(&parse(arguments)?, arguments).await,
            "space_recent" => self.recent(parse(arguments)?),
            "space_add_to_run" => self.add(&bundle, parse(arguments)?),
            "space_export" => self.export(&bundle, parse(arguments)?).await,
            _ => Err(invalid("Unknown Search Space tool")),
        }
    }
    fn save(&self, source: &str, query: &str, args: &Value, result: &mut Value) -> Result<()> {
        let record = self.store.record_search(None, source, query, args, &json!({"total":result["total"],"status":result["status"],"bundle_id":result["bundle_id"]}))?;
        result["query_id"] = record["query_id"].clone();
        Ok(())
    }
    fn url(&self, path: &str) -> Result<String> {
        Ok(format!(
            "{}{}",
            self.search
                .meili_config()
                .ok_or_else(|| Error::ProviderUnavailable("Meilisearch is not running".into()))?
                .url,
            path
        ))
    }
    async fn request(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value> {
        let mut req = self.search.meili_request(method, &self.url(path)?);
        if let Some(body) = body {
            req = req.json(body);
        }
        let response = req
            .send()
            .await
            .map_err(|_| Error::ProviderUnavailable("Meilisearch is not running".into()))?;
        if !response.status().is_success() {
            return Err(Error::ProviderUnavailable(format!(
                "Meilisearch returned HTTP {}",
                response.status().as_u16()
            )));
        }
        // 200k identifiers (up to 128 bytes each) can exceed the legacy 16 MB
        // response bound. Only ids are requested; the wide data stays in SQLite.
        meili_json_with_limit(response, 64_000_000).await
    }
    async fn task(&self, method: Method, path: &str, body: Option<&Value>) -> Result<()> {
        let task = self.request(method, path, body).await?;
        let uid = task["taskUid"]
            .as_u64()
            .ok_or_else(|| Error::ProviderUnavailable("Meilisearch omitted taskUid".into()))?;
        self.search
            .wait_for_meili_tasks(&[json!(uid)], Duration::from_secs(300))
            .await?;
        Ok(())
    }
    async fn status(&self, bundle: &Bundle) -> Result<Value> {
        let up = self.request(Method::GET, "/health", None).await.is_ok();
        let state = {
            let _lock = self.sync_lock.lock().await;
            sync_state()?
        };
        let same = state["bundle_id"] == bundle.id;
        let stats = if up {
            self.request(
                Method::GET,
                &format!("/indexes/{}/stats", bundle.index),
                None,
            )
            .await
            .ok()
        } else {
            None
        };
        Ok(
            json!({"meili":if up {"up"} else {"down"},"index":bundle.index,"bundle_id":bundle.id,"documents":stats.as_ref().and_then(|v|v["numberOfDocuments"].as_u64()).unwrap_or(0),"last_synced_at":if same {state["last_synced_at"].clone()} else {Value::Null},"task_status":if same {state["task_status"].as_str().unwrap_or("unsynced")} else {"unsynced"}}),
        )
    }
    async fn sync(&self, bundle: &Bundle) -> Result<Value> {
        if self
            .sync_running
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            return Err(Error::Conflict(
                "Search Space sync is already running.".into(),
            ));
        }
        let _running = SyncRunning(self.sync_running.clone());
        self.request(Method::GET, "/health", None).await?;
        let mut state = json!({"bundle_id":bundle.id,"index":bundle.index,"documents":0,"last_synced_at":null,"task_status":"processing"});
        {
            let _lock = self.sync_lock.lock().await;
            if active(&self.store)?.id != bundle.id {
                return Err(Error::Conflict(
                    "Active MID bundle changed; retry sync.".into(),
                ));
            }
            write_sync(&state)?;
        }
        let result = self.sync_documents(bundle).await;
        match result {
            Ok(documents) => {
                state["documents"] = json!(documents);
                state["task_status"] = json!("succeeded");
                state["last_synced_at"] = json!(chrono::Utc::now().to_rfc3339());
            }
            Err(ref e) => {
                state["task_status"] = json!("failed");
                state["error"] = json!(e.to_string());
            }
        }
        {
            let _lock = self.sync_lock.lock().await;
            write_sync(&state)?;
        }
        result?;
        state["meili"] = json!("up");
        Ok(state)
    }
    async fn sync_documents(&self, bundle: &Bundle) -> Result<usize> {
        let path = format!("/indexes/{}", bundle.index);
        let response = self
            .search
            .meili_request(Method::GET, &self.url(&path)?)
            .send()
            .await?;
        if response.status().is_success() {
            self.task(Method::DELETE, &path, None).await?;
        } else if response.status() != reqwest::StatusCode::NOT_FOUND {
            return Err(Error::ProviderUnavailable(format!(
                "Meilisearch returned HTTP {}",
                response.status()
            )));
        }
        self.task(
            Method::POST,
            "/indexes",
            Some(&json!({"uid":bundle.index,"primaryKey":"id"})),
        )
        .await?;
        self.task(Method::PATCH,&format!("{path}/settings"),Some(&json!({"searchableAttributes":bundle.search_columns,"filterableAttributes":bundle.categories,"pagination":{"maxTotalHits":200000}}))).await?;
        let mut cursor = 0;
        let mut total = 0;
        loop {
            let rows = row_page(&self.store, bundle, cursor, 5000)?;
            if rows.is_empty() {
                break;
            }
            cursor = rows.last().expect("rows").0;
            let documents = rows
                .into_iter()
                .map(|(_, row)| {
                    let mut doc = json!({});
                    for col in &bundle.columns {
                        doc[col] = row["values"][col].clone();
                    }
                    for col in ["company_id", "name", "website"] {
                        doc[col] = row[col].clone();
                    }
                    doc["id"] = row["company_id"].clone();
                    doc
                })
                .collect::<Vec<_>>();
            total += documents.len();
            self.task(
                Method::POST,
                &format!("{path}/documents"),
                Some(&json!(documents)),
            )
            .await?;
        }
        if active(&self.store)?.id != bundle.id {
            return Err(Error::Conflict(
                "Active MID bundle changed during sync; retry.".into(),
            ));
        }
        Ok(total)
    }
    fn browse(&self, bundle: &Bundle, args: &BrowseArgs) -> Result<Value> {
        page(args.offset, args.limit)?;
        let results = self.browse_rows(bundle, args, args.offset, args.limit)?;
        Ok(
            json!({"bundle_id":bundle.id,"columns":bundle.columns,"results":results,"total":count(&self.store,bundle)?,"offset":args.offset,"limit":args.limit}),
        )
    }
    fn browse_rows(
        &self,
        bundle: &Bundle,
        args: &BrowseArgs,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<Value>> {
        if args
            .sort
            .as_ref()
            .is_some_and(|s| !bundle.columns.contains(&s.column))
        {
            return Err(invalid("Sort column is not in the active MID workbook"));
        }
        let order = match args.sort.as_ref() {
            Some(s) => format!(
                "{} {},c.name COLLATE NOCASE,r.company_id",
                if bundle.numbers.contains(&s.column) {
                    "CAST(json_extract(r.row_json, ?) AS REAL)"
                } else {
                    "json_extract(r.row_json, ?) COLLATE NOCASE"
                },
                if matches!(s.direction, Direction::Asc) {
                    "ASC"
                } else {
                    "DESC"
                }
            ),
            None => "r.row_no".into(),
        };
        self.store.with_connection(|c| {
            let mut stmt = c.prepare(&format!("SELECT r.company_id,c.name,c.website,r.row_json FROM mid_rows r JOIN companies c USING(company_id) WHERE r.bundle_id=? ORDER BY {order} LIMIT ? OFFSET ?"))?;
            let decode = |r: &rusqlite::Row<'_>| Ok(json!({"company_id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"website":r.get::<_,Option<String>>(2)?,"values":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(Value::Null)}));
            let rows = if let Some(sort) = &args.sort {
                let path = format!("$.{}",serde_json::to_string(&sort.column)?);
                stmt.query_map(params![bundle.id,path,limit as i64,offset as i64],decode)?.collect::<std::result::Result<Vec<_>,_>>()?
            } else { stmt.query_map(params![bundle.id,limit as i64,offset as i64],decode)?.collect::<std::result::Result<Vec<_>,_>>()? };
            Ok(rows)
        })
    }
    async fn lexical_hits(&self, bundle: &Bundle, args: &LexicalArgs) -> Result<LexicalResults> {
        let (keywords, tree, positives) = lexical_expression(args)?;
        self.request(Method::GET, "/health", None).await?;
        let state = {
            let _lock = self.sync_lock.lock().await;
            sync_state()?
        };
        let stats = self
            .request(
                Method::GET,
                &format!("/indexes/{}/stats", bundle.index),
                None,
            )
            .await;
        if state["bundle_id"] != bundle.id
            || state["task_status"] != "succeeded"
            || !stats.is_ok_and(|s| s["numberOfDocuments"].as_u64().is_some_and(|n| n > 0))
        {
            return Err(Error::ProviderUnavailable(
                "Search Space index is not synced yet".into(),
            ));
        }
        let mut hits = BTreeMap::new();
        // ISCC can promote a provisional MID key after the bundle was indexed.
        // Resolve only exact PK bridges; names and websites never merge hits.
        let aliases = self.store.with_connection(|c| {
            let mut stmt = c.prepare("SELECT i.identifier,i.company_id FROM company_identifiers i JOIN mid_rows r ON r.company_id=i.company_id WHERE r.bundle_id=? AND i.kind='PK'")?;
            let rows = stmt.query_map([&bundle.id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<BTreeMap<_,_>,_>>()?;
            Ok(rows)
        })?;
        for (id, k) in &keywords {
            let q = if k.text.split_whitespace().count() > 1 || matches!(k.r#match, Match::Exact) {
                format!("\"{}\"", k.text.replace('"', " "))
            } else {
                k.text.clone()
            };
            let raw = self.request(Method::POST,&format!("/indexes/{}/search",bundle.index),Some(&json!({"q":q,"limit":200000,"attributesToRetrieve":["company_id"],"attributesToSearchOn":bundle.search_columns,"matchingStrategy":"all"}))).await?;
            let rows = raw["hits"]
                .as_array()
                .ok_or_else(|| Error::ProviderUnavailable("Meilisearch omitted hits".into()))?;
            let mut found = BTreeMap::new();
            for row in rows {
                if let Some(id) = row["company_id"].as_str() {
                    found.insert(aliases.get(id).map_or(id, String::as_str).to_owned(), 1.0);
                }
            }
            hits.insert(id.clone(), found);
        }
        let matched = tree.eval(&hits);
        let keywords = keywords.into_iter().collect::<Vec<_>>();
        let mut result = Vec::with_capacity(matched.len());
        // Read only identity/name here. Wide workbook columns are hydrated per page.
        self.store.with_connection(|c| {
            let mut stmt = c.prepare("SELECT r.company_id,c.name FROM mid_rows r JOIN companies c USING(company_id) WHERE r.bundle_id=?")?;
            for row in stmt.query_map([&bundle.id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))? {
                let (id,name) = row?;
                if !matched.contains(&id) { continue; }
                let positive_count = positives.iter().filter(|k| hits[*k].contains_key(&id)).count();
                let matched_keywords = keywords.iter().enumerate().filter(|(_, (k,_))|hits[k].contains_key(&id)).fold(0u64, |bits,(i,_)|bits | (1u64 << i));
                result.push(LexicalHit { id,name,strength:100.0 * positive_count as f64 / positives.len() as f64,matched:matched_keywords });
            }
            Ok(())
        })?;
        result.sort_by(|a, b| {
            b.strength
                .total_cmp(&a.strength)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                .then_with(|| a.id.cmp(&b.id))
        });
        // A rebuild may have started while the network queries were in flight.
        // Never publish results collected against an incomplete or replaced index.
        {
            let _lock = self.sync_lock.lock().await;
            if sync_state()? != state || active(&self.store)?.id != bundle.id {
                return Err(Error::Conflict(
                    "Search Space index changed; retry the search.".into(),
                ));
            }
        }
        Ok(LexicalResults {
            hits: result,
            keywords,
        })
    }
    async fn lexical(&self, bundle: &Bundle, args: &LexicalArgs) -> Result<Value> {
        page(args.offset, args.limit)?;
        let hits = self.lexical_hits(bundle, args).await?;
        let results = hits
            .hits
            .iter()
            .skip(args.offset)
            .take(args.limit)
            .map(|hit| lexical_row(&self.store, bundle, hit, &hits.keywords))
            .collect::<Result<Vec<_>>>()?;
        Ok(
            json!({"bundle_id":bundle.id,"columns":bundle.columns,"results":results,"total":hits.hits.len(),"offset":args.offset,"limit":args.limit}),
        )
    }
    async fn semantic_context(
        &self,
        bundle: &Bundle,
        args: &SemanticArgs,
    ) -> Result<std::result::Result<SemanticContext, String>> {
        text(&args.text, 2000)?;
        if args
            .min_score
            .is_some_and(|s| !s.is_finite() || !(0.0..=10.0).contains(&s))
        {
            return Err(invalid("min_score must be 0..10"));
        }
        let config = RetrievalConfig::from_env()?;
        if config.embed_endpoint.is_none() {
            return Ok(Err(
                "Embedding model is unavailable (set MNA_EMBED_ENDPOINT).".into(),
            ));
        }
        if bundle.semantic != "ready" {
            return Ok(Err(format!(
                "MID embeddings are unavailable ({}).",
                bundle.semantic
            )));
        }
        let adapter = LocalHttpAdapter::new(config)?;
        let vectors = match adapter
            .embed(&[format!("query: {}", args.text.trim())])
            .await
        {
            Ok(v) => v,
            Err(e) => return Ok(Err(format!("Embedding worker is unavailable: {e}"))),
        };
        Ok(Ok(SemanticContext {
            model: adapter.config().embedder.clone(),
            query: vectors[0].clone(),
            min: args.min_score.unwrap_or(0.0),
        }))
    }
    async fn semantic(&self, bundle: &Bundle, args: &SemanticArgs) -> Result<Value> {
        page(args.offset, args.limit)?;
        let k = args.offset + args.limit;
        if k > 5000 {
            return Err(invalid("Semantic offset + limit must be at most 5000"));
        }
        let context = match self.semantic_context(bundle, args).await? {
            Ok(c) => c,
            Err(reason) => {
                return Ok(
                    json!({"status":"skipped","reason":reason,"results":[],"total":0,"bundle_id":bundle.id}),
                )
            }
        };
        let mut heap = BinaryHeap::new();
        let total = visit_semantic(&self.store, bundle, &context, |hit| {
            heap.push(Reverse(hit));
            if heap.len() > k {
                heap.pop();
            }
            Ok(())
        })?;
        if total.valid == 0 {
            return Ok(
                json!({"status":"skipped","reason":"No compatible MID vectors are available.","results":[],"total":0,"bundle_id":bundle.id}),
            );
        }
        let mut hits = heap.into_iter().map(|h| h.0).collect::<Vec<_>>();
        hits.sort_by(|a, b| b.cmp(a));
        let results = hits
            .iter()
            .skip(args.offset)
            .map(|hit| semantic_row(&self.store, bundle, hit))
            .collect::<Result<Vec<_>>>()?;
        Ok(
            json!({"status":"searched","bundle_id":bundle.id,"columns":bundle.columns,"results":results,"total":total.matched,"missing_vectors":total.missing,"offset":args.offset,"limit":args.limit}),
        )
    }
    async fn iscc(&self, args: &IsccArgs, arguments: &Value) -> Result<Value> {
        text(&args.query, 300)?;
        if !(1..=1000).contains(&args.count) {
            return Err(invalid("count must be 1..1000"));
        }
        let simulated = crate::simulate::enabled();
        let mut rows = if simulated {
            crate::simulate::iscc_rows(&self.store, "", &args.query)?
        } else {
            iscc_adapter(args).await?
        };
        rows.truncate(args.count);
        for row in &mut rows {
            if let Some(obj) = row.as_object_mut() {
                obj.retain(|key, _| crate::identity::normalize_header(key) != "iqlink");
            }
        }
        let record = self.store.record_search(
            None,
            "SPACE_ISCC",
            &args.query,
            arguments,
            &json!({"total":rows.len(),"simulated":simulated}),
        )?;
        let hydrated = DataService::new(self.store.clone()).ingest_iscc_rows_with_simulation(
            None,
            record["query_id"].as_str(),
            &rows,
            simulated,
        )?;
        let query = record["query_id"].as_str().expect("query id");
        let results = self.store.with_connection(|c| {
            let mut stmt = c.prepare("SELECT s.company_id,c.name,c.website,s.row_json FROM source_rows s JOIN companies c USING(company_id) WHERE s.source='ISCC' AND s.run_scope='' AND s.query_scope=? ORDER BY s.source_row_id")?;
            let rows = stmt.query_map([query],|r|Ok(json!({"company_id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"website":r.get::<_,Option<String>>(2)?,"values":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(Value::Null),"simulated":simulated})))?.collect::<std::result::Result<Vec<_>,_>>()?;
            Ok(rows)
        })?;
        let columns = rows
            .iter()
            .filter_map(Value::as_object)
            .flat_map(|r| r.keys().cloned())
            .collect::<BTreeSet<_>>();
        Ok(
            json!({"query_id":query,"results":results,"columns":columns,"total":results.len(),"simulated":simulated,"ingestion":hydrated}),
        )
    }
    fn recent(&self, args: RecentArgs) -> Result<Value> {
        if !(1..=200).contains(&args.limit) {
            return Err(invalid("limit must be 1..200"));
        }
        self.store.with_connection(|c| {
            let mut stmt = c.prepare("SELECT query_id,source,query,parameters_json,results_json,created_at FROM search_queries WHERE run_id IS NULL AND source IN ('SPACE_LEXICAL','SPACE_SEMANTIC','SPACE_ISCC') ORDER BY created_at DESC,rowid DESC LIMIT ?")?;
            let queries = stmt.query_map([args.limit as i64],|r|Ok(json!({"query_id":r.get::<_,String>(0)?,"source":r.get::<_,String>(1)?,"query":r.get::<_,String>(2)?,"parameters":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(Value::Null),"results":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).unwrap_or(Value::Null),"created_at":r.get::<_,String>(5)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
            Ok(json!({"queries":queries}))
        })
    }
    fn add(&self, bundle: &Bundle, args: AddArgs) -> Result<Value> {
        if args.company_ids.is_empty() || args.company_ids.len() > 5000 {
            return Err(invalid("company_ids must contain 1..5000 entries"));
        }
        let unique = args.company_ids.iter().collect::<BTreeSet<_>>();
        if unique.len() != args.company_ids.len() {
            return Err(invalid("Duplicate company ids"));
        }
        self.store
            .execute("get_run_context", &json!({"run_id":args.run_id}))?;
        let query_source = if let Some(query) = &args.query_id {
            let record = self.store.get_search_query(query)?;
            if !record["run_id"].is_null()
                || !record["source"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("SPACE_"))
            {
                return Err(invalid("query_id must be a Search Space query"));
            }
            Some(record["source"].as_str().unwrap().to_owned())
        } else {
            None
        };
        let mut groups = BTreeMap::<String, Vec<String>>::new();
        let mut iscc_rows = Vec::new();
        self.store.with_connection(|c| {
            for id in &args.company_ids {
                let mid = c.query_row("SELECT 1 FROM mid_rows WHERE bundle_id=? AND company_id=?",params![bundle.id,id],|r|r.get::<_,i64>(0)).optional()?.is_some();
                let iscc = c.query_row("SELECT row_json,simulated FROM source_rows WHERE source='ISCC' AND run_scope='' AND company_id=? AND (? IS NULL OR query_scope=?) ORDER BY imported_at DESC,source_row_id DESC LIMIT 1",params![id,if query_source.as_deref()==Some("SPACE_ISCC") {args.query_id.as_deref()} else {None},args.query_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,bool>(1)?))).optional()?;
                let source = if query_source.as_deref()==Some("SPACE_ISCC") || !mid { "ISCC" } else { "MID" };
                if source == "ISCC" {
                    let (raw,simulated) = iscc.ok_or_else(||invalid(format!("Company is not in Search Space: {id}")))?;
                    iscc_rows.push((serde_json::from_str::<Value>(&raw)?,simulated));
                } else if !mid { return Err(invalid(format!("Company is not in active MID bundle: {id}"))); }
                groups.entry(source.into()).or_default().push(id.clone());
            }
            Ok(())
        })?;
        // Run source projections scope ISCC rows to the run. Copy the selected
        // hydration through the existing ingestion path so its provenance survives.
        let data = DataService::new(self.store.clone());
        for simulated in [false, true] {
            let rows = iscc_rows
                .iter()
                .filter(|(_, s)| *s == simulated)
                .map(|(r, _)| r.clone())
                .collect::<Vec<_>>();
            for chunk in rows.chunks(1000) {
                data.ingest_iscc_rows_with_simulation(Some(&args.run_id), None, chunk, simulated)?;
            }
        }
        let mut added = 0;
        for (source, ids) in groups {
            for chunk in ids.chunks(1000) {
                let result = self.store.execute("add_candidates",&json!({"run_id":args.run_id,"companies":chunk,"discovery_source":source,"query_id":args.query_id}))?;
                added += result["added"].as_u64().unwrap_or(0);
            }
        }
        Ok(
            json!({"run_id":args.run_id,"requested":args.company_ids.len(),"added":added,"query_id":args.query_id}),
        )
    }
    async fn export(&self, bundle: &Bundle, args: ExportArgs) -> Result<Value> {
        let _ = args.format;
        std::fs::create_dir_all(export_dir())?;
        prune_exports()?;
        let file = format!("space-{}.xlsx", uuid::Uuid::new_v4());
        let path = export_dir().join(&file);
        let mut cleanup = ExportCleanup {
            path: path.clone(),
            keep: false,
        };
        let mut workbook = rust_xlsxwriter::Workbook::new();
        workbook
            .set_tempdir(export_dir())
            .map_err(|e| Error::Internal(e.to_string()))?;
        let sheet = workbook.add_worksheet_with_constant_memory();
        let mut written = 0u32;
        match args.search {
            SearchArgs::Browse(search) => {
                page(search.offset, search.limit)?;
                let columns = export_columns(bundle, &[]);
                write_headers(sheet, &columns)?;
                if let Some(sort) = &search.sort {
                    // Sort the narrow identity list once; hydrate wide cells one at a
                    // time. Re-running ORDER BY for every page is quadratic work.
                    let ids = self.sorted_ids(bundle, sort)?;
                    for id in ids {
                        written += 1;
                        write_row(
                            sheet,
                            written,
                            &columns,
                            &hydrate(&self.store, bundle, &id)?,
                        )?;
                    }
                } else {
                    let mut cursor = 0;
                    loop {
                        let rows = row_page(&self.store, bundle, cursor, 200)?;
                        if rows.is_empty() {
                            break;
                        }
                        cursor = rows.last().expect("rows").0;
                        for (_, row) in rows {
                            written += 1;
                            write_row(sheet, written, &columns, &row)?;
                        }
                    }
                }
            }
            SearchArgs::Lexical(search) => {
                page(search.offset, search.limit)?;
                let hits = self.lexical_hits(bundle, &search).await?;
                let columns = export_columns(
                    bundle,
                    &[
                        "matched_keywords",
                        "raw_score",
                        "hit_count",
                        "match_strength",
                    ],
                );
                write_headers(sheet, &columns)?;
                for hit in &hits.hits {
                    written += 1;
                    write_row(
                        sheet,
                        written,
                        &columns,
                        &lexical_row(&self.store, bundle, hit, &hits.keywords)?,
                    )?;
                }
            }
            SearchArgs::Semantic(search) => {
                page(search.offset, search.limit)?;
                let context = self
                    .semantic_context(bundle, &search)
                    .await?
                    .map_err(Error::ProviderUnavailable)?;
                let columns = export_columns(bundle, &["score", "cosine"]);
                write_headers(sheet, &columns)?;
                let totals = visit_semantic(&self.store, bundle, &context, |hit| {
                    written += 1;
                    write_row(
                        sheet,
                        written,
                        &columns,
                        &semantic_row(&self.store, bundle, &hit)?,
                    )
                })?;
                if totals.valid == 0 {
                    return Err(Error::ProviderUnavailable(
                        "No compatible MID vectors are available.".into(),
                    ));
                }
            }
            SearchArgs::Iscc(search) => {
                if crate::simulate::enabled() && !args.allow_simulated {
                    return Err(invalid(
                        "Export contains simulated data; set allow_simulated explicitly.",
                    ));
                }
                let result = self
                    .iscc(&search, &json!({"query":search.query,"count":search.count}))
                    .await?;
                let mut columns = vec!["company_id".to_owned()];
                columns.extend(
                    result["columns"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_owned),
                );
                if result["simulated"] == true {
                    columns.push("simulated".into());
                }
                write_headers(sheet, &columns)?;
                for row in result["results"].as_array().expect("ISCC results") {
                    written += 1;
                    write_row(sheet, written, &columns, row)?;
                }
            }
        }
        workbook
            .save(&path)
            .map_err(|e| Error::Internal(format!("XLSX export failed: {e}")))?;
        cleanup.keep = true;
        Ok(json!({"file":file,"rows":written}))
    }
    fn sorted_ids(&self, bundle: &Bundle, sort: &Sort) -> Result<Vec<String>> {
        if !bundle.columns.contains(&sort.column) {
            return Err(invalid("Sort column is not in the active MID workbook"));
        }
        let key = if bundle.numbers.contains(&sort.column) {
            "CAST(json_extract(r.row_json, ?) AS REAL)"
        } else {
            "json_extract(r.row_json, ?) COLLATE NOCASE"
        };
        let direction = if matches!(sort.direction, Direction::Asc) {
            "ASC"
        } else {
            "DESC"
        };
        let path = format!("$.{}", serde_json::to_string(&sort.column)?);
        self.store.with_connection(|c| {
            let mut stmt = c.prepare(&format!("SELECT r.company_id FROM mid_rows r JOIN companies c USING(company_id) WHERE r.bundle_id=? ORDER BY {key} {direction},c.name COLLATE NOCASE,r.company_id"))?;
            let ids = stmt.query_map(params![bundle.id, path], |r| r.get(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(ids)
        })
    }
}
struct SyncRunning(std::sync::Arc<std::sync::atomic::AtomicBool>);
impl Drop for SyncRunning {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}
struct ExportCleanup {
    path: PathBuf,
    keep: bool,
}
impl Drop for ExportCleanup {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
/// Recent searches record a search once, on its first page, not on every page turn.
fn first_page(arguments: &Value) -> bool {
    arguments.get("offset").and_then(Value::as_u64).unwrap_or(0) == 0
}

fn prune_exports() -> Result<()> {
    let now = std::time::SystemTime::now();
    for entry in std::fs::read_dir(export_dir())? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("space-") && name.ends_with(".xlsx") {
            // A locked or vanished old export must never block a new one.
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_file()
                && meta
                    .modified()
                    .ok()
                    .and_then(|m| now.duration_since(m).ok())
                    .is_some_and(|age| age > Duration::from_secs(7 * 24 * 60 * 60))
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}
fn xlsx_text(value: &str) -> String {
    if value.encode_utf16().count() <= 32767 {
        return value.to_owned();
    }
    let mut units = 0;
    let mut result = String::new();
    for ch in value.chars() {
        units += ch.len_utf16();
        if units > 32766 {
            break;
        }
        result.push(ch);
    }
    result.push('…');
    result
}
struct LexicalHit {
    id: String,
    name: String,
    strength: f64,
    matched: u64,
}
struct LexicalResults {
    hits: Vec<LexicalHit>,
    keywords: Vec<(String, Keyword)>,
}
fn lexical_row(
    store: &Store,
    bundle: &Bundle,
    hit: &LexicalHit,
    keywords: &[(String, Keyword)],
) -> Result<Value> {
    let mut row = hydrate(store, bundle, &hit.id)?;
    row["matched_keywords"] = json!(keywords
        .iter()
        .enumerate()
        .filter(|(i, _)| hit.matched & (1u64 << i) != 0)
        .map(|(_, (id, k))| json!({"id":id,"text":k.text}))
        .collect::<Vec<_>>());
    row["raw_score"] = json!(hit.matched.count_ones());
    row["hit_count"] = json!(hit.matched.count_ones());
    row["match_strength"] = json!(hit.strength);
    Ok(row)
}
type Expression = (
    BTreeMap<String, Keyword>,
    mid_search::Expr,
    BTreeSet<String>,
);
fn lexical_expression(args: &LexicalArgs) -> Result<Expression> {
    if args.keywords.len() > 50 {
        return Err(invalid("At most 50 keywords are allowed"));
    }
    let mut keywords = BTreeMap::new();
    for (n, k) in args.keywords.iter().enumerate() {
        text(&k.text, 80)?;
        let id = k.id.clone().unwrap_or_else(|| format!("k{}", n + 1));
        if id.is_empty()
            || id.len() > 80
            || id.chars().any(|c| c.is_whitespace() || "()\"".contains(c))
            || ["AND", "OR", "NOT", "and", "or", "not"].contains(&id.as_str())
        {
            return Err(invalid("Keyword ids must be single tokens, not operators"));
        }
        if keywords.insert(id, k.clone()).is_some() {
            return Err(invalid("Keyword ids must be unique"));
        }
    }
    let default = keywords.keys().cloned().collect::<Vec<_>>().join(" OR ");
    let source = args.expression.as_deref().unwrap_or(&default);
    if source.chars().count() > 500 {
        return Err(invalid("Expression exceeds 500 characters"));
    }
    let auto = keywords.is_empty();
    let mut aliases = keywords
        .iter()
        .map(|(id, k)| (k.text.trim().to_owned(), id.clone()))
        .collect::<Vec<_>>();
    aliases.sort_by_key(|(text, _)| Reverse(text.len()));
    let mut remaining = source.trim();
    let mut tokens = Vec::new();
    // Scan the original expression once; replacing aliases repeatedly can corrupt
    // expressions when one keyword's text is another keyword's id.
    while !remaining.is_empty() {
        let boundary = |tail: &str| {
            tail.is_empty() || tail.starts_with(|c: char| c.is_whitespace() || c == '(' || c == ')')
        };
        if remaining.starts_with(['(', ')']) {
            tokens.push(remaining[..1].to_owned());
            remaining = remaining[1..].trim_start();
            continue;
        }
        let end = remaining
            .find(|c: char| c.is_whitespace() || c == '(' || c == ')')
            .unwrap_or(remaining.len());
        let token = &remaining[..end];
        if ["AND", "OR", "NOT"].contains(&token) || keywords.contains_key(token) {
            tokens.push(token.to_owned());
            remaining = remaining[end..].trim_start();
            continue;
        }
        let (operand, consumed) = if let Some(quoted) = remaining.strip_prefix('"') {
            let end = quoted
                .find('"')
                .ok_or_else(|| invalid("Unclosed keyword phrase"))?;
            (&quoted[..end], end + 2)
        } else if let Some((alias, _)) = aliases
            .iter()
            .find(|(alias, _)| remaining.starts_with(alias) && boundary(&remaining[alias.len()..]))
        {
            (alias.as_str(), alias.len())
        } else {
            (token, end)
        };
        let id = if let Some((_, id)) = aliases.iter().find(|(alias, _)| alias == operand) {
            id.clone()
        } else if auto {
            if ["and", "or", "not"].contains(&operand) {
                return Err(invalid("Boolean operators must be uppercase"));
            }
            text(operand, 80)?;
            let id = format!("k{}", keywords.len() + 1);
            if let Some((id, _)) = keywords.iter().find(|(_, k)| k.text == operand) {
                id.clone()
            } else {
                keywords.insert(
                    id.clone(),
                    Keyword {
                        id: Some(id.clone()),
                        text: operand.into(),
                        r#match: Match::Stem,
                    },
                );
                id
            }
        } else {
            operand.to_owned()
        };
        tokens.push(id);
        remaining = remaining[consumed..].trim_start();
    }
    let expression = tokens.join(" ");
    if keywords.is_empty() || keywords.len() > 50 {
        return Err(invalid("A search requires 1..50 keywords"));
    }
    let (tree, _) = mid_search::expression(&expression)?;
    let mut positives = BTreeSet::new();
    let mut negatives = BTreeSet::new();
    tree.ids(false, &mut positives, &mut negatives);
    for id in positives.union(&negatives) {
        if !keywords.contains_key(id) {
            return Err(invalid(format!("Unknown keyword: {id}")));
        }
    }
    // Expression overrides the chips: unused chips do not affect strength or cause
    // provider queries. Only keywords with a positive operand enter the denominator
    // (including a keyword also used negatively in a different expression branch).
    let used = positives
        .union(&negatives)
        .cloned()
        .collect::<BTreeSet<_>>();
    keywords.retain(|id, _| used.contains(id));
    if positives.is_empty() {
        return Err(invalid("Expression must contain a positive keyword"));
    }
    Ok((keywords, tree, positives))
}
struct SemanticContext {
    model: retrieval::ModelIdentity,
    query: Vec<f32>,
    min: f64,
}
struct SemanticTotals {
    valid: usize,
    missing: usize,
    matched: usize,
}
struct SemanticHit {
    id: String,
    name: String,
    cosine: f64,
    score: f64,
}
impl PartialEq for SemanticHit {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for SemanticHit {}
impl PartialOrd for SemanticHit {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for SemanticHit {
    fn cmp(&self, other: &Self) -> Ordering {
        self.score
            .total_cmp(&other.score)
            .then_with(|| self.cosine.total_cmp(&other.cosine))
            .then_with(|| other.name.to_lowercase().cmp(&self.name.to_lowercase()))
            .then_with(|| other.id.cmp(&self.id))
    }
}
fn visit_semantic(
    store: &Store,
    bundle: &Bundle,
    context: &SemanticContext,
    mut visit: impl FnMut(SemanticHit) -> Result<()>,
) -> Result<SemanticTotals> {
    let mut cursor = 0;
    let mut totals = SemanticTotals {
        valid: 0,
        missing: 0,
        matched: 0,
    };
    let norm = |v: &[f32]| v.iter().map(|n| f64::from(*n).powi(2)).sum::<f64>().sqrt();
    loop {
        let rows = store.with_connection(|c| {
            let mut stmt = c.prepare("SELECT r.row_no,r.company_id,c.name,r.desc_hash,e.text_hash,e.dimensions,e.vector_blob FROM mid_rows r JOIN companies c USING(company_id) LEFT JOIN embedding_vectors e ON e.company_id=r.company_id AND e.model=? AND e.model_version=? WHERE r.bundle_id=? AND r.row_no>? ORDER BY r.row_no LIMIT 256")?;
            let rows = stmt.query_map(params![context.model.model,context.model.version,bundle.id,cursor],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,Option<i64>>(5)?,r.get::<_,Option<Vec<u8>>>(6)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
            Ok(rows)
        })?;
        if rows.is_empty() {
            break;
        }
        for (row_no, id, name, hash, vector_hash, dimensions, blob) in rows {
            cursor = row_no;
            let vector = blob
                .filter(|v| v.len() == context.model.dimensions * 4)
                .map(|v| {
                    v.as_chunks::<4>()
                        .0
                        .iter()
                        .map(|b| f32::from_le_bytes(*b))
                        .collect::<Vec<_>>()
                });
            if dimensions != Some(context.model.dimensions as i64)
                || vector_hash.as_ref() != Some(&hash)
                || vector
                    .as_ref()
                    .is_none_or(|v| retrieval::validate_vector(v, &context.model).is_err())
            {
                totals.missing += 1;
                continue;
            }
            let vector = vector.expect("validated vector");
            let dot = vector
                .iter()
                .zip(&context.query)
                .map(|(a, b)| f64::from(*a) * f64::from(*b))
                .sum::<f64>();
            let cosine = (dot / (norm(&vector) * norm(&context.query))).clamp(-1.0, 1.0);
            let score = (100.0 * cosine.max(0.0)).round() / 10.0;
            totals.valid += 1;
            if score < context.min {
                continue;
            }
            totals.matched += 1;
            visit(SemanticHit {
                id,
                name,
                cosine,
                score,
            })?;
        }
    }
    Ok(totals)
}
fn semantic_row(store: &Store, bundle: &Bundle, hit: &SemanticHit) -> Result<Value> {
    let mut row = hydrate(store, bundle, &hit.id)?;
    row["score"] = json!(hit.score);
    row["cosine"] = json!(hit.cosine);
    Ok(row)
}
fn export_columns(bundle: &Bundle, extra: &[&str]) -> Vec<String> {
    let mut cols = vec!["company_id".into()];
    cols.extend(bundle.columns.iter().cloned());
    cols.extend(extra.iter().map(|s| s.to_string()));
    cols
}
fn write_headers(sheet: &mut rust_xlsxwriter::Worksheet, columns: &[String]) -> Result<()> {
    if columns.len() > 16384 {
        return Err(invalid("Too many XLSX columns"));
    }
    for (col, name) in columns.iter().enumerate() {
        sheet
            .write_string(0, col as u16, xlsx_text(name))
            .map_err(|e| Error::Internal(e.to_string()))?;
    }
    Ok(())
}
fn write_row(
    sheet: &mut rust_xlsxwriter::Worksheet,
    row: u32,
    columns: &[String],
    value: &Value,
) -> Result<()> {
    for (col, name) in columns.iter().enumerate() {
        let v = value.get(name).unwrap_or(&value["values"][name]);
        if v.is_null() {
            continue;
        }
        if let Some(number) = v.as_f64() {
            sheet
                .write_number(row, col as u16, number)
                .map_err(|e| Error::Internal(e.to_string()))?;
        } else {
            let text = v
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| v.to_string());
            sheet
                .write_string(row, col as u16, xlsx_text(&text))
                .map_err(|e| Error::Internal(e.to_string()))?;
        }
    }
    Ok(())
}
/// Adapter boundary for the real ISCC Excel dump; simulation bypasses it.
pub fn iscc_dump_rows(bytes: &[u8]) -> Result<Vec<Value>> {
    let mut workbook: Xlsx<_> = Xlsx::new(Cursor::new(bytes))
        .map_err(|e| Error::ProviderUnavailable(format!("Invalid ISCC Excel dump: {e}")))?;
    let mut rows = Vec::new();
    for name in workbook.sheet_names() {
        let range = workbook
            .worksheet_range(&name)
            .map_err(|e| Error::ProviderUnavailable(e.to_string()))?;
        let mut iter = range.rows();
        let Some(header) = iter.next() else { continue };
        let headers = header.iter().map(ToString::to_string).collect::<Vec<_>>();
        if !headers.iter().any(|h| {
            matches!(
                crate::identity::normalize_header(h).as_str(),
                "cid" | "eci" | "ecid"
            )
        }) {
            continue;
        }
        for cells in iter {
            if cells.iter().all(|c| c.to_string().trim().is_empty()) {
                continue;
            }
            let mut row = json!({});
            for (i, h) in headers.iter().enumerate() {
                if !h.trim().is_empty() && crate::identity::normalize_header(h) != "iqlink" {
                    row[h] = json!(cells.get(i).map(ToString::to_string).unwrap_or_default());
                }
            }
            rows.push(row);
            if rows.len() > 1000 {
                return Err(Error::ProviderUnavailable(
                    "ISCC dump exceeds 1000 rows".into(),
                ));
            }
        }
    }
    if rows.is_empty() {
        return Err(Error::ProviderUnavailable(
            "ISCC dump contains no company rows".into(),
        ));
    }
    Ok(rows)
}
async fn iscc_adapter(args: &IsccArgs) -> Result<Vec<Value>> {
    if std::env::var("MNA_ENABLE_EXTERNAL").ok().as_deref() != Some("true") {
        return Err(Error::ProviderUnavailable(
            "ISCC is unavailable; external providers are disconnected.".into(),
        ));
    }
    let endpoint = std::env::var("MNA_ISCC_ENDPOINT")
        .map_err(|_| Error::ProviderUnavailable("ISCC endpoint is not configured".into()))?;
    let token = std::env::var("MNA_ISCC_TOKEN")
        .map_err(|_| Error::ProviderUnavailable("ISCC token is not configured".into()))?;
    let url = reqwest::Url::parse(&endpoint).map_err(|_| invalid("Invalid ISCC endpoint"))?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid(
            "ISCC endpoint must be HTTP(S) without URL credentials",
        ));
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(30))
        .build()?;
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&json!({"query":args.query,"limit":args.count}))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(Error::ProviderUnavailable(format!(
            "ISCC returned HTTP {}",
            response.status().as_u16()
        )));
    }
    let bytes = crate::providers::read_bounded(response, 16_000_000).await?;
    iscc_dump_rows(&bytes)
}
