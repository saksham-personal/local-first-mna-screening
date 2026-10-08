//! Read models for the company grid and the company drawer.
//!
//! `get_screening_grid` serves a page of a run's companies with a constant number of SQL
//! statements per page (no per-company queries). `get_company_detail` serves everything known
//! about one company by reusing the source readers behind `get_candidate_source_data`.
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
};

use chrono::{DateTime, Duration, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use schemars::JsonSchema;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Map, Value};

use crate::{
    data::{hydrate_source_rows, merge_usable_fields},
    error::{Error, Result},
    mid_config::{ColumnType, MidIndexConfig},
    projection::{self, IdentitySources},
    source_mapping::SourceMapping,
    store::Store,
};

const DEFAULT_GRID_LIMIT: usize = 500;
const MAX_GRID_LIMIT: usize = 1000;
const SOFT_PAGE_BYTES: usize = 1536 * 1024;
const HARD_PAGE_BYTES: usize = 8 * 1024 * 1024;
/// Source rows sampled per source to discover column headers.
const HEADER_SAMPLE_ROWS: usize = 400;
/// Newest source rows read per company and source when composing the grid description. A
/// newer blank value falls back to an older nonblank one, as in the source readers.
const ROWS_PER_SOURCE: i64 = 4;
const MAX_ACTIVITY: usize = 100;

const PAGE_CTE: &str = "WITH page AS (
    SELECT company_id FROM candidates
    WHERE run_id=?1 AND (?2 OR considered=1) AND (?3 IS NULL OR company_id>?3)
    ORDER BY company_id LIMIT ?4
), aliases AS (
    SELECT company_id AS current_id,company_id AS alias_id FROM page
    UNION
    SELECT p.company_id,ci.identifier FROM page p
    JOIN company_identifiers ci ON ci.company_id=p.company_id AND ci.kind='PK'
) ";

#[derive(Default)]
struct KeywordAggregate {
    best_match_pct: Option<f64>,
    hit_count: i64,
    matched: Vec<Value>,
    matched_texts: HashSet<String>,
    queries: Vec<Value>,
}

#[derive(Clone)]
struct RoundInfo {
    key: String,
    round_no: i64,
    provider: String,
    provider_label: String,
    score_columns: Vec<String>,
    output_columns: Vec<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Copy, Default, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum GridView {
    #[default]
    All,
    Mid,
    Iscc,
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
    /// Page size, default 500, maximum 1000. Large pages shrink automatically.
    #[serde(default)]
    limit: Option<usize>,
    /// Include larger bridge-only fields needed to construct Company records.
    #[serde(default)]
    include_company_payload: bool,
    #[serde(default)]
    view: GridView,
    /// Column ids to project into values. Omit to include all non-description columns.
    #[serde(default)]
    columns: Option<Vec<String>>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct DetailArgs {
    run_id: String,
    /// A company id, or a typed identifier such as ECID:123, CID:456 or PBID:PB1.
    company_id: String,
    #[serde(default)]
    view: GridView,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct DescriptionArgs {
    run_id: String,
    /// Visible company ids, at most 500.
    #[schemars(length(max = 500))]
    company_ids: Vec<String>,
}

pub fn input_schema(tool: &str) -> Option<Value> {
    let schema = match tool {
        "get_screening_grid" => schemars::schema_for!(GridArgs),
        "get_company_detail" => schemars::schema_for!(DetailArgs),
        "get_grid_descriptions" => schemars::schema_for!(DescriptionArgs),
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

fn display_keyword_query(rationale: &str, expression: &str, keywords_json: &str) -> String {
    let keywords = serde_json::from_str::<Value>(keywords_json).unwrap_or_else(|_| json!([]));
    crate::mid_search::display_keyword_query(rationale, expression, &keywords)
}

fn add_matched(aggregate: &mut KeywordAggregate, matched_json: &str) {
    let matched = serde_json::from_str::<Value>(matched_json).unwrap_or(Value::Null);
    for item in matched.as_array().into_iter().flatten() {
        let Some(text) = item.get("text").and_then(Value::as_str) else {
            continue;
        };
        if aggregate.matched.len() >= 20 || !aggregate.matched_texts.insert(text.to_owned()) {
            continue;
        }
        aggregate.matched.push(json!({
            "id": item.get("id").cloned().unwrap_or(Value::Null),
            "text": text,
        }));
    }
}

fn keyword_payload(aggregate: KeywordAggregate) -> Value {
    if aggregate.queries.is_empty() {
        return Value::Null;
    }
    json!({
        "best_match_pct": aggregate.best_match_pct,
        "hit_count": aggregate.hit_count,
        "matched": aggregate.matched,
        "queries": aggregate.queries,
    })
}

fn page_keyword_data(
    conn: &Connection,
    run_id: &str,
    include_hidden: bool,
    after_company_id: Option<&str>,
    limit: usize,
) -> Result<HashMap<String, Value>> {
    let sql = format!(
        "{PAGE_CTE}
         SELECT a.current_id,q.query_id,q.rationale,q.expression,q.keywords_json,
                h.match_pct,h.hit_count,h.matched_json
         FROM mid_keyword_hits h
         JOIN mid_keyword_queries q ON q.query_id=h.query_id AND q.run_id=h.run_id
         JOIN aliases a ON a.alias_id=h.company_id
         WHERE h.run_id=?1
         ORDER BY a.current_id,q.created_at DESC,q.query_id DESC"
    );
    let mut statement = conn.prepare(&sql)?;
    let mut aggregates = HashMap::<String, KeywordAggregate>::new();
    for row in statement.query_map(
        params![run_id, include_hidden, after_company_id, limit as i64],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, f64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, String>(7)?,
            ))
        },
    )? {
        let (company_id, query_id, rationale, expression, keywords, match_pct, hit_count, matched) =
            row?;
        let aggregate = aggregates.entry(company_id).or_default();
        aggregate.best_match_pct = Some(
            aggregate
                .best_match_pct
                .unwrap_or(f64::NEG_INFINITY)
                .max(match_pct),
        );
        aggregate.hit_count = aggregate.hit_count.max(hit_count);
        add_matched(aggregate, &matched);
        if aggregate.queries.len() < 10 {
            aggregate.queries.push(json!({
                "query_id": query_id,
                "rationale": rationale,
                "display_query": display_keyword_query(&rationale, &expression, &keywords),
                "match_pct": match_pct,
            }));
        }
    }
    Ok(aggregates
        .into_iter()
        .map(|(company_id, aggregate)| (company_id, keyword_payload(aggregate)))
        .collect())
}

fn company_keyword_data(conn: &Connection, run_id: &str, company_id: &str) -> Result<Value> {
    let mut statement = conn.prepare(
        "SELECT q.query_id,q.rationale,q.expression,q.keywords_json,h.match_pct,h.hit_count,h.matched_json
         FROM mid_keyword_hits h
         JOIN mid_keyword_queries q ON q.query_id=h.query_id AND q.run_id=h.run_id
         WHERE h.run_id=?1 AND (h.company_id=?2 OR h.company_id IN
           (SELECT identifier FROM company_identifiers WHERE company_id=?2 AND kind='PK'))
         ORDER BY q.created_at DESC,q.query_id DESC",
    )?;
    let mut aggregate = KeywordAggregate::default();
    let mut detail_queries = Vec::new();
    for row in statement.query_map(params![run_id, company_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, f64>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, String>(6)?,
        ))
    })? {
        let (query_id, rationale, expression, keywords, match_pct, hit_count, matched_json) = row?;
        let display_query = display_keyword_query(&rationale, &expression, &keywords);
        let matched_value =
            serde_json::from_str::<Value>(&matched_json).unwrap_or_else(|_| json!([]));
        aggregate.best_match_pct = Some(
            aggregate
                .best_match_pct
                .unwrap_or(f64::NEG_INFINITY)
                .max(match_pct),
        );
        aggregate.hit_count = aggregate.hit_count.max(hit_count);
        add_matched(&mut aggregate, &matched_json);
        aggregate.queries.push(json!({
            "query_id": query_id,
            "rationale": rationale,
            "display_query": display_query,
            "match_pct": match_pct,
        }));
        detail_queries.push(json!({
            "query_id": query_id,
            "rationale": rationale,
            "display_query": display_query,
            "match_pct": match_pct,
            "hit_count": hit_count,
            "matched": matched_value,
        }));
    }
    if detail_queries.is_empty() {
        return Ok(Value::Null);
    }
    Ok(json!({
        "best_match_pct": aggregate.best_match_pct,
        "hit_count": aggregate.hit_count,
        "matched": aggregate.matched,
        "queries": detail_queries,
    }))
}

fn page_semantic_data(
    conn: &Connection,
    run_id: &str,
    include_hidden: bool,
    after_company_id: Option<&str>,
    limit: usize,
) -> Result<HashMap<String, f64>> {
    let sql = format!(
        "{PAGE_CTE}, approved AS (
             SELECT r.revision FROM criteria_revisions r
             JOIN criteria_revision_approvals a USING(revision_id)
             WHERE r.run_id=?1 ORDER BY r.revision DESC LIMIT 1
         ), ranked AS (
             SELECT a.current_id,s.score,
                    ROW_NUMBER() OVER(PARTITION BY a.current_id ORDER BY
                      CASE WHEN s.criteria_revision=(SELECT revision FROM approved) THEN 0 ELSE 1 END,
                      CASE WHEN s.company_id=a.current_id THEN 0 ELSE 1 END,
                      s.criteria_revision DESC) AS rn
             FROM mid_semantic_scores s JOIN aliases a ON a.alias_id=s.company_id
             WHERE s.run_id=?1
         )
         SELECT current_id,score FROM ranked WHERE rn=1"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(
        params![run_id, include_hidden, after_company_id, limit as i64],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)),
    )?;
    let scores = rows.collect::<std::result::Result<HashMap<_, _>, _>>()?;
    Ok(scores)
}

fn semantic_detail(conn: &Connection, run_id: &str, company_id: &str) -> Result<Value> {
    let mut statement = conn.prepare(
        "SELECT s.score,s.cosine,s.model,s.criteria_revision,s.computed_at
         FROM mid_semantic_scores s
         WHERE s.run_id=?1 AND (s.company_id=?2 OR s.company_id IN
           (SELECT identifier FROM company_identifiers WHERE company_id=?2 AND kind='PK'))
         ORDER BY CASE WHEN s.criteria_revision=(
             SELECT r.revision FROM criteria_revisions r
             JOIN criteria_revision_approvals a USING(revision_id)
             WHERE r.run_id=?1 ORDER BY r.revision DESC LIMIT 1
         ) THEN 0 ELSE 1 END,
         CASE WHEN s.company_id=?2 THEN 0 ELSE 1 END,
         s.criteria_revision DESC LIMIT 1",
    )?;
    Ok(statement
        .query_row(params![run_id, company_id], |r| {
            Ok(json!({
                "score": r.get::<_, f64>(0)?,
                "cosine": r.get::<_, f64>(1)?,
                "model": r.get::<_, String>(2)?,
                "criteria_revision": r.get::<_, i64>(3)?,
                "computed_at": r.get::<_, String>(4)?,
            }))
        })
        .optional()?
        .unwrap_or(Value::Null))
}

fn rounds_for_run(conn: &Connection, run_id: &str) -> Result<Vec<RoundInfo>> {
    let mut statement = conn.prepare(
        "SELECT sr.round_no,sr.provider,p.spec_json
         FROM screening_rounds sr JOIN prepared_plans p ON p.plan_id=sr.plan_id
         WHERE sr.run_id=? ORDER BY sr.round_no",
    )?;
    let mut rounds = Vec::new();
    for row in statement.query_map([run_id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (round_no, provider, spec_json) = row?;
        let spec: Value = serde_json::from_str(&spec_json)?;
        rounds.push(RoundInfo {
            key: format!("R{round_no}"),
            round_no,
            provider_label: crate::execution::screening_provider_label(&provider),
            provider,
            score_columns: serde_json::from_value(spec["score_columns"].clone())
                .unwrap_or_default(),
            output_columns: serde_json::from_value(spec["output_columns"].clone())
                .unwrap_or_default(),
        });
    }
    Ok(rounds)
}

fn round_payload(info: &RoundInfo, result: &Value, created_at: Option<&str>) -> Value {
    let values: Map<String, Value> = info
        .output_columns
        .iter()
        .map(|column| {
            (
                column.clone(),
                result.get(column).cloned().unwrap_or(Value::Null),
            )
        })
        .collect();
    let scores: Map<String, Value> = info
        .score_columns
        .iter()
        .map(|column| {
            (
                column.clone(),
                crate::execution::screening_score_value(result.get(column)),
            )
        })
        .collect();
    let mut payload = json!({
        "provider": info.provider,
        "provider_label": info.provider_label,
        "score_columns": info.score_columns,
        "values": Value::Object(values),
        "scores": Value::Object(scores),
    });
    if let Some(created_at) = created_at {
        payload["result"] = result.clone();
        payload["created_at"] = json!(created_at);
    }
    payload
}

fn page_assessments(
    conn: &Connection,
    run_id: &str,
    include_hidden: bool,
    after_company_id: Option<&str>,
    limit: usize,
    rounds: &[RoundInfo],
) -> Result<HashMap<String, Value>> {
    let sql = format!(
        "{PAGE_CTE}, ranked AS (
             SELECT a.current_id,sr.round_no,ma.result_json,ma.created_at,
                    ROW_NUMBER() OVER(PARTITION BY a.current_id,sr.round_no
                      ORDER BY ma.created_at DESC,ma.assessment_id DESC) AS rn
             FROM aliases a
             JOIN model_assessments ma ON ma.company_id=a.alias_id AND ma.run_id=?1
             JOIN screening_rounds sr ON sr.run_id=ma.run_id AND sr.plan_id=ma.plan_id
         )
         SELECT current_id,round_no,result_json FROM ranked WHERE rn=1
         ORDER BY current_id,round_no"
    );
    let mut statement = conn.prepare(&sql)?;
    let by_round: HashMap<i64, &RoundInfo> =
        rounds.iter().map(|round| (round.round_no, round)).collect();
    let mut results = HashMap::<String, Map<String, Value>>::new();
    for row in statement.query_map(
        params![run_id, include_hidden, after_company_id, limit as i64],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )? {
        let (company_id, round_no, raw_result) = row?;
        let Some(round) = by_round.get(&round_no) else {
            continue;
        };
        let result: Value = serde_json::from_str(&raw_result)?;
        results
            .entry(company_id)
            .or_default()
            .insert(round.key.clone(), round_payload(round, &result, None));
    }
    Ok(results
        .into_iter()
        .map(|(company_id, rounds)| (company_id, Value::Object(rounds)))
        .collect())
}

fn company_rounds(
    conn: &Connection,
    run_id: &str,
    company_id: &str,
    rounds: &[RoundInfo],
) -> Result<Value> {
    let mut statement = conn.prepare(
        "SELECT sr.round_no,ma.result_json,ma.created_at
         FROM model_assessments ma
         JOIN screening_rounds sr ON sr.run_id=ma.run_id AND sr.plan_id=ma.plan_id
         WHERE ma.run_id=?1 AND (ma.company_id=?2 OR ma.company_id IN
           (SELECT identifier FROM company_identifiers WHERE company_id=?2 AND kind='PK'))
         ORDER BY sr.round_no,ma.created_at DESC,ma.assessment_id DESC",
    )?;
    let by_round: HashMap<i64, &RoundInfo> =
        rounds.iter().map(|round| (round.round_no, round)).collect();
    let mut output = Map::new();
    let mut seen = HashSet::new();
    for row in statement.query_map(params![run_id, company_id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (round_no, raw_result, created_at) = row?;
        let Some(round) = by_round.get(&round_no) else {
            continue;
        };
        if !seen.insert(round_no) {
            continue;
        }
        let result: Value = serde_json::from_str(&raw_result)?;
        output.insert(
            round.key.clone(),
            round_payload(round, &result, Some(&created_at)),
        );
    }
    Ok(Value::Object(output))
}

fn simulated_for_company(conn: &Connection, run_id: &str, company_id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT
           EXISTS(SELECT 1 FROM source_rows WHERE run_scope=?1 AND simulated=1 AND
             (company_id=?2 OR company_id IN
               (SELECT identifier FROM company_identifiers WHERE company_id=?2 AND kind='PK')))
           OR EXISTS(SELECT 1 FROM evidence WHERE run_id=?1 AND simulated=1 AND
             (company_id=?2 OR company_id IN
               (SELECT identifier FROM company_identifiers WHERE company_id=?2 AND kind='PK')))
           OR EXISTS(SELECT 1 FROM model_assessments WHERE run_id=?1 AND simulated=1 AND
             (company_id=?2 OR company_id IN
               (SELECT identifier FROM company_identifiers WHERE company_id=?2 AND kind='PK'))) ",
        params![run_id, company_id],
        |r| r.get::<_, i64>(0),
    )? != 0)
}

fn company_iscc_data(conn: &Connection, run_id: &str, company_id: &str) -> Result<Value> {
    let latest: Option<(Option<f64>, String)> = conn
        .query_row(
            "SELECT relevance_score,row_json FROM source_rows
             WHERE source='ISCC' AND run_scope=?1 AND (company_id=?2 OR company_id IN
               (SELECT identifier FROM company_identifiers WHERE company_id=?2 AND kind='PK'))
             ORDER BY imported_at DESC,source_row_id DESC LIMIT 1",
            params![run_id, company_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let source_relevancy: Option<f64> = conn.query_row(
        "SELECT MAX(relevance_score) FROM source_rows
         WHERE source='ISCC' AND run_scope=?1 AND (company_id=?2 OR company_id IN
           (SELECT identifier FROM company_identifiers WHERE company_id=?2 AND kind='PK'))",
        params![run_id, company_id],
        |r| r.get(0),
    )?;
    let discovery_relevancy: Option<f64> = conn.query_row(
        "SELECT MAX(retrieval_score) FROM candidate_discovery
         WHERE run_id=?1 AND discovery_source='ISCC' AND (company_id=?2 OR company_id IN
           (SELECT identifier FROM company_identifiers WHERE company_id=?2 AND kind='PK'))",
        params![run_id, company_id],
        |r| r.get(0),
    )?;
    let relevancy = source_relevancy
        .or(discovery_relevancy)
        .filter(|score| score.is_finite())
        .map(|score| (score * 100.0).round() / 100.0);
    if latest.is_none() && relevancy.is_none() {
        return Ok(Value::Null);
    }
    let row = latest
        .as_ref()
        .and_then(|(_, raw)| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or(Value::Null);
    Ok(json!({"relevancy": relevancy, "row": row}))
}

fn run_has_columns(conn: &Connection, run_id: &str) -> Result<(bool, bool, bool)> {
    conn.query_row(
        "SELECT
           EXISTS(SELECT 1 FROM mid_keyword_hits WHERE run_id=?1),
           EXISTS(SELECT 1 FROM mid_semantic_scores WHERE run_id=?1),
           (EXISTS(SELECT 1 FROM candidate_discovery WHERE run_id=?1 AND discovery_source='ISCC')
            OR EXISTS(SELECT 1 FROM source_rows WHERE run_scope=?1 AND source='ISCC'))",
        [run_id],
        |r| {
            Ok((
                r.get::<_, i64>(0)? != 0,
                r.get::<_, i64>(1)? != 0,
                r.get::<_, i64>(2)? != 0,
            ))
        },
    )
    .map_err(Into::into)
}

const ISCC_DESCRIPTIONS: &[&str] = &[
    "Company Description",
    "Pitchbook Description",
    "Factset Description",
    "Demandbase Description",
    "Dealogic Description",
    "Offerings",
    "Pitchbook Keywords",
    "NAICS Description",
];
const RUN_ALIASES: &str = "WITH members AS (
    SELECT company_id FROM candidates WHERE run_id=?1
), aliases AS (
    SELECT company_id AS current_id,company_id AS alias_id FROM members
    UNION SELECT m.company_id,ci.identifier FROM members m
    JOIN company_identifiers ci ON ci.company_id=m.company_id AND ci.kind='PK'
)";
type SourceRecords = HashMap<(String, String), Vec<Value>>;

/// Read the same bounded source history once for a page, descriptions, or a drawer.
/// Source rows win over the active bundle fallback; promoted PK aliases remain readable.
fn source_records(conn: &Connection, run_id: &str, ids: &[String]) -> Result<SourceRecords> {
    let mut statement = conn.prepare(
        "WITH ids AS (SELECT value AS company_id FROM json_each(?2)), aliases AS (
            SELECT company_id AS current_id,company_id AS alias_id FROM ids
            UNION SELECT i.company_id,ci.identifier FROM ids i
            JOIN company_identifiers ci ON ci.company_id=i.company_id AND ci.kind='PK'
        ), raw AS (
            SELECT a.current_id,s.source,s.row_json,s.imported_at,s.source_row_id
            FROM aliases a JOIN source_rows s ON s.company_id=a.alias_id
            WHERE s.source='MID' OR (s.source='ISCC' AND s.run_scope=?1)
            UNION ALL
            SELECT a.current_id,'MID',m.row_json,'',CAST(m.row_no AS TEXT)
            FROM aliases a JOIN mid_rows m ON m.company_id=a.alias_id
            JOIN mid_bundles b ON b.bundle_id=m.bundle_id AND b.status='active'
        ), ranked AS (
            SELECT *,ROW_NUMBER() OVER(PARTITION BY current_id,source
              ORDER BY imported_at DESC,source_row_id DESC) AS rn FROM raw
        ) SELECT current_id,source,row_json FROM ranked WHERE rn<=?3
          ORDER BY current_id,source,rn",
    )?;
    let mut records = SourceRecords::new();
    for row in statement.query_map(
        params![run_id, serde_json::to_string(ids)?, ROWS_PER_SOURCE],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )? {
        let (id, source, raw) = row?;
        records
            .entry((id, source))
            .or_default()
            .push(serde_json::from_str(&raw)?);
    }
    Ok(records)
}

fn latest_source<'a>(records: &'a SourceRecords, id: &str, source: &str) -> &'a Value {
    records
        .get(&(id.to_owned(), source.to_owned()))
        .and_then(|rows| rows.first())
        .unwrap_or(&Value::Null)
}

struct GridColumn {
    id: String,
    kind: &'static str,
    catalog: Value,
    mid: Option<String>,
    iscc: Option<String>,
    path: Vec<String>,
    description: bool,
}

struct ColumnModel {
    config: MidIndexConfig,
    columns: Vec<GridColumn>,
    has_mid: bool,
    has_iscc: bool,
}

impl ColumnModel {
    fn load(conn: &Connection, run_id: &str, view: GridView, rounds: &[RoundInfo]) -> Result<Self> {
        let config = MidIndexConfig::load()?;
        let mapping = SourceMapping::load()?;
        let sql = format!("{RUN_ALIASES} SELECT
            EXISTS(SELECT 1 FROM aliases a JOIN source_rows s ON s.company_id=a.alias_id WHERE s.source='MID')
            OR EXISTS(SELECT 1 FROM aliases a JOIN mid_rows m ON m.company_id=a.alias_id JOIN mid_bundles b ON b.bundle_id=m.bundle_id WHERE b.status='active')
            OR EXISTS(SELECT 1 FROM candidate_discovery WHERE run_id=?1 AND discovery_source='MID')
            OR EXISTS(SELECT 1 FROM mid_keyword_hits WHERE run_id=?1)
            OR EXISTS(SELECT 1 FROM mid_semantic_scores WHERE run_id=?1),
            EXISTS(SELECT 1 FROM aliases a JOIN source_rows s ON s.company_id=a.alias_id WHERE s.source='ISCC' AND s.run_scope=?1)
            OR EXISTS(SELECT 1 FROM candidate_discovery WHERE run_id=?1 AND discovery_source='ISCC')");
        let (has_mid, has_iscc): (bool, bool) =
            conn.query_row(&sql, [run_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let active: Option<String> = conn
            .query_row(
                "SELECT config_json FROM mid_bundles WHERE status='active'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let mut mid_columns: Vec<String> = active
            .map(|raw| serde_json::from_str::<Value>(&raw))
            .transpose()?
            .and_then(|v| serde_json::from_value(v["workbook_columns"].clone()).ok())
            .unwrap_or_default();
        let need_mid_headers = mid_columns.is_empty();
        // Headers come from a bounded sample of rows so the cost does not grow with run size.
        let sql = format!("{RUN_ALIASES}, sample AS (
              SELECT * FROM (SELECT s.source,s.row_json FROM aliases a JOIN source_rows s ON s.company_id=a.alias_id
                WHERE s.source='MID' AND ?2 LIMIT {HEADER_SAMPLE_ROWS})
              UNION ALL
              SELECT * FROM (SELECT s.source,s.row_json FROM aliases a JOIN source_rows s ON s.company_id=a.alias_id
                WHERE s.source='ISCC' AND s.run_scope=?1 LIMIT {HEADER_SAMPLE_ROWS}))
            SELECT DISTINCT x.source,j.key FROM sample x JOIN json_each(x.row_json) j
            ORDER BY x.source,j.key");
        let mut statement = conn.prepare(&sql)?;
        let mut iscc_columns = Vec::new();
        for row in statement.query_map(params![run_id, need_mid_headers], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })? {
            let (source, column) = row?;
            if source == "MID" {
                mid_columns.push(column);
            } else {
                iscc_columns.push(column);
            }
        }
        let effective_view = match view {
            GridView::All if has_mid && has_iscc => GridView::All,
            GridView::All if has_iscc => GridView::Iscc,
            GridView::All => GridView::Mid,
            other => other,
        };
        let mut model = Self {
            config,
            columns: Vec::new(),
            has_mid,
            has_iscc,
        };
        for (source, names) in [("MID", mid_columns), ("ISCC", iscc_columns)] {
            if (effective_view == GridView::Mid && source != "MID")
                || (effective_view == GridView::Iscc && source != "ISCC")
            {
                continue;
            }
            for name in names {
                if source == "ISCC" && mapping.dropped_iscc.contains(&name) {
                    continue;
                }
                let id = if effective_view == GridView::All {
                    mapping
                        .merged_column_name(source, &name)
                        .expect("known source")
                } else {
                    name.clone()
                };
                let mapped_name = if source == "ISCC" {
                    mapping.mid_name_for_iscc(&name).unwrap_or(&name)
                } else {
                    &name
                };
                let identity = model
                    .config
                    .identifier_columns
                    .ecid
                    .iter()
                    .chain(&model.config.identifier_columns.cid)
                    .chain(&model.config.name_columns)
                    .chain(&model.config.website_columns)
                    .any(|s| s == &name);
                let coverage = model
                    .config
                    .coverage_columns
                    .iter()
                    .any(|s| s.eq_ignore_ascii_case(&name))
                    || [
                        "CB Banker",
                        "GCB Banker",
                        "IB Client Executive",
                        "Quality of Connection",
                        "Total R12 Call Count",
                        "CB R12 Call Count",
                        "IB R12 Call Count",
                        "Last Call Date",
                    ]
                    .iter()
                    .any(|s| s.eq_ignore_ascii_case(&name));
                let hydration = model.config.identifier_columns.pbid.contains(&name)
                    || name.starts_with("pb_")
                    || name.starts_with("[ROGO]")
                    || name.starts_with("rogo_")
                    || name.starts_with("bing_");
                let group = if identity {
                    "identity"
                } else if coverage {
                    "coverage"
                } else if hydration {
                    "hydration"
                } else if source == "MID" {
                    "mid"
                } else {
                    "iscc"
                };
                let kind = match model.config.column_types.get(mapped_name) {
                    Some(ColumnType::Number) => "number",
                    Some(ColumnType::Date) => "date",
                    Some(ColumnType::Category) => "category",
                    _ => "text",
                };
                let visible = identity
                    || model
                        .config
                        .display_columns
                        .iter()
                        .any(|s| s == mapped_name);
                let description = name.to_ascii_lowercase().contains("description")
                    || if source == "MID" {
                        model.config.description_columns.contains(&name)
                    } else {
                        ISCC_DESCRIPTIONS.contains(&name.as_str())
                    };
                if let Some(existing) = model.columns.iter_mut().find(|c| c.catalog["id"] == id) {
                    existing.iscc = Some(name);
                    existing.catalog["source"] = json!("merged");
                } else {
                    model.columns.push(GridColumn {
                        id: id.clone(), kind,
                        catalog: json!({"id":id,"label":id,"group":group,"source":if effective_view == GridView::All && mapping.iscc_to_mid.values().any(|s| s == mapped_name) {"merged"} else if source == "MID" {"mid"} else {"iscc"},"type":kind,"default_visible":visible}),
                        mid: (source == "MID").then(|| name.clone()), iscc: (source == "ISCC").then_some(name), path: Vec::new(), description,
                    });
                }
            }
        }
        // Core identity also exists for legacy candidates without a wide source row.
        for (mid_name, iscc_name, path) in [
            ("Company", "Company Name", "name"),
            ("Website", "Company Website", "website"),
            ("Crescendo ID", "CID", "cid"),
            ("ECID", "ECI", "ecid"),
        ] {
            let id = if effective_view == GridView::Iscc {
                iscc_name
            } else {
                mid_name
            };
            model.derived(id, "identity", "text", &[path], true, false);
        }
        model.derived(
            "company_id",
            "identity",
            "text",
            &["company_id"],
            true,
            false,
        );
        let mid_scores = match view {
            GridView::Mid => Some(("MID Score", "MID Semantic Score")),
            GridView::Iscc => None,
            GridView::All if !has_iscc => Some(("MID Score", "MID Semantic Score")),
            GridView::All => Some(("MID_Keyword Score", "MID_Semantic Score")),
        };
        if let Some((keyword, semantic)) = mid_scores {
            model.derived(keyword, "scores", "score", &["mid_score"], true, false);
            model.derived(
                semantic,
                "scores",
                "score",
                &["mid_semantic_score"],
                true,
                false,
            );
        }
        let iscc_score = match view {
            GridView::Mid => None,
            GridView::Iscc => Some("ISCC Score"),
            GridView::All if has_iscc && !has_mid => Some("ISCC Score"),
            GridView::All => Some("ISCC_Score"),
        };
        if let Some(id) = iscc_score {
            model.derived(id, "scores", "score", &["iscc_relevancy"], true, false);
        }
        for (id, key) in [
            ("pb_name", "name"),
            ("pb_website", "website"),
            ("pb_description", "description"),
            ("pb_linkedin_url", "linkedin_url"),
            ("pb_hq_location", "hq_location"),
            ("pb_active_investors", "active_investors"),
            ("pb_universe", "universe"),
        ] {
            model.derived(
                id,
                "hydration",
                "text",
                &["pb", key],
                false,
                key == "description",
            );
        }
        model.derived("PBID", "hydration", "text", &["pbid"], false, false);
        for (id, path) in [
            ("pb_hydrated", "pb"),
            ("rogo_hydrated", "rogo"),
            ("bing_hydrated", "bing"),
        ] {
            model.derived(
                id,
                "hydration",
                "category",
                &["coverage", path],
                false,
                false,
            );
        }
        let mut statement = conn.prepare("SELECT DISTINCT j.key FROM candidates c JOIN company_enrichment e USING(company_id) JOIN json_each(e.rogo_json) j WHERE c.run_id=? ORDER BY j.key")?;
        for key in statement.query_map([run_id], |r| r.get::<_, String>(0))? {
            let key = key?;
            model.derived(
                &format!("rogo_{key}"),
                "hydration",
                "text",
                &["rogo", &key],
                false,
                key.to_lowercase().contains("description"),
            );
        }
        for id in ["source", "considered", "consideration_reason", "simulated"] {
            model.derived(id, "status", "category", &[id], id == "considered", false);
        }
        for round in rounds {
            for name in &round.output_columns {
                let score = round.score_columns.contains(name);
                model.derived(
                    &format!("{} {} {name}", round.key, round.provider_label),
                    "rounds",
                    if score { "score" } else { "text" },
                    &[
                        "rounds",
                        &round.key,
                        if score { "scores" } else { "values" },
                        name,
                    ],
                    score,
                    false,
                );
            }
            for name in &round.score_columns {
                model.derived(
                    &format!("{} {} {name}", round.key, round.provider_label),
                    "rounds",
                    "score",
                    &["rounds", &round.key, "scores", name],
                    true,
                    false,
                );
            }
        }
        Ok(model)
    }

    fn derived(
        &mut self,
        id: &str,
        group: &str,
        kind: &'static str,
        path: &[&str],
        visible: bool,
        description: bool,
    ) {
        if let Some(existing) = self.columns.iter_mut().find(|c| c.catalog["id"] == id) {
            // A workbook/ISCC column of the same name falls back to the stored identity.
            if existing.path.is_empty() {
                existing.path = path.iter().map(|s| (*s).to_owned()).collect();
            }
            return;
        }
        self.columns.push(GridColumn { id: id.to_owned(), kind, catalog: json!({"id":id,"label":id,"group":group,"source":"derived","type":kind,"default_visible":visible}), mid: None, iscc: None, path: path.iter().map(|s| (*s).to_owned()).collect(), description });
    }

    fn catalog(&self) -> Vec<Value> {
        self.columns.iter().map(|c| c.catalog.clone()).collect()
    }

    fn values(
        &self,
        mid: &Value,
        iscc: &Value,
        row: &Value,
        requested: Option<&HashSet<String>>,
    ) -> Value {
        let mut values = Map::new();
        for column in &self.columns {
            let id = &column.id;
            if requested.map_or(column.description, |ids| !ids.contains(id)) {
                continue;
            }
            let value = column
                .mid
                .as_ref()
                .and_then(|key| mid.get(key))
                .filter(|v| usable(v))
                .or_else(|| {
                    column
                        .iscc
                        .as_ref()
                        .and_then(|key| iscc.get(key))
                        .filter(|v| usable(v))
                })
                .or_else(|| {
                    if column.path.is_empty() {
                        None
                    } else {
                        column.path.iter().try_fold(row, |v, key| v.get(key))
                    }
                })
                .unwrap_or(&Value::Null);
            values.insert(id.to_owned(), typed_value(value, column.kind));
        }
        Value::Object(values)
    }
}

fn usable(value: &Value) -> bool {
    !value.is_null()
        && !value
            .as_str()
            .is_some_and(|s| s.trim().is_empty() || s.trim() == "-")
}

fn typed_value(value: &Value, kind: &str) -> Value {
    if !usable(value) {
        return Value::Null;
    }
    if !matches!(kind, "number" | "date") && matches!(value, Value::Number(_) | Value::String(_)) {
        return value.clone();
    }
    let text = value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string());
    if kind == "number" {
        let clean = text.trim().replace(',', "");
        if let Ok(number) = clean.parse::<f64>() {
            if number.is_finite() {
                return json!(number);
            }
        }
    }
    if kind == "date" {
        if let Ok(date) = DateTime::parse_from_rfc3339(text.trim()) {
            return json!(date.to_rfc3339());
        }
        for format in [
            "%Y-%m-%d",
            "%Y-%m-%d %H:%M:%S",
            "%m/%d/%Y",
            "%m/%d/%y",
            "%Y/%m/%d",
            "%d-%b-%Y",
        ] {
            if let Ok(date) = NaiveDate::parse_from_str(text.trim(), format) {
                return json!(date.format("%Y-%m-%d").to_string());
            }
        }
        if let Ok(serial) = text.parse::<f64>() {
            if serial.is_finite() && (1.0..=2_958_465.0).contains(&serial) {
                if let Some(date) = NaiveDate::from_ymd_opt(1899, 12, 30)
                    .and_then(|d| d.checked_add_signed(Duration::days(serial as i64)))
                {
                    return json!(date.format("%Y-%m-%d").to_string());
                }
            }
        }
    }
    match value {
        Value::Number(_) | Value::String(_) => value.clone(),
        _ => json!(text),
    }
}

/// `get_grid_descriptions`: only the visible companies, with source headings left to the UI.
pub fn grid_descriptions(store: &Store, arguments: &Value) -> Result<Value> {
    let args: DescriptionArgs = parse(arguments)?;
    if args.company_ids.len() > 500 {
        return Err(Error::Validation(
            "company_ids must contain at most 500 ids".into(),
        ));
    }
    for id in &args.company_ids {
        bounded("company_id", id, 160)?;
    }
    let config = MidIndexConfig::load()?;
    store.with_connection(|conn| {
        require_run(conn, &args.run_id)?;
        let mut statement = conn.prepare("SELECT company_id FROM candidates WHERE run_id=?1 AND company_id IN (SELECT value FROM json_each(?2))")?;
        let members: HashSet<String> = statement.query_map(params![args.run_id, serde_json::to_string(&args.company_ids)?], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
        let records = source_records(conn, &args.run_id, &args.company_ids)?;
        let rows: Vec<Value> = args.company_ids.iter().filter(|id| members.contains(*id)).map(|id| {
            let mut sources = Vec::new();
            for (source, columns) in [("MID", config.description_columns.iter().map(String::as_str).collect::<Vec<_>>()), ("ISCC", ISCC_DESCRIPTIONS.to_vec())] {
                if !records.contains_key(&(id.clone(), source.to_owned())) { continue; }
                let row = latest_source(&records, id, source);
                let items: Vec<Value> = columns.iter().filter_map(|label| {
                    row.get(*label).and_then(Value::as_str).filter(|text| !text.trim().is_empty() && text.trim() != "-").map(|text| json!({"label":label,"text":text}))
                }).collect();
                sources.push(json!({"source":source,"items":items}));
            }
            json!({"company_id":id,"sources":sources})
        }).collect();
        Ok(json!({"run_id":args.run_id,"companies":rows}))
    })
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
    // Larger requests (older callers ask for 2000) are clamped; pages shrink further by size.
    let limit = args.limit.unwrap_or(DEFAULT_GRID_LIMIT).min(MAX_GRID_LIMIT);
    if limit == 0 {
        return Err(Error::Validation("limit must be at least 1".into()));
    }
    if let Some(cursor) = &args.after_company_id {
        bounded("after_company_id", cursor, 160)?;
    }
    store.with_connection(|conn| grid_page(conn, &args, limit))
}

/// One grid page. Rows are built as JSON objects so later phases can add keys (keywords,
/// semantic score, per-round scores) without changing the paging or the SQL shape here.
fn grid_page(conn: &Connection, args: &GridArgs, limit: usize) -> Result<Value> {
    let run_id = &args.run_id;
    let include_hidden = args.include_hidden;
    let after_company_id = args.after_company_id.as_deref();
    let include_company_payload = args.include_company_payload;
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
        aliases AS (
            SELECT company_id AS current_id,company_id AS alias_id FROM page
            UNION
            SELECT p.company_id,ci.identifier FROM page p
            JOIN company_identifiers ci ON ci.company_id=p.company_id AND ci.kind='PK'
        ),
        src AS (
            SELECT a.current_id AS company_id,
                   MAX(s.source='MID') AS has_mid,
                   MAX(s.source='ISCC' AND s.run_scope=?1) AS has_iscc,
                   MAX(CASE WHEN s.source='ISCC' AND s.run_scope=?1 THEN s.relevance_score END) AS iscc_relevance
            FROM aliases a JOIN source_rows s ON s.company_id=a.alias_id
            GROUP BY a.current_id
        ),
        disc AS (
            SELECT a.current_id AS company_id,
                   MAX(CASE WHEN d.discovery_source='MID' THEN d.retrieval_score END) AS mid_score,
                   MAX(CASE WHEN d.discovery_source='ISCC' THEN d.retrieval_score END) AS iscc_score,
                   MAX(d.discovery_source='MID') AS found_mid,
                   MAX(d.discovery_source='ISCC') AS found_iscc,
                   COUNT(*) AS discoveries
            FROM aliases a JOIN candidate_discovery d ON d.company_id=a.alias_id
            WHERE d.run_id=?1 GROUP BY a.current_id
        ),
        simulated AS (
            SELECT a.current_id FROM aliases a
            JOIN source_rows s ON s.company_id=a.alias_id
            WHERE s.run_scope=?1 AND s.simulated=1
            UNION
            SELECT a.current_id FROM aliases a
            JOIN evidence ev ON ev.company_id=a.alias_id
            WHERE ev.run_id=?1 AND ev.simulated=1
            UNION
            SELECT a.current_id FROM aliases a
            JOIN model_assessments ma ON ma.company_id=a.alias_id
            WHERE ma.run_id=?1 AND ma.simulated=1
        )
        SELECT p.company_id,p.considered,p.consideration_reason,
               c.name,c.website,c.city,json_extract(c.metadata_json,'$.hq_state'),c.description,
               (SELECT identifier FROM company_identifiers WHERE company_id=p.company_id AND kind='PBID'),
               e.pb_website,e.pb_name,e.pb_description,e.pb_linkedin_url,e.pb_hq_location,e.pb_active_investors,e.pb_universe,
               COALESCE(e.rogo_json,'{}')!='{}',
               EXISTS(SELECT 1 FROM evidence b WHERE b.run_id=?1 AND b.company_id=p.company_id AND b.claim='bing_research_observation' AND b.source_type='bing'),
               COALESCE(src.has_mid,0),COALESCE(src.has_iscc,0),src.iscc_relevance,
               disc.mid_score,disc.iscc_score,COALESCE(disc.found_mid,0),COALESCE(disc.found_iscc,0),COALESCE(disc.discoveries,0),
               (SELECT json_group_array(json_object('kind',kind,'value',identifier)) FROM company_identifiers WHERE company_id=p.company_id),
               c.keywords_json,COALESCE(e.rogo_json,'{}'),(e.company_id IS NOT NULL),
               sim.current_id IS NOT NULL
        FROM page p
        JOIN companies c ON c.company_id=p.company_id
        LEFT JOIN company_enrichment e ON e.company_id=p.company_id
        LEFT JOIN src ON src.company_id=p.company_id
        LEFT JOIN disc ON disc.company_id=p.company_id
        LEFT JOIN simulated sim ON sim.current_id=p.company_id
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
        identifiers_json: String,
        keywords_json: String,
        rogo_json: String,
        has_enrichment: bool,
        simulated: bool,
    }
    let mut fetched = statement
        .query_map(
            params![run_id, include_hidden, after_company_id, fetch],
            |r| {
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
                    identifiers_json: r.get(26)?,
                    keywords_json: r.get(27)?,
                    rogo_json: r.get(28)?,
                    has_enrichment: r.get::<_, i64>(29)? != 0,
                    simulated: r.get::<_, i64>(30)? != 0,
                })
            },
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(statement);
    let has_more = fetched.len() > limit;
    fetched.truncate(limit);
    let ids: Vec<String> = fetched.iter().map(|row| row.company_id.clone()).collect();
    let source_rows = source_records(conn, run_id, &ids)?;

    let keywords = page_keyword_data(conn, run_id, include_hidden, after_company_id, limit)?;
    let semantic = page_semantic_data(conn, run_id, include_hidden, after_company_id, limit)?;
    let rounds = rounds_for_run(conn, run_id)?;
    let assessments = page_assessments(
        conn,
        run_id,
        include_hidden,
        after_company_id,
        limit,
        &rounds,
    )?;
    let (has_mid_keyword, has_semantic, has_iscc) = run_has_columns(conn, run_id)?;
    let model = ColumnModel::load(conn, run_id, args.view, &rounds)?;
    let requested = args
        .columns
        .as_ref()
        .map(|ids| ids.iter().cloned().collect::<HashSet<_>>());
    if let Some(ids) = &requested {
        for id in ids {
            if !model
                .columns
                .iter()
                .any(|column| column.catalog["id"] == *id)
            {
                return Err(Error::Validation(format!("unknown grid column: {id}")));
            }
        }
    }

    let identity = IdentitySources::default();
    let mut rows = Vec::with_capacity(fetched.len());
    for row in fetched {
        let company_id = row.company_id.clone();
        let merged = |source: &str| {
            let records = source_rows
                .get(&(company_id.clone(), source.to_owned()))
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            if records.len() <= 1 {
                Cow::Borrowed(records.first().unwrap_or(&Value::Null))
            } else {
                Cow::Owned(Value::Object(merge_usable_fields(records)))
            }
        };
        let (mid, iscc) = (merged("MID"), merged("ISCC"));
        let company_payload = if include_company_payload {
            let mid_source_row = latest_source(&source_rows, &company_id, "MID");
            let mut identifiers =
                serde_json::from_str::<Value>(&row.identifiers_json).unwrap_or_else(|_| json!([]));
            if let Some(identifiers) = identifiers.as_array_mut() {
                identifiers.sort_by(|left, right| {
                    left["kind"]
                        .as_str()
                        .unwrap_or_default()
                        .cmp(right["kind"].as_str().unwrap_or_default())
                        .then_with(|| {
                            left["value"]
                                .as_str()
                                .unwrap_or_default()
                                .cmp(right["value"].as_str().unwrap_or_default())
                        })
                });
            }
            let company_keywords =
                serde_json::from_str::<Value>(&row.keywords_json).unwrap_or_else(|_| json!([]));
            let rogo = serde_json::from_str::<Value>(&row.rogo_json).unwrap_or_else(|_| json!({}));
            // The raw canonical values, exactly as `get_company` returns them (the grid's own
            // name/website prefer PitchBook and its description is a labelled projection).
            Some(json!({
                "name": row.name.clone(),
                "website": row.website.clone(),
                "description": row.description.clone(),
                "identifiers": identifiers,
                "keywords": company_keywords,
                "rogo": rogo,
                "has_enrichment": row.has_enrichment,
                "mid_source_row": mid_source_row,
            }))
        } else {
            None
        };
        let mid_keyword = keywords.get(&company_id).cloned().unwrap_or(Value::Null);
        let mid_semantic_score = semantic
            .get(&company_id)
            .copied()
            .filter(|score| score.is_finite())
            .map(|score| (score * 10.0).round() / 10.0)
            .map_or(Value::Null, |score| json!(score));
        let iscc_relevancy = row
            .iscc_relevance
            .or(row.iscc_score)
            .filter(|score| score.is_finite())
            .map(|score| (score * 100.0).round() / 100.0);
        let company_rounds = assessments
            .get(&company_id)
            .cloned()
            .unwrap_or_else(|| json!({}));
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
        let source = match (
            row.has_mid
                || row.found_mid
                || !latest_source(&source_rows, &company_id, "MID").is_null(),
            row.has_iscc || row.found_iscc,
        ) {
            (true, true) => json!("both"),
            (true, false) => json!("MID"),
            (false, true) => json!("ISCC"),
            _ => Value::Null,
        };
        let preferred = |pb: &Option<String>| pb.clone().filter(|value| !value.trim().is_empty());
        let identifier_values: Value = serde_json::from_str(&row.identifiers_json)?;
        let identifier = |kind: &str| {
            identifier_values
                .as_array()
                .into_iter()
                .flatten()
                .find(|id| id["kind"] == kind)
                .map(|id| id["value"].clone())
                .unwrap_or(Value::Null)
        };
        let keyword_score = mid_keyword["best_match_pct"]
            .as_f64()
            .map(|score| score / 100.0)
            .or(row.mid_score);
        let mut output = json!({
            "company_id": company_id,
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
            "mid_score": keyword_score,
            "iscc_score": row.iscc_score.or(row.iscc_relevance),
            "mid_keyword": mid_keyword,
            "mid_semantic_score": mid_semantic_score,
            "iscc_relevancy": iscc_relevancy,
            "simulated": row.simulated,
            "rounds": company_rounds,
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
        });
        output["cid"] = identifier("CID");
        output["ecid"] = identifier("ECID");
        output["rogo"] = serde_json::from_str(&row.rogo_json)?;
        output["values"] = model.values(
            latest_source(&source_rows, &company_id, "MID"),
            latest_source(&source_rows, &company_id, "ISCC"),
            &output,
            requested.as_ref(),
        );
        let fields = output.as_object_mut().expect("grid row");
        for key in ["cid", "ecid", "rogo"] {
            fields.remove(key);
        }
        if !model.has_mid {
            if let Some(values) = output["values"].as_object_mut() {
                for key in ["MID_Keyword Score", "MID_Semantic Score"] {
                    if let Some(value) = values.get_mut(key) {
                        *value = Value::Null;
                    }
                }
            }
        }
        if !model.has_iscc {
            if let Some(value) = output["values"].get_mut("ISCC_Score") {
                *value = Value::Null;
            }
        }
        if let Some(payload) = company_payload {
            output["company_payload"] = payload;
        }
        rows.push(output);
    }
    let mut page = json!({
        "run_id": run_id,
        "selection_revision": fingerprint["selection_revision"],
        "criteria_revision": fingerprint["criteria_revision"],
        "source_hash": source_hash,
        "include_hidden": include_hidden,
        "total": total,
        "considered_count": considered_count,
        "hidden_count": total - considered_count,
        "next_cursor": null,
        "columns": model.catalog(),
        "rounds": rounds.iter().map(|round| json!({
            "key": round.key,
            "round_no": round.round_no,
            "provider": round.provider,
            "provider_label": round.provider_label,
            "score_columns": round.score_columns,
            "output_columns": round.output_columns,
        })).collect::<Vec<_>>(),
        "has_mid_keyword": has_mid_keyword,
        "has_semantic": has_semantic,
        "has_iscc": has_iscc,
        "rows": [],
    });
    // Size the already-fetched page without rerunning any query. Always allow one row so
    // even an unusually large company advances the keyset cursor (subject to the hard cap).
    let mut bytes = serde_json::to_vec(&page)?.len() + 162;
    let mut keep = 0;
    for row in &rows {
        let size = serde_json::to_vec(row)?.len() + 1;
        if keep > 0 && bytes + size > SOFT_PAGE_BYTES {
            break;
        }
        bytes += size;
        keep += 1;
    }
    if has_more || keep < rows.len() {
        page["next_cursor"] = rows
            .get(keep.saturating_sub(1))
            .map(|row| row["company_id"].clone())
            .unwrap_or(Value::Null);
    }
    rows.truncate(keep);
    page["rows"] = Value::Array(rows);
    if bytes > HARD_PAGE_BYTES {
        return Err(Error::Validation(
            "a single screening grid row exceeds the 8 MB hard cap".into(),
        ));
    }
    Ok(page)
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
        let mid_keyword = company_keyword_data(conn, &args.run_id, &company_id)?;
        let mid_semantic = semantic_detail(conn, &args.run_id, &company_id)?;
        let iscc = company_iscc_data(conn, &args.run_id, &company_id)?;
        let rounds = rounds_for_run(conn, &args.run_id)?;
        let company_rounds = company_rounds(conn, &args.run_id, &company_id, &rounds)?;
        let simulated = simulated_for_company(conn, &args.run_id, &company_id)?;
        let model = ColumnModel::load(conn, &args.run_id, args.view, &rounds)?;
        let records = source_records(conn, &args.run_id, std::slice::from_ref(&company_id))?;
        let identifier = |kind: &str| identifiers.iter().find(|id| id["kind"] == kind)
            .map(|id| id["identifier"].clone()).unwrap_or(Value::Null);
        let legacy_mid_score: Option<f64> = conn.query_row(
            "SELECT MAX(retrieval_score) FROM candidate_discovery WHERE run_id=?1 AND discovery_source='MID' AND (company_id=?2 OR company_id IN (SELECT identifier FROM company_identifiers WHERE company_id=?2 AND kind='PK'))",
            params![args.run_id,company_id], |r| r.get(0))?;
        let has_bing: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM evidence WHERE run_id=?1 AND company_id=?2 AND source_type='bing' AND claim='bing_research_observation')",params![args.run_id,company_id],|r|r.get(0))?;
        let pb = &row["sources"]["PB"];
        let derived = json!({
            "company_id":company_id,"name":company["name"],"website":company["website"],
            "cid":identifier("CID"),"ecid":identifier("ECID"),"pbid":row["PBId"],
            "considered":considered!=0,"consideration_reason":reason,"simulated":simulated,
            "source":match (!latest_source(&records,&company_id,"MID").is_null(), !latest_source(&records,&company_id,"ISCC").is_null()) {(true,true)=>Some("both"),(true,false)=>Some("MID"),(false,true)=>Some("ISCC"),_=>None},
            "mid_score":if model.has_mid {mid_keyword["best_match_pct"].as_f64().map(|s|s/100.0).or(legacy_mid_score)} else {None},
            "mid_semantic_score":if model.has_mid {mid_semantic["score"].as_f64().map(|s|(s*10.0).round()/10.0)} else {None},
            "iscc_relevancy":if model.has_iscc {iscc["relevancy"].clone()} else {Value::Null},
            "rounds":company_rounds,"rogo":row["sources"]["ROGO"],
            "pb":{"name":pb["PB_Name"],"website":pb["PB_Website"],"description":pb["PB_Description"],"linkedin_url":pb["PB_LinkedIn URL"],"hq_location":pb["PB_HQ Location"],"active_investors":pb["PB_Active Investors"],"universe":pb["PB_Universe"]},
            "coverage":{"pb":usable(&pb["PB_Name"])||usable(&pb["PB_Description"]),"rogo":row["sources"]["ROGO"].as_object().is_some_and(|o|!o.is_empty()),"bing":has_bing},
        });
        let requested = model.columns.iter().map(|column| column.catalog["id"].as_str().expect("column id").to_owned()).collect();
        let values = model.values(latest_source(&records,&company_id,"MID"),latest_source(&records,&company_id,"ISCC"),&derived,Some(&requested));

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
            "mid_keyword": mid_keyword,
            "mid_semantic": mid_semantic,
            "iscc": iscc,
            "rounds": company_rounds,
            "simulated": simulated,
            "activity": activity(conn, &args.run_id, &company_id)?,
            "columns": model.catalog(),
            "values": values,
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
            (Some(score), Some(rank)) => {
                summary.push_str(&format!(" (score {score:.2}, rank {rank})"))
            }
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
                    clip(
                        value["question"].as_str().unwrap_or("research question"),
                        120
                    ),
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
