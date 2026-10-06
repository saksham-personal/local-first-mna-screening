//! Read models for the company grid and the company drawer.
//!
//! `get_screening_grid` serves a page of a run's companies with a constant number of SQL
//! statements per page (no per-company queries). `get_company_detail` serves everything known
//! about one company by reusing the source readers behind `get_candidate_source_data`.
use std::collections::HashMap;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use schemars::JsonSchema;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Map, Value};

use crate::{
    data::{hydrate_source_rows, merge_usable_fields},
    error::{Error, Result},
    projection::{self, IdentitySources},
    store::Store,
};

const DEFAULT_GRID_LIMIT: usize = 1000;
const MAX_GRID_LIMIT: usize = 2000;
/// Newest source rows read per company and source when composing the grid description. A
/// newer blank value falls back to an older nonblank one, as in the source readers.
const ROWS_PER_SOURCE: i64 = 4;
const MAX_ACTIVITY: usize = 100;

fn default_true() -> bool {
    true
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct GridArgs {
    run_id: String,
    /// Include companies hidden by review (default true). Hidden rows carry considered=false.
    #[serde(default = "default_true")]
    include_hidden: bool,
    /// Keyset cursor: the next_cursor of the previous page.
    #[serde(default)]
    after_company_id: Option<String>,
    /// Page size, default 1000, maximum 2000.
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct DetailArgs {
    run_id: String,
    /// A company id, or a typed identifier such as ECID:123, CID:456 or PBID:PB1.
    company_id: String,
}

pub fn input_schema(tool: &str) -> Option<Value> {
    let schema = match tool {
        "get_screening_grid" => schemars::schema_for!(GridArgs),
        "get_company_detail" => schemars::schema_for!(DetailArgs),
        _ => return None,
    };
    serde_json::to_value(schema).ok()
}

fn parse<T: DeserializeOwned>(arguments: &Value) -> Result<T> {
    serde_json::from_value(arguments.clone()).map_err(|error| Error::Validation(error.to_string()))
}

fn bounded(name: &str, value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value != value.trim() || value.len() > max {
        return Err(Error::Validation(format!(
            "{name} must be trimmed, nonblank, and at most {max} bytes"
        )));
    }
    Ok(())
}

fn require_run(conn: &Connection, run_id: &str) -> Result<()> {
    bounded("run_id", run_id, 160)?;
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM screening_runs WHERE run_id=?",
            [run_id],
            |r| r.get(0),
        )
        .optional()?;
    if found.is_none() {
        return Err(Error::NotFound(format!("run not found: {run_id}")));
    }
    Ok(())
}

fn clip(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let mut clipped: String = flat.chars().take(max.saturating_sub(1)).collect();
        clipped.push('…');
        clipped
    }
}

/// `get_screening_grid`
pub fn screening_grid(store: &Store, arguments: &Value) -> Result<Value> {
    let args: GridArgs = parse(arguments)?;
    let limit = args.limit.unwrap_or(DEFAULT_GRID_LIMIT);
    if !(1..=MAX_GRID_LIMIT).contains(&limit) {
        return Err(Error::Validation(format!(
            "limit must be 1..={MAX_GRID_LIMIT}"
        )));
    }
    if let Some(cursor) = &args.after_company_id {
        bounded("after_company_id", cursor, 160)?;
    }
    store.with_connection(|conn| {
        grid_page(
            conn,
            &args.run_id,
            args.include_hidden,
            args.after_company_id.as_deref(),
            limit,
        )
    })
}

/// One grid page. Rows are built as JSON objects so later phases can add keys (keywords,
/// semantic score, per-round scores) without changing the paging or the SQL shape here.
pub(crate) fn grid_page(
    conn: &Connection,
    run_id: &str,
    include_hidden: bool,
    after_company_id: Option<&str>,
    limit: usize,
) -> Result<Value> {
    require_run(conn, run_id)?;
    let fingerprint = crate::review::selection_fingerprint(conn, run_id)?;
    let source_hash = crate::review::source_hash(conn, run_id, &fingerprint)?;
    let (total, considered_count): (i64, i64) = conn.query_row(
        "SELECT COUNT(*),COALESCE(SUM(considered),0) FROM candidates WHERE run_id=?",
        [run_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let fetch = (limit + 1) as i64;

    let mut statement = conn.prepare(
        "WITH page AS (
            SELECT company_id,considered,consideration_reason FROM candidates
            WHERE run_id=?1 AND (?2 OR considered=1) AND (?3 IS NULL OR company_id>?3)
            ORDER BY company_id LIMIT ?4
        ),
        src AS (
            SELECT s.company_id,
                   MAX(s.source='MID') AS has_mid,
                   MAX(s.source='ISCC' AND s.run_scope=?1) AS has_iscc,
                   MAX(CASE WHEN s.source='ISCC' AND s.run_scope=?1 THEN s.relevance_score END) AS iscc_relevance
            FROM source_rows s WHERE s.company_id IN (SELECT company_id FROM page) GROUP BY s.company_id
        ),
        disc AS (
            SELECT d.company_id,
                   MAX(CASE WHEN d.discovery_source='MID' THEN d.retrieval_score END) AS mid_score,
                   MAX(CASE WHEN d.discovery_source='ISCC' THEN d.retrieval_score END) AS iscc_score,
                   MAX(d.discovery_source='MID') AS found_mid,
                   MAX(d.discovery_source='ISCC') AS found_iscc,
                   COUNT(*) AS discoveries
            FROM candidate_discovery d
            WHERE d.run_id=?1 AND d.company_id IN (SELECT company_id FROM page) GROUP BY d.company_id
        )
        SELECT p.company_id,p.considered,p.consideration_reason,
               c.name,c.website,c.city,json_extract(c.metadata_json,'$.hq_state'),c.description,
               (SELECT identifier FROM company_identifiers WHERE company_id=p.company_id AND kind='PBID'),
               e.pb_website,e.pb_name,e.pb_description,e.pb_linkedin_url,e.pb_hq_location,e.pb_active_investors,e.pb_universe,
               COALESCE(e.rogo_json,'{}')!='{}',
               EXISTS(SELECT 1 FROM evidence b WHERE b.run_id=?1 AND b.company_id=p.company_id AND b.claim='bing_research_observation' AND b.source_type='bing'),
               COALESCE(src.has_mid,0),COALESCE(src.has_iscc,0),src.iscc_relevance,
               disc.mid_score,disc.iscc_score,COALESCE(disc.found_mid,0),COALESCE(disc.found_iscc,0),COALESCE(disc.discoveries,0)
        FROM page p
        JOIN companies c ON c.company_id=p.company_id
        LEFT JOIN company_enrichment e ON e.company_id=p.company_id
        LEFT JOIN src ON src.company_id=p.company_id
        LEFT JOIN disc ON disc.company_id=p.company_id
        ORDER BY p.company_id",
    )?;
    struct Fetched {
        company_id: String,
        considered: bool,
        reason: Option<String>,
        name: String,
        website: Option<String>,
        city: Option<String>,
        state: Option<String>,
        description: Option<String>,
        pbid: Option<String>,
        pb: [Option<String>; 7],
        has_rogo: bool,
        has_bing: bool,
        has_mid: bool,
        has_iscc: bool,
        iscc_relevance: Option<f64>,
        mid_score: Option<f64>,
        iscc_score: Option<f64>,
        found_mid: bool,
        found_iscc: bool,
        discoveries: i64,
    }
    let mut fetched = statement
        .query_map(params![run_id, include_hidden, after_company_id, fetch], |r| {
            Ok(Fetched {
                company_id: r.get(0)?,
                considered: r.get::<_, i64>(1)? != 0,
                reason: r.get(2)?,
                name: r.get(3)?,
                website: r.get(4)?,
                city: r.get(5)?,
                state: r.get(6)?,
                description: r.get(7)?,
                pbid: r.get(8)?,
                pb: [
                    r.get(9)?,
                    r.get(10)?,
                    r.get(11)?,
                    r.get(12)?,
                    r.get(13)?,
                    r.get(14)?,
                    r.get(15)?,
                ],
                has_rogo: r.get::<_, i64>(16)? != 0,
                has_bing: r.get::<_, i64>(17)? != 0,
                has_mid: r.get::<_, i64>(18)? != 0,
                has_iscc: r.get::<_, i64>(19)? != 0,
                iscc_relevance: r.get(20)?,
                mid_score: r.get(21)?,
                iscc_score: r.get(22)?,
                found_mid: r.get::<_, i64>(23)? != 0,
                found_iscc: r.get::<_, i64>(24)? != 0,
                discoveries: r.get(25)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(statement);
    let has_more = fetched.len() > limit;
    fetched.truncate(limit);
    let next_cursor = if has_more {
        fetched.last().map(|row| row.company_id.clone())
    } else {
        None
    };

    // Newest source rows of the same page, for the combined description.
    let mut rows_statement = conn.prepare(
        "SELECT company_id,source,row_json FROM (
            SELECT s.company_id,s.source,s.row_json,
                   ROW_NUMBER() OVER (PARTITION BY s.company_id,s.source ORDER BY s.imported_at DESC,s.source_row_id DESC) AS rn
            FROM source_rows s
            WHERE s.company_id IN (
                SELECT company_id FROM (
                    SELECT company_id FROM candidates
                    WHERE run_id=?1 AND (?2 OR considered=1) AND (?3 IS NULL OR company_id>?3)
                    ORDER BY company_id LIMIT ?4
                )
            ) AND (s.source='MID' OR s.run_scope=?1)
         ) WHERE rn<=?5 ORDER BY company_id,source,rn",
    )?;
    let mut source_rows: HashMap<(String, String), Vec<Value>> = HashMap::new();
    for row in rows_statement.query_map(
        params![run_id, include_hidden, after_company_id, fetch, ROWS_PER_SOURCE],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )? {
        let (company_id, source, raw) = row?;
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            source_rows
                .entry((company_id, source))
                .or_default()
                .push(value);
        }
    }
    drop(rows_statement);

    let identity = IdentitySources::default();
    let mut rows = Vec::with_capacity(fetched.len());
    for row in fetched {
        let merged = |source: &str| {
            let records = source_rows
                .get(&(row.company_id.clone(), source.to_owned()))
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            Value::Object(merge_usable_fields(records))
        };
        let (mid, iscc) = (merged("MID"), merged("ISCC"));
        let pb_source = if row.pb.iter().any(Option::is_some) {
            json!({
                "PB_Website": row.pb[0], "PB_Name": row.pb[1], "PB_Description": row.pb[2],
                "PB_LinkedIn URL": row.pb[3], "PB_HQ Location": row.pb[4],
                "PB_Active Investors": row.pb[5], "PB_Universe": row.pb[6],
            })
        } else {
            json!({})
        };
        let (mut lines, legacy) = projection::description_lines(&pb_source, &mid, &iscc, &identity);
        if legacy {
            projection::legacy_description(&mut lines, row.description.as_deref(), &identity);
        }
        let source = match (row.has_mid || row.found_mid, row.has_iscc || row.found_iscc) {
            (true, true) => json!("both"),
            (true, false) => json!("MID"),
            (false, true) => json!("ISCC"),
            _ => Value::Null,
        };
        let preferred = |pb: &Option<String>| pb.clone().filter(|value| !value.trim().is_empty());
        rows.push(json!({
            "company_id": row.company_id,
            "name": preferred(&row.pb[1]).unwrap_or(row.name),
            "website": preferred(&row.pb[0]).or(row.website),
            "hq_city": row.city,
            "hq_state": row.state,
            "description": projection::join_descriptions(&lines),
            "source": source,
            "considered": row.considered,
            "consideration_reason": row.reason,
            "pbid": row.pbid,
            // The best observation per source, never the first one seen.
            "mid_score": row.mid_score,
            "iscc_score": row.iscc_score.or(row.iscc_relevance),
            "coverage": {
                "pb": row.pb[1].is_some() || row.pb[2].is_some(),
                "rogo": row.has_rogo,
                "bing": row.has_bing,
            },
            "pb": {
                "name": row.pb[1],
                "website": row.pb[0],
                "description": row.pb[2],
                "hq_location": row.pb[4],
                "active_investors": row.pb[5],
                "universe": row.pb[6],
                "linkedin_url": row.pb[3],
            },
            "discovery_count": row.discoveries,
        }));
    }
    Ok(json!({
        "run_id": run_id,
        "selection_revision": fingerprint["selection_revision"],
        "criteria_revision": fingerprint["criteria_revision"],
        "source_hash": source_hash,
        "include_hidden": include_hidden,
        "total": total,
        "considered_count": considered_count,
        "hidden_count": total - considered_count,
        "next_cursor": next_cursor,
        "rows": rows,
    }))
}

/// `get_company_detail`
pub fn company_detail(store: &Store, arguments: &Value) -> Result<Value> {
    let args: DetailArgs = parse(arguments)?;
    bounded("run_id", &args.run_id, 160)?;
    bounded("company_id", &args.company_id, 160)?;
    let company_id = store.resolve_company_id(&args.company_id)?;
    let mut company = store.execute("get_company", &json!({"company_id": company_id}))?;
    if let Some(object) = company.as_object_mut() {
        object.remove("embedding");
    }
    store.with_connection(|conn| {
        require_run(conn, &args.run_id)?;
        let state: Option<(i64, Option<String>)> = conn
            .query_row(
                "SELECT considered,consideration_reason FROM candidates WHERE run_id=? AND company_id=?",
                params![args.run_id, company_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (considered, reason) = state.ok_or_else(|| {
            Error::NotFound(format!(
                "company {company_id} is not a candidate in run {}",
                args.run_id
            ))
        })?;

        let mut statement = conn.prepare(
            "SELECT kind,identifier,first_seen_at FROM company_identifiers WHERE company_id=? ORDER BY kind,identifier",
        )?;
        let identifiers = statement
            .query_map([&company_id], |r| {
                Ok(json!({
                    "kind": r.get::<_, String>(0)?,
                    "identifier": r.get::<_, String>(1)?,
                    "first_seen_at": r.get::<_, String>(2)?,
                }))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(statement);

        let hydrated = hydrate_source_rows(conn, &args.run_id, std::slice::from_ref(&company_id))?;
        let row = hydrated
            .into_iter()
            .next()
            .ok_or_else(|| Error::Internal("company source row missing".into()))?;
        let mut sources = Map::new();
        for (label, key, lineage, updated_at) in [
            ("MID", "MID", &row["provenance"]["MID"], Value::Null),
            ("ISCC", "ISCC", &row["provenance"]["ISCC"], Value::Null),
            (
                "PITCHBOOK",
                "PB",
                &row["provenance"]["PB"],
                row["provenance"]["PB_updated_at"].clone(),
            ),
            (
                "ROGO",
                "ROGO",
                &row["provenance"]["ROGO"],
                row["provenance"]["ROGO_updated_at"].clone(),
            ),
        ] {
            let fields = &row["sources"][key];
            if fields.as_object().is_some_and(|object| !object.is_empty()) {
                sources.insert(
                    label.into(),
                    json!({"fields": fields, "lineage": lineage, "updated_at": updated_at}),
                );
            }
        }

        let identity = IdentitySources::default();
        let (mut lines, legacy) = projection::description_lines(
            &row["sources"]["PB"],
            &row["sources"]["MID"],
            &row["sources"]["ISCC"],
            &identity,
        );
        if legacy {
            projection::legacy_description(&mut lines, company["description"].as_str(), &identity);
        }
        let descriptions: Vec<Value> = lines
            .iter()
            .map(|(label, text)| json!({"label": label, "text": text}))
            .collect();

        Ok(json!({
            "run_id": args.run_id,
            "company_id": company_id,
            "company": company,
            "identifiers": identifiers,
            "pbid": row["PBId"],
            "considered": considered != 0,
            "consideration_reason": reason,
            "sources": Value::Object(sources),
            "descriptions": descriptions,
            "activity": activity(conn, &args.run_id, &company_id)?,
        }))
    })
}

struct Event {
    kind: &'static str,
    at: String,
    summary: String,
}

/// Hide/restore history, discovery, evidence and Bing observations, assessments, labels and
/// enrichment imports of one company, newest first and bounded.
fn activity(conn: &Connection, run_id: &str, company_id: &str) -> Result<Vec<Value>> {
    let mut events = Vec::<Event>::new();

    // Membership of the considered set changed between two review snapshots.
    let mut statement = conn.prepare(
        "SELECT created_at,reason,instr(keep_company_ids_json,json_quote(?2))>0 FROM shortlist_reviews WHERE run_id=?1 ORDER BY rowid",
    )?;
    let mut previously_kept = true;
    let mut transitions = Vec::new();
    for row in statement.query_map(params![run_id, company_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, i64>(2)? != 0,
        ))
    })? {
        let (at, reason, kept) = row?;
        if kept != previously_kept {
            let reason = reason.unwrap_or_else(|| "shortlist review".into());
            transitions.push(Event {
                kind: if kept { "restored" } else { "hidden" },
                at,
                summary: format!(
                    "{}: {}",
                    if kept { "Restored" } else { "Hidden" },
                    clip(&reason, 200)
                ),
            });
        }
        previously_kept = kept;
    }
    drop(statement);
    events.extend(transitions);

    let mut statement = conn.prepare(
        "SELECT discovery_source,retrieval_score,rank,discovered_at FROM candidate_discovery WHERE run_id=? AND company_id=? ORDER BY discovered_at DESC LIMIT 10",
    )?;
    for row in statement.query_map(params![run_id, company_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<f64>>(1)?,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, String>(3)?,
        ))
    })? {
        let (source, score, rank, at) = row?;
        let mut summary = format!("Found by {source} search");
        match (score, rank) {
            (Some(score), Some(rank)) => summary.push_str(&format!(" (score {score:.2}, rank {rank})")),
            (Some(score), None) => summary.push_str(&format!(" (score {score:.2})")),
            _ => {}
        }
        events.push(Event {
            kind: "discovery",
            at,
            summary,
        });
    }
    drop(statement);

    let mut statement = conn.prepare(
        "SELECT claim,source_type,value_json,retrieved_at FROM evidence WHERE run_id=? AND company_id=? ORDER BY retrieved_at DESC,evidence_id DESC LIMIT 20",
    )?;
    for row in statement.query_map(params![run_id, company_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })? {
        let (claim, source_type, raw, at) = row?;
        let value: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        if claim == "bing_research_observation" && source_type == "bing" {
            events.push(Event {
                kind: "bing",
                at,
                summary: format!(
                    "Bing: {} {}",
                    clip(value["question"].as_str().unwrap_or("research question"), 120),
                    clip(value["answer"].as_str().unwrap_or(""), 160)
                )
                .trim()
                .to_owned(),
            });
        } else {
            let shown = match &value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            events.push(Event {
                kind: "evidence",
                at,
                summary: format!("{claim} ({source_type}): {}", clip(&shown, 200)),
            });
        }
    }
    drop(statement);

    let mut statement = conn.prepare(
        "SELECT provider,result_json,created_at FROM model_assessments WHERE run_id=? AND company_id=? ORDER BY created_at DESC,assessment_id DESC LIMIT 20",
    )?;
    for row in statement.query_map(params![run_id, company_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (provider, raw, at) = row?;
        let result: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let fields = result
            .as_object()
            .map(|object| {
                object
                    .iter()
                    .filter_map(|(key, value)| match value {
                        Value::String(text) => Some(format!("{key}={}", clip(text, 60))),
                        Value::Number(number) => Some(format!("{key}={number}")),
                        _ => None,
                    })
                    .take(3)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        events.push(Event {
            kind: "assessment",
            at,
            summary: format!("{provider} assessment: {fields}")
                .trim_end_matches(": ")
                .to_owned(),
        });
    }
    drop(statement);

    let mut statement = conn.prepare(
        "SELECT label,analyst_note,updated_at FROM company_labels WHERE run_id=? AND company_id=?",
    )?;
    for row in statement.query_map(params![run_id, company_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (label, note, at) = row?;
        events.push(Event {
            kind: "label",
            at,
            summary: match note {
                Some(note) if !note.trim().is_empty() => {
                    format!("Analyst label {label}: {}", clip(&note, 200))
                }
                _ => format!("Analyst label {label}"),
            },
        });
    }
    drop(statement);

    let mut statement = conn.prepare(
        "SELECT kind,imported_at FROM enrichment_rows WHERE company_id=? ORDER BY imported_at DESC LIMIT 10",
    )?;
    for row in statement.query_map([company_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (kind, at) = row?;
        events.push(Event {
            kind: "enrichment",
            at,
            summary: match kind.as_str() {
                "PB_MAPPING" => "PitchBook mapping row imported".to_owned(),
                "PB_DATA" => "PitchBook data row imported".to_owned(),
                _ => "ROGO row imported".to_owned(),
            },
        });
    }
    drop(statement);

    let sort_key = |event: &Event| {
        (
            DateTime::parse_from_rfc3339(&event.at)
                .map(|at| at.with_timezone(&Utc))
                .ok(),
            event.at.clone(),
        )
    };
    events.sort_by_key(|event| std::cmp::Reverse(sort_key(event)));
    events.truncate(MAX_ACTIVITY);
    Ok(events
        .into_iter()
        .map(|event| json!({"kind": event.kind, "at": event.at, "summary": event.summary}))
        .collect())
}
