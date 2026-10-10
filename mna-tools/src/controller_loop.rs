//! Analyst-enabled discovery loops. Model decisions are data; only deterministic
//! consolidation can call the audited shortlist review operation.
use crate::{
    controller::{self, PendingTurn},
    error::{Error, Result},
    runtime::{ToolCall, ToolDefinition},
    Runtime, Store,
};
use rusqlite::{params, OptionalExtension};
use schemars::JsonSchema;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    sync::{Mutex, OnceLock},
};
use uuid::Uuid;

pub const LOOP_ACTIONS: &[&str] = &[
    "search_mid",
    "search_mid_semantic",
    "score_mid_semantic",
    "search_iscc",
    "inspect_band",
    "keep_query_results",
    "drop_companies",
    "finish_loop",
];
pub const OBSERVATION_BYTES: usize = 4_800;
pub const TURN_OBSERVATION_BYTES: usize = 32_000;
pub const LOOP_STATE_BYTES: usize = 6_000;
const STALE_APPLY: &str = "The shortlist changed during the loop. Resume to re-apply, or cancel.";

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Start {
    run_id: String,
    analyst_message: String,
    /// From 1 to 50, default 50.
    max_turns: Option<u32>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct LoopId {
    loop_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RunId {
    run_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Consolidate {
    loop_id: String,
    apply: bool,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Cancel {
    loop_id: String,
    keep: bool,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Undo {
    loop_id: String,
    #[serde(default)]
    force: bool,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Keep {
    loop_id: String,
    /// Stable loop query id Q1, Q2, ... (or the real query id).
    query_id: String,
    /// Threshold on this query's score scale (keyword/ISCC 0..1; semantic 0..10).
    min_score: f64,
    note: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Band {
    loop_id: String,
    query_id: String,
    min_score: f64,
    max_score: f64,
    /// 1..15, default 15.
    limit: Option<usize>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct DropCompanies {
    loop_id: String,
    company_ids: Vec<String>,
    reason: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Finish {
    loop_id: String,
    summary: String,
}

pub fn input_schema(name: &str) -> Option<Value> {
    let schema = match name {
        "start_controller_loop" => schemars::schema_for!(Start),
        "run_controller_loop_turn" | "get_controller_loop" => schemars::schema_for!(LoopId),
        "list_controller_loops" => schemars::schema_for!(RunId),
        "consolidate_controller_loop" => schemars::schema_for!(Consolidate),
        "cancel_controller_loop" => schemars::schema_for!(Cancel),
        "undo_controller_loop" => schemars::schema_for!(Undo),
        "keep_query_results" => schemars::schema_for!(Keep),
        "inspect_band" => schemars::schema_for!(Band),
        "drop_companies" => schemars::schema_for!(DropCompanies),
        "finish_loop" => schemars::schema_for!(Finish),
        _ => return None,
    };
    Some(serde_json::to_value(schema).expect("schema serializes"))
}

pub fn action_catalog() -> Vec<ToolDefinition> {
    let mut catalog = crate::runtime::tool_definitions();
    for (name, description, mutates_state) in [
        (
            "inspect_band",
            "Inspect up to 15 companies in a query score band",
            false,
        ),
        (
            "keep_query_results",
            "Set or overwrite a query's keep threshold",
            true,
        ),
        (
            "drop_companies",
            "Exclude up to 50 specific run companies with a core-business reason",
            true,
        ),
        (
            "finish_loop",
            "Request deterministic consolidation of the recorded decisions",
            true,
        ),
    ] {
        catalog.push(ToolDefinition {
            name,
            description,
            category: "loop",
            mutates_state,
            input_schema: input_schema(name).expect("loop schema"),
        });
    }
    catalog
}
fn parse<T: DeserializeOwned>(args: &Value) -> Result<T> {
    serde_json::from_value(args.clone()).map_err(|e| Error::Validation(e.to_string()))
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn invalid(message: &str) -> Error {
    Error::Validation(message.into())
}
fn text(value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max {
        return Err(invalid("text is blank or exceeds its byte limit"));
    }
    Ok(())
}
/// UTF-8 byte caps are stricter than the controller's chars/4 token estimate.
fn clip(value: &str, bytes: usize) -> String {
    let mut end = value.len().min(bytes);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].replace(['\n', '\r', '\t'], " ")
}
fn truncate(value: &mut String, bytes: usize) {
    let mut end = value.len().min(bytes);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
}
fn max_score(source: &str) -> f64 {
    if source == "MID_SEMANTIC" {
        10.0
    } else {
        1.0
    }
}

// Reject overlapping turn/consolidate/cancel requests, including direct admin calls.
static BUSY: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
struct Guard(String);
impl Guard {
    fn acquire(store: &Store, id: &str) -> Result<Self> {
        let identity = if store.db_path() == std::path::Path::new(":memory:") {
            store.with_connection(|c| Ok(format!("{c:p}")))?
        } else {
            store.db_path().display().to_string()
        };
        let key = format!("{identity}:{id}");
        let mut busy = BUSY
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| Error::Internal("loop lock poisoned".into()))?;
        if !busy.insert(key.clone()) {
            return Err(Error::Conflict(
                "A loop operation is already running".into(),
            ));
        }
        Ok(Self(key))
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        if let Ok(mut busy) = BUSY.get_or_init(Default::default).lock() {
            busy.remove(&self.0);
        }
    }
}

fn record(store: &Store, id: &str) -> Result<Value> {
    store.with_connection(|c| {
        c.query_row("SELECT loop_id,run_id,conversation_id,status,max_turns,turns_used,analyst_message,selection_revision_before,applied_review_id,final_count,summary,created_at,updated_at,criteria_revision_id,selection_before_json,observations,none_count,finish_requested,undone_review_id FROM controller_loops WHERE loop_id=?", [id], |r| Ok(json!({
            "loop_id":r.get::<_,String>(0)?,"run_id":r.get::<_,String>(1)?,"conversation_id":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?,"max_turns":r.get::<_,i64>(4)?,"turns_used":r.get::<_,i64>(5)?,"analyst_message":r.get::<_,String>(6)?,"selection_revision_before":r.get::<_,i64>(7)?,"applied_review_id":r.get::<_,Option<String>>(8)?,"final_count":r.get::<_,Option<i64>>(9)?,"summary":r.get::<_,Option<String>>(10)?,"created_at":r.get::<_,String>(11)?,"updated_at":r.get::<_,String>(12)?,"criteria_revision_id":r.get::<_,String>(13)?,"selection_before_json":r.get::<_,String>(14)?,"observations":r.get::<_,String>(15)?,"none_count":r.get::<_,i64>(16)?,"finish_requested":r.get::<_,bool>(17)?,"undone_review_id":r.get::<_,Option<String>>(18)?
        }))).optional()?.ok_or_else(|| Error::NotFound("Controller loop not found".into()))
    })
}
fn string<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn active(v: &Value) -> Result<()> {
    if !["running", "paused"].contains(&string(v, "status")) {
        return Err(Error::Conflict("Loop is not active".into()));
    }
    Ok(())
}
fn criteria_current(store: &Store, v: &Value) -> Result<()> {
    let current = store.execute("get_criteria_history", &json!({"run_id":v["run_id"]}))?;
    if current["last_criteria"]["approved"] != true
        || current["last_criteria"]["revision_id"] != v["criteria_revision_id"]
    {
        return Err(Error::Conflict(
            "Loop criteria changed; start a new analyst-enabled loop after approval".into(),
        ));
    }
    Ok(())
}

pub fn start(store: &Store, args: &Value) -> Result<Value> {
    let args: Start = parse(args)?;
    text(&args.analyst_message, 16_000)?;
    if args.analyst_message.chars().count() > 4_000 {
        return Err(invalid("analyst_message must be 1..4000 characters"));
    }
    let max = args.max_turns.unwrap_or(50);
    if !(1..=50).contains(&max) {
        return Err(invalid("max_turns must be 1..50"));
    }
    let history = store.execute("get_criteria_history", &json!({"run_id":args.run_id}))?;
    if history["last_criteria"]["approved"] != true {
        return Err(Error::Conflict(
            "Analyst-approved criteria are required".into(),
        ));
    }
    let id = format!("loop-{}", Uuid::new_v4());
    let _guard = Guard::acquire(store, &args.run_id)?;
    // Snapshot initial selection, even when there has never been a manual review.
    store.with_connection(|c| {
        let tx = c.transaction()?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM controller_loops WHERE run_id=? AND status IN ('running','paused','consolidating'))",[&args.run_id],|r|r.get(0))?;
        if exists { return Err(Error::Conflict("An active loop already exists for this run".into())); }
        let before: i64 = tx.query_row("SELECT COALESCE(MAX(rowid),0) FROM shortlist_reviews WHERE run_id=?",[&args.run_id],|r|r.get(0))?;
        let mut stmt = tx.prepare("SELECT company_id FROM candidates WHERE run_id=? AND considered=1 ORDER BY company_id")?;
        let ids = stmt.query_map([&args.run_id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        drop(stmt);
        // Start a clean conversation, preserving existing single-turn history.
        tx.execute("UPDATE llm_conversations SET status='closed',updated_at=? WHERE run_id=? AND provider='llm_suite' AND status='active'",params![now(),args.run_id])?;
        let conversation = format!("conv-{}",Uuid::new_v4());
        tx.execute("INSERT INTO llm_conversations(conversation_id,run_id,provider,status,created_at,updated_at) VALUES(?,?,'llm_suite','active',?,?)",params![conversation,args.run_id,now(),now()])?;
        tx.execute("INSERT INTO controller_loops(loop_id,run_id,conversation_id,status,max_turns,analyst_message,selection_revision_before,criteria_revision_id,selection_before_json,created_at,updated_at) VALUES(?,?,?,'running',?,?,?,?,?,?,?)",params![id,args.run_id,conversation,max,args.analyst_message,before,history["last_criteria"]["revision_id"].as_str(),serde_json::to_string(&ids)?,now(),now()])?;
        tx.commit()?; Ok(())
    })?;
    get(store, &json!({"loop_id":id}))
}

fn queries(store: &Store, id: &str) -> Result<Vec<Value>> {
    store.with_connection(|c| {
        let mut stmt = c.prepare("SELECT q.query_id,q.short_id,q.source,q.label,q.turn,q.total,q.histogram_json,k.min_score,k.kept_count,k.note,k.turn FROM controller_loop_queries q LEFT JOIN controller_loop_keeps k ON k.loop_id=q.loop_id AND k.query_id=q.query_id WHERE q.loop_id=? ORDER BY q.rowid")?;
        let rows = stmt.query_map([id],|r| Ok(json!({"query_id":r.get::<_,String>(0)?,"id":r.get::<_,String>(1)?,"source":r.get::<_,String>(2)?,"label":r.get::<_,String>(3)?,"turn":r.get::<_,i64>(4)?,"total":r.get::<_,i64>(5)?,"histogram":serde_json::from_str::<Value>(&r.get::<_,String>(6)?).unwrap_or_default(),"min_score":r.get::<_,Option<f64>>(7)?,"kept_count":r.get::<_,Option<i64>>(8)?,"note":r.get::<_,Option<String>>(9)?,"keep_turn":r.get::<_,Option<i64>>(10)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut rows = rows;
        for q in &mut rows {
            if let Some(score) = q["min_score"].as_f64() {
                q["kept_count"] = json!(c.query_row("SELECT COUNT(*) FROM controller_loop_hits h JOIN controller_loops l ON l.loop_id=h.loop_id JOIN candidates c ON c.run_id=l.run_id AND c.company_id=h.company_id WHERE h.loop_id=? AND h.query_id=? AND h.score>=? AND NOT EXISTS(SELECT 1 FROM controller_loop_drops d WHERE d.loop_id=h.loop_id AND d.company_id=h.company_id)",params![id,string(q,"query_id"),score],|r|r.get::<_,i64>(0))?);
            }
        }
        Ok(rows)
    })
}
fn kept_count(store: &Store, id: &str, query_id: &str, score: f64) -> Result<i64> {
    store.with_connection(|c| Ok(c.query_row("SELECT COUNT(*) FROM controller_loop_hits h JOIN controller_loops l ON l.loop_id=h.loop_id JOIN candidates c ON c.run_id=l.run_id AND c.company_id=h.company_id WHERE h.loop_id=? AND h.query_id=? AND h.score>=? AND NOT EXISTS(SELECT 1 FROM controller_loop_drops d WHERE d.loop_id=h.loop_id AND d.company_id=h.company_id)",params![id,query_id,score],|r|r.get(0))?))
}
fn bounded_exclusions(store: &Store, run_id: &str, fallback: &str) -> Result<String> {
    let history = store.execute("get_criteria_history", &json!({"run_id":run_id}))?;
    let Some(items) = history["last_criteria"]["core_business_exclusions"].as_array() else {
        return Ok(clip(fallback, 550));
    };
    let mut selected = Vec::new();
    for item in items {
        selected.push(item);
        if serde_json::to_string(&selected)?.len() > 550 {
            selected.pop();
            break;
        }
    }
    let mut out = serde_json::to_string(&selected)?;
    if selected.len() < items.len() {
        out.push_str(" (additional exclusions omitted)");
    }
    Ok(out)
}
pub fn consolidated(store: &Store, id: &str) -> Result<Vec<String>> {
    store.with_connection(|c| {
        let mut stmt = c.prepare("SELECT DISTINCT h.company_id FROM controller_loop_hits h JOIN controller_loop_keeps k ON k.loop_id=h.loop_id AND k.query_id=h.query_id JOIN controller_loops l ON l.loop_id=h.loop_id JOIN candidates c ON c.run_id=l.run_id AND c.company_id=h.company_id WHERE h.loop_id=? AND h.score>=k.min_score AND NOT EXISTS(SELECT 1 FROM controller_loop_drops d WHERE d.loop_id=h.loop_id AND d.company_id=h.company_id) ORDER BY h.company_id")?;
        let rows = stmt.query_map([id],|r|r.get(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        Ok(rows)
    })
}
pub fn get(store: &Store, args: &Value) -> Result<Value> {
    let args: LoopId = parse(args)?;
    let mut v = record(store, &args.loop_id)?;
    let qs = queries(store, &args.loop_id)?;
    v["keeps"] = json!(qs
        .iter()
        .filter(|q| !q["min_score"].is_null())
        .collect::<Vec<_>>());
    v["queries"] = json!(qs);
    v["consolidated_count"] = json!(consolidated(store, &args.loop_id)?.len());
    let (turns,drops,simulated) = store.with_connection(|c| {
        let mut stmt = c.prepare("SELECT t.turn,ct.turn_id,ct.kind,ct.reply_markdown,ct.results_json,ct.status,ct.error,ct.simulated FROM controller_loop_turns t JOIN controller_turns ct ON ct.turn_id=t.turn_id WHERE t.loop_id=? ORDER BY ct.rowid")?;
        let turns = stmt.query_map([&args.loop_id],|r|Ok(json!({"turn":r.get::<_,i64>(0)?,"turn_id":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"reply_markdown":r.get::<_,Option<String>>(3)?,"instructions":serde_json::from_str::<Value>(&r.get::<_,Option<String>>(4)?.unwrap_or_else(||"[]".into())).unwrap_or_default(),"status":r.get::<_,String>(5)?,"error":r.get::<_,Option<String>>(6)?,"simulated":r.get::<_,bool>(7)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let drops: i64 = c.query_row("SELECT COUNT(*) FROM controller_loop_drops WHERE loop_id=?",[&args.loop_id],|r|r.get(0))?;
        let simulated: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM controller_loop_turns lt JOIN controller_turns ct ON ct.turn_id=lt.turn_id WHERE lt.loop_id=? AND ct.simulated=1) OR EXISTS(SELECT 1 FROM controller_loop_hits WHERE loop_id=? AND simulated=1)",params![args.loop_id,args.loop_id],|r|r.get(0))?;
        Ok((turns,drops,simulated))
    })?;
    v["turns"] = json!(turns);
    v["drops"] = json!(drops);
    v["simulated"] = json!(simulated);
    v.as_object_mut()
        .expect("loop object")
        .remove("selection_before_json");
    Ok(v)
}
pub fn list(store: &Store, args: &Value) -> Result<Value> {
    let args: RunId = parse(args)?;
    store.execute("get_run_context", &json!({"run_id":args.run_id}))?;
    let ids = store.with_connection(|c| {
        let mut stmt = c.prepare("SELECT loop_id FROM controller_loops WHERE run_id=? ORDER BY created_at DESC LIMIT 100")?;
        let ids = stmt.query_map([&args.run_id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?; Ok(ids)
    })?;
    Ok(
        json!({"loops":ids.iter().map(|id|get(store,&json!({"loop_id":id}))).collect::<Result<Vec<_>>>()?}),
    )
}

/// Recover a crash between the audited shortlist commit and the loop's receipt.
/// Unfinished work is always paused; startup never sends or applies anything.
pub(crate) fn recover_interrupted(store: &Store) -> Result<()> {
    store.with_connection(|c| {
        let tx=c.transaction()?;
        let mut stmt=tx.prepare("SELECT loop_id FROM controller_loops WHERE status='consolidating'")?;
        let ids=stmt.query_map([],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        drop(stmt);
        for id in ids {
            let reason=format!("LLM Suite loop {id} consolidation (analyst-enabled Loop)");
            let reviewed=tx.query_row("SELECT review_id,considered_count FROM shortlist_reviews WHERE run_id=(SELECT run_id FROM controller_loops WHERE loop_id=?) AND reason=? ORDER BY rowid DESC LIMIT 1",params![id,reason],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).optional()?;
            if let Some((review,count))=reviewed {
                tx.execute("UPDATE controller_loops SET status='completed',applied_review_id=?,final_count=?,summary=COALESCE(summary,'Consolidated shortlist apply recovered after restart.'),updated_at=? WHERE loop_id=?",params![review,count,now(),id])?;
            }
        }
        tx.execute("UPDATE controller_loops SET status='paused',updated_at=? WHERE status IN ('running','consolidating')",[now()])?;
        tx.commit()?;Ok(())
    })
}

fn query(store: &Store, id: &str, q: &str) -> Result<Value> {
    queries(store, id)?
        .into_iter()
        .find(|v| string(v, "id").eq_ignore_ascii_case(q) || v["query_id"] == q)
        .ok_or_else(|| Error::NotFound("Query does not belong to this loop".into()))
}
#[derive(Clone)]
struct Hit {
    id: String,
    name: String,
    score: f64,
    description: String,
    matched: String,
    simulated: bool,
}
fn hits(store: &Store, id: &str, q: &str) -> Result<Vec<Hit>> {
    store.with_connection(|c| {
        let mut stmt = c.prepare("SELECT h.company_id,substr(c.name,1,80),h.score,substr(COALESCE(c.description,''),1,160),h.matched_json,h.simulated FROM controller_loop_hits h JOIN companies c ON c.company_id=h.company_id WHERE h.loop_id=? AND h.query_id=? ORDER BY h.score DESC,h.company_id")?;
        let rows = stmt.query_map(params![id,q],|r|Ok(Hit {id:r.get(0)?,name:r.get(1)?,score:r.get(2)?,description:r.get(3)?,matched:r.get(4)?,simulated:r.get(5)?}))?.collect::<std::result::Result<Vec<_>,_>>()?; Ok(rows)
    })
}
fn row(h: &Hit, bytes: usize) -> String {
    // Oversized identifiers are explicitly marked as clipped; never suggest a guessed id.
    let cid = if h.id.len() > 80 {
        format!(
            "{}… [id clipped; inspect_band for full id]",
            clip(&h.id, 40)
        )
    } else {
        clip(&h.id, 80)
    };
    let tail = format!(
        " · company_id: {}{}",
        cid,
        if h.simulated { " *" } else { "" }
    );
    let prefix = format!("- {:.2} · ", h.score);
    let room = bytes.saturating_sub(tail.len() + prefix.len() + 12);
    let name = clip(&h.name, room.min(40));
    let matched: Value = serde_json::from_str(&h.matched).unwrap_or_default();
    let matched = matched
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().or_else(|| v["text"].as_str()))
                .collect::<Vec<_>>()
                .join("; ")
        })
        .unwrap_or_default();
    let matched = clip(&matched, room.saturating_sub(name.len()).min(35));
    let desc = clip(
        &h.description.chars().take(160).collect::<String>(),
        room.saturating_sub(name.len() + matched.len()).min(160),
    );
    let mut out = format!("{prefix}{name} · {desc} · [{matched}]{tail}");
    truncate(&mut out, bytes);
    out
}

pub fn observation(store: &Store, id: &str, q: &str) -> Result<String> {
    let q = query(store, id, q)?;
    let rows = hits(store, id, string(&q, "query_id"))?;
    let union = store.with_connection(|c| {
        let mut stmt=c.prepare("SELECT DISTINCT h.company_id FROM controller_loop_hits h JOIN controller_loop_keeps k ON k.loop_id=h.loop_id AND k.query_id=h.query_id WHERE h.loop_id=? AND h.query_id!=? AND h.score>=k.min_score AND NOT EXISTS(SELECT 1 FROM controller_loop_drops d WHERE d.loop_id=h.loop_id AND d.company_id=h.company_id)")?;
        let rows=stmt.query_map(params![id,string(&q,"query_id")],|r|r.get::<_,String>(0))?.collect::<std::result::Result<BTreeSet<_>,_>>()?;
        Ok(rows)
    })?;
    let new = rows.iter().filter(|h| !union.contains(&h.id)).count();
    let max = max_score(string(&q, "source"));
    let threshold = q["min_score"].as_f64().unwrap_or_else(|| {
        rows.get(rows.len() / 2)
            .map_or(0.0, |h| (h.score + rows[(rows.len() - 1) / 2].score) / 2.0)
    });
    let bins = q["histogram"].as_array().cloned().unwrap_or_default();
    let histogram = bins
        .iter()
        .enumerate()
        .map(|(i, n)| {
            format!(
                "{:.1}–{:.1}:{n}",
                i as f64 * max / 10.0,
                (i + 1) as f64 * max / 10.0
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    let mut out = format!("{} · {} · \"{}\" · {} hits ({new} new, {} already kept) · scale: {}\nHistogram: {histogram}\n",string(&q,"id"),string(&q,"source"),clip(string(&q,"label"),220),q["total"],rows.len()-new,if max==10.0 {"semantic 0–10"}else if q["source"]=="ISCC" {"relevancy 0–1"}else {"match strength 0–1"});
    if rows.iter().any(|h| h.simulated) {
        out.push_str("* = SIMULATED source sample\n");
    }
    let mut borderline = rows.iter().collect::<Vec<_>>();
    borderline.sort_by(|a, b| {
        (a.score - threshold)
            .abs()
            .total_cmp(&(b.score - threshold).abs())
            .then_with(|| a.id.cmp(&b.id))
    });
    borderline.truncate(8);
    borderline.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.id.cmp(&b.id)));
    let sections = [
        ("Top:".to_owned(), rows.iter().take(8).collect::<Vec<_>>()),
        (format!("Borderline (around {threshold:.2}):"), borderline),
        (
            "Bottom:".to_owned(),
            rows.iter()
                .skip(rows.len().saturating_sub(4))
                .collect::<Vec<_>>(),
        ),
    ];
    let row_bytes = OBSERVATION_BYTES.saturating_sub(out.len() + 120) / 20;
    for (label, samples) in sections {
        out.push_str(&label);
        out.push('\n');
        for h in samples {
            out.push_str(&row(h, row_bytes));
            out.push('\n');
        }
    }
    truncate(&mut out, OBSERVATION_BYTES);
    Ok(out)
}

/// Register a search before its bounded UI summary loses the result rows.
pub(crate) fn register_search(
    store: &Store,
    id: &str,
    action: &str,
    args: &Value,
    result: &Value,
) -> Result<Option<String>> {
    if ![
        "search_mid",
        "search_mid_semantic",
        "score_mid_semantic",
        "search_iscc",
    ]
    .contains(&action)
        || result["status"] == "skipped"
    {
        return Ok(None);
    }
    let v = record(store, id)?;
    let run = string(&v, "run_id");
    let source = if action == "search_iscc" {
        "ISCC"
    } else if action.contains("semantic") {
        "MID_SEMANTIC"
    } else {
        "MID_KEYWORD"
    };
    let label = if action == "score_mid_semantic" {
        "Approved core business semantic scoring".into()
    } else if let Some(keywords) = args["keywords"].as_array() {
        let words = keywords
            .iter()
            .filter_map(|k| k["text"].as_str())
            .collect::<Vec<_>>()
            .join("; ");
        format!(
            "{words}{}",
            args["expression"]
                .as_str()
                .map(|e| format!(" ({e})"))
                .unwrap_or_default()
        )
    } else {
        args["query"]
            .as_str()
            .or_else(|| args["rationale"].as_str())
            .unwrap_or(action)
            .into()
    };
    let qid = match result["query_id"].as_str() {
        Some(q) => q.to_owned(),
        None if action == "score_mid_semantic" => string(
            &store.record_search(Some(run), "MID_SEMANTIC", &label, args, result)?,
            "query_id",
        )
        .to_owned(),
        None => return Err(Error::Internal("Search omitted query_id".into())),
    };
    store.with_connection(|c| {
        let tx = c.transaction()?;
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM controller_loop_queries WHERE loop_id=?",[id],|r|r.get(0))?;
        let short = format!("Q{}",count+1);
        let turn = v["turns_used"].as_i64().unwrap_or(0)+1;
        tx.execute("INSERT OR IGNORE INTO controller_loop_queries(loop_id,query_id,source,label,turn,total,histogram_json,short_id) VALUES(?,?,?,?,?,0,'[]',?)",params![id,qid,source,clip(&label,600),turn,short])?;
        let simulated = result["simulated"]==true;
        if action=="score_mid_semantic" {
            tx.execute("INSERT OR IGNORE INTO controller_loop_hits(loop_id,query_id,company_id,score,simulated) SELECT ?,?,s.company_id,s.score,? FROM mid_semantic_scores s JOIN candidates c ON c.run_id=s.run_id AND c.company_id=s.company_id WHERE s.run_id=? AND s.criteria_revision=?",params![id,qid,simulated,run,result["criteria_revision"].as_i64()])?;
        }else if source=="MID_SEMANTIC" {
            if let Some(rows)=result["results"].as_array() {for h in rows {
                if let (Some(cid),Some(score))=(h["company_id"].as_str(),h["score"].as_f64()) {tx.execute("INSERT OR IGNORE INTO controller_loop_hits(loop_id,query_id,company_id,score,simulated) VALUES(?,?,?,?,?)",params![id,qid,cid,score,simulated])?;}
            }}
        }else if source=="ISCC" {
            tx.execute("INSERT OR IGNORE INTO controller_loop_hits(loop_id,query_id,company_id,score,simulated) SELECT ?,?,company_id,MAX(relevance_score),MAX(simulated) FROM source_rows WHERE run_scope=? AND query_scope=? AND source='ISCC' AND relevance_score IS NOT NULL GROUP BY company_id",params![id,qid,run,qid])?;
        }else {
            tx.execute("INSERT OR IGNORE INTO controller_loop_hits(loop_id,query_id,company_id,score,matched_json,simulated) SELECT ?,?,company_id,match_pct/100.0,matched_json,? FROM mid_keyword_hits WHERE query_id=? AND run_id=?",params![id,qid,simulated,qid,run])?;
            // Legacy search_mid records its own retrieval score in candidate_discovery.
            tx.execute("INSERT OR IGNORE INTO controller_loop_hits(loop_id,query_id,company_id,score,simulated) SELECT ?,?,company_id,retrieval_score,? FROM candidate_discovery WHERE query_id=? AND run_id=? AND retrieval_score IS NOT NULL",params![id,qid,simulated,qid,run])?;
        }
        let mut bins = [0u64;10];
        let mut stmt = tx.prepare("SELECT score FROM controller_loop_hits WHERE loop_id=? AND query_id=?")?;
        for score in stmt.query_map(params![id,qid],|r|r.get::<_,f64>(0))? {let score=score?;bins[((score/max_score(source)*10.0).floor() as usize).min(9)]+=1;}
        drop(stmt);
        tx.execute("UPDATE controller_loop_queries SET total=?,histogram_json=? WHERE loop_id=? AND query_id=?",params![bins.iter().sum::<u64>(),serde_json::to_string(&bins)?,id,qid])?;
        tx.commit()?; Ok(())
    })?;
    Ok(Some(qid))
}

pub(crate) async fn execute_action(
    runtime: &Runtime,
    store: &Store,
    id: &str,
    action: &str,
    args: &Value,
) -> Result<Value> {
    let v = record(store, id)?;
    active(&v)?;
    criteria_current(store, &v)?;
    if !LOOP_ACTIONS.contains(&action) {
        return Err(invalid("Action is forbidden in loop mode"));
    }
    if ![
        "inspect_band",
        "keep_query_results",
        "drop_companies",
        "finish_loop",
    ]
    .contains(&action)
    {
        let qs = queries(store, id)?;
        let current_turn = v["turns_used"].as_i64().unwrap_or(0) + 1;
        if qs.len() >= 50 || qs.iter().filter(|q| q["turn"] == current_turn).count() >= 4 {
            return Err(invalid("Search budget reached: at most 4 queries per turn and 50 per loop; inspect or consolidate existing queries"));
        }
        let result = runtime
            .execute(ToolCall {
                tool: action.into(),
                arguments: args.clone(),
            })
            .await?;
        // ISCC hydration does not add candidates; use the same run-scoped add path.
        if action == "search_iscc" {
            let rows = store.with_connection(|c| {
                let mut stmt = c.prepare("SELECT company_id,MAX(relevance_score) FROM source_rows WHERE run_scope=? AND query_scope=? AND source='ISCC' GROUP BY company_id")?;
                let rows=stmt.query_map(params![v["run_id"].as_str(),result["query_id"].as_str()],|r|Ok(json!({"company_id":r.get::<_,String>(0)?,"retrieval_score":r.get::<_,Option<f64>>(1)?})))?.collect::<std::result::Result<Vec<_>,_>>()?; Ok(rows)
            })?;
            for chunk in rows.chunks(1_000) {
                runtime.execute(ToolCall {tool:"add_candidates".into(),arguments:json!({"run_id":v["run_id"],"companies":chunk,"discovery_source":"ISCC","query_id":result["query_id"]})}).await?;
            }
        }
        register_search(store, id, action, args, &result)?;
        return Ok(result);
    }
    decision(store, action, args)
}

/// Loop-only actions are deliberately absent from the public tool dispatch.
pub(crate) fn decision(store: &Store, action: &str, args: &Value) -> Result<Value> {
    let id = args["loop_id"]
        .as_str()
        .ok_or_else(|| invalid("loop_id required"))?;
    let v = record(store, id)?;
    active(&v)?;
    let turn = v["turns_used"].as_i64().unwrap_or(0) + 1;
    match action {
        "keep_query_results" => {
            let a: Keep = parse(args)?;
            text(&a.note, 1_000)?;
            let q = query(store, &a.loop_id, &a.query_id)?;
            if !a.min_score.is_finite()
                || !(0.0..=max_score(string(&q, "source"))).contains(&a.min_score)
            {
                return Err(invalid("Threshold is outside this query's score scale"));
            }
            let count = kept_count(store, id, string(&q, "query_id"), a.min_score)?;
            store.with_connection(|c| {c.execute("INSERT INTO controller_loop_keeps(loop_id,query_id,min_score,kept_count,note,turn) VALUES(?,?,?,?,?,?) ON CONFLICT(loop_id,query_id) DO UPDATE SET min_score=excluded.min_score,kept_count=excluded.kept_count,note=excluded.note,turn=excluded.turn",params![id,q["query_id"].as_str(),a.min_score,count,a.note,turn])?;Ok(())})?;
            Ok(json!({"query_id":q["id"],"min_score":a.min_score,"kept_count":count}))
        }
        "inspect_band" => {
            let a: Band = parse(args)?;
            let limit = a.limit.unwrap_or(15);
            let q = query(store, &a.loop_id, &a.query_id)?;
            if !(1..=15).contains(&limit)
                || !a.min_score.is_finite()
                || !a.max_score.is_finite()
                || a.min_score < 0.0
                || a.max_score > max_score(string(&q, "source"))
                || a.min_score > a.max_score
            {
                return Err(invalid(
                    "Use an ordered score band on this query's scale and limit 1..15",
                ));
            }
            let rows = hits(store, id, string(&q, "query_id"))?
                .into_iter()
                .filter(|h| h.score >= a.min_score && h.score <= a.max_score)
                .take(limit)
                .collect::<Vec<_>>();
            Ok(
                json!({"query_id":q["id"],"samples":rows.iter().map(|h|json!({"company_id":h.id,"name":clip(&h.name,80),"score":h.score,"description":clip(&h.description,160),"matched_keywords":serde_json::from_str::<Value>(&h.matched).unwrap_or_default(),"simulated":h.simulated})).collect::<Vec<_>>(),"observation":format!("{} · {} · band {:.2}–{:.2}\n{}",q["id"].as_str().unwrap_or(""),q["source"].as_str().unwrap_or(""),a.min_score,a.max_score,rows.iter().map(|h|row(h,240)).collect::<Vec<_>>().join("\n"))}),
            )
        }
        "drop_companies" => {
            let a: DropCompanies = parse(args)?;
            text(&a.reason, 1_000)?;
            if a.company_ids.is_empty()
                || a.company_ids.len() > 50
                || a.company_ids.iter().collect::<BTreeSet<_>>().len() != a.company_ids.len()
            {
                return Err(invalid("Use 1..50 distinct company ids"));
            }
            store.with_connection(|c| {let tx=c.transaction()?;for cid in &a.company_ids {
                let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM candidates WHERE run_id=? AND company_id=?)",params![v["run_id"].as_str(),cid],|r|r.get(0))?;
                if !exists {return Err(invalid("Dropped companies must belong to the run"));}
                tx.execute("INSERT INTO controller_loop_drops(loop_id,company_id,reason,turn) VALUES(?,?,?,?) ON CONFLICT(loop_id,company_id) DO UPDATE SET reason=excluded.reason,turn=excluded.turn",params![a.loop_id,cid,a.reason,turn])?;
            }tx.commit()?;Ok(())})?;
            Ok(json!({"dropped":a.company_ids.len()}))
        }
        "finish_loop" => {
            let a: Finish = parse(args)?;
            text(&a.summary, 2_000)?;
            store.with_connection(|c| {c.execute("UPDATE controller_loops SET finish_requested=1,summary=?,updated_at=? WHERE loop_id=?",params![a.summary,now(),a.loop_id])?;Ok(())})?;
            Ok(json!({"finish_requested":true}))
        }
        _ => Err(invalid("Unknown loop action")),
    }
}

pub fn loop_state(store: &Store, id: &str) -> Result<String> {
    let v = record(store, id)?;
    let k = v["turns_used"].as_i64().unwrap_or(0) + 1;
    let n = v["max_turns"].as_i64().unwrap_or(50);
    let summary = controller::run_summary(store, string(&v, "run_id"))?;
    let business = summary
        .split("Approved core business: ")
        .nth(1)
        .unwrap_or("")
        .split("\nCore-business exclusions:")
        .next()
        .unwrap_or("");
    let exclusions = summary
        .split("Core-business exclusions: ")
        .nth(1)
        .unwrap_or("")
        .split("\nCandidates by source:")
        .next()
        .unwrap_or("");
    let criteria = format!(
        "Approved core business: {}\nCore-business exclusions: {}",
        clip(business, 800),
        bounded_exclusions(store, string(&v, "run_id"), exclusions)?
    );
    let qs = queries(store, id)?;
    let drops = store.with_connection(|c| {
        Ok(c.query_row(
            "SELECT COUNT(*) FROM controller_loop_drops WHERE loop_id=?",
            [id],
            |r| r.get::<_, i64>(0),
        )?)
    })?;
    let suffix = format!(
        "Drops: {drops}\nConsolidated: {} companies",
        consolidated(store, id)?.len()
    );
    let mut out = format!(
        "Turn {k} of {n} ({} remaining)\nCriteria:\n{}\nQueries:\n",
        (n - k + 1).max(0),
        criteria
    );
    // There can be hundreds of queries. Every Q-id remains visible; compress labels first.
    let room = LOOP_STATE_BYTES.saturating_sub(out.len() + suffix.len() + 1);
    let per_query = if qs.is_empty() { 0 } else { room / qs.len() };
    for q in &qs {
        let keep = if let Some(score) = q["min_score"].as_f64() {
            format!("keep ≥ {score:.2} → {} kept", q["kept_count"])
        } else {
            "not kept".into()
        };
        let base = format!(
            "{} · {} · \"\" · {} hits · {keep}\n",
            string(q, "id"),
            string(q, "source"),
            q["total"]
        );
        out.push_str(&format!(
            "{} · {} · \"{}\" · {} hits · {keep}\n",
            string(q, "id"),
            string(q, "source"),
            clip(
                string(q, "label"),
                per_query.saturating_sub(base.len()).min(160)
            ),
            q["total"]
        ));
    }
    // Enforce a finite table before accepting more search actions (see turn).
    if out.len() + suffix.len() > LOOP_STATE_BYTES {
        return Err(invalid("Loop query table exceeds state budget"));
    }
    out.push_str(&suffix);
    Ok(out)
}
pub fn budget_notice(store: &Store, id: &str) -> Result<String> {
    let v = record(store, id)?;
    let remaining = v["max_turns"].as_i64().unwrap_or(50) - v["turns_used"].as_i64().unwrap_or(0);
    if remaining > 5 {
        return Ok(String::new());
    }
    let unkept = queries(store, id)?
        .iter()
        .filter(|q| q["min_score"].is_null())
        .map(|q| string(q, "id").to_owned())
        .collect::<Vec<_>>()
        .join(", ");
    crate::prompts::render(
        "controller-loop-budget",
        &[
            ("remaining", &remaining.to_string()),
            ("final_turn", &v["max_turns"].to_string()),
            ("unkept_queries", &unkept),
        ],
    )
}

async fn apply_review(
    runtime: &Runtime,
    v: &Value,
    ids: Vec<String>,
    revision: i64,
    reason: String,
) -> Result<Value> {
    runtime.dispatch("review_shortlist",json!({"run_id":v["run_id"],"keep_company_ids":ids,"expected_selection_revision":revision,"reason":reason}),true).await
}
async fn consolidate_inner(
    runtime: &Runtime,
    store: &Store,
    id: &str,
    apply: bool,
) -> Result<Value> {
    let v = record(store, id)?;
    if v["status"] == "completed" {
        return get(store, &json!({"loop_id":id}));
    }
    if v["status"] != "failed" {
        active(&v)?;
    }
    criteria_current(store, &v)?;
    let qs = queries(store, id)?;
    let has_keeps = qs.iter().any(|q| !q["min_score"].is_null());
    let ids = consolidated(store, id)?;
    store.with_connection(|c| {
        c.execute(
            "UPDATE controller_loops SET status='consolidating',updated_at=? WHERE loop_id=?",
            params![now(), id],
        )?;
        Ok(())
    })?;
    // An explicit resume/cancel-keep after a stale apply retries against the current
    // revision. Preserve the original snapshot for undo and retain review's CAS check.
    let revision = if v["status"] == "paused" && v["summary"] == STALE_APPLY {
        store.execute(
            "get_shortlist_context",
            &json!({"run_id":v["run_id"],"limit":1}),
        )?["selection_revision"]
            .as_i64()
            .unwrap_or(0)
    } else {
        v["selection_revision_before"].as_i64().unwrap_or(0)
    };
    let reviewed = if apply && has_keeps {
        match apply_review(
            runtime,
            &v,
            ids.clone(),
            revision,
            format!("LLM Suite loop {id} consolidation (analyst-enabled Loop)"),
        )
        .await
        {
            Ok(review) => Some(review),
            Err(error) => {
                let summary = if matches!(error, Error::Conflict(_)) {
                    STALE_APPLY.to_owned()
                } else {
                    error.to_string()
                };
                store.with_connection(|c| {c.execute("UPDATE controller_loops SET status='paused',summary=?,updated_at=? WHERE loop_id=?",params![summary,now(),id])?;Ok(())})?;
                return Err(error);
            }
        }
    } else {
        None
    };
    let summary = if !has_keeps {
        "No keep decisions were made; the shortlist was not changed.".to_owned()
    } else if v["summary"]
        .as_str()
        .is_some_and(|s| !s.is_empty() && s != STALE_APPLY)
    {
        string(&v, "summary").to_owned()
    } else {
        format!(
            "Consolidated {} companies from {} kept queries.",
            ids.len(),
            qs.iter().filter(|q| !q["min_score"].is_null()).count()
        )
    };
    store.with_connection(|c| {c.execute("UPDATE controller_loops SET status='completed',applied_review_id=?,final_count=?,summary=?,updated_at=? WHERE loop_id=?",params![reviewed.as_ref().and_then(|r|r["review_id"].as_str()),ids.len(),summary,now(),id])?;Ok(())})?;
    get(store, &json!({"loop_id":id}))
}
pub async fn admin(runtime: &Runtime, store: &Store, name: &str, args: &Value) -> Result<Value> {
    if name == "start_controller_loop" {
        return start(store, args);
    }
    if name == "run_controller_loop_turn" {
        let a: LoopId = parse(args)?;
        return turn(runtime, store, &a.loop_id).await;
    }
    let id = args["loop_id"]
        .as_str()
        .ok_or_else(|| invalid("loop_id required"))?;
    let _guard = Guard::acquire(store, id)?;
    match name {
        "consolidate_controller_loop" => {
            let a: Consolidate = parse(args)?;
            consolidate_inner(runtime, store, &a.loop_id, a.apply).await
        }
        "cancel_controller_loop" => {
            let a: Cancel = parse(args)?;
            let v = record(store, &a.loop_id)?;
            if v["status"] == "cancelled" || v["status"] == "completed" {
                return get(store, &json!({"loop_id":id}));
            }
            if v["status"] != "failed" {
                active(&v)?;
            }
            if a.keep {
                consolidate_inner(runtime, store, id, true).await?;
            }
            store.with_connection(|c| {c.execute("UPDATE controller_loops SET status='cancelled',summary=CASE WHEN ? THEN summary ELSE 'Loop cancelled; shortlist unchanged. Searches remain in history.' END,updated_at=? WHERE loop_id=?",params![a.keep,now(),id])?;Ok(())})?;
            get(store, &json!({"loop_id":id}))
        }
        "undo_controller_loop" => {
            let a: Undo = parse(args)?;
            let v = record(store, &a.loop_id)?;
            if v["applied_review_id"].is_null() {
                return Err(Error::Conflict(
                    "Loop has no applied shortlist to undo".into(),
                ));
            }
            if !v["undone_review_id"].is_null() {
                return get(store, &json!({"loop_id":id}));
            }
            let (latest, applied) = store.with_connection(|c| {
                Ok((
                    c.query_row(
                        "SELECT COALESCE(MAX(rowid),0) FROM shortlist_reviews WHERE run_id=?",
                        [string(&v, "run_id")],
                        |r| r.get::<_, i64>(0),
                    )?,
                    c.query_row(
                        "SELECT rowid FROM shortlist_reviews WHERE review_id=?",
                        [string(&v, "applied_review_id")],
                        |r| r.get::<_, i64>(0),
                    )?,
                ))
            })?;
            if latest != applied && !a.force {
                return Err(Error::Conflict(
                    "Shortlist changed after loop applied; force:true is required to undo".into(),
                ));
            }
            let ids = serde_json::from_str(string(&v, "selection_before_json"))?;
            let reviewed = apply_review(
                runtime,
                &v,
                ids,
                latest,
                format!(
                    "Undo LLM Suite loop {id}: restore selection revision {} (analyst request)",
                    v["selection_revision_before"]
                ),
            )
            .await?;
            store.with_connection(|c| {
                c.execute(
                    "UPDATE controller_loops SET undone_review_id=?,updated_at=? WHERE loop_id=?",
                    params![reviewed["review_id"].as_str(), now(), id],
                )?;
                Ok(())
            })?;
            let mut result = get(store, &json!({"loop_id":id}))?;
            result["undo_review"] = reviewed;
            Ok(result)
        }
        _ => Err(invalid("Unknown loop admin operation")),
    }
}

fn turn_observations(store: &Store, id: &str, turn: i64) -> Result<String> {
    let qs = queries(store, id)?;
    let mut parts = Vec::new();
    for q in qs.iter().filter(|q| q["turn"] == turn) {
        parts.push(observation(store, id, string(q, "query_id"))?);
    }
    let results=store.with_connection(|c| {
        let mut stmt=c.prepare("SELECT ct.results_json FROM controller_loop_turns lt JOIN controller_turns ct ON ct.turn_id=lt.turn_id WHERE lt.loop_id=? AND lt.turn=? ORDER BY ct.rowid")?;
        let rows=stmt.query_map(params![id,turn],|r|r.get::<_,Option<String>>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;Ok(rows)
    })?;
    for saved in results.into_iter().flatten() {
        let rows: Value = serde_json::from_str(&saved)?;
        if let Some(rows) = rows.as_array() {
            for r in rows {
                if r["status"] == "rejected" || r["status"] == "failed" {
                    parts.push(format!(
                        "Rejected: {} — {}",
                        clip(string(r, "action"), 80),
                        clip(string(r, "reason"), 300)
                    ));
                } else if r["action"] == "inspect_band" {
                    parts.push(string(&r["result_summary"], "observation").to_owned());
                } else if r["result_summary"]["status"] == "skipped" {
                    parts.push(format!(
                        "{}: skipped — {}",
                        string(r, "action"),
                        clip(string(&r["result_summary"], "reason"), 300)
                    ));
                }
            }
        }
    }
    let mut out = String::new();
    for part in parts {
        if out.len() + part.len() + 1 > TURN_OBSERVATION_BYTES {
            out.push_str("Additional observations omitted by turn budget. Use inspect_band.\n");
            break;
        }
        out.push_str(&part);
        out.push('\n');
    }
    if out.len() > TURN_OBSERVATION_BYTES {
        out = clip(&out, TURN_OBSERVATION_BYTES);
    }
    Ok(out)
}

pub async fn turn(runtime: &Runtime, store: &Store, id: &str) -> Result<Value> {
    let _guard = Guard::acquire(store, id)?;
    let outcome = turn_inner(runtime, store, id).await;
    if let Err(error) = &outcome {
        // Rate gates preserve progress and can be retried without replaying accepted actions.
        if !matches!(error, Error::RateLimited(_)) {
            let status = if recoverable_provider_error(error) {
                "paused"
            } else {
                "failed"
            };
            store.with_connection(|c|{c.execute("UPDATE controller_loops SET status=?,summary=?,updated_at=? WHERE loop_id=? AND status='running'",params![status,error.to_string(),now(),id])?;Ok(())})?;
        }
    }
    outcome
}
fn recoverable_provider_error(error: &Error) -> bool {
    matches!(error, Error::ProviderUnavailable(_) | Error::Http(_))
        || matches!(error, Error::Conflict(message) if message.starts_with("Provider receipt is uncertain")
            || message.starts_with("Provider reply was interrupted")
            || message.starts_with("This provider request may already have been sent")
            || message.starts_with("Provider returned HTTP "))
}
async fn turn_inner(runtime: &Runtime, store: &Store, id: &str) -> Result<Value> {
    let mut v = record(store, id)?;
    active(&v)?;
    criteria_current(store, &v)?;
    let k = v["turns_used"].as_i64().unwrap_or(0) + 1;
    let n = v["max_turns"].as_i64().unwrap_or(50);
    if k > n || v["finish_requested"] == true {
        return consolidate_inner(runtime, store, id, true).await;
    }
    store.with_connection(|c| {
        c.execute(
            "UPDATE controller_loops SET status='running',updated_at=? WHERE loop_id=?",
            params![now(), id],
        )?;
        Ok(())
    })?;
    let model = std::env::var("MNA_LLMSUITE_DEPLOYMENT")
        .ok()
        .filter(|s| !s.trim().is_empty() && s.len() <= 160)
        .ok_or_else(|| {
            Error::ProviderUnavailable("Configure the LLM Suite controller model".into())
        })?;
    let catalog = action_catalog();
    let guide = controller::action_guide(&catalog, LOOP_ACTIONS);
    let state = loop_state(store, id)?;
    let budget = budget_notice(store, id)?;
    // Resume a main turn that succeeded before a feedback send hit the rate gate.
    let saved=store.with_connection(|c| {
        let mut stmt=c.prepare("SELECT ct.turn_id,ct.kind,ct.calls_json,ct.status,ct.parsed_json FROM controller_loop_turns lt JOIN controller_turns ct ON ct.turn_id=lt.turn_id WHERE lt.loop_id=? AND lt.turn=? AND ct.status='executed' AND ct.kind!='handoff' ORDER BY ct.rowid")?;
        let rows=stmt.query_map(params![id,k],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;Ok(rows)
    })?;
    let mut parent;
    let mut feedback;
    let mut repairs;
    if let Some(last) = saved.last() {
        parent = last.0.clone();
        let parsed = serde_json::from_str(&last.4)?;
        feedback = crate::instruction_set::to_tool_calls(
            &parsed,
            LOOP_ACTIONS,
            &catalog,
            &crate::instruction_set::InstructionContext {
                run_id: string(&v, "run_id").into(),
                extra: [("loop_id".into(), json!(id))].into_iter().collect(),
            },
        )
        .feedback;
        repairs = saved.iter().filter(|t| t.1 == "feedback").count();
    } else {
        let mut conversation = controller::conversation(store, string(&v, "run_id"), None)?;
        let first = k == 1
            || conversation.estimated_tokens == 0
            || conversation.id != string(&v, "conversation_id");
        let render = |first: bool| {
            if first {
                crate::prompts::render(
                    "controller-loop",
                    &[
                        ("action_guide", &guide),
                        ("loop_state", &state),
                        ("observations", string(&v, "observations")),
                        ("analyst_message", string(&v, "analyst_message")),
                        ("budget_notice", &budget),
                    ],
                )
            } else {
                crate::prompts::render(
                    "controller-loop-turn",
                    &[
                        ("turn_label", state.lines().next().unwrap_or("")),
                        ("loop_state", &state),
                        ("observations", string(&v, "observations")),
                        ("budget_notice", &budget),
                    ],
                )
            }
        };
        let mut prompt = render(first)?;
        let threshold = std::env::var("MNA_LLMSUITE_ROTATE_TOKENS")
            .ok()
            .and_then(|s| s.parse::<i64>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(180_000);
        if conversation.estimated_tokens > 0
            && conversation.estimated_tokens + (prompt.chars().count().div_ceil(4) as i64)
                > threshold
        {
            let handoff = crate::prompts::render(
                "conversation-handoff",
                &[
                    (
                        "run_summary",
                        &controller::run_summary(store, string(&v, "run_id"))?,
                    ),
                    (
                        "recent_decisions",
                        &controller::recent_decisions(store, string(&v, "run_id"), 10)?.join("\n"),
                    ),
                    ("loop_state", &state),
                ],
            )?;
            // Handoff on the old id, then seed a fresh context with the authoritative state.
            controller::execute_turn(
                runtime,
                store,
                PendingTurn {
                    loop_id: Some(id),
                    run_id: string(&v, "run_id"),
                    conversation_id: &conversation.id,
                    parent: None,
                    kind: "handoff",
                    message: None,
                    prompt_id: "conversation-handoff",
                    prompt: &handoff,
                    model: &model,
                    allowed: LOOP_ACTIONS,
                    catalog: &catalog,
                },
            )
            .await?;
            conversation = controller::conversation(store, string(&v, "run_id"), Some("rotated"))?;
            prompt = render(true)?;
        }
        store.with_connection(|c|{c.execute("UPDATE controller_loops SET conversation_id=?,status='running',updated_at=? WHERE loop_id=?",params![conversation.id,now(),id])?;Ok(())})?;
        v["conversation_id"] = json!(conversation.id);
        let result = controller::execute_turn(
            runtime,
            store,
            PendingTurn {
                loop_id: Some(id),
                run_id: string(&v, "run_id"),
                conversation_id: string(&v, "conversation_id"),
                parent: None,
                kind: "analyst",
                message: Some(string(&v, "analyst_message")),
                prompt_id: if first || prompt.starts_with("You are running") {
                    "controller-loop"
                } else {
                    "controller-loop-turn"
                },
                prompt: &prompt,
                model: &model,
                allowed: LOOP_ACTIONS,
                catalog: &catalog,
            },
        )
        .await?;
        parent = result.0;
        feedback = result.1;
        repairs = 0;
    }
    while !feedback.is_empty() && repairs < 2 {
        let prompt = crate::prompts::render(
            "instruction-feedback",
            &[("feedback", &feedback), ("allowed_actions", &guide)],
        )?;
        let (next, more) = controller::execute_turn(
            runtime,
            store,
            PendingTurn {
                loop_id: Some(id),
                run_id: string(&v, "run_id"),
                conversation_id: string(&v, "conversation_id"),
                parent: Some(&parent),
                kind: "feedback",
                message: None,
                prompt_id: "instruction-feedback",
                prompt: &prompt,
                model: &model,
                allowed: LOOP_ACTIONS,
                catalog: &catalog,
            },
        )
        .await?;
        parent = next;
        feedback = more;
        repairs += 1;
    }
    let observations = turn_observations(store, id, k)?;
    let is_none = store.with_connection(|c| {
        let reply: String = c.query_row(
            "SELECT ct.reply_markdown FROM controller_loop_turns lt JOIN controller_turns ct ON ct.turn_id=lt.turn_id WHERE lt.loop_id=? AND lt.turn=? AND ct.kind='analyst' AND ct.status='executed' ORDER BY ct.rowid DESC LIMIT 1",
            params![id,k],
            |r| r.get(0),
        )?;
        let parsed = crate::instruction_set::parse_reply(&reply);
        Ok(parsed.instructions.is_empty()
            && reply
                .lines()
                .any(|s| s.trim().eq_ignore_ascii_case("None.")))
    })?;
    store.with_connection(|c|{c.execute("UPDATE controller_loops SET turns_used=?,observations=?,none_count=CASE WHEN ? THEN none_count+1 ELSE 0 END,updated_at=? WHERE loop_id=?",params![k,observations,is_none,now(),id])?;Ok(())})?;
    let v = record(store, id)?;
    if k >= n || v["finish_requested"] == true || v["none_count"].as_i64().unwrap_or(0) >= 2 {
        return consolidate_inner(runtime, store, id, true).await;
    }
    get(store, &json!({"loop_id":id}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn timeout_and_network_errors_are_recoverable_but_fatal_errors_are_not() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let error = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(20))
            .build()
            .unwrap()
            .get(format!("http://{address}/timeout"))
            .send()
            .await
            .unwrap_err();
        assert!(error.is_timeout());
        assert!(recoverable_provider_error(&Error::Http(error)));
        drop(listener);
        let error = reqwest::get(format!("http://{address}/network"))
            .await
            .unwrap_err();
        assert!(recoverable_provider_error(&Error::Http(error)));
        assert!(recoverable_provider_error(&Error::Conflict(
            "Provider returned HTTP 503; no answer was accepted".into()
        )));
        assert!(!recoverable_provider_error(&Error::Validation(
            "Invalid query state".into()
        )));
        assert!(!recoverable_provider_error(&Error::Internal(
            "Fatal loop storage failure".into()
        )));
    }

    #[test]
    fn oversized_ids_and_cjk_observations_are_hard_bounded() {
        let (s, id) = fixture();
        add_query(&s, &id, "search_mid", 0);
        let q = query(&s, &id, "q1").unwrap();
        s.with_connection(|c| {
            c.execute("UPDATE controller_loop_queries SET label=? WHERE loop_id=?", params!["長".repeat(8000),id])?;
            for n in 0..40 {
                let cid = format!("{n}-{}", "長".repeat(4000));
                c.execute("INSERT INTO companies(company_id,name,description,created_at,updated_at) VALUES(?,?,?,datetime('now'),datetime('now'))", params![cid,"長".repeat(200),"長".repeat(300)])?;
                c.execute("INSERT INTO controller_loop_hits(loop_id,query_id,company_id,score) VALUES(?,?,?,?)", params![id,q["query_id"].as_str(),cid,n as f64/40.0])?;
            }
            Ok(())
        }).unwrap();
        let obs = observation(&s, &id, "q1").unwrap();
        assert!(obs.len() <= OBSERVATION_BYTES);
        assert!(obs.chars().count().div_ceil(4) <= 1200);
        assert!(obs.contains("id clipped"));
        for label in ["Histogram:", "Top:", "Borderline", "Bottom:"] {
            assert!(obs.contains(label));
        }
        let band = decision(
            &s,
            "inspect_band",
            &json!({"loop_id":id,"query_id":"q1","min_score":0.0,"max_score":1.0}),
        )
        .unwrap();
        assert!(band["observation"].as_str().unwrap().len() <= 4000);
    }

    #[test]
    fn exclusion_budget_preserves_whole_items_and_guide_hides_injected_fields() {
        let (s, id) = fixture();
        let revision = s.execute("save_criteria_revision", &json!({"run_id":"R","criteria_text":"Claims software","business_definition":"長".repeat(600),"core_business_exclusions":["consulting", "x".repeat(500), "y".repeat(30), "長".repeat(300), "outsourcing"]})).unwrap();
        s.execute("approve_criteria_revision", &json!({"run_id":"R","revision":revision["revision"],"digest":revision["digest"],"approved_by":"Analyst"})).unwrap();
        let state = loop_state(&s, &id).unwrap();
        assert!(state.contains(&format!(
            "{} (additional exclusions omitted)",
            json!(["consulting", "x".repeat(500), "y".repeat(30)])
        )));
        assert!(state.len() <= LOOP_STATE_BYTES);
        let guide = controller::action_guide(&action_catalog(), LOOP_ACTIONS);
        assert!(!guide.contains("loop_id"));
        assert!(!guide.contains("run_id"));
        assert!(guide.contains("query_id"));
    }

    fn fixture() -> (Store, String) {
        let s = Store::open(":memory:").unwrap();
        s.execute(
            "create_run",
            &json!({"run_id":"R","objective":"Insurance","original_criteria":{}}),
        )
        .unwrap();
        let criteria=s.execute("save_criteria_revision",&json!({"run_id":"R","criteria_text":"Claims","business_definition":"Claims software","core_business_exclusions":["consulting"]})).unwrap();
        s.execute("approve_criteria_revision",&json!({"run_id":"R","revision":criteria["revision"],"digest":criteria["digest"],"approved_by":"Analyst"})).unwrap();
        let companies=(0..40).map(|i|json!({"company_id":format!("C{i:02}"),"name":format!("Northline {i} {}","長".repeat(100)),"description":format!("Claims and policy administration software {}","長".repeat(300))})).collect::<Vec<_>>();
        s.execute("ingest_companies", &json!({"companies":companies}))
            .unwrap();
        s.execute("add_candidates",&json!({"run_id":"R","companies":companies.iter().map(|c|c["company_id"].clone()).collect::<Vec<_>>(),"discovery_source":"MID"})).unwrap();
        let v = start(
            &s,
            &json!({"run_id":"R","analyst_message":"Find claims software","max_turns":50}),
        )
        .unwrap();
        (s, string(&v, "loop_id").into())
    }
    fn add_query(s: &Store, id: &str, action: &str, offset: usize) -> String {
        let result = json!({"results":(offset..40).map(|i|json!({"company_id":format!("C{i:02}"),"score":i as f64/4.0})).collect::<Vec<_>>()});
        let q = s
            .record_search(Some("R"), "MID", "claims; policy", &json!({}), &result)
            .unwrap();
        let qid = string(&q, "query_id").to_owned();
        if action == "search_mid" {
            s.execute("add_candidates",&json!({"run_id":"R","companies":(offset..40).map(|i|json!({"company_id":format!("C{i:02}"),"retrieval_score":i as f64/40.0})).collect::<Vec<_>>(),"discovery_source":"MID","query_id":qid})).unwrap();
        }
        let mut result = result;
        result["query_id"] = json!(qid);
        register_search(s, id, action, &json!({"query":"claims; policy"}), &result)
            .unwrap()
            .unwrap()
    }
    fn keep(s: &Store, id: &str, q: &str, min: f64) {
        decision(
            s,
            "keep_query_results",
            &json!({"loop_id":id,"query_id":q,"min_score":min,"note":"Core-business boundary"}),
        )
        .unwrap();
    }
    #[test]
    fn observation_histogram_samples_caps_and_sources() {
        let (s, id) = fixture();
        let q = add_query(&s, &id, "search_mid", 0);
        let obs = observation(&s, &id, &q).unwrap();
        assert!(obs.len() <= OBSERVATION_BYTES);
        assert!(obs.chars().count().div_ceil(4) <= 1_200);
        for expected in [
            "Q1 · MID_KEYWORD",
            "40 hits (40 new",
            "Histogram:",
            "0.0–0.1:4",
            "Top:",
            "Borderline (around 0.49):",
            "Bottom:",
            "C39",
            "C00",
            "Claims and policy",
        ] {
            assert!(obs.contains(expected), "missing {expected}: {obs}");
        }
        keep(&s, &id, "Q1", 0.4);
        assert!(observation(&s, &id, &q)
            .unwrap()
            .contains("Borderline (around 0.40):"));
        let q2 = add_query(&s, &id, "search_mid_semantic", 0);
        assert!(observation(&s, &id, &q2)
            .unwrap()
            .contains("scale: semantic 0–10"));
        assert!(loop_state(&s, &id).unwrap().len() <= LOOP_STATE_BYTES);
        assert!(loop_state(&s, &id)
            .unwrap()
            .contains("Core-business exclusions: [\"consulting\"]"));
        let band = decision(
            &s,
            "inspect_band",
            &json!({"loop_id":id,"query_id":"Q1","min_score":0.4,"max_score":0.6,"limit":15}),
        )
        .unwrap();
        assert!(band["samples"].as_array().unwrap().len() <= 15);
        assert!(band["samples"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["score"].as_f64().unwrap() >= 0.4 && r["score"].as_f64().unwrap() <= 0.6));
    }
    #[test]
    fn keep_overwrites_and_consolidation_unions_query_scales_minus_drops() {
        let (s, id) = fixture();
        add_query(&s, &id, "search_mid", 0);
        add_query(&s, &id, "search_mid_semantic", 10);
        keep(&s, &id, "Q1", 0.8);
        assert_eq!(consolidated(&s, &id).unwrap().len(), 8);
        keep(&s, &id, "Q1", 0.5);
        assert_eq!(consolidated(&s, &id).unwrap().len(), 20);
        keep(&s, &id, "Q2", 2.5);
        assert_eq!(consolidated(&s, &id).unwrap().len(), 30);
        decision(
            &s,
            "drop_companies",
            &json!({"loop_id":id,"company_ids":["C10","C39"],"reason":"Clear misfits"}),
        )
        .unwrap();
        let union = consolidated(&s, &id).unwrap();
        assert_eq!(union.len(), 28);
        assert!(!union.contains(&"C10".into()));
        assert!(!union.contains(&"C39".into()));
        let v = get(&s, &json!({"loop_id":id})).unwrap();
        assert_eq!(v["keeps"].as_array().unwrap().len(), 2);
        assert_eq!(v["queries"][0]["min_score"], 0.5);
        assert_eq!(v["queries"][0]["kept_count"], 19);
        assert_eq!(v["queries"][1]["kept_count"], 28);
        assert!(loop_state(&s, &id).unwrap().contains("→ 19 kept"));
        assert!(decision(
            &s,
            "keep_query_results",
            &json!({"loop_id":id,"query_id":"Q1","min_score":8,"note":"Wrong scale"})
        )
        .is_err());
    }
    #[tokio::test]
    async fn consolidation_audited_review_and_undo_restore_initial_selection() {
        let (s, id) = fixture();
        add_query(&s, &id, "search_mid", 0);
        keep(&s, &id, "Q1", 0.75);
        let runtime = Runtime::new(s.clone()).unwrap();
        let v = admin(
            &runtime,
            &s,
            "consolidate_controller_loop",
            &json!({"loop_id":id,"apply":true}),
        )
        .await
        .unwrap();
        assert_eq!(v["status"], "completed");
        assert_eq!(v["final_count"], 10);
        assert!(!v["applied_review_id"].is_null());
        let shortlist = s
            .execute("get_shortlist_context", &json!({"run_id":"R"}))
            .unwrap();
        assert_eq!(shortlist["considered_count"], 10);
        assert_eq!(shortlist["hidden_count"], 30);
        let reason = s
            .with_connection(|c| {
                Ok(c.query_row(
                    "SELECT reason FROM shortlist_reviews WHERE review_id=?",
                    [v["applied_review_id"].as_str().unwrap()],
                    |r| r.get::<_, String>(0),
                )?)
            })
            .unwrap();
        assert_eq!(
            reason,
            format!("LLM Suite loop {id} consolidation (analyst-enabled Loop)")
        );
        admin(&runtime, &s, "undo_controller_loop", &json!({"loop_id":id}))
            .await
            .unwrap();
        assert_eq!(
            s.execute("get_shortlist_context", &json!({"run_id":"R"}))
                .unwrap()["considered_count"],
            40
        );
        assert_eq!(
            s.with_connection(
                |c| Ok(c.query_row("SELECT COUNT(*) FROM candidates", [], |r| r
                    .get::<_, i64>(0))?)
            )
            .unwrap(),
            40
        );
    }
    #[tokio::test]
    async fn stale_selection_blocks_apply_and_undo_requires_explicit_force() {
        let (s, id) = fixture();
        add_query(&s, &id, "search_mid", 0);
        keep(&s, &id, "Q1", 0.5);
        let runtime = Runtime::new(s.clone()).unwrap();
        admin(
            &runtime,
            &s,
            "consolidate_controller_loop",
            &json!({"loop_id":id,"apply":true}),
        )
        .await
        .unwrap();
        s.execute("review_shortlist",&json!({"run_id":"R","keep_company_ids":["C00"],"reason":"Subsequent manual selection"})).unwrap();
        assert!(
            admin(&runtime, &s, "undo_controller_loop", &json!({"loop_id":id}))
                .await
                .unwrap_err()
                .to_string()
                .contains("force:true")
        );
        admin(
            &runtime,
            &s,
            "undo_controller_loop",
            &json!({"loop_id":id,"force":true}),
        )
        .await
        .unwrap();
        let new = start(
            &s,
            &json!({"run_id":"R","analyst_message":"Discover again"}),
        )
        .unwrap();
        let id = string(&new, "loop_id");
        add_query(&s, id, "search_mid", 0);
        keep(&s, id, "Q1", 0.5);
        s.execute(
            "review_shortlist",
            &json!({"run_id":"R","keep_company_ids":[],"reason":"Manual change during loop"}),
        )
        .unwrap();
        assert!(admin(
            &runtime,
            &s,
            "consolidate_controller_loop",
            &json!({"loop_id":id,"apply":true})
        )
        .await
        .is_err());
        assert_eq!(
            s.execute("get_shortlist_context", &json!({"run_id":"R"}))
                .unwrap()["considered_count"],
            0
        );
    }
    #[tokio::test]
    async fn no_keeps_and_cancel_discard_never_apply() {
        let (s, id) = fixture();
        let runtime = Runtime::new(s.clone()).unwrap();
        let v = admin(
            &runtime,
            &s,
            "consolidate_controller_loop",
            &json!({"loop_id":id,"apply":true}),
        )
        .await
        .unwrap();
        assert_eq!(
            v["summary"],
            "No keep decisions were made; the shortlist was not changed."
        );
        assert!(v["applied_review_id"].is_null());
        let next = start(&s, &json!({"run_id":"R","analyst_message":"Find more"})).unwrap();
        let id = string(&next, "loop_id");
        add_query(&s, id, "search_mid", 0);
        keep(&s, id, "Q1", 0.5);
        let v = admin(
            &runtime,
            &s,
            "cancel_controller_loop",
            &json!({"loop_id":id,"keep":false}),
        )
        .await
        .unwrap();
        assert_eq!(v["status"], "cancelled");
        assert!(v["applied_review_id"].is_null());
        assert_eq!(
            s.execute("get_shortlist_context", &json!({"run_id":"R"}))
                .unwrap()["considered_count"],
            40
        );
    }
    #[tokio::test]
    async fn failed_loops_can_cancel_with_or_without_saved_keeps() {
        for keep_decisions in [false, true] {
            let (s, id) = fixture();
            add_query(&s, &id, "search_mid", 0);
            keep(&s, &id, "q1", 0.5);
            s.with_connection(|c| {
                c.execute(
                    "UPDATE controller_loops SET status='failed' WHERE loop_id=?",
                    [&id],
                )?;
                Ok(())
            })
            .unwrap();
            let runtime = Runtime::new(s.clone()).unwrap();
            let result = admin(
                &runtime,
                &s,
                "cancel_controller_loop",
                &json!({"loop_id":id,"keep":keep_decisions}),
            )
            .await
            .unwrap();
            assert_eq!(result["status"], "cancelled");
            assert_eq!(!result["applied_review_id"].is_null(), keep_decisions);
            assert_eq!(
                s.execute("get_shortlist_context", &json!({"run_id":"R"}))
                    .unwrap()["considered_count"],
                if keep_decisions { 20 } else { 40 }
            );
        }
    }
    #[test]
    fn reserve_starts_at_five_remaining_and_actions_are_mode_scoped() {
        let (s, id) = fixture();
        assert!(budget_notice(&s, &id).unwrap().is_empty());
        s.with_connection(|c| {
            c.execute(
                "UPDATE controller_loops SET turns_used=44 WHERE loop_id=?",
                [&id],
            )?;
            Ok(())
        })
        .unwrap();
        assert!(budget_notice(&s, &id).unwrap().is_empty());
        s.with_connection(|c| {
            c.execute(
                "UPDATE controller_loops SET turns_used=45 WHERE loop_id=?",
                [&id],
            )?;
            Ok(())
        })
        .unwrap();
        assert!(budget_notice(&s, &id)
            .unwrap()
            .contains("TURN BUDGET: 5 turns left"));
        let catalog = action_catalog();
        let parsed=crate::instruction_set::parse_reply("## Instruction set\n1. **keep_query_results**\n - query_id: Q1\n - min_score: 0.5\n - note: fit\n - loop_id: forged\n2. **export_shortlist**\n3. **approve_criteria_revision**");
        let ctx = crate::instruction_set::InstructionContext {
            run_id: "R".into(),
            extra: [("loop_id".into(), json!(id))].into_iter().collect(),
        };
        let single = crate::instruction_set::to_tool_calls(
            &parsed,
            controller::CONTROLLER_ACTIONS,
            &catalog,
            &ctx,
        );
        assert!(single.calls.is_empty());
        assert_eq!(single.rejected.len(), 3);
        let looped = crate::instruction_set::to_tool_calls(&parsed, LOOP_ACTIONS, &catalog, &ctx);
        assert_eq!(looped.calls.len(), 1);
        assert_eq!(looped.rejected.len(), 2);
        assert_eq!(looped.calls[0].arguments["loop_id"], id);
    }

    #[test]
    fn iscc_and_semantic_scoring_freeze_query_specific_scores() {
        let (s, id) = fixture();
        let q = s
            .record_search(
                Some("R"),
                "search_iscc",
                "claims software",
                &json!({}),
                &json!({}),
            )
            .unwrap();
        let qid = string(&q, "query_id");
        crate::data::DataService::new(s.clone()).ingest_iscc_rows_with_simulation(Some("R"),Some(qid),&[
            json!({"ECI":"E1","CID":"1","Company Name":"ISCC Claims","Description":"Claims software","Relevancy Score":0.83}),
            json!({"ECI":"E2","CID":"2","Company Name":"ISCC Misfit","Description":"Consulting","Relevancy Score":0.12}),
        ],true).unwrap();
        register_search(
            &s,
            &id,
            "search_iscc",
            &json!({"query":"claims software"}),
            &json!({"query_id":qid,"simulated":true}),
        )
        .unwrap();
        let obs = observation(&s, &id, "Q1").unwrap();
        assert!(obs.contains("scale: relevancy 0–1"));
        assert!(obs.contains("0.8–0.9:1"));
        assert!(obs.contains("SIMULATED"));
        // These ISCC hits are not run candidates, so they cannot enter consolidation.
        keep(&s, &id, "Q1", 0.5);
        assert!(consolidated(&s, &id).unwrap().is_empty());
        assert_eq!(
            get(&s, &json!({"loop_id":id})).unwrap()["queries"][0]["kept_count"],
            0
        );
        s.with_connection(|c|{c.execute("INSERT INTO mid_semantic_scores(run_id,company_id,criteria_revision,score,cosine,model,computed_at) VALUES('R','C00',1,8.5,0.85,'fixture','now')",[])?;Ok(())}).unwrap();
        register_search(
            &s,
            &id,
            "score_mid_semantic",
            &json!({"run_id":"R"}),
            &json!({"status":"scored","criteria_revision":1}),
        )
        .unwrap();
        keep(&s, &id, "Q2", 8.0);
        assert_eq!(consolidated(&s, &id).unwrap(), ["C00"]);
        s.with_connection(|c| {
            c.execute("UPDATE mid_semantic_scores SET score=0", [])?;
            Ok(())
        })
        .unwrap();
        assert!(observation(&s, &id, "Q2").unwrap().contains("8.50"));
        assert_eq!(consolidated(&s, &id).unwrap(), ["C00"]);
    }

    #[tokio::test]
    async fn restart_recovers_a_review_receipt_and_pauses_unsent_work() {
        let (s, id) = fixture();
        add_query(&s, &id, "search_mid", 0);
        keep(&s, &id, "Q1", 0.5);
        let review=s.execute("review_shortlist",&json!({"run_id":"R","keep_company_ids":consolidated(&s,&id).unwrap(),"reason":format!("LLM Suite loop {id} consolidation (analyst-enabled Loop)")})).unwrap();
        s.with_connection(|c| {
            c.execute(
                "UPDATE controller_loops SET status='consolidating' WHERE loop_id=?",
                [&id],
            )?;
            Ok(())
        })
        .unwrap();
        recover_interrupted(&s).unwrap();
        let v = get(&s, &json!({"loop_id":id})).unwrap();
        assert_eq!(v["status"], "completed");
        assert_eq!(v["applied_review_id"], review["review_id"]);
        assert_eq!(v["final_count"], 20);
        let next = start(&s, &json!({"run_id":"R","analyst_message":"Find more"})).unwrap();
        recover_interrupted(&s).unwrap();
        assert_eq!(
            get(&s, &json!({"loop_id":next["loop_id"]})).unwrap()["status"],
            "paused"
        );
    }
}
