//! Saved PitchBook/ROGO import match reports.
//!
//! A report is a non-cumulative snapshot of one import measured against the run's *current*
//! candidates (considered and hidden alike). Importing never changes which companies are
//! considered; the analyst reads the report and applies a decision through
//! `apply_enrichment_review`.
use std::collections::{BTreeMap, BTreeSet, HashMap};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    error::{Error, Result},
    store::Store,
};

/// Most recent reports kept per run and purpose. Older ones are pruned on insert.
const REPORT_RETENTION: i64 = 25;
const SAMPLE_ROWS: usize = 25;
/// Reasons a candidate has no PitchBook data after an import.
pub const NOT_MATCHED_REASONS: [&str; 5] = [
    "not_in_mapping",
    "profile_not_company",
    "blank_pbid",
    "no_data_row",
    "conflict",
];
/// Compact PitchBook fields in `company_enrichment` column order.
const PB_FIELDS: [&str; 7] = [
    "PB_Website",
    "PB_Name",
    "PB_Description",
    "PB_LinkedIn URL",
    "PB_HQ Location",
    "PB_Active Investors",
    "PB_Universe",
];

/// What a PitchBook import saw, beyond what the database can say afterwards.
#[derive(Default)]
pub struct PitchbookFacts {
    /// Latest mapping row seen per candidate: (Company Profile is Yes, PBId present).
    pub mapping: HashMap<String, (bool, bool)>,
    /// Candidates whose Yes/PBId mapping row collided with a PBID owned by another company.
    pub conflicts: BTreeSet<String>,
}

/// What a ROGO import saw.
#[derive(Default)]
pub struct RogoFacts {
    pub rows: usize,
    /// company_id -> number of ROGO rows merged into it
    pub matched: BTreeMap<String, usize>,
    /// (1-based row number within the import, website as written)
    pub unmatched: Vec<(usize, Option<String>)>,
    /// (website as written, normalized host, distinct companies sharing the host)
    pub ambiguous: Vec<(Option<String>, String, BTreeSet<String>)>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ReportArgs {
    run_id: String,
    /// A specific report. Defaults to the latest report of the run.
    #[serde(default)]
    report_id: Option<String>,
    /// With no report_id, restrict "latest" to "pitchbook" or "rogo".
    #[serde(default)]
    purpose: Option<String>,
}

pub fn input_schema(tool: &str) -> Option<Value> {
    (tool == "get_enrichment_report")
        .then(|| serde_json::to_value(schemars::schema_for!(ReportArgs)).expect("report schema"))
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

struct CandidateRow {
    company_id: String,
    name: String,
    website: Option<String>,
    considered: bool,
    reason: Option<String>,
    pbid: Option<String>,
    pb: [Option<String>; 7],
}

fn run_candidates(conn: &Connection, run_id: &str) -> Result<Vec<CandidateRow>> {
    let mut statement = conn.prepare(
        "SELECT x.company_id,x.considered,x.consideration_reason,c.name,c.website,
                (SELECT identifier FROM company_identifiers WHERE company_id=x.company_id AND kind='PBID'),
                e.pb_website,e.pb_name,e.pb_description,e.pb_linkedin_url,e.pb_hq_location,e.pb_active_investors,e.pb_universe
         FROM candidates x
         JOIN companies c ON c.company_id=x.company_id
         LEFT JOIN company_enrichment e ON e.company_id=x.company_id
         WHERE x.run_id=? ORDER BY x.company_id",
    )?;
    let rows = statement
        .query_map([run_id], |r| {
            Ok(CandidateRow {
                company_id: r.get(0)?,
                considered: r.get::<_, i64>(1)? != 0,
                reason: r.get(2)?,
                name: r.get(3)?,
                website: r.get(4)?,
                pbid: r.get(5)?,
                pb: [
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                    r.get(11)?,
                    r.get(12)?,
                ],
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Mapping evidence saved by earlier imports (company-global), oldest first so later rows win.
fn persisted_mapping(conn: &Connection, run_id: &str) -> Result<HashMap<String, (bool, bool)>> {
    let mut statement = conn.prepare(
        "SELECT r.company_id,r.row_json FROM enrichment_rows r
         WHERE r.kind='PB_MAPPING' AND r.company_id IN (SELECT company_id FROM candidates WHERE run_id=?)
         ORDER BY r.imported_at,r.rowid",
    )?;
    let mut mapping = HashMap::new();
    for row in statement.query_map([run_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (company_id, raw) = row?;
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            let (is_company, pbid) = crate::data::mapping_fields(&value);
            mapping.insert(company_id, (is_company, pbid.is_some()));
        }
    }
    Ok(mapping)
}

fn run_totals(conn: &Connection, run_id: &str) -> Result<(i64, i64)> {
    Ok(conn.query_row(
        "SELECT COUNT(*),COALESCE(SUM(considered),0) FROM candidates WHERE run_id=?",
        [run_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

pub fn save_pitchbook_report(
    conn: &Connection,
    run_id: &str,
    files: &Value,
    counts: &Value,
    facts: &PitchbookFacts,
) -> Result<Value> {
    let candidates = run_candidates(conn, run_id)?;
    let mut mapping = persisted_mapping(conn, run_id)?;
    for (company_id, state) in &facts.mapping {
        mapping.insert(company_id.clone(), *state);
    }
    let mut matched = Vec::new();
    let mut not_matched = Vec::new();
    let mut reasons: BTreeMap<&str, usize> = NOT_MATCHED_REASONS.iter().map(|r| (*r, 0)).collect();
    let (mut matched_considered, mut not_matched_considered) = (0usize, 0usize);
    for candidate in &candidates {
        // pb[1] is PB_Name and pb[2] PB_Description: either one counts as PitchBook data.
        if candidate.pb[1].is_some() || candidate.pb[2].is_some() {
            let fields: Vec<&str> = PB_FIELDS
                .iter()
                .zip(&candidate.pb)
                .filter(|(_, value)| value.is_some())
                .map(|(label, _)| *label)
                .collect();
            if candidate.considered {
                matched_considered += 1;
            }
            matched.push(json!({
                "company_id": candidate.company_id,
                "name": candidate.name,
                "website": candidate.website,
                "pbid": candidate.pbid,
                "pb_name": candidate.pb[1],
                "pb_website": candidate.pb[0],
                "fields_hydrated": fields,
                "considered": candidate.considered,
                "consideration_reason": candidate.reason,
            }));
            continue;
        }
        let reason = if facts.conflicts.contains(&candidate.company_id) {
            "conflict"
        } else {
            match mapping.get(&candidate.company_id) {
                Some((false, _)) => "profile_not_company",
                Some((true, false)) => "blank_pbid",
                Some((true, true)) if candidate.pbid.is_some() => "no_data_row",
                // A valid Yes/PBId row exists but the PBID could not be applied.
                Some((true, true)) => "conflict",
                None if candidate.pbid.is_some() => "no_data_row",
                None => "not_in_mapping",
            }
        };
        *reasons.entry(reason).or_default() += 1;
        if candidate.considered {
            not_matched_considered += 1;
        }
        not_matched.push(json!({
            "company_id": candidate.company_id,
            "name": candidate.name,
            "website": candidate.website,
            "reason": reason,
            "pbid": candidate.pbid,
            "considered": candidate.considered,
            "consideration_reason": candidate.reason,
        }));
    }
    let (total, considered) = run_totals(conn, run_id)?;
    let mut summary = json!({
        "candidates_total": total,
        "considered_count": considered,
        "hidden_count": total - considered,
        "matched_count": matched.len(),
        "matched_considered": matched_considered,
        "not_matched_count": not_matched.len(),
        "not_matched_considered": not_matched_considered,
        "not_matched_reasons": reasons,
    });
    merge_counts(&mut summary, counts);
    insert_report(
        conn,
        run_id,
        "pitchbook",
        files,
        &summary,
        &Value::Array(matched),
        &Value::Array(not_matched),
    )
}

pub fn save_rogo_report(
    conn: &Connection,
    run_id: &str,
    files: &Value,
    counts: &Value,
    facts: &RogoFacts,
) -> Result<Value> {
    let directory: HashMap<String, (String, Option<String>)> = run_candidates(conn, run_id)?
        .into_iter()
        .map(|c| (c.company_id, (c.name, c.website)))
        .collect();
    let describe = |company_id: &str| {
        directory
            .get(company_id)
            .cloned()
            .unwrap_or_else(|| (company_id.to_owned(), None))
    };
    let matched: Vec<Value> = facts
        .matched
        .iter()
        .map(|(company_id, rows)| {
            let (name, website) = describe(company_id);
            json!({"company_id":company_id,"name":name,"website":website,"rows":rows})
        })
        .collect();
    let unmatched_rows = json!({
        "count": facts.unmatched.len(),
        "sample": facts.unmatched.iter().take(SAMPLE_ROWS).map(|(row, website)| json!({"row":row,"website":website})).collect::<Vec<_>>(),
    });
    let ambiguous: Vec<Value> = facts
        .ambiguous
        .iter()
        .map(|(website, host, company_ids)| {
            json!({
                "website": website,
                "host": host,
                "company_ids": company_ids,
                "names": company_ids.iter().map(|id| describe(id).0).collect::<Vec<_>>(),
            })
        })
        .collect();
    let covered: i64 = conn.query_row(
        "SELECT COUNT(*) FROM candidates x JOIN company_enrichment e ON e.company_id=x.company_id WHERE x.run_id=? AND e.rogo_json!='{}'",
        [run_id],
        |r| r.get(0),
    )?;
    let (total, considered) = run_totals(conn, run_id)?;
    let mut summary = json!({
        "candidates_total": total,
        "considered_count": considered,
        "hidden_count": total - considered,
        "matched_count": matched.len(),
        "rogo_covered_count": covered,
        "unmatched_row_count": facts.unmatched.len(),
        "ambiguous_count": ambiguous.len(),
    });
    merge_counts(&mut summary, counts);
    insert_report(
        conn,
        run_id,
        "rogo",
        files,
        &summary,
        &Value::Array(matched),
        &json!({"unmatched_rows":unmatched_rows,"ambiguous":ambiguous}),
    )
}

fn merge_counts(summary: &mut Value, counts: &Value) {
    if let (Some(target), Some(source)) = (summary.as_object_mut(), counts.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn insert_report(
    conn: &Connection,
    run_id: &str,
    purpose: &str,
    files: &Value,
    summary: &Value,
    matched: &Value,
    not_matched: &Value,
) -> Result<Value> {
    let report_id = format!("ER-{}", Uuid::new_v4());
    let created_at = now();
    conn.execute(
        "INSERT INTO enrichment_import_reports(report_id,run_id,purpose,files_json,summary_json,matched_json,not_matched_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
        params![
            report_id,
            run_id,
            purpose,
            serde_json::to_string(files)?,
            serde_json::to_string(summary)?,
            serde_json::to_string(matched)?,
            serde_json::to_string(not_matched)?,
            created_at
        ],
    )?;
    conn.execute(
        "DELETE FROM enrichment_import_reports WHERE run_id=?1 AND purpose=?2 AND rowid NOT IN (SELECT rowid FROM enrichment_import_reports WHERE run_id=?1 AND purpose=?2 ORDER BY created_at DESC,rowid DESC LIMIT ?3)",
        params![run_id, purpose, REPORT_RETENTION],
    )?;
    Ok(report_json(
        &report_id,
        run_id,
        purpose,
        &created_at,
        files,
        summary,
        matched,
        not_matched,
    ))
}

#[allow(clippy::too_many_arguments)]
fn report_json(
    report_id: &str,
    run_id: &str,
    purpose: &str,
    created_at: &str,
    files: &Value,
    summary: &Value,
    matched: &Value,
    not_matched: &Value,
) -> Value {
    let mut report = json!({
        "report_id": report_id,
        "run_id": run_id,
        "purpose": purpose,
        "created_at": created_at,
        "files": files,
        "summary": summary,
        "matched": matched,
    });
    if purpose == "rogo" {
        report["unmatched_rows"] = not_matched["unmatched_rows"].clone();
        report["ambiguous"] = not_matched["ambiguous"].clone();
    } else {
        report["not_matched"] = not_matched.clone();
    }
    report
}

/// `get_enrichment_report`: one saved report, or the latest of the run.
pub fn get_report(store: &Store, arguments: &Value) -> Result<Value> {
    let args: ReportArgs = serde_json::from_value(arguments.clone())
        .map_err(|error| Error::Validation(error.to_string()))?;
    if args.run_id.trim().is_empty() || args.run_id.len() > 160 {
        return Err(Error::Validation(
            "run_id must contain 1..=160 bytes".into(),
        ));
    }
    if let Some(report_id) = &args.report_id {
        if report_id.trim().is_empty() || report_id.len() > 160 {
            return Err(Error::Validation(
                "report_id must contain 1..=160 bytes".into(),
            ));
        }
    }
    let purpose = match args.purpose.as_deref() {
        None => None,
        Some(value @ ("pitchbook" | "rogo")) => Some(value),
        Some(_) => {
            return Err(Error::Validation(
                "purpose must be \"pitchbook\" or \"rogo\"".into(),
            ))
        }
    };
    store.with_connection(|conn| {
        let run_exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM screening_runs WHERE run_id=?",
                [&args.run_id],
                |r| r.get(0),
            )
            .optional()?;
        if run_exists.is_none() {
            return Err(Error::NotFound(format!("run not found: {}", args.run_id)));
        }
        type Stored = (String, String, String, String, String, String, String);
        let columns = "report_id,purpose,files_json,summary_json,matched_json,not_matched_json,created_at";
        let map_row = |r: &rusqlite::Row<'_>| -> rusqlite::Result<Stored> {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        };
        let stored: Option<Stored> = match &args.report_id {
            Some(report_id) => conn
                .query_row(
                    &format!("SELECT {columns} FROM enrichment_import_reports WHERE report_id=? AND run_id=?"),
                    params![report_id, args.run_id],
                    map_row,
                )
                .optional()?,
            None => conn
                .query_row(
                    &format!("SELECT {columns} FROM enrichment_import_reports WHERE run_id=?1 AND (?2 IS NULL OR purpose=?2) ORDER BY created_at DESC,rowid DESC LIMIT 1"),
                    params![args.run_id, purpose],
                    map_row,
                )
                .optional()?,
        };
        let (report_id, purpose, files, summary, matched, not_matched, created_at) = stored
            .ok_or_else(|| {
                Error::NotFound(match &args.report_id {
                    Some(id) => format!("enrichment report not found: {id}"),
                    None => format!("no enrichment report saved for run {}", args.run_id),
                })
            })?;
        Ok(report_json(
            &report_id,
            &args.run_id,
            &purpose,
            &created_at,
            &serde_json::from_str(&files)?,
            &serde_json::from_str(&summary)?,
            &serde_json::from_str(&matched)?,
            &serde_json::from_str(&not_matched)?,
        ))
    })
}
