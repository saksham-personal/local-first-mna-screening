//! Analyst verification is separate from the confidence of a research lead.
use crate::{
    error::{Error, Result},
    Store,
};
use rusqlite::{params, Connection, OptionalExtension};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
type ClaimState = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ReviewArgs {
    run_id: String,
    evidence_id: String,
    reviewed_by: String,
    decision: String,
    reason: String,
}

pub fn input_schema(tool: &str) -> Option<Value> {
    (tool == "review_evidence_claim")
        .then(|| serde_json::to_value(schemars::schema_for!(ReviewArgs)).expect("review schema"))
}

pub fn attach(conn: &Connection, row: &mut Value) -> Result<()> {
    let id = row["evidence_id"]
        .as_str()
        .ok_or_else(|| Error::Internal("evidence identifier missing".into()))?;
    let state: Option<ClaimState> = conn.query_row("SELECT verification_status,claim_provenance_json,reviewed_by,review_reason,reviewed_at FROM evidence_claim_state WHERE evidence_id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    let (status, provenance, reviewer, reason, at) =
        state.unwrap_or(("UNKNOWN".into(), "{}".into(), None, None, None));
    row["evidence_confidence"] = row["confidence"].clone();
    row["verification_status"] = json!(status);
    row["claim_provenance"] = serde_json::from_str(&provenance)?;
    row["verification"] = json!({"reviewed_by":reviewer,"reason":reason,"reviewed_at":at});
    Ok(())
}

/// Reachable only through the analyst-authenticated admin route.
pub fn review(store: &Store, arguments: &Value) -> Result<Value> {
    let a: ReviewArgs =
        serde_json::from_value(arguments.clone()).map_err(|e| Error::Validation(e.to_string()))?;
    if !["VERIFIED", "REJECTED"].contains(&a.decision.as_str())
        || a.reviewed_by.trim().is_empty()
        || a.reviewed_by.len() > 160
        || a.reason.trim().is_empty()
        || a.reason.len() > 10_000
    {
        return Err(Error::Validation(
            "review requires VERIFIED or REJECTED, reviewer identity, and a reason".into(),
        ));
    }
    store.with_connection(|conn| {
        let tx=conn.transaction()?;
        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM evidence WHERE evidence_id=? AND run_id=?)",params![a.evidence_id,a.run_id],|r|r.get(0))?;
        if !exists { return Err(Error::NotFound("evidence is not in this run".into())); }
        let at=chrono::Utc::now().to_rfc3339();
        tx.execute("UPDATE evidence_claim_state SET verification_status=?,reviewed_by=?,review_reason=?,reviewed_at=? WHERE evidence_id=?",params![a.decision,a.reviewed_by,a.reason,at,a.evidence_id])?;
        tx.commit()?;
        Ok(json!({"run_id":a.run_id,"evidence_id":a.evidence_id,"verification_status":a.decision,"reviewed_by":a.reviewed_by,"reviewed_at":at}))
    })
}
