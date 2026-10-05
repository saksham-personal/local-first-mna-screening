//! Durable, run-scoped analyst review. Authorization is enforced by runtime;
//! Store::execute exposes these operations for trusted callers and tests.
use crate::{
    error::{Error, Result},
    store::Store,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use schemars::JsonSchema;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ContextArgs {
    run_id: String,
    #[serde(default)]
    include_hidden: bool,
    #[serde(default)]
    after_company_id: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ReviewArgs {
    run_id: String,
    keep_company_ids: Vec<String>,
    #[serde(default)]
    expected_selection_revision: Option<i64>,
    #[serde(default)]
    review_columns: Option<BTreeMap<String, Vec<String>>>,
    #[serde(default)]
    reason: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SaveCriteriaArgs {
    run_id: String,
    criteria_text: String,
    business_definition: String,
    #[serde(default)]
    good_fit_examples: Vec<String>,
    #[serde(default)]
    bad_fit_examples: Vec<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ApproveCriteriaArgs {
    run_id: String,
    revision: i64,
    digest: String,
    approved_by: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RunArgs {
    run_id: String,
}

pub fn input_schema(tool: &str) -> Option<Value> {
    let schema = match tool {
        "get_shortlist_context" => schemars::schema_for!(ContextArgs),
        "review_shortlist" => schemars::schema_for!(ReviewArgs),
        "save_criteria_revision" => schemars::schema_for!(SaveCriteriaArgs),
        "approve_criteria_revision" => schemars::schema_for!(ApproveCriteriaArgs),
        "get_criteria_history" => schemars::schema_for!(RunArgs),
        _ => return None,
    };
    serde_json::to_value(schema).ok()
}

fn parse<T: DeserializeOwned>(arguments: &Value) -> Result<T> {
    serde_json::from_value(arguments.clone()).map_err(|e| Error::Validation(e.to_string()))
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn bounded(name: &str, value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty()
        || value != value.trim()
        || value.len() > max
        || value.chars().any(char::is_control)
    {
        return Err(Error::Validation(format!(
            "{name} must be trimmed, nonblank, and at most {max} bytes"
        )));
    }
    Ok(())
}
fn bounded_text(name: &str, value: &str, max: usize) -> Result<()> {
    if value.len() > max
        || value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
    {
        return Err(Error::Validation(format!(
            "{name} exceeds {max} bytes or contains unsupported control characters"
        )));
    }
    Ok(())
}
fn require_run(conn: &Connection, run_id: &str) -> Result<()> {
    bounded("run_id", run_id, 160)?;
    if conn
        .query_row(
            "SELECT 1 FROM screening_runs WHERE run_id=?",
            [run_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_none()
    {
        return Err(Error::NotFound(format!("run not found: {run_id}")));
    }
    Ok(())
}
fn digest(value: &Value) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

pub fn execute(store: &Store, tool: &str, arguments: &Value) -> Result<Value> {
    match tool {
        "get_shortlist_context" => context(store, parse(arguments)?),
        "review_shortlist" => review(store, parse(arguments)?),
        "save_criteria_revision" => save_criteria(store, parse(arguments)?),
        "approve_criteria_revision" => approve_criteria(store, parse(arguments)?),
        "get_criteria_history" => history(store, parse(arguments)?),
        _ => Err(Error::Validation(format!("unknown review tool: {tool}"))),
    }
}

pub(crate) fn review_columns(
    conn: &Connection,
    run_id: &str,
) -> Result<BTreeMap<String, Vec<String>>> {
    let mut stmt = conn.prepare(
        "SELECT plan_id,columns_json FROM shortlist_review_columns WHERE run_id=? ORDER BY plan_id",
    )?;
    let mut out = BTreeMap::new();
    for row in stmt.query_map([run_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (plan, raw) = row?;
        out.insert(plan, serde_json::from_str(&raw)?);
    }
    Ok(out)
}

pub(crate) fn criteria_revision(conn: &Connection, run_id: &str) -> Result<Value> {
    let row=conn.query_row("SELECT r.revision_id,r.revision,r.digest,r.criteria_text,r.business_definition,r.good_fit_examples_json,r.bad_fit_examples_json,r.created_at,a.approved_by,a.approved_at FROM criteria_revisions r LEFT JOIN criteria_revision_approvals a ON a.revision_id=r.revision_id WHERE r.run_id=? ORDER BY r.revision DESC LIMIT 1",[run_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,String>(7)?,r.get::<_,Option<String>>(8)?,r.get::<_,Option<String>>(9)?))).optional()?;
    if let Some((
        id,
        revision,
        digest,
        text,
        definition,
        good,
        bad,
        created,
        approved_by,
        approved_at,
    )) = row
    {
        Ok(
            json!({"id":id,"revision_id":id,"revision":revision,"digest":digest,"criteria_text":text,"business_definition":definition,"good_fit_examples":serde_json::from_str::<Value>(&good)?,"bad_fit_examples":serde_json::from_str::<Value>(&bad)?,"created_at":created,"approved":approved_at.is_some(),"approved_by":approved_by,"approved_at":approved_at}),
        )
    } else {
        Ok(Value::Null)
    }
}

pub(crate) fn selection_fingerprint(conn: &Connection, run_id: &str) -> Result<Value> {
    let revision: i64 = conn.query_row(
        "SELECT COALESCE(MAX(rowid),0) FROM shortlist_reviews WHERE run_id=?",
        [run_id],
        |r| r.get(0),
    )?;
    Ok(
        json!({"selection_revision":revision,"review_columns":review_columns(conn,run_id)?,"criteria_revision":criteria_revision(conn,run_id)?}),
    )
}

fn context(store: &Store, args: ContextArgs) -> Result<Value> {
    let limit = args.limit.unwrap_or(1000);
    if !(1..=1000).contains(&limit) {
        return Err(Error::Validation("limit must be 1..=1000".into()));
    }
    if let Some(cursor) = &args.after_company_id {
        bounded("after_company_id", cursor, 160)?;
    }
    store.with_connection(|conn|{
        require_run(conn,&args.run_id)?;
        let (total,considered_count):(i64,i64)=conn.query_row("SELECT COUNT(*),COALESCE(SUM(considered),0) FROM candidates WHERE run_id=?",[&args.run_id],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let mut stmt=conn.prepare("SELECT x.company_id,x.status,x.considered,COALESCE(NULLIF(e.pb_name,''),c.name),COALESCE(NULLIF(e.pb_website,''),c.website), (SELECT identifier FROM company_identifiers WHERE company_id=x.company_id AND kind='PBID' ORDER BY identifier LIMIT 1), COALESCE((e.pb_name IS NOT NULL OR e.pb_description IS NOT NULL),0),COALESCE(e.rogo_json,'{}')!='{}',EXISTS(SELECT 1 FROM evidence b WHERE b.run_id=x.run_id AND b.company_id=x.company_id AND b.claim='bing_research_observation' AND b.source_type='bing'),x.consideration_reason FROM candidates x JOIN companies c ON c.company_id=x.company_id LEFT JOIN company_enrichment e ON e.company_id=x.company_id WHERE x.run_id=? AND (? OR x.considered=1) AND (? IS NULL OR x.company_id>?) ORDER BY x.company_id LIMIT ?")?;
        let rows=stmt.query_map(params![args.run_id,args.include_hidden,args.after_company_id,args.after_company_id,(limit+1) as i64],|r|Ok(json!({"company_id":r.get::<_,String>(0)?,"pk":r.get::<_,String>(0)?,"status":r.get::<_,String>(1)?,"considered":r.get::<_,i64>(2)?!=0,"name":r.get::<_,String>(3)?,"website":r.get::<_,Option<String>>(4)?,"PBId":r.get::<_,Option<String>>(5)?,"consideration_reason":r.get::<_,Option<String>>(9)?,"coverage":{"PB":r.get::<_,i64>(6)?!=0,"ROGO":r.get::<_,i64>(7)?!=0,"BING":r.get::<_,i64>(8)?!=0}})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let has_more=rows.len()>limit;
        let rows=rows.into_iter().take(limit).collect::<Vec<_>>();
        let next_after_company_id=if has_more { rows.last().and_then(|r|r["company_id"].as_str()).map(str::to_owned) } else {None};
        let mut coverage=Map::new();
        for (name,sql) in [
            ("PB","SELECT COUNT(*) FROM candidates x WHERE x.run_id=? AND x.considered=1 AND EXISTS(SELECT 1 FROM company_enrichment e WHERE e.company_id=x.company_id AND (e.pb_name IS NOT NULL OR e.pb_description IS NOT NULL))"),
            ("ROGO","SELECT COUNT(*) FROM candidates x WHERE x.run_id=? AND x.considered=1 AND EXISTS(SELECT 1 FROM company_enrichment e WHERE e.company_id=x.company_id AND e.rogo_json!='{}')"),
            ("BING","SELECT COUNT(DISTINCT x.company_id) FROM candidates x JOIN evidence b ON b.run_id=x.run_id AND b.company_id=x.company_id WHERE x.run_id=? AND x.considered=1 AND b.claim='bing_research_observation' AND b.source_type='bing'")
        ] { coverage.insert(name.into(),json!(conn.query_row::<i64,_,_>(sql,[&args.run_id],|r|r.get(0))?)); }
        let fingerprint=selection_fingerprint(conn,&args.run_id)?;
        let source_version:i64=conn.query_row("SELECT version FROM source_change_counter WHERE singleton=1",[],|r|r.get(0))?;
        let source_hash=digest(&json!({"run_id":args.run_id,"source_version":source_version,"review":fingerprint}))?;
        Ok(json!({"run_id":args.run_id,"total":total,"considered_count":considered_count,"hidden_count":total-considered_count,"candidates":rows,"has_more":has_more,"next_after_company_id":next_after_company_id,"review_columns":fingerprint["review_columns"],"selection_revision":fingerprint["selection_revision"],"criteria_revision":fingerprint["criteria_revision"],"coverage":coverage,"source_hash":source_hash}))
    })
}

fn review(store: &Store, args: ReviewArgs) -> Result<Value> {
    if args.keep_company_ids.len() > 250_000 {
        return Err(Error::Validation("too many company ids".into()));
    }
    if let Some(reason) = &args.reason {
        if reason.len() > 20_000 {
            return Err(Error::Validation("reason exceeds 20000 bytes".into()));
        }
    }
    let keep: BTreeSet<_> = args.keep_company_ids.iter().cloned().collect();
    if keep.len() != args.keep_company_ids.len() {
        return Err(Error::Validation("duplicate company id".into()));
    }
    for id in &keep {
        bounded("company_id", id, 160)?;
    }
    store.with_connection(|conn|{
        let tx=conn.transaction()?;
        require_run(&tx,&args.run_id)?;
        let current_revision:i64=tx.query_row("SELECT COALESCE(MAX(rowid),0) FROM shortlist_reviews WHERE run_id=?",[&args.run_id],|r|r.get(0))?;
        if args.expected_selection_revision.is_some_and(|expected|expected!=current_revision) {return Err(Error::Conflict("shortlist selection changed since it was read".into()));}
        let mut stmt=tx.prepare("SELECT company_id FROM candidates WHERE run_id=?")?;
        let all=stmt.query_map([&args.run_id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<BTreeSet<_>,_>>()?;
        drop(stmt);
        if !keep.is_subset(&all){return Err(Error::Validation("keep_company_ids contains a company outside this run".into()));}
        let mut columns=review_columns(&tx,&args.run_id)?;
        if let Some(selected)=args.review_columns {
            if selected.len()>100 {return Err(Error::Validation("too many assessment plans".into()));}
            for (plan,cols) in &selected {
                bounded("plan_id",plan,160)?;
                if cols.len()>100 || cols.iter().collect::<BTreeSet<_>>().len()!=cols.len() {return Err(Error::Validation("duplicate or excess review columns".into()));}
                let spec:Option<String>=tx.query_row("SELECT spec_json FROM prepared_plans WHERE plan_id=? AND run_id=? AND EXISTS(SELECT 1 FROM model_assessments WHERE plan_id=prepared_plans.plan_id)",params![plan,args.run_id],|r|r.get(0)).optional()?;
                let spec=spec.ok_or_else(||Error::Validation(format!("assessment plan unavailable in this run: {plan}")))?;
                let spec:Value=serde_json::from_str(&spec)?;
                let allowed=spec["output_columns"].as_array().ok_or_else(||Error::Internal("plan output columns missing".into()))?;
                for col in cols {bounded("review column",col,160)?;if !allowed.iter().any(|v|v==col){return Err(Error::Validation(format!("review column {col} is unavailable for {plan}")));}}
            }
            tx.execute("DELETE FROM shortlist_review_columns WHERE run_id=?",[&args.run_id])?;
            for (plan,cols) in &selected {if !cols.is_empty(){tx.execute("INSERT INTO shortlist_review_columns(run_id,plan_id,columns_json) VALUES(?,?,?)",params![args.run_id,plan,serde_json::to_string(cols)?])?;}}
            columns=selected.into_iter().filter(|(_,v)|!v.is_empty()).collect();
        }
        for id in &all {tx.execute("UPDATE candidates SET consideration_reason=CASE WHEN ? THEN NULL WHEN considered=1 THEN 'manual' ELSE consideration_reason END,considered=? WHERE run_id=? AND company_id=?",params![keep.contains(id),keep.contains(id),args.run_id,id])?;}
        let review_id=format!("REV-{}",Uuid::new_v4());
        tx.execute("INSERT INTO shortlist_reviews(review_id,run_id,keep_company_ids_json,review_columns_json,considered_count,hidden_count,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",params![review_id,args.run_id,serde_json::to_string(&keep)?,serde_json::to_string(&columns)?,keep.len() as i64,(all.len()-keep.len()) as i64,args.reason,now()])?;
        let selection_revision=tx.last_insert_rowid();
        tx.commit()?;
        Ok(json!({"run_id":args.run_id,"review_id":review_id,"selection_revision":selection_revision,"total":all.len(),"considered_count":keep.len(),"hidden_count":all.len()-keep.len(),"review_columns":columns}))
    })
}

fn validate_examples(name: &str, examples: &[String]) -> Result<()> {
    if examples.len() > 100 {
        return Err(Error::Validation(format!("{name} exceeds 100 entries")));
    }
    for value in examples {
        bounded_text(name, value, 4000)?;
    }
    Ok(())
}
fn save_criteria(store: &Store, args: SaveCriteriaArgs) -> Result<Value> {
    bounded_text("criteria_text", &args.criteria_text, 100_000)?;
    bounded_text("business_definition", &args.business_definition, 100_000)?;
    validate_examples("good_fit_examples", &args.good_fit_examples)?;
    validate_examples("bad_fit_examples", &args.bad_fit_examples)?;
    store.with_connection(|conn|{
        let tx=conn.transaction()?;require_run(&tx,&args.run_id)?;
        let latest=criteria_revision(&tx,&args.run_id)?;
        if latest["approved"]==false && latest["criteria_text"]==args.criteria_text && latest["business_definition"]==args.business_definition && latest["good_fit_examples"]==json!(args.good_fit_examples) && latest["bad_fit_examples"]==json!(args.bad_fit_examples) {
            return Ok(json!({"run_id":args.run_id,"id":latest["id"],"revision_id":latest["revision_id"],"revision":latest["revision"],"digest":latest["digest"],"approved":false,"last_criteria":latest}));
        }
        let revision:i64=tx.query_row("SELECT COALESCE(MAX(revision),0)+1 FROM criteria_revisions WHERE run_id=?",[&args.run_id],|r|r.get(0))?;
        let body=json!({"run_id":args.run_id,"revision":revision,"criteria_text":args.criteria_text,"business_definition":args.business_definition,"good_fit_examples":args.good_fit_examples,"bad_fit_examples":args.bad_fit_examples});
        let hash=digest(&body)?;let revision_id=format!("CRIT-{}",Uuid::new_v4());
        tx.execute("INSERT INTO criteria_revisions(revision_id,run_id,revision,digest,criteria_text,business_definition,good_fit_examples_json,bad_fit_examples_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",params![revision_id,args.run_id,revision,hash,args.criteria_text,args.business_definition,serde_json::to_string(&args.good_fit_examples)?,serde_json::to_string(&args.bad_fit_examples)?,now()])?;
        tx.commit()?;
        Ok(json!({"run_id":args.run_id,"id":revision_id,"revision_id":revision_id,"revision":revision,"digest":hash,"approved":false,"last_criteria":body}))
    })
}
fn approve_criteria(store: &Store, args: ApproveCriteriaArgs) -> Result<Value> {
    bounded("approved_by", &args.approved_by, 160)?;
    bounded("digest", &args.digest, 64)?;
    store.with_connection(|conn|{
        let tx=conn.transaction()?;require_run(&tx,&args.run_id)?;
        let current=criteria_revision(&tx,&args.run_id)?;
        if current.is_null(){return Err(Error::NotFound("no criteria revision".into()));}
        if current["business_definition"].as_str().is_none_or(|s|s.trim().is_empty()) || current["criteria_text"].as_str().is_none_or(|s|s.trim().is_empty()) {return Err(Error::Validation("complete criteria_text and business_definition before approval".into()));}
        if current["revision"]!=args.revision || current["digest"]!=args.digest {return Err(Error::Conflict("criteria revision is no longer latest or digest differs".into()));}
        if current["approved"]==true {return Err(Error::Conflict("criteria revision already approved".into()));}
        let id=current["id"].as_str().expect("id");
        tx.execute("INSERT INTO criteria_revision_approvals(revision_id,approved_by,approved_at) VALUES(?,?,?)",params![id,args.approved_by,now()])?;
        let profile_version:i64=tx.query_row("SELECT COALESCE(MAX(version),0)+1 FROM screening_profiles WHERE run_id=?",[&args.run_id],|r|r.get(0))?;
        let content=json!({"business_definition":current["business_definition"],"core_business_query":current["business_definition"],"core_business_criteria":current["criteria_text"],"good_fit_examples":current["good_fit_examples"],"bad_fit_examples":current["bad_fit_examples"]});
        let timestamp=now();
        tx.execute("UPDATE screening_profiles SET status='SUPERSEDED' WHERE run_id=? AND status='APPROVED'",[&args.run_id])?;
        tx.execute("INSERT INTO screening_profiles(profile_id,run_id,version,content_json,rationale,status,proposed_at,approved_at,approved_by) VALUES(?,?,?,?,?,'APPROVED',?,?,?)",params![format!("PROF-{}",Uuid::new_v4()),args.run_id,profile_version,serde_json::to_string(&content)?,format!("Approved criteria revision {}",args.revision),timestamp,timestamp,args.approved_by])?;
        tx.execute("UPDATE screening_runs SET status='ACTIVE',updated_at=? WHERE run_id=? AND status='DRAFT'",params![timestamp,args.run_id])?;
        tx.commit()?;
        Ok(json!({"run_id":args.run_id,"id":id,"revision":args.revision,"digest":args.digest,"approved":true,"approved_by":args.approved_by,"profile_version":profile_version}))
    })
}
fn history(store: &Store, args: RunArgs) -> Result<Value> {
    store.with_connection(|conn|{
        require_run(conn,&args.run_id)?;
        let mut stmt=conn.prepare("SELECT r.revision_id,r.revision,r.digest,r.criteria_text,r.business_definition,r.good_fit_examples_json,r.bad_fit_examples_json,r.created_at,a.approved_by,a.approved_at FROM criteria_revisions r LEFT JOIN criteria_revision_approvals a ON a.revision_id=r.revision_id WHERE r.run_id=? ORDER BY r.revision")?;
        let mut versions=Vec::new();
        for row in stmt.query_map([&args.run_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,String>(7)?,r.get::<_,Option<String>>(8)?,r.get::<_,Option<String>>(9)?)))? {
            let(id,revision,digest,text,definition,good,bad,created,by,at)=row?;
            versions.push(json!({"id":id,"revision_id":id,"revision":revision,"digest":digest,"criteria_text":text,"business_definition":definition,"good_fit_examples":serde_json::from_str::<Value>(&good)?,"bad_fit_examples":serde_json::from_str::<Value>(&bad)?,"created_at":created,"approved":at.is_some(),"approved_by":by,"approved_at":at}));
        }
        Ok(json!({"run_id":args.run_id,"revisions":versions,"last_criteria":versions.last(),"count":versions.len()}))
    })
}

/// Explicit mapping rows are authoritative for that row only. A partial file
/// never hides candidates absent from the file, and a valid Yes/PBId never
/// restores a company manually hidden by review.
pub fn hide_explicit_unmapped_pb(
    conn: &Connection,
    run_id: &str,
    company_id: &str,
    reason: &str,
) -> Result<bool> {
    if !matches!(reason, "pitchbook_unmapped" | "pitchbook_non_company") {
        return Err(Error::Validation(
            "invalid PitchBook consideration reason".into(),
        ));
    }
    Ok(conn.execute(
        "UPDATE candidates SET considered=0,consideration_reason=? WHERE run_id=? AND company_id=? AND considered=1",
        params![reason,run_id, company_id],
    )? > 0)
}

pub(crate) fn hide_all_unmapped_pb(conn: &Connection, run_id: &str) -> Result<usize> {
    Ok(conn.execute("UPDATE candidates SET considered=0,consideration_reason='pitchbook_unmapped' WHERE run_id=? AND considered=1 AND NOT EXISTS(SELECT 1 FROM company_identifiers i WHERE i.company_id=candidates.company_id AND i.kind='PBID')",[run_id])?)
}

pub(crate) fn restore_pb_mapping(
    conn: &Connection,
    run_id: &str,
    company_id: &str,
) -> Result<bool> {
    Ok(conn.execute("UPDATE candidates SET considered=1,consideration_reason=NULL WHERE run_id=? AND company_id=? AND considered=0 AND consideration_reason IN ('pitchbook_unmapped','pitchbook_non_company')",params![run_id,company_id])?>0)
}

pub(crate) fn record_pb_import_review(conn: &Connection, run_id: &str) -> Result<i64> {
    let mut stmt = conn.prepare(
        "SELECT company_id FROM candidates WHERE run_id=? AND considered=1 ORDER BY company_id",
    )?;
    let keep = stmt
        .query_map([run_id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM candidates WHERE run_id=?",
        [run_id],
        |r| r.get(0),
    )?;
    conn.execute("INSERT INTO shortlist_reviews(review_id,run_id,keep_company_ids_json,review_columns_json,considered_count,hidden_count,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",params![format!("REV-{}",Uuid::new_v4()),run_id,serde_json::to_string(&keep)?,serde_json::to_string(&review_columns(conn,run_id)?)?,keep.len() as i64,total-keep.len() as i64,"PitchBook enrichment import",now()])?;
    Ok(conn.last_insert_rowid())
}
