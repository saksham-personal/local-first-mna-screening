//! Durable MID index builds. Only bounded batches hold a write transaction; the
//! workbook and local inference run on a dedicated thread and SQLite connection.
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    time::Instant,
};

use calamine::{open_workbook, DataRef, Reader, Xlsx};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::{
    data::{ingest_source_row, IngestCounters},
    error::{Error, Result},
    identity::{field_text, normalize_header},
    mid_config::MidIndexConfig,
    retrieval::{self, Embedder, LocalHttpAdapter, RetrievalConfig},
    store::Store,
    tabular,
};

const BATCH: usize = 5_000;
const CANCELLED: &str = "Index build cancelled";
const STEP_DEFS: [(&str, &str); 8] = [
    ("read_workbook", "Read workbook"),
    ("validate_headers", "Check columns"),
    ("normalize_identifiers", "Match company IDs"),
    ("store_rows", "Store rows"),
    ("keyword_index", "Build keyword index"),
    ("semantic_embeddings", "Semantic embeddings"),
    ("verify", "Verify"),
    ("activate", "Activate"),
];

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct EmptyArgs {}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct BuildArgs {
    build_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct BundleArgs {
    bundle_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    #[serde(default = "default_limit")]
    #[schemars(range(min = 1, max = 50))]
    limit: usize,
}
fn default_limit() -> usize {
    20
}
fn default_activate() -> bool {
    true
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct StartArgs {
    file: String,
    #[schemars(length(min = 1, max = 120))]
    name: String,
    #[serde(default = "default_activate")]
    activate_on_success: bool,
}

pub fn input_schema(tool: &str) -> Option<Value> {
    let schema = match tool {
        "get_mid_index_status" => schemars::schema_for!(EmptyArgs),
        "get_index_build" | "cancel_index_build" => schemars::schema_for!(BuildArgs),
        "list_index_builds" => schemars::schema_for!(ListArgs),
        "start_index_build" => schemars::schema_for!(StartArgs),
        "activate_mid_bundle" | "delete_mid_bundle" => schemars::schema_for!(BundleArgs),
        _ => return None,
    };
    let mut value = serde_json::to_value(schema).ok()?;
    // The runtime catalog contract includes properties even for empty objects.
    if tool == "get_mid_index_status" {
        value["properties"] = json!({});
    }
    Some(value)
}

fn parse<T: serde::de::DeserializeOwned>(args: &Value) -> Result<T> {
    serde_json::from_value(args.clone()).map_err(|e| Error::Validation(e.to_string()))
}
fn now() -> String {
    Utc::now().to_rfc3339()
}

pub fn execute(store: &Store, tool: &str, args: &Value) -> Result<Value> {
    match tool {
        "start_index_build" => start(store, parse(args)?),
        "get_index_build" => {
            let args: BuildArgs = parse(args)?;
            store.with_connection(|c| build_value(c, &args.build_id))
        }
        "get_mid_index_status" => {
            let _: EmptyArgs = parse(args)?;
            let config = MidIndexConfig::load()?;
            store.with_connection(|c| {
                let active = c.query_row("SELECT bundle_id,name,row_count,activated_at,semantic_status,semantic_model,config_hash,fts_id FROM mid_bundles WHERE status='active'", [], |r|
                    Ok(json!({"bundle_id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"row_count":r.get::<_,i64>(2)?,"activated_at":r.get::<_,Option<String>>(3)?,"semantic_status":r.get::<_,String>(4)?,"semantic_model":r.get::<_,Option<String>>(5)?,"config_hash":r.get::<_,String>(6)?,"fts_id":r.get::<_,i64>(7)?}))).optional()?;
                let running: Option<String> = c.query_row("SELECT build_id FROM index_builds WHERE status IN ('queued','running') LIMIT 1", [], |r| r.get(0)).optional()?;
                let running = running.map(|id| build_value(c, &id)).transpose()?;
                Ok(json!({"active":active,"running_build":running,"config":{
                    "search_columns":config.search_columns,"llm_description_columns":config.llm_description_columns,
                    "fts5_column_names":config.fts5_column_names,"source_weights":config.source_weights,"identifier_columns":config.identifier_columns}}))
            })
        }
        "list_index_builds" => {
            let args: ListArgs = parse(args)?;
            if !(1..=50).contains(&args.limit) {
                return Err(Error::Validation("limit must be 1..=50".into()));
            }
            store.with_connection(|c| {
                let ids = c.prepare("SELECT build_id FROM index_builds ORDER BY started_at DESC,build_id DESC LIMIT ?")?
                    .query_map([args.limit as i64], |r| r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
                let builds = ids.iter().map(|id| build_value(c, id)).collect::<Result<Vec<_>>>()?;
                let bundles = c.prepare("SELECT bundle_id,name,status,row_count,created_at,activated_at,semantic_status FROM mid_bundles ORDER BY created_at DESC,bundle_id DESC LIMIT ?")?
                    .query_map([args.limit as i64], |r| Ok(json!({"bundle_id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"row_count":r.get::<_,i64>(3)?,"created_at":r.get::<_,String>(4)?,"activated_at":r.get::<_,Option<String>>(5)?,"semantic_status":r.get::<_,String>(6)?})))?
                    .collect::<std::result::Result<Vec<_>,_>>()?;
                Ok(json!({"builds":builds,"bundles":bundles}))
            })
        }
        "cancel_index_build" => {
            let args: BuildArgs = parse(args)?;
            store.with_connection(|c| {
                let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let build = build_value(&tx, &args.build_id)?;
                if build["status"] != "running" && build["status"] != "queued" {
                    return Err(Error::Conflict(
                        "Only a running build can be cancelled".into(),
                    ));
                }
                tx.execute(
                    "UPDATE index_builds SET cancel_requested=1,updated_at=? WHERE build_id=?",
                    params![now(), args.build_id],
                )?;
                tx.commit()?;
                build_value(c, &args.build_id)
            })
        }
        "activate_mid_bundle" => {
            let args: BundleArgs = parse(args)?;
            store.with_connection(|c| {
                let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
                activate_bundle(&tx, &args.bundle_id)?;
                tx.commit()?;
                Ok(json!({"bundle_id":args.bundle_id,"status":"active"}))
            })
        }
        "delete_mid_bundle" => {
            let args: BundleArgs = parse(args)?;
            store.with_connection(|c| {
                let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let (fts, status) = bundle_info(&tx, &args.bundle_id)?;
                if matches!(status.as_str(), "active" | "building") {
                    return Err(Error::Conflict(
                        "Cannot delete an active or building bundle".into(),
                    ));
                }
                drop_fts(&tx, fts)?;
                tx.execute(
                    "DELETE FROM mid_bundles WHERE bundle_id=?",
                    [&args.bundle_id],
                )?;
                tx.commit()?;
                Ok(json!({"bundle_id":args.bundle_id,"deleted":true}))
            })
        }
        _ => Err(Error::Validation(format!(
            "unknown index build tool: {tool}"
        ))),
    }
}

fn build_value(c: &Connection, id: &str) -> Result<Value> {
    let raw = c.query_row("SELECT i.build_id,i.bundle_id,i.status,i.current_step,i.steps_json,i.rows_total,i.rows_done,i.activate_on_success,i.cancel_requested,i.log_json,i.started_at,i.updated_at,i.finished_at,i.error,b.name,b.source_file,b.status,b.row_count,b.semantic_status FROM index_builds i JOIN mid_bundles b ON b.bundle_id=i.bundle_id WHERE i.build_id=?", [id], |r| {
        Ok(json!({"build_id":r.get::<_,String>(0)?,"bundle_id":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"current_step":r.get::<_,Option<String>>(3)?,"steps":r.get::<_,String>(4)?,"rows_total":r.get::<_,Option<i64>>(5)?,"rows_done":r.get::<_,i64>(6)?,"activate_on_success":r.get::<_,bool>(7)?,"cancel_requested":r.get::<_,bool>(8)?,"log":r.get::<_,String>(9)?,"started_at":r.get::<_,String>(10)?,"updated_at":r.get::<_,String>(11)?,"finished_at":r.get::<_,Option<String>>(12)?,"error":r.get::<_,Option<String>>(13)?,"bundle":{"name":r.get::<_,String>(14)?,"source_file":r.get::<_,String>(15)?,"status":r.get::<_,String>(16)?,"row_count":r.get::<_,i64>(17)?,"semantic_status":r.get::<_,String>(18)?}}))
    }).optional()?.ok_or_else(|| Error::NotFound(format!("Index build not found: {id}")))?;
    let mut value = raw;
    value["steps"] = serde_json::from_str(value["steps"].as_str().unwrap_or("[]"))?;
    value["log"] = serde_json::from_str(value["log"].as_str().unwrap_or("[]"))?;
    Ok(value)
}

#[derive(Serialize)]
struct Step {
    id: &'static str,
    label: &'static str,
    status: &'static str,
    rows_done: usize,
    rows_total: Option<usize>,
    started_at: Option<String>,
    finished_at: Option<String>,
    rate_per_sec: Option<f64>,
    eta_seconds: Option<f64>,
    detail: Option<String>,
}
fn steps() -> Vec<Step> {
    STEP_DEFS
        .iter()
        .map(|&(id, label)| Step {
            id,
            label,
            status: "pending",
            rows_done: 0,
            rows_total: None,
            started_at: None,
            finished_at: None,
            rate_per_sec: None,
            eta_seconds: None,
            detail: None,
        })
        .collect()
}

fn start(store: &Store, args: StartArgs) -> Result<Value> {
    let db = store.db_path();
    if db.as_os_str().is_empty() || db == Path::new(":memory:") {
        return Err(Error::Validation(
            "Index builds need a file database".into(),
        ));
    }
    if args.name.trim().is_empty() || args.name.chars().count() > 120 {
        return Err(Error::Validation(
            "name must contain 1..120 characters".into(),
        ));
    }
    let path = tabular::resolve_import_path(&args.file)?;
    if !path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("xlsx"))
    {
        return Err(Error::Validation(
            "Index builds require an .xlsx workbook".into(),
        ));
    }
    let config = MidIndexConfig::load()?;
    let build_id = format!("IDX-{}", Uuid::new_v4());
    let bundle_id = format!("MID-{}", Uuid::new_v4());
    let fts = store.with_connection(|c| {
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let running: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM index_builds WHERE status IN ('queued','running'))", [], |r| r.get(0))?;
        if running { return Err(Error::Conflict("An index build is already running".into())); }
        let fts: i64 = tx.query_row("SELECT COALESCE(MAX(fts_id),0)+1 FROM mid_bundles", [], |r| r.get(0))?;
        tx.execute("INSERT INTO mid_bundles(bundle_id,fts_id,name,status,source_file,config_json,config_hash,created_at) VALUES(?,?,?,'building',?,?,?,?)",
            params![bundle_id,fts,args.name,args.file,serde_json::to_string(&config)?,config.config_hash()?,now()])?;
        tx.execute("INSERT INTO index_builds(build_id,bundle_id,status,steps_json,activate_on_success,started_at,updated_at) VALUES(?,?,'running',?,?,?,?)",
            params![build_id,bundle_id,serde_json::to_string(&steps())?,args.activate_on_success,now(),now()])?;
        tx.commit()?; Ok(fts)
    })?;
    let db = db.to_path_buf();
    let worker_id = build_id.clone();
    let worker_bundle = bundle_id.clone();
    let fallback = store.clone();
    let spawned = std::thread::Builder::new().name("mid-index-build".into()).spawn(move || {
        let outcome = worker_connection(&db).and_then(|conn| {
            let mut worker = Worker { conn, build:worker_id.clone(), bundle:worker_bundle.clone(), fts, config,
                steps:steps(), log:Vec::new(), done:0,total:None,stored:0,duplicates:0,counters:IngestCounters::default(),activate:args.activate_on_success };
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| worker.run(path)))
                .unwrap_or_else(|_| Err(Error::Internal("Index worker panicked".into())));
            worker.finish(result)
        });
        if let Err(e) = outcome {
            tracing::error!(error=%e,build_id=%worker_id,"MID build worker failed");
            let _ = fallback.with_connection(|c| {
                c.execute("UPDATE index_builds SET status='failed',error=?,updated_at=?,finished_at=? WHERE build_id=? AND status='running'",params![e.to_string(),now(),now(),worker_id])?;
                c.execute("UPDATE mid_bundles SET status='failed',error=? WHERE bundle_id=? AND status='building'",params![e.to_string(),worker_bundle])?;
                Ok(())
            });
        }
    });
    if let Err(e) = spawned {
        store.with_connection(|c| {
            let tx = c.transaction()?;
            tx.execute("UPDATE index_builds SET status='failed',error=?,finished_at=?,updated_at=? WHERE build_id=?",params![e.to_string(),now(),now(),build_id])?;
            tx.execute("UPDATE mid_bundles SET status='failed',error=? WHERE bundle_id=?",params![e.to_string(),bundle_id])?;
            tx.commit()?; Ok(())
        })?;
        return Err(e.into());
    }
    Ok(json!({"build_id":build_id,"bundle_id":bundle_id,"status":"running"}))
}

fn worker_connection(path: &Path) -> Result<Connection> {
    let c = Connection::open(path)?;
    c.busy_timeout(std::time::Duration::from_millis(5_000))?;
    c.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")?;
    Ok(c)
}
fn bundle_info(c: &Connection, id: &str) -> Result<(i64, String)> {
    c.query_row(
        "SELECT fts_id,status FROM mid_bundles WHERE bundle_id=?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| Error::NotFound(format!("MID bundle not found: {id}")))
}
fn drop_fts(c: &Connection, fts: i64) -> Result<()> {
    c.execute_batch(&format!(
        "DROP TABLE IF EXISTS mid_fts_{fts}; DROP TABLE IF EXISTS mid_fts_exact_{fts};"
    ))?;
    Ok(())
}
fn tables_exist(c: &Connection, fts: i64) -> Result<bool> {
    Ok(c.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN (?,?)",
        params![format!("mid_fts_{fts}"), format!("mid_fts_exact_{fts}")],
        |r| r.get::<_, i64>(0),
    )? == 2)
}
fn activate_bundle(c: &Connection, id: &str) -> Result<()> {
    let (fts, status) = bundle_info(c, id)?;
    if !matches!(status.as_str(), "ready" | "superseded") || !tables_exist(c, fts)? {
        return Err(Error::Conflict(
            "Only a ready or superseded bundle with keyword tables can be activated".into(),
        ));
    }
    let previous: Option<String> = c
        .query_row(
            "SELECT bundle_id FROM mid_bundles WHERE status='active'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    c.execute(
        "UPDATE mid_bundles SET status='superseded' WHERE status='active'",
        [],
    )?;
    c.execute(
        "UPDATE mid_bundles SET status='active',activated_at=? WHERE bundle_id=?",
        params![now(), id],
    )?;
    let keep = match previous {
        Some(id) => Some(id),
        None => c.query_row("SELECT bundle_id FROM mid_bundles WHERE status='superseded' ORDER BY activated_at DESC,created_at DESC LIMIT 1",[],|r|r.get(0)).optional()?,
    };
    let prune = c.prepare("SELECT bundle_id,fts_id FROM mid_bundles WHERE status='superseded' AND (? IS NULL OR bundle_id<>?)")?
        .query_map(params![keep,keep],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
    for (id, fts) in prune {
        drop_fts(c, fts)?;
        c.execute("DELETE FROM mid_rows WHERE bundle_id=?", [id])?;
    }
    Ok(())
}

pub fn recover_interrupted(store: &Store) -> Result<()> {
    store.with_connection(|c| {
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let ids = tx.prepare("SELECT i.build_id,i.bundle_id,b.fts_id FROM index_builds i JOIN mid_bundles b ON b.bundle_id=i.bundle_id WHERE i.status IN ('queued','running')")?
            .query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        for (build,bundle,fts) in ids {
            let message = "Interrupted by a restart. Start the build again.";
            let mut value = build_value(&tx,&build)?;
            if let Some(steps) = value["steps"].as_array_mut() { for step in steps { if step["status"] == "running" {
                step["status"] = json!("failed"); step["detail"] = json!(message); step["finished_at"] = json!(now());
            } } }
            let mut log = value["log"].as_array().cloned().unwrap_or_default();
            append_log(&mut log,"error",message);
            tx.execute("UPDATE index_builds SET status='interrupted',error=?,steps_json=?,log_json=?,updated_at=?,finished_at=? WHERE build_id=?",params![message,value["steps"].to_string(),json!(log).to_string(),now(),now(),build])?;
            tx.execute("UPDATE mid_bundles SET status='failed',error=? WHERE bundle_id=? AND status='building'",params![message,bundle])?;
            drop_fts(&tx,fts)?;
        }
        tx.commit()?; Ok(())
    })
}
fn append_log(log: &mut Vec<Value>, level: &str, message: &str) {
    log.push(json!({"at":now(),"level":level,"message":message}));
    if log.len() > 200 {
        log.drain(..log.len() - 200);
    }
}

struct Worker {
    conn: Connection,
    build: String,
    bundle: String,
    fts: i64,
    config: MidIndexConfig,
    steps: Vec<Step>,
    log: Vec<Value>,
    done: usize,
    total: Option<usize>,
    stored: usize,
    duplicates: usize,
    counters: IngestCounters,
    activate: bool,
}
impl Worker {
    fn persist(&mut self, current: usize) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("UPDATE index_builds SET current_step=?,steps_json=?,log_json=?,rows_done=?,rows_total=?,updated_at=? WHERE build_id=? AND status='running'",
            params![self.steps[current].id,serde_json::to_string(&self.steps)?,json!(self.log).to_string(),self.done as i64,self.total.map(|n|n as i64),now(),self.build])?;
        tx.execute(
            "UPDATE mid_bundles SET row_count=? WHERE bundle_id=?",
            params![self.stored as i64, self.bundle],
        )?;
        tx.commit()?;
        Ok(())
    }
    fn begin(&mut self, index: usize, total: Option<usize>) -> Result<()> {
        self.check_cancel()?;
        let step = &mut self.steps[index];
        step.status = "running";
        step.started_at = Some(now());
        step.rows_total = total;
        self.persist(index)
    }
    fn end(&mut self, index: usize, status: &'static str, detail: Option<String>) -> Result<()> {
        let step = &mut self.steps[index];
        step.status = status;
        step.finished_at = Some(now());
        step.detail = detail;
        if status == "done" {
            step.eta_seconds = Some(0.0);
        }
        self.persist(index)
    }
    fn check_cancel(&self) -> Result<()> {
        check_cancel(&self.conn, &self.build)
    }
    fn progress(
        &mut self,
        index: usize,
        done: usize,
        total: Option<usize>,
        count: usize,
        elapsed: f64,
    ) {
        let step = &mut self.steps[index];
        step.rows_done = done;
        step.rows_total = total;
        if count > 0 && elapsed > 0.0 {
            let rate = count as f64 / elapsed;
            let rate = step.rate_per_sec.map_or(rate, |old| 0.3 * rate + 0.7 * old);
            step.rate_per_sec = Some(rate);
            step.eta_seconds = total.map(|t| t.saturating_sub(done) as f64 / rate);
        }
    }
    fn run(&mut self, path: PathBuf) -> Result<()> {
        self.begin(0, None)?;
        let mut workbook: Xlsx<_> = open_workbook(path).map_err(workbook_error)?;
        let sheet = workbook
            .sheet_names()
            .first()
            .cloned()
            .ok_or_else(|| Error::Validation("Workbook has no sheets".into()))?;
        let mut reader = workbook
            .worksheet_cells_reader(&sheet)
            .map_err(workbook_error)?;
        let dimensions = reader.dimensions();
        self.total = if dimensions.end.0 > 0 {
            Some(dimensions.end.0 as usize)
        } else {
            None
        };
        self.end(0, "done", Some(format!("First sheet: {sheet}")))?;
        self.begin(1, None)?;
        let mut headers = BTreeMap::<u32, String>::new();
        let mut row_index = 0;
        let mut row = Map::new();
        let mut batch = Vec::with_capacity(BATCH);
        let mut validated = false;
        let mut clock = Instant::now();
        while let Some(cell) = reader.next_cell().map_err(workbook_error)? {
            let (r, col) = cell.get_position();
            let text = cell_text(cell.get_value());
            if r == 0 {
                if !text.is_empty() {
                    headers.insert(col, text);
                }
                continue;
            }
            if !validated {
                self.validate_headers(&headers)?;
                validated = true;
                self.end(1, "done", None)?;
                self.begin(2, self.total)?;
                self.begin(3, self.total)?;
                clock = Instant::now();
            }
            if r != row_index {
                if !row.is_empty() {
                    batch.push(Value::Object(std::mem::take(&mut row)));
                }
                if batch.len() == BATCH {
                    self.store_batch(&batch, clock.elapsed().as_secs_f64())?;
                    batch.clear();
                    clock = Instant::now();
                }
                row_index = r;
            }
            if !text.is_empty() {
                if let Some(header) = headers.get(&col) {
                    row.insert(header.clone(), Value::String(text));
                }
            }
        }
        if !validated {
            self.validate_headers(&headers)?;
            self.end(1, "done", None)?;
            self.begin(2, self.total)?;
            self.begin(3, self.total)?;
        }
        if !row.is_empty() {
            batch.push(Value::Object(row));
        }
        if !batch.is_empty() {
            self.store_batch(&batch, clock.elapsed().as_secs_f64())?;
        }
        self.total = Some(self.done);
        self.steps[2].rows_total = self.total;
        self.steps[3].rows_total = self.total;
        let detail = format!(
            "Stored {} companies; {} duplicates; {} quarantined rows.",
            self.stored, self.duplicates, self.counters.quarantined
        );
        append_log(&mut self.log, "info", &detail);
        self.end(2, "done", Some(detail.clone()))?;
        self.end(3, "done", Some(detail))?;
        self.keyword_index()?;
        self.semantic_embeddings()?;
        self.begin(6, Some(self.stored))?;
        let count: usize = self.conn.query_row(
            "SELECT COUNT(*) FROM mid_rows WHERE bundle_id=?",
            [&self.bundle],
            |r| r.get(0),
        )?;
        if count != self.stored {
            return Err(Error::Validation(
                "Verification failed: stored company count differs from mid_rows".into(),
            ));
        }
        for name in [
            format!("mid_fts_{}", self.fts),
            format!("mid_fts_exact_{}", self.fts),
        ] {
            let docs: usize =
                self.conn
                    .query_row(&format!("SELECT COUNT(*) FROM {name}_docsize"), [], |r| {
                        r.get(0)
                    })?;
            if docs != count {
                return Err(Error::Validation(format!(
                    "Verification failed: {name} document count differs from mid_rows"
                )));
            }
        }
        self.steps[6].rows_done = count;
        self.end(
            6,
            "done",
            Some(format!(
                "Verified {count} company rows and both keyword indexes"
            )),
        )?;
        self.begin(7, None)?;
        // Cancellation and activation are serialized in one write transaction.
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        check_cancel(&tx, &self.build)?;
        tx.execute(
            "UPDATE mid_bundles SET status='ready' WHERE bundle_id=?",
            [&self.bundle],
        )?;
        if self.activate {
            activate_bundle(&tx, &self.bundle)?;
        }
        let step = &mut self.steps[7];
        step.status = if self.activate { "done" } else { "skipped" };
        step.finished_at = Some(now());
        if !self.activate {
            step.detail = Some("Activation not requested".into());
        }
        append_log(
            &mut self.log,
            "info",
            if self.activate {
                "Verified bundle activated; previous bundle retained for rollback."
            } else {
                "Verified bundle ready; activation not requested."
            },
        );
        tx.execute("UPDATE index_builds SET status='succeeded',steps_json=?,log_json=?,updated_at=?,finished_at=? WHERE build_id=?",params![serde_json::to_string(&self.steps)?,json!(self.log).to_string(),now(),now(),self.build])?;
        tx.commit()?;
        Ok(())
    }
    fn validate_headers(&mut self, headers: &BTreeMap<u32, String>) -> Result<()> {
        let present: BTreeSet<String> = headers.values().map(|s| normalize_header(s)).collect();
        if present.len() != headers.len() {
            return Err(Error::Validation("Duplicate workbook header names".into()));
        }
        let has = |columns: &[String]| {
            columns
                .iter()
                .any(|s| present.contains(&normalize_header(s)))
        };
        if !has(&self.config.identifier_columns.ecid) && !has(&self.config.identifier_columns.cid) {
            return Err(Error::Validation(format!(
                "Missing identifier columns: at least one of {} is required",
                self.config
                    .identifier_columns
                    .ecid
                    .iter()
                    .chain(&self.config.identifier_columns.cid)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
        if !has(&self.config.name_columns) {
            return Err(Error::Validation(format!(
                "Missing name columns: at least one of {} is required",
                self.config.name_columns.join(", ")
            )));
        }
        if !has(&self.config.search_columns) {
            return Err(Error::Validation(format!(
                "Missing search columns: at least one of {} is required",
                self.config.search_columns.join(", ")
            )));
        }
        let configured: BTreeSet<&String> = self
            .config
            .metadata_columns
            .iter()
            .chain(&self.config.search_columns)
            .chain(&self.config.llm_description_columns)
            .chain(&self.config.name_columns)
            .chain(&self.config.website_columns)
            .chain(&self.config.identifier_columns.ecid)
            .chain(&self.config.identifier_columns.cid)
            .chain(&self.config.identifier_columns.pbid)
            .collect();
        let missing = configured
            .into_iter()
            .filter(|s| !present.contains(&normalize_header(s)))
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            append_log(
                &mut self.log,
                "warn",
                &format!("Configured columns not present: {}", missing.join(", ")),
            );
        }
        Ok(())
    }
    fn store_batch(&mut self, batch: &[Value], read_seconds: f64) -> Result<()> {
        self.check_cancel()?;
        let clock = Instant::now();
        let tx = self.conn.transaction()?;
        for row in batch {
            if let Some(company) = ingest_source_row(&tx, "MID", "", "", row, &mut self.counters)? {
                let desc = self
                    .config
                    .llm_description_columns
                    .iter()
                    .filter_map(|label| {
                        field_text(row, &[label.as_str()]).map(|text| format!("{label}: {text}"))
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let added=tx.execute("INSERT OR IGNORE INTO mid_rows(bundle_id,company_id,row_json,desc_text,desc_hash) VALUES(?,?,?,?,?)",params![self.bundle,company,row.to_string(),desc,retrieval::text_hash(&desc)])?;
                if added == 0 {
                    self.duplicates += 1;
                    if self.duplicates <= 20 {
                        append_log(
                            &mut self.log,
                            "warn",
                            &format!("Duplicate company {company}; kept its first workbook row."),
                        );
                    }
                } else {
                    self.stored += 1;
                }
            }
        }
        tx.commit()?;
        self.done += batch.len();
        let elapsed = read_seconds + clock.elapsed().as_secs_f64();
        self.progress(2, self.done, self.total, batch.len(), elapsed);
        self.progress(3, self.done, self.total, batch.len(), elapsed);
        self.persist(3)
    }
    fn keyword_index(&mut self) -> Result<()> {
        self.begin(4, Some(self.stored))?;
        let names = self
            .config
            .search_columns
            .iter()
            .map(|c| format!("\"{}\"", self.config.fts5_column_names[c]))
            .collect::<Vec<_>>()
            .join(",");
        let tx = self.conn.transaction()?;
        drop_fts(&tx, self.fts)?;
        for (table, tokenizer) in [
            (format!("mid_fts_{}", self.fts), "porter unicode61"),
            (format!("mid_fts_exact_{}", self.fts), "unicode61"),
        ] {
            tx.execute_batch(&format!("CREATE VIRTUAL TABLE {table} USING fts5({names},content='',tokenize='{tokenizer}');"))?;
        }
        tx.commit()?;
        let placeholders = std::iter::repeat_n("?", self.config.search_columns.len() + 1)
            .collect::<Vec<_>>()
            .join(",");
        let stem = format!(
            "INSERT INTO mid_fts_{}(rowid,{names}) VALUES({placeholders})",
            self.fts
        );
        let exact = format!(
            "INSERT INTO mid_fts_exact_{}(rowid,{names}) VALUES({placeholders})",
            self.fts
        );
        let mut cursor = 0i64;
        let mut done = 0;
        loop {
            self.check_cancel()?;
            let clock = Instant::now();
            let rows=self.conn.prepare("SELECT row_no,row_json FROM mid_rows WHERE bundle_id=? AND row_no>? ORDER BY row_no LIMIT ?")?
                .query_map(params![self.bundle,cursor,BATCH as i64],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
            if rows.is_empty() {
                break;
            }
            let tx = self.conn.transaction()?;
            {
                let mut stem = tx.prepare(&stem)?;
                let mut exact = tx.prepare(&exact)?;
                for (row_no, raw) in &rows {
                    let row: Value = serde_json::from_str(raw)?;
                    let mut values = vec![rusqlite::types::Value::Integer(*row_no)];
                    values.extend(self.config.search_columns.iter().map(|c| {
                        rusqlite::types::Value::Text(
                            field_text(&row, &[c.as_str()]).unwrap_or_default(),
                        )
                    }));
                    stem.execute(rusqlite::params_from_iter(&values))?;
                    exact.execute(rusqlite::params_from_iter(&values))?;
                    cursor = *row_no;
                }
            }
            tx.commit()?;
            done += rows.len();
            self.progress(
                4,
                done,
                Some(self.stored),
                rows.len(),
                clock.elapsed().as_secs_f64(),
            );
            self.persist(4)?;
        }
        self.end(4, "done", None)
    }
    fn semantic_embeddings(&mut self) -> Result<()> {
        self.begin(5, Some(self.stored))?;
        let config = RetrievalConfig::from_env()?;
        if config.embed_endpoint.is_none() {
            let reason = "Embedding model not configured (set MNA_EMBED_ENDPOINT).";
            self.conn.execute(
                "UPDATE mid_bundles SET semantic_status='skipped' WHERE bundle_id=?",
                [&self.bundle],
            )?;
            append_log(&mut self.log, "info", reason);
            return self.end(5, "skipped", Some(reason.into()));
        }
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let adapter = {
            let _guard = rt.enter();
            LocalHttpAdapter::new(config)?
        };
        let identity = &adapter.config().embedder;
        let mut cursor = 0i64;
        let mut done = 0;
        let mut saved = 0;
        let mut cached = 0;
        let mut empty = 0;
        loop {
            self.check_cancel()?;
            let clock = Instant::now();
            let rows=self.conn.prepare("SELECT r.row_no,r.company_id,r.desc_text,r.desc_hash,e.text_hash FROM mid_rows r LEFT JOIN embedding_vectors e ON e.company_id=r.company_id AND e.model=? AND e.model_version=? WHERE r.bundle_id=? AND r.row_no>? ORDER BY r.row_no LIMIT 64")?
                .query_map(params![identity.model,identity.version,self.bundle,cursor],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
            if rows.is_empty() {
                break;
            }
            let mut entries = Vec::new();
            for (row_no, id, desc, hash, existing) in &rows {
                cursor = *row_no;
                if desc.trim().is_empty() {
                    empty += 1;
                } else if existing.as_ref() == Some(hash) {
                    cached += 1;
                } else {
                    entries.push((id, desc, hash));
                }
            }
            // The existing local adapter accepts at most 32 texts per request.
            for chunk in entries.chunks(32) {
                self.check_cancel()?;
                let texts = chunk
                    .iter()
                    .map(|(_, desc, _)| (*desc).clone())
                    .collect::<Vec<_>>();
                let vectors = rt.block_on(adapter.embed(&texts))?;
                self.check_cancel()?;
                let tx = self.conn.transaction()?;
                for ((id, _, hash), vector) in chunk.iter().zip(vectors) {
                    retrieval::validate_vector(&vector, identity)?;
                    let blob: Vec<u8> = vector.iter().flat_map(|v| v.to_le_bytes()).collect();
                    tx.execute("INSERT INTO embedding_vectors(company_id,model,model_version,dimensions,text_hash,vector_blob,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(company_id,model,model_version) DO UPDATE SET dimensions=excluded.dimensions,text_hash=excluded.text_hash,vector_blob=excluded.vector_blob,created_at=excluded.created_at",params![id,identity.model,identity.version,identity.dimensions as i64,hash,blob,now()])?;
                    saved += 1;
                }
                tx.commit()?;
            }
            done += rows.len();
            self.progress(
                5,
                done,
                Some(self.stored),
                rows.len(),
                clock.elapsed().as_secs_f64(),
            );
            self.persist(5)?;
        }
        self.conn.execute(
            "UPDATE mid_bundles SET semantic_status='ready',semantic_model=? WHERE bundle_id=?",
            params![identity.model, self.bundle],
        )?;
        self.end(
            5,
            "done",
            Some(format!(
                "Saved {saved} embeddings; {cached} unchanged; {empty} empty descriptions skipped."
            )),
        )
    }
    fn finish(&mut self, result: Result<()>) -> Result<()> {
        let Err(error) = result else {
            return Ok(());
        };
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (requested, build_status): (bool, String) = tx.query_row(
            "SELECT cancel_requested,status FROM index_builds WHERE build_id=?",
            [&self.build],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        // Startup recovery can already have finalized this build. Do not replace
        // its interrupted state or touch a bundle another operation has handled.
        if build_status != "running" {
            return Ok(());
        }
        let cancelled = error.to_string() == CANCELLED || requested;
        let status = if cancelled { "cancelled" } else { "failed" };
        let message = if cancelled {
            CANCELLED.to_owned()
        } else {
            error.to_string()
        };
        for step in &mut self.steps {
            if step.status == "running" {
                step.status = "failed";
                step.finished_at = Some(now());
                step.detail = Some(message.clone());
            }
        }
        append_log(
            &mut self.log,
            if cancelled { "info" } else { "error" },
            &message,
        );
        drop_fts(&tx, self.fts)?;
        if cancelled {
            tx.execute("DELETE FROM mid_rows WHERE bundle_id=?", [&self.bundle])?;
            append_log(&mut self.log,"info","Partial index rows and keyword tables removed. Companies, identifiers and source rows already imported remain as valid identity data.");
        }
        tx.execute("UPDATE mid_bundles SET status=?,error=?,semantic_status=CASE WHEN semantic_status='pending' THEN 'failed' ELSE semantic_status END WHERE bundle_id=?",params![status,message,self.bundle])?;
        tx.execute("UPDATE index_builds SET status=?,error=?,steps_json=?,log_json=?,updated_at=?,finished_at=? WHERE build_id=? AND status='running'",params![status,message,serde_json::to_string(&self.steps)?,json!(self.log).to_string(),now(),now(),self.build])?;
        tx.commit()?;
        Ok(())
    }
}
fn check_cancel(c: &Connection, build: &str) -> Result<()> {
    let (cancel, status): (bool, String) = c.query_row(
        "SELECT cancel_requested,status FROM index_builds WHERE build_id=?",
        [build],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if cancel {
        Err(Error::Conflict(CANCELLED.into()))
    } else if status != "running" {
        Err(Error::Conflict("Build is no longer running".into()))
    } else {
        Ok(())
    }
}
fn workbook_error(e: calamine::XlsxError) -> Error {
    Error::Validation(format!("Cannot read workbook: {e}"))
}
fn cell_text(cell: &DataRef<'_>) -> String {
    match cell {
        DataRef::Empty => String::new(),
        DataRef::String(s) | DataRef::DurationIso(s) => s.trim().to_owned(),
        DataRef::DateTimeIso(s) => s.split('T').next().unwrap_or(s).trim().to_owned(),
        DataRef::SharedString(s) => s.trim().to_owned(),
        DataRef::Int(n) => n.to_string(),
        DataRef::Float(n) => n.to_string(),
        DataRef::Bool(b) => b.to_string(),
        DataRef::Error(e) => e.to_string(),
        DataRef::DateTime(d) => {
            let (y, m, d, _, _, _, _) = d.to_ymd_hms_milli();
            format!("{y:04}-{m:02}-{d:02}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workbook_cell_values_preserve_identifiers_and_iso_dates() {
        assert_eq!(cell_text(&DataRef::Float(42.0)), "42");
        assert_eq!(cell_text(&DataRef::Float(42.5)), "42.5");
        assert_eq!(cell_text(&DataRef::SharedString(" 00042 ")), "00042");
        assert_eq!(cell_text(&DataRef::Empty), "");
        assert_eq!(
            cell_text(&DataRef::DateTimeIso("2025-10-13T12:00:00".into())),
            "2025-10-13"
        );
        let date =
            calamine::ExcelDateTime::new(45943.5, calamine::ExcelDateTimeType::DateTime, false);
        assert_eq!(cell_text(&DataRef::DateTime(date)), "2025-10-13");
    }
}
