//! Durable, approval-gated prepared execution plans. Provider transport lives in the runtime.
use chrono::{Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::projection::{self, IdentitySources, SourceColumn};
use crate::result_parser;
use crate::Store;

const MAX_BATCH: usize = 200;
const MAX_ROWS: usize = 100_000;
const MAX_RESPONSE_BYTES: usize = 2_000_000;
const LEASE_SECONDS: i64 = 120;

#[derive(Clone)]
pub struct ExecutionService {
    store: Store,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProposeArgs {
    pub run_id: String,
    pub mode: String,
    pub provider: String,
    pub deployment: String,
    pub prompt: String,
    #[serde(default)]
    pub question: Option<String>,
    #[serde(default)]
    pub company_ids: Vec<String>,
    #[serde(default)]
    pub source_columns: Vec<SourceColumn>,
    #[serde(default)]
    pub identity_sources: IdentitySources,
    #[serde(default)]
    pub input_columns: Vec<String>,
    #[serde(default)]
    pub output_columns: Vec<String>,
    #[serde(default)]
    pub score_columns: Vec<String>,
    #[serde(default = "default_batch_size")]
    pub batch_size: usize,
    #[serde(default)]
    pub provider_options: Value,
    #[serde(default)]
    pub retrieval_configuration: Value,
}
fn default_batch_size() -> usize {
    50
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct PlanIdArgs {
    plan_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ScreeningRoundsArgs {
    run_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ApproveArgs {
    plan_id: String,
    digest: String,
    approved_by: String,
    approval_key: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CancelArgs {
    plan_id: String,
    cancelled_by: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct LeaseArgs {
    job_id: String,
    controller_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct DispatchArgs {
    job_id: String,
    lease_token: String,
    request_key: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ResponseArgs {
    job_id: String,
    lease_token: String,
    response_text: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ReconcileArgs {
    job_id: String,
    attempt: i64,
    outcome: String,
    reason: String,
    #[serde(default)]
    response_text: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct FailureArgs {
    job_id: String,
    lease_token: String,
    kind: String,
    reason: String,
    #[serde(default)]
    retry_after_seconds: Option<u64>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RetryArgs {
    job_id: String,
    attempt: i64,
    reason: String,
    analyst_requested: bool,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct JobIdArgs {
    job_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct AssessmentsArgs {
    run_id: String,
    #[serde(default)]
    plan_id: Option<String>,
    #[serde(default)]
    company_id: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SlotArgs {
    purpose: String,
    request_key: String,
}

fn parse<T: for<'de> Deserialize<'de>>(args: &Value) -> Result<T> {
    serde_json::from_value(args.clone()).map_err(|e| Error::Validation(e.to_string()))
}
fn id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4())
}
fn timestamp() -> String {
    Utc::now().to_rfc3339()
}
fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn json_hash(value: &Value) -> Result<String> {
    Ok(hash(serde_json::to_vec(value)?))
}
fn encoded(value: &Value) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}
fn decoded(value: String) -> Result<Value> {
    Ok(serde_json::from_str(&value)?)
}
fn bounded(label: &str, value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max {
        Err(Error::Validation(format!(
            "{label} must be nonempty and at most {max} bytes"
        )))
    } else {
        Ok(())
    }
}

impl ExecutionService {
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    pub fn execute(&self, tool: &str, args: &Value) -> Result<Value> {
        if !args.is_object() || serde_json::to_vec(args)?.len() > 2_100_000 {
            return Err(Error::Validation(
                "execution arguments must be an object of at most 2.1 MB".into(),
            ));
        }
        match tool {
            "propose_prepared_plan" => self.propose(parse(args)?),
            "get_prepared_plan" => self.get_plan(parse(args)?),
            "approve_prepared_plan" => self.approve(parse(args)?),
            "cancel_prepared_plan" => self.cancel(parse(args)?),
            "lease_execution_job" => self.lease(parse(args)?),
            "mark_execution_dispatch" => self.dispatch(parse(args)?),
            "record_execution_response" => self.record(parse(args)?),
            "reconcile_execution_job" => self.reconcile(parse(args)?),
            "record_execution_failure" => self.failure(parse(args)?),
            "retry_execution_job" => self.retry(parse(args)?),
            "get_execution_job" => self.get_job(parse(args)?),
            "get_execution_progress" => self.progress(parse(args)?),
            "get_model_assessments" => self.assessments(parse(args)?),
            "get_screening_rounds" => self.screening_rounds(parse(args)?),
            "reserve_llmsuite_slot" => {
                let a: SlotArgs = parse(args)?;
                self.reserve_llmsuite_slot(&a.purpose, &a.request_key)
            }
            "consume_llmsuite_slot" => {
                let a: SlotArgs = parse(args)?;
                self.store.with_connection(|conn| {
                    let tx = conn.transaction()?;
                    let value = reserve_slot_tx(&tx, &a.purpose, &a.request_key, Utc::now(), true)?;
                    tx.commit()?;
                    Ok(value)
                })
            }
            _ => Err(Error::Validation(format!("unknown execution tool: {tool}"))),
        }
    }

    fn propose(&self, mut args: ProposeArgs) -> Result<Value> {
        bounded("run_id", &args.run_id, 160)?;
        if args.deployment.len() > 160 || args.deployment != args.deployment.trim() {
            return Err(Error::Validation(
                "deployment must be trimmed and at most 160 bytes".into(),
            ));
        }
        bounded("prompt", &args.prompt, 100_000)?;
        if !matches!(args.mode.as_str(), "screening" | "question") {
            return Err(Error::Validation(
                "mode must be screening or question".into(),
            ));
        }
        if !matches!(args.provider.as_str(), "llm_suite" | "copilot") {
            return Err(Error::Validation(
                "provider must be llm_suite or copilot".into(),
            ));
        }
        if args.batch_size == 0 || args.batch_size > MAX_BATCH {
            return Err(Error::Validation(format!(
                "batch_size must be 1..={MAX_BATCH}"
            )));
        }
        if args.mode == "question" {
            bounded("question", args.question.as_deref().unwrap_or(""), 20_000)?;
            if !args.score_columns.is_empty() {
                return Err(Error::Validation(
                    "general questions do not use scoring columns".into(),
                ));
            }
        } else {
            if args.output_columns.is_empty() {
                return Err(Error::Validation("screening needs output columns".into()));
            }
            if args.question.is_some() {
                return Err(Error::Validation(
                    "screening does not accept question".into(),
                ));
            }
        }
        unique_columns(&args.output_columns, "output_columns")?;
        unique_columns(&args.score_columns, "score_columns")?;
        if args
            .output_columns
            .iter()
            .any(|s| s.eq_ignore_ascii_case("index"))
        {
            return Err(Error::Validation(
                "index is reserved and supplied by the service".into(),
            ));
        }
        if args
            .score_columns
            .iter()
            .any(|s| !args.output_columns.contains(s))
        {
            return Err(Error::Validation(
                "score_columns must be selected output_columns".into(),
            ));
        }
        if args.company_ids.len() > MAX_ROWS {
            return Err(Error::Validation("company scope too large".into()));
        }
        if args
            .company_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != args.company_ids.len()
        {
            return Err(Error::Validation("company_ids contains duplicates".into()));
        }
        args.company_ids.sort();
        if !args.provider_options.is_object() && !args.provider_options.is_null() {
            return Err(Error::Validation(
                "provider_options must be an object".into(),
            ));
        }
        if !args.retrieval_configuration.is_object() && !args.retrieval_configuration.is_null() {
            return Err(Error::Validation(
                "retrieval_configuration must be an object".into(),
            ));
        }
        self.store.with_connection(|conn| {
            let tx=conn.transaction()?;
            let mut snapshot=projection::snapshot_selected(&tx,&args.run_id,&args.company_ids,&args.source_columns,&args.identity_sources,&args.input_columns)?;
            if args.mode == "screening" && snapshot["rows"].as_array().is_none_or(Vec::is_empty) { return Err(Error::Validation("screening scope has no candidates".into())); }
            if args.mode == "screening" && snapshot["profile_version"].as_i64().unwrap_or(0)<=0 {return Err(Error::Conflict("screening requires an approved profile".into()));}
            if let Some(requested)=(!args.input_columns.is_empty()).then_some(&args.input_columns) {
                let actual:Vec<String>=serde_json::from_value(snapshot["input_columns"].clone())?;
                if requested != &actual { return Err(Error::Validation("input_columns must match the projected columns exactly".into())); }
            }
            args.input_columns=serde_json::from_value(snapshot["input_columns"].clone())?;
            if args.provider=="copilot" && snapshot["pb_linkedin_count"].as_u64().unwrap_or(0)>0 && !args.input_columns.iter().any(|s| s=="LinkedIn URL") {
                return Err(Error::Validation("Copilot screening requires the genuine PB LinkedIn URL projection".into()));
            }
            snapshot["adapter_configuration_hash"]=json!(adapter_configuration_hash(&args.provider)?);
            let compiled_prompt=crate::gateway::compiled_prompt(&args.prompt,&args.output_columns,&args.score_columns);
            snapshot["execution_contract_hash"]=json!(json_hash(&json!({"contract_version":2,"compiled_prompt":compiled_prompt,"repair_limit":2,"selected_columns_only":true}))?);
            snapshot["compiled_prompt"]=json!(compiled_prompt);
            let spec=serde_json::to_value(&args)?;
            let digest=json_hash(&json!({"schema_version":2,"spec":spec,"snapshot":snapshot}))?;
            let plan_id=id("PPLAN"); let now=timestamp();
            tx.execute("INSERT INTO prepared_plans(plan_id,run_id,schema_version,digest,status,spec_json,snapshot_json,proposed_at) VALUES(?,?,2,?,'PROPOSED',?,?,?)",params![plan_id,args.run_id,digest,encoded(&spec)?,encoded(&snapshot)?,now])?;
            tx.commit()?;
            Ok(json!({"plan_id":plan_id,"run_id":args.run_id,"schema_version":2,"digest":digest,"status":"PROPOSED","spec":spec,"snapshot":snapshot,"proposed_at":now,"executed":false}))
        })
    }

    fn get_plan(&self, a: PlanIdArgs) -> Result<Value> {
        self.store.with_connection(|conn| {
            let plan=load_plan(conn,&a.plan_id)?;
            let mut stmt=conn.prepare("SELECT job_id,ordinal,state,input_hash FROM execution_jobs WHERE plan_id=? ORDER BY ordinal")?;
            let jobs=stmt.query_map([&a.plan_id],|r|Ok(json!({"job_id":r.get::<_,String>(0)?,"ordinal":r.get::<_,i64>(1)?,"state":r.get::<_,String>(2)?,"input_hash":r.get::<_,String>(3)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
            Ok(json!({"plan_id":a.plan_id,"run_id":plan.run_id,"schema_version":2,"digest":plan.digest,"status":plan.status,"spec":plan.spec,"snapshot":plan.snapshot,"jobs":jobs,"executed":false}))
        })
    }

    fn approve(&self, a: ApproveArgs) -> Result<Value> {
        bounded("approved_by", &a.approved_by, 160)?;
        bounded("approval_key", &a.approval_key, 160)?;
        self.store.with_connection(|conn| {
            let tx=conn.transaction()?; let p=load_plan(&tx,&a.plan_id)?;
            if p.digest!=a.digest { return Err(Error::Conflict("approval digest differs from immutable proposal".into())); }
            if p.status=="APPROVED" {
                let existing:(String,String,String)=tx.query_row("SELECT approval_key,digest,approved_by FROM prepared_plan_approvals WHERE plan_id=?",[&a.plan_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
                if existing==(a.approval_key.clone(),a.digest.clone(),a.approved_by.clone()) {
                    let round_no: Option<i64> = if p.spec["mode"] == "screening" {
                        tx.query_row("SELECT round_no FROM screening_rounds WHERE plan_id=?", [&a.plan_id], |r| r.get(0)).optional()?
                    } else { None };
                    tx.commit()?;
                    let mut result=json!({"plan_id":a.plan_id,"status":"APPROVED","idempotent":true});
                    if let Some(round_no)=round_no { result["round_no"]=json!(round_no); }
                    return Ok(result);
                }
                return Err(Error::Conflict("plan already has a different immutable approval".into()));
            }
            if p.status!="PROPOSED" { return Err(Error::Conflict(format!("plan is {}",p.status))); }
            if let Err(e)=require_fresh(&tx,&p) {
                tx.execute("UPDATE prepared_plans SET status='STALE' WHERE plan_id=?",[&a.plan_id])?;
                tx.commit()?;
                return Err(e);
            }
            let spec:ProposeArgs=serde_json::from_value(p.spec.clone())?;
            bounded("deployment",&spec.deployment,160)?;
            let rows=p.snapshot["rows"].as_array().ok_or_else(||Error::Internal("snapshot rows missing".into()))?;
            let batches:Vec<Vec<Value>>=if spec.mode=="question" && spec.output_columns.is_empty() { vec![if spec.company_ids.is_empty(){Vec::new()}else{rows.clone()}] } else { rows.chunks(spec.batch_size).map(|v|v.to_vec()).collect() };
            if batches.is_empty() {return Err(Error::Validation("table output requires at least one company".into()));}
            if spec.mode=="question" && spec.output_columns.is_empty() && spec.company_ids.len()>spec.batch_size {return Err(Error::Validation("a general question context must fit in one batch; select output columns for company questions".into()));}
            let now=timestamp();
            for (ordinal, batch) in batches.iter().enumerate() {
                let job_id=id("EJOB");
                let indices:Vec<usize>=batch.iter().map(|r|r["index"].as_u64().unwrap_or(0) as usize).collect();
                if spec.mode=="screening" && indices.contains(&0) { return Err(Error::Internal("projected row index missing".into())); }
                let payload=json!({"schema_version":2,"plan_id":a.plan_id,"run_id":p.run_id,"mode":spec.mode,"provider":spec.provider,"deployment":spec.deployment,"prompt":spec.prompt,"compiled_prompt":p.snapshot["compiled_prompt"],"execution_contract_hash":p.snapshot["execution_contract_hash"],"question":spec.question,"input_columns":spec.input_columns,"output_columns":spec.output_columns,"score_columns":spec.score_columns,"provider_options":spec.provider_options,"retrieval_configuration":spec.retrieval_configuration,"rows":batch,"indices":indices,"candidate_hash":p.snapshot["candidate_hash"],"data_hash":p.snapshot["data_hash"],"profile_version":p.snapshot["profile_version"],"adapter_configuration_hash":p.snapshot["adapter_configuration_hash"]});
                let input_hash=json_hash(&payload)?;
                tx.execute("INSERT INTO execution_jobs(job_id,plan_id,run_id,ordinal,state,payload_json,input_hash,created_at,updated_at) VALUES(?,?,?,?,'READY',?,?,?,?)",params![job_id,a.plan_id,p.run_id,ordinal as i64,encoded(&payload)?,input_hash,now,now])?;
                for row in batch {
                    let index=row["index"].as_i64().ok_or_else(||Error::Internal("row index missing".into()))?;
                    let pk=row["pk"].as_str().ok_or_else(||Error::Internal("row pk missing".into()))?;
                    let row_hash=json_hash(row)?;
                    tx.execute("INSERT INTO execution_index_map(plan_id,row_index,company_id,job_id,row_hash) VALUES(?,?,?,?,?)",params![a.plan_id,index,pk,job_id,row_hash])?;
                }
                tx.execute("INSERT INTO execution_outbox(event_id,plan_id,job_id,kind,payload_json,created_at) VALUES(?,?,?,'JOB_READY',?,?)",params![id("EO"),a.plan_id,job_id,encoded(&json!({"job_id":job_id,"input_hash":input_hash}))?,now])?;
            }
            tx.execute("INSERT INTO prepared_plan_approvals(plan_id,approval_key,digest,approved_by,approved_at) VALUES(?,?,?,?,?)",params![a.plan_id,a.approval_key,a.digest,a.approved_by,now])?;
            tx.execute("UPDATE prepared_plans SET status='APPROVED',approved_at=?,approved_by=? WHERE plan_id=?",params![now,a.approved_by,a.plan_id])?;
            let round_no=if spec.mode=="screening" {
                let round_no:i64=tx.query_row("SELECT COALESCE(MAX(round_no),0)+1 FROM screening_rounds WHERE run_id=?",[&p.run_id],|r|r.get(0))?;
                tx.execute("INSERT INTO screening_rounds(run_id,round_no,plan_id,provider,created_at) VALUES(?,?,?,?,?)",params![p.run_id,round_no,a.plan_id,spec.provider,now])?;
                Some(round_no)
            } else { None };
            tx.commit()?;
            let mut result=json!({"plan_id":a.plan_id,"status":"APPROVED","job_count":batches.len(),"idempotent":false});
            if let Some(round_no)=round_no { result["round_no"]=json!(round_no); }
            Ok(result)
        })
    }

    fn cancel(&self, a: CancelArgs) -> Result<Value> {
        bounded("cancelled_by", &a.cancelled_by, 160)?;
        self.store.with_connection(|conn| {let tx=conn.transaction()?;let p=load_plan(&tx,&a.plan_id)?;
            if p.status=="CANCELLED" {return Ok(json!({"plan_id":a.plan_id,"status":"CANCELLED","idempotent":true}));}
            let running:i64=tx.query_row("SELECT COUNT(*) FROM execution_jobs WHERE plan_id=? AND state IN ('RUNNING','AMBIGUOUS')",[&a.plan_id],|r|r.get(0))?;
            if running>0 {return Err(Error::Conflict("dispatched jobs must be reconciled before cancellation".into()));}
            let now=timestamp(); tx.execute("UPDATE prepared_plans SET status='CANCELLED',cancelled_at=? WHERE plan_id=?",params![now,a.plan_id])?;
            tx.execute("UPDATE execution_jobs SET state='CANCELLED',updated_at=? WHERE plan_id=? AND state IN ('READY','LEASED','WAITING_RATE','PARSE_REVIEW')",params![now,a.plan_id])?;
            tx.commit()?;Ok(json!({"plan_id":a.plan_id,"status":"CANCELLED","cancelled_by":a.cancelled_by})) })
    }

    fn lease(&self, a: LeaseArgs) -> Result<Value> {
        bounded("controller_id", &a.controller_id, 160)?;
        self.store.with_connection(|conn| {let tx=conn.transaction()?;let j=load_job(&tx,&a.job_id)?;let p=load_plan(&tx,&j.plan_id)?;
            if p.status!="APPROVED" {return Err(Error::Conflict("plan is not approved".into()));}
            if let Err(e)=require_fresh(&tx,&p) { mark_stale(&tx,&p.plan_id,&j.job_id)?;tx.commit()?;return Err(e); }
            let now=Utc::now();
            if j.state=="WAITING_RATE" && j.next_eligible_at.as_deref().and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok()).is_some_and(|t|t>now) {return Err(Error::RateLimited("job is waiting for its next eligible time".into()));}
            let expired=j.lease_expires_at.as_deref().and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok()).is_some_and(|t|t<now);
            if j.state=="LEASED" && !expired {return Err(Error::Conflict("job has an active lease".into()));}
            if j.state=="RUNNING" && expired {tx.execute("UPDATE execution_jobs SET state='AMBIGUOUS',updated_at=? WHERE job_id=?",params![timestamp(),a.job_id])?;tx.commit()?;return Err(Error::Conflict("dispatched lease expired; job is AMBIGUOUS and requires reconciliation".into()));}
            if !matches!(j.state.as_str(),"READY"|"WAITING_RATE"|"LEASED"|"PARSE_REVIEW") {return Err(Error::Conflict(format!("job cannot be leased from {}",j.state)));}
            // A lease that expired before dispatch is safe to replace. A dispatched
            // attempt is represented by RUNNING until explicitly reconciled.
            let token=id("LEASE");let until=(now+Duration::seconds(LEASE_SECONDS)).to_rfc3339();
            tx.execute("UPDATE execution_jobs SET state='LEASED',lease_token=?,lease_expires_at=?,updated_at=? WHERE job_id=?",params![token,until,timestamp(),a.job_id])?;
            tx.execute("UPDATE execution_outbox SET consumed_at=? WHERE job_id=? AND consumed_at IS NULL",params![timestamp(),a.job_id])?;
            tx.commit()?;
            Ok(json!({"job_id":a.job_id,"plan_id":j.plan_id,"state":"LEASED","lease_token":token,"lease_expires_at":until,"payload":j.payload,"input_hash":j.input_hash,"adapter_configured":adapter_configured(&j.payload),"executed":false,"repair_prompt":j.repair_prompt})) })
    }

    fn dispatch(&self, a: DispatchArgs) -> Result<Value> {
        bounded("request_key", &a.request_key, 160)?;
        self.store.with_connection(|conn| {let tx=conn.transaction()?;let j=load_job(&tx,&a.job_id)?;let p=load_plan(&tx,&j.plan_id)?;
            if p.status!="APPROVED" {return Err(Error::Conflict("plan is not approved".into()));}
            if let Err(e)=require_fresh(&tx,&p) {mark_stale(&tx,&p.plan_id,&j.job_id)?;tx.commit()?;return Err(e);}
            require_lease(&j,&a.lease_token)?;
            if !adapter_configured(&j.payload) {return Err(Error::ProviderUnavailable("provider adapter is not configured".into()));}
            if j.payload["adapter_configuration_hash"]!=json!(adapter_configuration_hash(j.payload["provider"].as_str().unwrap_or(""))?) {return Err(Error::Conflict("provider endpoint configuration changed; propose a new plan".into()));}
            let used_key:Option<String>=tx.query_row("SELECT job_id FROM execution_provider_audit WHERE request_key=? LIMIT 1",[&a.request_key],|r|r.get(0)).optional()?;
            if used_key.is_some() {return Err(Error::Conflict("request key already dispatched".into()));}
            if j.payload["provider"]=="llm_suite" {
                match reserve_slot_tx(&tx,if j.repair_attempt>0 {"repair"} else {j.payload["mode"].as_str().unwrap_or("screening")},&a.request_key,Utc::now(),true) {
                    Ok(_) => {},
                    Err(Error::RateLimited(message)) => {
                        let next=next_slot_time(&tx,Utc::now())?;
                        tx.execute("UPDATE execution_jobs SET state='WAITING_RATE',next_eligible_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=?",params![next,timestamp(),a.job_id])?;
                        tx.commit()?;
                        return Ok(json!({"job_id":a.job_id,"state":"WAITING_RATE","executed":false,"next_eligible_at":next,"reason":message}));
                    }
                    Err(e)=>return Err(e),
                }
            }
            let now=timestamp();
            tx.execute("INSERT INTO execution_provider_audit(audit_id,job_id,provider,purpose,request_key,payload_hash,recorded_at) VALUES(?,?,?,?,?,?,?)",params![id("EA"),a.job_id,j.payload["provider"].as_str(),"screening_or_question",a.request_key,j.input_hash,now])?;
            tx.execute("UPDATE execution_jobs SET state='RUNNING',attempt=attempt+1,dispatched_at=?,response_hash=NULL,raw_response=NULL,error_text=NULL,next_eligible_at=NULL,updated_at=? WHERE job_id=?",params![now,now,a.job_id])?;
            tx.commit()?;Ok(json!({"job_id":a.job_id,"state":"RUNNING","executed":false,"dispatch_authorized":true,"request_key":a.request_key})) })
    }

    fn record(&self, a: ResponseArgs) -> Result<Value> {
        self.record_inner(a, false, None, None)
    }

    fn record_inner(
        &self,
        a: ResponseArgs,
        reconciled: bool,
        reason: Option<&str>,
        expected_attempt: Option<i64>,
    ) -> Result<Value> {
        if a.response_text.len() > MAX_RESPONSE_BYTES {
            return Err(Error::Validation("response exceeds 2 MB".into()));
        }
        let response_hash = hash(a.response_text.as_bytes());
        self.store.with_connection(|conn| {let tx=conn.transaction()?;let j=load_job(&tx,&a.job_id)?;let p=load_plan(&tx,&j.plan_id)?;
            if matches!(j.state.as_str(),"SUCCEEDED"|"PARSE_REVIEW"|"FAILED") {
                if j.response_hash.as_deref()==Some(response_hash.as_str()) {return Ok(json!({"job_id":a.job_id,"state":j.state,"idempotent":true}));}
                return Err(Error::Conflict("job already has a different response for this attempt".into()));
            }
            if !matches!(j.state.as_str(),"RUNNING"|"AMBIGUOUS") {return Err(Error::Conflict(format!("job is {}",j.state)));}
            if expected_attempt.is_some_and(|attempt|attempt!=j.attempt) {return Err(Error::Conflict("reconciliation refers to a different provider attempt".into()));}
            if !reconciled && j.lease_token.as_deref()!=Some(&a.lease_token) {return Err(Error::Conflict("lease token mismatch".into()));}
            let historical=p.status!="APPROVED" || require_fresh(&tx,&p).is_err();
            if historical {mark_stale(&tx,&p.plan_id,&j.job_id)?;}
            let now=timestamp();
            if reconciled {tx.execute("INSERT INTO execution_reconciliations(reconciliation_id,job_id,outcome,reason,created_at) VALUES(?,?,'response_received',?,?)",params![id("REC"),a.job_id,reason.unwrap_or("late response"),now])?;}
            let direct_answer=j.payload["mode"]=="question" && j.payload["output_columns"].as_array().is_some_and(Vec::is_empty);
            let parsed=if direct_answer {if a.response_text.trim().is_empty(){Err(Error::Validation("question answer is empty".into()))}else{Ok(Vec::new())}} else {
                let cols:Vec<String>=serde_json::from_value(j.payload["output_columns"].clone())?;
                let scores:Vec<String>=serde_json::from_value(j.payload["score_columns"].clone())?;
                let indices:Vec<usize>=serde_json::from_value(j.payload["indices"].clone())?;
                result_parser::parse_markdown_results(&a.response_text,&cols,&indices,&scores)
            };
            match parsed {
                Ok(rows)=>{
                    tx.execute("INSERT INTO execution_responses(response_id,job_id,attempt,response_hash,raw_response,parse_status,created_at) VALUES(?,?,?,?,?,'ACCEPTED',?)",params![id("ER"),a.job_id,j.attempt,response_hash,a.response_text,now])?;
                    if direct_answer {
                        tx.execute("INSERT INTO execution_question_answers(answer_id,run_id,plan_id,job_id,provider,question,answer,attribution_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",params![id("EQA"),j.run_id,j.plan_id,a.job_id,j.payload["provider"].as_str(),j.payload["question"].as_str(),a.response_text,encoded(&j.payload["retrieval_configuration"])?,now])?;
                    } else {
                        for row in rows {
                            let index=row["index"].as_i64().ok_or_else(||Error::Internal("parser omitted index".into()))?;
                            let company_id:String=tx.query_row("SELECT company_id FROM execution_index_map WHERE plan_id=? AND job_id=? AND row_index=?",params![j.plan_id,a.job_id,index],|r|r.get(0))?;
                            tx.execute("INSERT INTO model_assessments(assessment_id,run_id,plan_id,job_id,company_id,row_index,provider,prompt,result_json,created_at,simulated) VALUES(?,?,?,?,?,?,?,?,?,?,?)",params![id("MA"),j.run_id,j.plan_id,a.job_id,company_id,index,j.payload["provider"].as_str(),j.payload["prompt"].as_str(),encoded(&row)?,now,j.payload["adapter_configuration_hash"] == json!(crate::simulate::adapter_hash(j.payload["provider"].as_str().unwrap_or(""))?)])?;
                        }
                    }
                    tx.execute("UPDATE execution_jobs SET state='SUCCEEDED',response_hash=?,raw_response=?,completed_at=?,updated_at=? WHERE job_id=?",params![response_hash,a.response_text,now,now,a.job_id])?;
                    tx.commit()?;Ok(json!({"job_id":a.job_id,"state":"SUCCEEDED","response_hash":response_hash,"idempotent":false,"executed":true,"historical":historical}))
                }
                Err(e)=>{
                    let error=e.to_string();let repair=j.repair_attempt+1;
                    let table_answer=if direct_answer {""} else {"yes"};
                    let direct_answer_hint=if direct_answer {"yes"} else {""};
                    let original_response=a.response_text.chars().take(20_000).collect::<String>();
                    let repair_prompt=crate::prompts::render("batch-repair",&[("error",error.as_str()),("table_answer",table_answer),("direct_answer",direct_answer_hint),("original_response",original_response.as_str())])?;
                    tx.execute("INSERT INTO execution_responses(response_id,job_id,attempt,response_hash,raw_response,parse_status,parse_error,created_at) VALUES(?,?,?,?,?,'QUARANTINED',?,?)",params![id("ER"),a.job_id,j.attempt,response_hash,a.response_text,error,now])?;
                    let state=if repair<=2 && !historical {"PARSE_REVIEW"} else {"FAILED"};
                    tx.execute("UPDATE execution_jobs SET state=?,response_hash=?,raw_response=?,repair_attempt=?,repair_prompt=?,error_text=?,updated_at=? WHERE job_id=?",params![state,response_hash,a.response_text,repair,repair_prompt,error,now,a.job_id])?;
                    tx.commit()?;Ok(json!({"job_id":a.job_id,"state":state,"parse_error":error,"repair_attempt":repair,"repair_prompt":repair_prompt,"executed":true,"accepted":false,"historical":historical}))
                }
            }
        })
    }

    fn reconcile(&self, a: ReconcileArgs) -> Result<Value> {
        bounded("reason", &a.reason, 2000)?;
        if a.outcome == "response_received" {
            return self.record_inner(
                ResponseArgs {
                    job_id: a.job_id,
                    lease_token: String::new(),
                    response_text: a.response_text.ok_or_else(|| {
                        Error::Validation("response_received requires response_text".into())
                    })?,
                },
                true,
                Some(&a.reason),
                Some(a.attempt),
            );
        }
        if a.response_text.is_some()
            || !matches!(a.outcome.as_str(), "confirmed_not_sent" | "abandon")
        {
            return Err(Error::Validation(
                "reconciliation outcome must be response_received, confirmed_not_sent, or abandon"
                    .into(),
            ));
        }
        self.store.with_connection(|conn|{let tx=conn.transaction()?;let j=load_job(&tx,&a.job_id)?;
            if j.state!="AMBIGUOUS" {return Err(Error::Conflict("only an ambiguous job can be reconciled".into()));}
            if j.attempt!=a.attempt {return Err(Error::Conflict("reconciliation refers to a different provider attempt".into()));}
            let p=load_plan(&tx,&j.plan_id)?;
            let fresh=p.status=="APPROVED" && require_fresh(&tx,&p).is_ok();
            let state=if a.outcome=="confirmed_not_sent" && fresh {"READY"} else {"FAILED"};
            let now=timestamp();
            tx.execute("INSERT INTO execution_reconciliations(reconciliation_id,job_id,outcome,reason,created_at) VALUES(?,?,?,?,?)",params![id("REC"),a.job_id,a.outcome,a.reason,now])?;
            tx.execute("UPDATE execution_jobs SET state=?,lease_token=NULL,lease_expires_at=NULL,error_text=?,updated_at=? WHERE job_id=?",params![state,a.reason,now,a.job_id])?;
            if state=="READY" {tx.execute("INSERT INTO execution_outbox(event_id,plan_id,job_id,kind,payload_json,created_at) VALUES(?,?,?,'JOB_READY',?,?)",params![id("EO"),j.plan_id,a.job_id,encoded(&json!({"job_id":a.job_id,"reconciled":true}))?,now])?;}
            tx.commit()?;Ok(json!({"job_id":a.job_id,"state":state,"reconciled":true,"automatically_redispatched":false}))
        })
    }

    fn failure(&self, a: FailureArgs) -> Result<Value> {
        bounded("reason", &a.reason, 2000)?;
        if !matches!(a.kind.as_str(), "rate_limited" | "ambiguous" | "rejected") {
            return Err(Error::Validation(
                "failure kind must be rate_limited, ambiguous, or rejected".into(),
            ));
        }
        self.store.with_connection(|conn|{let tx=conn.transaction()?;let j=load_job(&tx,&a.job_id)?;
            if j.state!="RUNNING" || j.lease_token.as_deref()!=Some(&a.lease_token) {return Err(Error::Conflict("running attempt and matching lease required".into()));}
            let state=match a.kind.as_str(){"rate_limited"=>"WAITING_RATE","ambiguous"=>"AMBIGUOUS",_=>"FAILED"};
            let next=if state=="WAITING_RATE" {Some((Utc::now()+Duration::seconds(a.retry_after_seconds.unwrap_or(60).clamp(1,3600) as i64)).to_rfc3339())}else{None};
            tx.execute("UPDATE execution_jobs SET state=?,error_text=?,next_eligible_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=?",params![state,a.reason,next,timestamp(),a.job_id])?;
            if a.kind=="rejected" {
                tx.execute("INSERT INTO execution_outbox(event_id,plan_id,job_id,kind,payload_json,created_at) VALUES(?,?,?,'JOB_FAILED_REJECTED',?,?)",params![id("EO"),j.plan_id,a.job_id,encoded(&json!({"attempt":j.attempt,"reason":a.reason}))?,timestamp()])?;
            }
            tx.commit()?;Ok(json!({"job_id":a.job_id,"state":state,"next_eligible_at":next,"executed":true,"accepted":false}))
        })
    }

    fn retry(&self, a: RetryArgs) -> Result<Value> {
        bounded("reason", &a.reason, 2000)?;
        if !a.analyst_requested {
            return Err(Error::Validation(
                "explicit analyst retry request is required".into(),
            ));
        }
        self.store.with_connection(|conn| {
            let tx=conn.transaction()?;
            let j=load_job(&tx,&a.job_id)?;
            if j.state!="FAILED" {return Err(Error::Conflict(format!("job cannot be retried from {}",j.state)));}
            if j.attempt!=a.attempt {return Err(Error::Conflict("retry refers to a different provider attempt".into()));}
            let p=load_plan(&tx,&j.plan_id)?;
            if p.status!="APPROVED" {return Err(Error::Conflict("plan is not approved".into()));}
            if let Err(e)=require_fresh(&tx,&p) {mark_stale(&tx,&p.plan_id,&j.job_id)?;tx.commit()?;return Err(e);}
            // Only a provider's definitive rejected response is safe to send anew.
            // Parse failures and reconciled ambiguous attempts remain quarantined.
            let rejected:i64=tx.query_row("SELECT COUNT(*) FROM execution_outbox WHERE job_id=? AND kind='JOB_FAILED_REJECTED' AND json_extract(payload_json,'$.attempt')=?",params![a.job_id,a.attempt],|r|r.get(0))?;
            if rejected!=1 || j.response_hash.is_some() || j.repair_attempt>=2 {
                return Err(Error::Conflict("failure has no definitive rejected receipt; reconcile or approve a new plan".into()));
            }
            let now=timestamp();
            tx.execute("UPDATE execution_jobs SET state='READY',lease_token=NULL,lease_expires_at=NULL,next_eligible_at=NULL,error_text=NULL,updated_at=? WHERE job_id=?",params![now,a.job_id])?;
            tx.execute("INSERT INTO execution_outbox(event_id,plan_id,job_id,kind,payload_json,created_at) VALUES(?,?,?,'JOB_RETRY',?,?)",params![id("EO"),j.plan_id,a.job_id,encoded(&json!({"expected_attempt":a.attempt,"reason":a.reason,"analyst_requested":true}))?,now])?;
            tx.commit()?;
            Ok(json!({"job_id":a.job_id,"state":"READY","previous_attempt":a.attempt,"executed":false,"automatically_redispatched":false}))
        })
    }

    fn get_job(&self, a: JobIdArgs) -> Result<Value> {
        self.store.with_connection(|conn|{let j=load_job(conn,&a.job_id)?;
            let retryable = j.state=="FAILED" && j.response_hash.is_none() && j.repair_attempt<2 && conn.query_row("SELECT COUNT(*) FROM execution_outbox WHERE job_id=? AND kind='JOB_FAILED_REJECTED' AND json_extract(payload_json,'$.attempt')=?",params![a.job_id,j.attempt],|r|r.get::<_,i64>(0))?==1 && load_plan(conn,&j.plan_id).is_ok_and(|p|p.status=="APPROVED" && require_fresh(conn,&p).is_ok());
            Ok(json!({"job_id":j.job_id,"plan_id":j.plan_id,"run_id":j.run_id,"state":j.state,"payload":j.payload,"input_hash":j.input_hash,"attempt":j.attempt,"repair_attempt":j.repair_attempt,"response_hash":j.response_hash,"raw_response":j.raw_response,"repair_prompt":j.repair_prompt,"error":j.error_text,"lease_expires_at":j.lease_expires_at,"next_eligible_at":j.next_eligible_at,"dispatched_at":j.dispatched_at,"executed":j.attempt>0,"accepted":j.state=="SUCCEEDED","retryable":retryable}))})
    }

    fn progress(&self, a: PlanIdArgs) -> Result<Value> {
        self.store.with_connection(|conn| {
            let p=load_plan(conn,&a.plan_id)?;
            // source_fresh: the plan's source snapshot still matches (any status). fresh: also APPROVED.
            let source_fresh=require_fresh(conn,&p).is_ok();
            let fresh=p.status=="APPROVED" && source_fresh;
            let mut stmt=conn.prepare("SELECT job_id,ordinal,state,input_hash,attempt,repair_attempt,error_text,next_eligible_at,response_hash,lease_expires_at FROM execution_jobs WHERE plan_id=? ORDER BY ordinal")?;
            let mut jobs=Vec::new();
            for row in stmt.query_map([&a.plan_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,i64>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,Option<String>>(8)?,r.get::<_,Option<String>>(9)?)))? {
                let(job_id,ordinal,state,input_hash,attempt,repair,error,next,response_hash,lease_expires_at)=row?;
                let retryable=fresh && state=="FAILED" && response_hash.is_none() && repair<2 && conn.query_row("SELECT COUNT(*) FROM execution_outbox WHERE job_id=? AND kind='JOB_FAILED_REJECTED' AND json_extract(payload_json,'$.attempt')=?",params![job_id,attempt],|r|r.get::<_,i64>(0))?==1;
                jobs.push(json!({"job_id":job_id,"plan_id":a.plan_id,"ordinal":ordinal,"state":state,"input_hash":input_hash,"attempt":attempt,"error":error,"next_eligible_at":next,"retryable":retryable,"lease_expires_at":lease_expires_at,"executed":attempt>0}));
            }
            Ok(json!({"plan_id":a.plan_id,"run_id":p.run_id,"digest":p.digest,"status":p.status,"fresh":fresh,"source_fresh":source_fresh,"spec":{"provider":p.spec["provider"],"mode":p.spec["mode"],"deployment":p.spec["deployment"]},"jobs":jobs,"executed":false}))
        })
    }

    fn assessments(&self, a: AssessmentsArgs) -> Result<Value> {
        self.store.with_connection(|conn|{
        let mut stmt=conn.prepare("SELECT assessment_id,plan_id,job_id,company_id,row_index,provider,prompt,result_json,created_at FROM model_assessments WHERE run_id=? AND plan_id NOT IN (SELECT plan_id FROM discarded_plans) ORDER BY created_at,row_index")?;
        let mut out=Vec::new();let rows=stmt.query_map([&a.run_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,String>(7)?,r.get::<_,String>(8)?)))?;
        let mut eligibility=std::collections::HashMap::new();
        for row in rows {let(id,plan,job,company,index,provider,prompt,result,created)=row?;if a.plan_id.as_ref().is_some_and(|v|v!=&plan)||a.company_id.as_ref().is_some_and(|v|v!=&company){continue;}
            let eligible=*eligibility.entry(plan.clone()).or_insert_with(||load_plan(conn,&plan).is_ok_and(|p|p.status=="APPROVED" && require_fresh(conn,&p).is_ok()));
            out.push(json!({"assessment_id":id,"run_id":a.run_id,"plan_id":plan,"job_id":job,"company_id":company,"index":index,"provider":provider,"prompt":prompt,"result":decoded(result)?,"created_at":created,"eligible_for_current_use":eligible}));}
        let mut answers=Vec::new();let mut answer_stmt=conn.prepare("SELECT plan_id,job_id,provider,question,answer,created_at FROM execution_question_answers WHERE run_id=? AND plan_id NOT IN (SELECT plan_id FROM discarded_plans) ORDER BY created_at")?;
        for row in answer_stmt.query_map([&a.run_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?)))? {let(plan,job,provider,question,answer,created)=row?;if a.plan_id.as_ref().is_some_and(|v|v!=&plan)||a.company_id.is_some(){continue;}let eligible=*eligibility.entry(plan.clone()).or_insert_with(||load_plan(conn,&plan).is_ok_and(|p|p.status=="APPROVED" && require_fresh(conn,&p).is_ok()));answers.push(json!({"plan_id":plan,"job_id":job,"provider":provider,"question":question,"answer":answer,"created_at":created,"eligible_for_current_use":eligible}));}
        Ok(json!({"run_id":a.run_id,"assessments":out,"count":out.len(),"question_answers":answers}))})
    }

    fn screening_rounds(&self, a: ScreeningRoundsArgs) -> Result<Value> {
        bounded("run_id", &a.run_id, 160)?;
        self.store.with_connection(|conn| {
            let mut stmt=conn.prepare("SELECT sr.round_no,sr.plan_id,sr.provider,sr.created_at,ppa.approved_by,p.spec_json FROM screening_rounds sr JOIN prepared_plans p ON p.plan_id=sr.plan_id JOIN prepared_plan_approvals ppa ON ppa.plan_id=sr.plan_id WHERE sr.run_id=? AND NOT EXISTS(SELECT 1 FROM discarded_plans d WHERE d.plan_id=sr.plan_id) ORDER BY sr.round_no")?;
            let mut rounds=Vec::new();
            for row in stmt.query_map([&a.run_id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?)))? {
                let(round_no,plan_id,provider,created_at,approved_by,spec_json)=row?;
                let spec:ProposeArgs=serde_json::from_str(&spec_json)?;
                let mut jobs=RoundJobCounts::default();
                let mut job_stmt=conn.prepare("SELECT state,COUNT(*) FROM execution_jobs WHERE plan_id=? GROUP BY state")?;
                for job in job_stmt.query_map([&plan_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))? {
                    let(state,count)=job?;
                    jobs.total+=count;
                    match state.as_str() {
                        "READY" | "WAITING_RATE" => jobs.ready+=count,
                        "LEASED" | "RUNNING" | "AMBIGUOUS" => jobs.running+=count,
                        "SUCCEEDED" => jobs.done+=count,
                        "FAILED" => jobs.failed+=count,
                        _ => jobs.other+=count,
                    }
                }
                let mut score_distribution=serde_json::Map::new();
                for column in &spec.score_columns {
                    let mut buckets=serde_json::Map::new();
                    for score in 0..=10 { buckets.insert(score.to_string(),json!(0)); }
                    buckets.insert("CHECK".into(),json!(0));
                    buckets.insert("blank".into(),json!(0));
                    score_distribution.insert(column.clone(),Value::Object(buckets));
                }
                let mut assessed_companies=std::collections::HashSet::new();
                let mut simulated=false;
                let mut assessment_stmt=conn.prepare("SELECT company_id,result_json,simulated FROM model_assessments WHERE run_id=? AND plan_id=?")?;
                for assessment in assessment_stmt.query_map(params![a.run_id,plan_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?)))? {
                    let(company_id,result_json,assessment_simulated)=assessment?;
                    assessed_companies.insert(company_id);
                    simulated|=assessment_simulated!=0;
                    let result:Value=serde_json::from_str(&result_json)?;
                    for column in &spec.score_columns {
                        let bucket=score_bucket(result.get(column));
                        let counts=score_distribution.get_mut(column).and_then(Value::as_object_mut).ok_or_else(||Error::Internal("score distribution column missing".into()))?;
                        let count=counts.get(&bucket).and_then(Value::as_u64).unwrap_or(0);
                        counts.insert(bucket,json!(count+1));
                    }
                }
                rounds.push(json!({
                    "round_no":round_no,
                    "plan_id":plan_id,
                    "provider":provider,
                    "provider_label":screening_provider_label(&provider),
                    "created_at":created_at,
                    "approved_by":approved_by,
                    "deployment":spec.deployment,
                    "output_columns":spec.output_columns,
                    "score_columns":spec.score_columns,
                    "jobs":jobs,
                    "assessed_companies":assessed_companies.len(),
                    "score_distribution":Value::Object(score_distribution),
                    "simulated":simulated
                }));
            }
            Ok(json!({"run_id":a.run_id,"rounds":rounds}))
        })
    }

    /// Shared durable gate for all LLM Suite roles, including workers outside this module.
    pub fn reserve_llmsuite_slot(&self, purpose: &str, request_key: &str) -> Result<Value> {
        bounded("purpose", purpose, 80)?;
        bounded("request_key", request_key, 160)?;
        self.store.with_connection(|conn| {
            let tx = conn.transaction()?;
            let value = reserve_slot_tx(&tx, purpose, request_key, Utc::now(), false)?;
            tx.commit()?;
            Ok(value)
        })
    }
}

fn unique_columns(columns: &[String], label: &str) -> Result<()> {
    let mut seen = std::collections::HashSet::new();
    for column in columns {
        bounded(label, column, 160)?;
        if column.trim().is_empty() {
            return Err(Error::Validation(format!(
                "{label} must not contain blank names"
            )));
        }
        if column != column.trim() || column.chars().any(char::is_control) {
            return Err(Error::Validation(format!(
                "{label} must be trimmed and contain no control characters"
            )));
        }
        if !seen.insert(column.to_lowercase()) {
            return Err(Error::Validation(format!("duplicate {label}: {column}")));
        }
    }
    if columns.len() > 100 {
        return Err(Error::Validation(format!("too many {label}")));
    }
    Ok(())
}

struct Plan {
    plan_id: String,
    run_id: String,
    digest: String,
    status: String,
    spec: Value,
    snapshot: Value,
}
fn load_plan(conn: &Connection, id: &str) -> Result<Plan> {
    let row:Option<(String,String,String,String,String,String)>=conn.query_row("SELECT plan_id,run_id,digest,status,spec_json,snapshot_json FROM prepared_plans WHERE plan_id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
    let (plan_id, run_id, digest, status, spec, snapshot) =
        row.ok_or_else(|| Error::NotFound(format!("prepared plan not found: {id}")))?;
    Ok(Plan {
        plan_id,
        run_id,
        digest,
        status,
        spec: decoded(spec)?,
        snapshot: decoded(snapshot)?,
    })
}
fn require_fresh(conn: &Connection, p: &Plan) -> Result<()> {
    let spec: ProposeArgs = serde_json::from_value(p.spec.clone())?;
    let compiled_prompt =
        crate::gateway::compiled_prompt(&spec.prompt, &spec.output_columns, &spec.score_columns);
    let contract_hash = json_hash(
        &json!({"contract_version":2,"compiled_prompt":compiled_prompt,"repair_limit":2,"selected_columns_only":true}),
    )?;
    if p.snapshot["execution_contract_hash"] != json!(contract_hash) {
        return Err(Error::Conflict(
            "prepared plan is stale: execution contract changed".into(),
        ));
    }
    let current = projection::snapshot_selected(
        conn,
        &p.run_id,
        &spec.company_ids,
        &spec.source_columns,
        &spec.identity_sources,
        &spec.input_columns,
    )?;
    for field in [
        "profile_version",
        "candidate_hash",
        "data_hash",
        "input_hash",
        "selected_row_hashes",
    ] {
        if current[field] != p.snapshot[field] {
            return Err(Error::Conflict(format!(
                "prepared plan is stale: {field} changed"
            )));
        }
    }
    if p.snapshot["adapter_configuration_hash"]
        != json!(adapter_configuration_hash(&spec.provider)?)
    {
        return Err(Error::Conflict(
            "prepared plan is stale: provider endpoint configuration changed".into(),
        ));
    }
    Ok(())
}
fn mark_stale(tx: &Transaction<'_>, plan_id: &str, job_id: &str) -> Result<()> {
    let now = timestamp();
    tx.execute(
        "UPDATE prepared_plans SET status='STALE' WHERE plan_id=? AND status='APPROVED'",
        [plan_id],
    )?;
    tx.execute("UPDATE execution_jobs SET state='STALE',updated_at=? WHERE plan_id=? AND state IN ('READY','LEASED','WAITING_RATE','PARSE_REVIEW')",params![now,plan_id])?;
    tx.execute("UPDATE execution_jobs SET state='AMBIGUOUS',updated_at=? WHERE plan_id=? AND state='RUNNING'",params![now,plan_id])?;
    let _ = job_id;
    Ok(())
}

struct Job {
    job_id: String,
    plan_id: String,
    run_id: String,
    state: String,
    payload: Value,
    input_hash: String,
    lease_token: Option<String>,
    lease_expires_at: Option<String>,
    attempt: i64,
    repair_attempt: i64,
    dispatched_at: Option<String>,
    response_hash: Option<String>,
    raw_response: Option<String>,
    repair_prompt: Option<String>,
    error_text: Option<String>,
    next_eligible_at: Option<String>,
}
fn load_job(conn: &Connection, id: &str) -> Result<Job> {
    let row=conn.query_row("SELECT job_id,plan_id,run_id,state,payload_json,input_hash,lease_token,lease_expires_at,attempt,repair_attempt,dispatched_at,response_hash,raw_response,repair_prompt,error_text FROM execution_jobs WHERE job_id=?",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,i64>(8)?,r.get::<_,i64>(9)?,r.get::<_,Option<String>>(10)?,r.get::<_,Option<String>>(11)?,r.get::<_,Option<String>>(12)?,r.get::<_,Option<String>>(13)?,r.get::<_,Option<String>>(14)?))).optional()?.ok_or_else(||Error::NotFound(format!("execution job not found: {id}")))?;
    let next_eligible_at = conn.query_row(
        "SELECT next_eligible_at FROM execution_jobs WHERE job_id=?",
        [id],
        |r| r.get(0),
    )?;
    Ok(Job {
        job_id: row.0,
        plan_id: row.1,
        run_id: row.2,
        state: row.3,
        payload: decoded(row.4)?,
        input_hash: row.5,
        lease_token: row.6,
        lease_expires_at: row.7,
        attempt: row.8,
        repair_attempt: row.9,
        dispatched_at: row.10,
        response_hash: row.11,
        raw_response: row.12,
        repair_prompt: row.13,
        error_text: row.14,
        next_eligible_at,
    })
}
fn require_lease(j: &Job, token: &str) -> Result<()> {
    if j.state != "LEASED" || j.lease_token.as_deref() != Some(token) {
        return Err(Error::Conflict("active lease token required".into()));
    }
    if j.lease_expires_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_none_or(|t| t < Utc::now())
    {
        return Err(Error::Conflict("lease expired".into()));
    }
    Ok(())
}
fn adapter_configured(payload: &Value) -> bool {
    if crate::simulate::enabled()
        && matches!(payload["provider"].as_str(), Some("llm_suite" | "copilot"))
    {
        return true;
    }
    if std::env::var("MNA_ENABLE_EXTERNAL").ok().as_deref() != Some("true") {
        return false;
    }
    let (endpoint, token) = match payload["provider"].as_str() {
        Some("llm_suite") => ("MNA_LLMSUITE_ENDPOINT", "MNA_LLMSUITE_TOKEN"),
        Some("copilot") => ("MNA_M365_ENDPOINT", "MNA_M365_TOKEN"),
        _ => return false,
    };
    std::env::var(endpoint).is_ok_and(|v| !v.trim().is_empty())
        && std::env::var(token).is_ok_and(|v| !v.trim().is_empty())
}
fn adapter_configuration_hash(provider: &str) -> Result<String> {
    if crate::simulate::enabled() && matches!(provider, "llm_suite" | "copilot") {
        return crate::simulate::adapter_hash(provider);
    }
    let endpoint = match provider {
        "llm_suite" => std::env::var("MNA_LLMSUITE_ENDPOINT").unwrap_or_default(),
        "copilot" => std::env::var("MNA_M365_ENDPOINT").unwrap_or_default(),
        _ => String::new(),
    };
    let configured = adapter_configured(&json!({"provider":provider}));
    json_hash(&json!({"provider":provider,"endpoint":endpoint,"enabled":configured}))
}
fn reserve_slot_tx(
    tx: &Transaction<'_>,
    purpose: &str,
    key: &str,
    now: chrono::DateTime<Utc>,
    consume: bool,
) -> Result<Value> {
    if !matches!(
        purpose,
        "orchestrator" | "subagent" | "screening" | "question" | "repair"
    ) {
        return Err(Error::Validation("unknown LLM Suite rate purpose".into()));
    }
    let epoch = now.timestamp_millis();
    if let Some((old_purpose, old_epoch, consumed)) = tx
        .query_row(
            "SELECT purpose,window_epoch,consumed_epoch FROM llmsuite_slots WHERE request_key=?",
            [key],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()?
    {
        if old_purpose != purpose {
            return Err(Error::Conflict(
                "request key already reserved for another purpose".into(),
            ));
        }
        if !consume {
            return Ok(
                json!({"request_key":key,"purpose":purpose,"reserved":consumed.is_none() && old_epoch>epoch-60_000,"idempotent":true,"consumed":consumed.is_some(),"reserved_epoch":old_epoch}),
            );
        }
        if consumed.is_some() {
            return Err(Error::Conflict(
                "rate reservation has already been consumed".into(),
            ));
        }
        let others: i64 = tx.query_row(
            "SELECT COUNT(*) FROM llmsuite_slots WHERE window_epoch>? AND request_key!=?",
            params![epoch - 60_000, key],
            |r| r.get(0),
        )?;
        if others >= 7 {
            return Err(Error::RateLimited(
                "LLM Suite allows seven requests in every rolling 60 seconds".into(),
            ));
        }
        tx.execute("UPDATE llmsuite_slots SET window_epoch=?,reserved_at=?,consumed_epoch=? WHERE request_key=?",params![epoch,now.to_rfc3339(),epoch,key])?;
        return Ok(
            json!({"request_key":key,"purpose":purpose,"reserved":true,"consumed":true,"idempotent":false}),
        );
    }
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM llmsuite_slots WHERE window_epoch>?",
        [epoch - 60_000],
        |r| r.get(0),
    )?;
    if count >= 7 {
        return Err(Error::RateLimited(
            "LLM Suite allows seven requests in every rolling 60 seconds".into(),
        ));
    }
    tx.execute("INSERT INTO llmsuite_slots(request_key,purpose,reserved_at,window_epoch,consumed_epoch) VALUES(?,?,?,?,?)",params![key,purpose,now.to_rfc3339(),epoch,if consume {Some(epoch)}else{None}])?;
    Ok(
        json!({"request_key":key,"purpose":purpose,"reserved":true,"idempotent":false,"remaining_in_window":6-count}),
    )
}
fn next_slot_time(tx: &Transaction<'_>, now: chrono::DateTime<Utc>) -> Result<String> {
    let oldest: i64 = tx
        .query_row(
            "SELECT MIN(window_epoch) FROM llmsuite_slots WHERE window_epoch>?",
            [now.timestamp_millis() - 60_000],
            |r| r.get::<_, Option<i64>>(0),
        )?
        .unwrap_or(now.timestamp_millis());
    Ok(
        chrono::DateTime::<Utc>::from_timestamp_millis(oldest + 60_001)
            .unwrap_or(now + Duration::seconds(60))
            .to_rfc3339(),
    )
}

pub fn input_schema(tool: &str) -> Option<Value> {
    macro_rules! schema {
        ($t:ty) => {
            serde_json::to_value(schemars::schema_for!($t)).ok()
        };
    }
    match tool {
        "propose_prepared_plan" => schema!(ProposeArgs),
        "get_prepared_plan" => schema!(PlanIdArgs),
        "approve_prepared_plan" => schema!(ApproveArgs),
        "cancel_prepared_plan" => schema!(CancelArgs),
        "lease_execution_job" => schema!(LeaseArgs),
        "mark_execution_dispatch" => schema!(DispatchArgs),
        "record_execution_response" => schema!(ResponseArgs),
        "reconcile_execution_job" => schema!(ReconcileArgs),
        "record_execution_failure" => schema!(FailureArgs),
        "retry_execution_job" => schema!(RetryArgs),
        "get_execution_job" => schema!(JobIdArgs),
        "get_execution_progress" => schema!(PlanIdArgs),
        "get_model_assessments" => schema!(AssessmentsArgs),
        "get_screening_rounds" => schema!(ScreeningRoundsArgs),
        "reserve_llmsuite_slot" => schema!(SlotArgs),
        "consume_llmsuite_slot" => schema!(SlotArgs),
        _ => None,
    }
}

#[derive(Default, Serialize)]
struct RoundJobCounts {
    total: i64,
    ready: i64,
    running: i64,
    done: i64,
    failed: i64,
    other: i64,
}

pub(crate) fn screening_provider_label(provider: &str) -> String {
    let normalized = provider.to_ascii_lowercase().replace(['_', '-', ' '], "");
    match normalized.as_str() {
        "llmsuite" => "LLM Suite".into(),
        "copilot" | "m365copilot" | "m365" => "M365 Copilot".into(),
        _ => provider.to_owned(),
    }
}

fn score_bucket(value: Option<&Value>) -> String {
    match screening_score_value(value) {
        Value::String(value) => value,
        Value::Number(value) => value.to_string(),
        _ => "blank".into(),
    }
}

pub(crate) fn screening_score_value(value: Option<&Value>) -> Value {
    let score = match value {
        Some(Value::String(raw)) if raw.trim().eq_ignore_ascii_case("check") => {
            return json!("CHECK");
        }
        Some(Value::String(raw)) => raw.trim().parse::<f64>().ok(),
        Some(Value::Number(number)) => number.as_f64(),
        _ => None,
    };
    match score {
        Some(score)
            if score.is_finite() && (0.0..=10.0).contains(&score) && score.fract() == 0.0 =>
        {
            json!(score as i64)
        }
        _ => Value::Null,
    }
}

#[cfg(test)]
mod rate_tests {
    use super::*;
    #[test]
    fn expired_reservations_cannot_authorize_a_dispatch_burst() {
        let store = Store::open(":memory:").unwrap();
        store
            .with_connection(|conn| {
                let tx = conn.transaction()?;
                let now = Utc::now();
                for n in 0..7 {
                    reserve_slot_tx(
                        &tx,
                        "orchestrator",
                        &format!("old-{n}"),
                        now - Duration::seconds(90),
                        false,
                    )?;
                }
                for n in 0..7 {
                    reserve_slot_tx(&tx, "screening", &format!("new-{n}"), now, true)?;
                }
                assert!(matches!(
                    reserve_slot_tx(&tx, "orchestrator", "old-0", now, true),
                    Err(Error::RateLimited(_))
                ));
                let later = now + Duration::seconds(61);
                for n in 0..7 {
                    reserve_slot_tx(&tx, "orchestrator", &format!("old-{n}"), later, true)?;
                }
                assert!(matches!(
                    reserve_slot_tx(&tx, "repair", "eighth", later, true),
                    Err(Error::RateLimited(_))
                ));
                assert!(matches!(
                    reserve_slot_tx(&tx, "orchestrator", "old-0", later, true),
                    Err(Error::Conflict(_))
                ));
                tx.commit()?;
                Ok(())
            })
            .unwrap();
    }
}

#[cfg(test)]
mod retry_tests {
    use super::*;

    fn failed_job() -> (Store, ExecutionService, String) {
        let store = Store::open(":memory:").unwrap();
        store
            .execute(
                "create_run",
                &json!({"run_id":"R","objective":"Question","original_criteria":{}}),
            )
            .unwrap();
        let service = ExecutionService::new(store.clone());
        let plan=service.execute("propose_prepared_plan",&json!({"run_id":"R","mode":"question","provider":"llm_suite","deployment":"fixture","prompt":"Explain","question":"What is known?"})).unwrap();
        service.execute("approve_prepared_plan",&json!({"plan_id":plan["plan_id"],"digest":plan["digest"],"approved_by":"Analyst","approval_key":"approval"})).unwrap();
        let job = service
            .execute("get_prepared_plan", &json!({"plan_id":plan["plan_id"]}))
            .unwrap()["jobs"][0]["job_id"]
            .as_str()
            .unwrap()
            .to_owned();
        store.with_connection(|conn| {
            conn.execute("UPDATE execution_jobs SET state='FAILED',attempt=1,dispatched_at=?,error_text='HTTP 400' WHERE job_id=?",params![timestamp(),job])?;
            conn.execute("INSERT INTO execution_outbox(event_id,plan_id,job_id,kind,payload_json,created_at) VALUES(?,?,?,'JOB_FAILED_REJECTED',?,?)",params![id("EO"),plan["plan_id"].as_str(),job,encoded(&json!({"attempt":1,"reason":"HTTP 400"}))?,timestamp()])?;
            Ok(())
        }).unwrap();
        (store, service, job)
    }

    #[test]
    fn rejected_attempt_can_be_explicitly_requeued_without_changing_rate_slots() {
        let (store, service, job) = failed_job();
        let result=service.execute("retry_execution_job",&json!({"job_id":job,"attempt":1,"reason":"Analyst requested retry","analyst_requested":true})).unwrap();
        assert_eq!(result["state"], "READY");
        assert_eq!(
            service
                .execute("get_execution_job", &json!({"job_id":job}))
                .unwrap()["attempt"],
            1
        );
        let (slots, retries): (i64, i64) = store
            .with_connection(|conn| {
                Ok((
                    conn.query_row("SELECT COUNT(*) FROM llmsuite_slots", [], |r| r.get(0))?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM execution_outbox WHERE job_id=? AND kind='JOB_RETRY'",
                        [&job],
                        |r| r.get(0),
                    )?,
                ))
            })
            .unwrap();
        assert_eq!((slots, retries), (0, 1));
        assert!(service
            .execute(
                "retry_execution_job",
                &json!({"job_id":job,"attempt":1,"reason":"Again","analyst_requested":true})
            )
            .is_err());
    }

    #[test]
    fn retry_rejects_ambiguous_stale_mismatched_and_unrequested_attempts() {
        let (store, service, job) = failed_job();
        assert!(service
            .execute(
                "retry_execution_job",
                &json!({"job_id":job,"attempt":1,"reason":"No","analyst_requested":false})
            )
            .is_err());
        assert!(service
            .execute(
                "retry_execution_job",
                &json!({"job_id":job,"attempt":0,"reason":"Wrong attempt","analyst_requested":true})
            )
            .is_err());
        store
            .with_connection(|conn| {
                conn.execute(
                    "UPDATE execution_jobs SET state='AMBIGUOUS' WHERE job_id=?",
                    [&job],
                )?;
                Ok(())
            })
            .unwrap();
        assert!(service
            .execute(
                "retry_execution_job",
                &json!({"job_id":job,"attempt":1,"reason":"Unsafe","analyst_requested":true})
            )
            .is_err());
        store.with_connection(|conn| {conn.execute("UPDATE execution_jobs SET state='FAILED' WHERE job_id=?",[&job])?;conn.execute("UPDATE prepared_plans SET status='STALE' WHERE plan_id=(SELECT plan_id FROM execution_jobs WHERE job_id=?)",[&job])?;Ok(())}).unwrap();
        assert!(service
            .execute(
                "retry_execution_job",
                &json!({"job_id":job,"attempt":1,"reason":"Stale","analyst_requested":true})
            )
            .is_err());
    }

    #[test]
    fn quarantined_parse_failure_cannot_be_requeued_as_provider_rejection() {
        let (store, service, job) = failed_job();
        store.with_connection(|conn| {conn.execute("UPDATE execution_jobs SET response_hash='quarantined',repair_attempt=2 WHERE job_id=?",[&job])?;Ok(())}).unwrap();
        assert!(service
            .execute(
                "retry_execution_job",
                &json!({"job_id":job,"attempt":1,"reason":"Unsafe","analyst_requested":true})
            )
            .is_err());
    }
}
