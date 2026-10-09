//! Analyst controlled soft discard for screening and Bing research results.
use crate::{
    error::{Error, Result},
    Store,
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct DiscardArgs {
    run_id: String,
    plan_id: String,
    kind: DiscardKind,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Clone, Copy, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum DiscardKind {
    Screening,
    Research,
}

impl DiscardKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Screening => "screening",
            Self::Research => "research",
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RunArgs {
    run_id: String,
}

pub fn input_schema(tool: &str) -> Option<Value> {
    let schema = match tool {
        "discard_plan_results" => schemars::schema_for!(DiscardArgs),
        "get_discarded_plans" => schemars::schema_for!(RunArgs),
        _ => return None,
    };
    serde_json::to_value(schema).ok()
}

pub fn execute(store: &Store, tool: &str, arguments: &Value, analyst: bool) -> Result<Value> {
    match tool {
        "discard_plan_results" => {
            if !analyst {
                return Err(Error::AnalystAuthRequired);
            }
            discard(store, serde_json::from_value(arguments.clone())?)
        }
        "get_discarded_plans" => {
            let args: RunArgs = serde_json::from_value(arguments.clone())?;
            get_discarded(store, args)
        }
        _ => Err(Error::NotFound(format!("unknown run control tool: {tool}"))),
    }
}

fn discard(store: &Store, args: DiscardArgs) -> Result<Value> {
    validate_id("run_id", &args.run_id)?;
    validate_id("plan_id", &args.plan_id)?;
    let kind = args.kind.as_str();
    if args.reason.as_ref().is_some_and(|s| s.len() > 10_000) {
        return Err(Error::Validation("reason exceeds 10000 bytes".into()));
    }
    let at = Utc::now().to_rfc3339();
    store.with_connection(|connection| {
        let tx = connection.transaction()?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM screening_runs WHERE run_id=?)",
            [&args.run_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(Error::NotFound(format!("run not found: {}", args.run_id)));
        }

        let previous: Option<(String, String)> = tx
            .query_row(
                "SELECT run_id,kind FROM discarded_plans WHERE plan_id=?",
                [&args.plan_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((run_id, kind)) = previous {
            if run_id != args.run_id || kind != args.kind.as_str() {
                return Err(Error::Conflict(
                    "plan was already discarded under a different run or kind".into(),
                ));
            }
            return Ok(json!({"run_id":args.run_id,"plan_id":args.plan_id,"kind":kind,"idempotent":true}));
        }

        match kind {
            "screening" => {
                let valid: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM prepared_plans WHERE plan_id=? AND run_id=? AND json_extract(spec_json,'$.mode') IN ('screening','question'))",
                    params![args.plan_id, args.run_id],
                    |row| row.get(0),
                )?;
                if !valid {
                    return Err(Error::NotFound("screening plan not found in this run".into()));
                }
                let active: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM execution_jobs WHERE plan_id=? AND state IN ('READY','LEASED','WAITING_RATE','PARSE_REVIEW','RUNNING','AMBIGUOUS')",
                    [&args.plan_id],
                    |row| row.get(0),
                )?;
                if active > 0 {
                    return Err(Error::Conflict(
                        "cancel or reconcile screening plan jobs before discarding results".into(),
                    ));
                }
            }
            "research" => {
                let valid: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM action_plans WHERE plan_id=? AND run_id=?)",
                    params![args.plan_id, args.run_id],
                    |row| row.get(0),
                )?;
                if !valid {
                    return Err(Error::NotFound("research plan not found in this run".into()));
                }
            }
            _ => unreachable!(),
        }

        tx.execute(
            "INSERT INTO discarded_plans(plan_id,run_id,kind,discarded_by,reason,discarded_at) VALUES(?,?,?,?,?,?)",
            params![args.plan_id, args.run_id, kind, "screening-ui-analyst", args.reason, at],
        )?;
        let marked_evidence = if args.kind == DiscardKind::Research {
            tx.execute(
                "UPDATE evidence SET discarded_plan_id=?1
                 WHERE run_id=?2 AND claim='bing_research_observation' AND source_type='bing'
                   AND source_reference IN (
                     SELECT query_id FROM search_queries WHERE run_id=?2 AND source='bing_search'
                       AND json_extract(parameters_json,'$.plan_id')=?1
                   )",
                params![args.plan_id, args.run_id],
            )?
        } else {
            0
        };
        tx.commit()?;
        Ok(json!({"run_id":args.run_id,"plan_id":args.plan_id,"kind":kind,"discarded":true,"marked_evidence":marked_evidence,"idempotent":false}))
    })
}

fn get_discarded(store: &Store, args: RunArgs) -> Result<Value> {
    validate_id("run_id", &args.run_id)?;
    store.with_connection(|connection| {
        let mut stmt = connection.prepare(
            "SELECT plan_id,kind,discarded_by,reason,discarded_at FROM discarded_plans WHERE run_id=? ORDER BY discarded_at,plan_id",
        )?;
        let rows = stmt.query_map([&args.run_id], |row| {
            Ok(json!({
                "plan_id": row.get::<_, String>(0)?,
                "kind": row.get::<_, String>(1)?,
                "discarded_by": row.get::<_, String>(2)?,
                "reason": row.get::<_, Option<String>>(3)?,
                "discarded_at": row.get::<_, String>(4)?,
            }))
        })?;
        let plans = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(json!({"run_id":args.run_id,"plans":plans,"count":plans.len()}))
    })
}

fn validate_id(label: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(Error::Validation(format!("invalid {label}")));
    }
    Ok(())
}
