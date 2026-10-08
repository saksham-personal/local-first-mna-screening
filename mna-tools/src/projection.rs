//! Run-scoped source projections. Read these inside the prepared-plan transaction.
use crate::{
    data::candidate_source_page,
    error::{Error, Result},
    identity::get_field,
    store::Store,
};
use rusqlite::{Connection, OptionalExtension};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const DEFAULT_INPUT_COLUMNS: [&str; 7] = [
    "index",
    "pk",
    "PBId",
    "Company Name",
    "Website",
    "Description",
    "LinkedIn URL",
];
const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceColumn {
    pub source: String,
    pub column: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct IdentitySources {
    pub name: Vec<String>,
    pub website: Vec<String>,
    pub description: Vec<String>,
}
impl Default for IdentitySources {
    fn default() -> Self {
        let all = vec!["PB".into(), "MID".into(), "ISCC".into()];
        Self {
            name: all.clone(),
            website: all.clone(),
            description: all,
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ProjectionArgs {
    run_id: String,
    #[serde(default)]
    company_ids: Vec<String>,
    #[serde(default)]
    selected_source_columns: Vec<SourceColumn>,
    #[serde(default)]
    identity_sources: IdentitySources,
    #[serde(default)]
    input_columns: Vec<String>,
}

pub fn input_schema(tool: &str) -> Option<Value> {
    matches!(
        tool,
        "get_run_source_projection" | "get_source_field_catalog"
    )
    .then(|| {
        serde_json::to_value(schemars::schema_for!(ProjectionArgs)).expect("projection schema")
    })
}

pub fn execute(store: &Store, tool: &str, arguments: &Value) -> Result<Value> {
    let args: ProjectionArgs =
        serde_json::from_value(arguments.clone()).map_err(|e| Error::Validation(e.to_string()))?;
    store.with_connection(|conn| {
        let tx = conn.transaction()?;
        let value = snapshot_selected(&tx, &args.run_id, &args.company_ids, &args.selected_source_columns, &args.identity_sources, &args.input_columns)?;
        tx.commit()?;
        if tool == "get_source_field_catalog" {
            Ok(json!({"run_id":args.run_id,"catalog":value["catalog"],"candidate_hash":value["candidate_hash"],"data_hash":value["data_hash"],"profile_version":value["profile_version"],"executed":false}))
        } else if tool == "get_run_source_projection" {
            Ok(value)
        } else {
            Err(Error::Validation("unknown projection tool".into()))
        }
    })
}

pub fn digest(value: &Value) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

fn usable(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(s) => !matches!(
            s.trim().to_ascii_uppercase().as_str(),
            "" | "-" | "--" | "NA" | "N/A" | "#N/A" | "NULL" | "NONE" | "NAN"
        ),
        _ => true,
    }
}

fn text_field(source: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        get_field(source, &[*key])
            .filter(|v| usable(v))
            .and_then(|v| match v {
                Value::String(s) => Some(s.trim().to_owned()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
    })
}

pub const PB_DESCRIPTION_LABEL: &str = "PitchBook Latest Description";
pub const MID_DESCRIPTION_LABEL: &str = "MID Description";
pub const ISCC_DESCRIPTION_LABEL: &str = "ISCC Description";
pub const LEGACY_DESCRIPTION_LABEL: &str = "Legacy stored description (source row unavailable)";

/// Labeled descriptions in the projection's preferred order (PitchBook, MID, ISCC), limited to
/// the sources the analyst selected. Also reports whether none of the three source objects
/// carries any usable value (a legacy company whose canonical row has no stored source rows).
pub fn description_lines(
    pb: &Value,
    mid: &Value,
    iscc: &Value,
    identity: &IdentitySources,
) -> (Vec<(&'static str, String)>, bool) {
    description_lines_with_columns(pb, mid, iscc, identity, &["Description", "Business Description", "Company Description"])
}

fn description_lines_with_columns(
    pb: &Value,
    mid: &Value,
    iscc: &Value,
    identity: &IdentitySources,
    mid_columns: &[&str],
) -> (Vec<(&'static str, String)>, bool) {
    fn joined(source: &Value, columns: &[&str]) -> Option<String> {
        let values = columns.iter().filter_map(|column| text_field(source, &[*column])).collect::<Vec<_>>();
        (!values.is_empty()).then(|| values.join("; "))
    }
    let mut lines = Vec::new();
    if identity.description.iter().any(|s| s == "PB") {
        if let Some(text) = text_field(pb, &["PB_Description", "Description"]) {
            lines.push((PB_DESCRIPTION_LABEL, text));
        }
    }
    if identity.description.iter().any(|s| s == "MID") {
        if let Some(text) = joined(mid, mid_columns) {
            lines.push((MID_DESCRIPTION_LABEL, text));
        }
    }
    if identity.description.iter().any(|s| s == "ISCC") {
        let text = joined(iscc, &["Company Description", "Pitchbook Description", "Factset Description",
            "Demandbase Description", "Dealogic Description", "Offerings", "Pitchbook Keywords", "NAICS Description"])
            .or_else(|| text_field(iscc, &["Description", "Business Description"]));
        if let Some(text) = text {
            if !lines.iter().any(|(label, existing)| *label == MID_DESCRIPTION_LABEL && existing.trim().to_lowercase() == text.trim().to_lowercase()) {
                lines.push((ISCC_DESCRIPTION_LABEL, text));
            }
        }
    }
    let legacy = [pb, mid, iscc]
        .iter()
        .all(|s| s.as_object().is_none_or(|m| !m.values().any(usable)));
    (lines, legacy)
}

/// Append the canonical stored description when no source row exists for a legacy company.
pub fn legacy_description(
    lines: &mut Vec<(&'static str, String)>,
    canonical: Option<&str>,
    identity: &IdentitySources,
) {
    if identity.description.is_empty() {
        return;
    }
    if let Some(text) = canonical.filter(|s| !s.trim().is_empty()) {
        lines.push((LEGACY_DESCRIPTION_LABEL, text.to_owned()));
    }
}

/// The single projected `Description` string: one `label: text` line per source.
pub fn join_descriptions(lines: &[(&'static str, String)]) -> String {
    lines
        .iter()
        .map(|(label, text)| format!("{label}: {text}"))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn valid_pb_linkedin(value: &str) -> bool {
    url::Url::parse(value).ok().is_some_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
            && url.host_str().is_some_and(|host| {
                host.eq_ignore_ascii_case("linkedin.com")
                    || host.to_ascii_lowercase().ends_with(".linkedin.com")
            })
            && url.path().starts_with("/company/")
            && url.path().trim_end_matches('/').len() > "/company/".len()
    })
}

/// Atomic when `connection` is a transaction. Complete candidate membership and
/// all source content are hashed even if the analyst selects a smaller scope.
pub fn snapshot(
    connection: &Connection,
    run_id: &str,
    company_ids: &[String],
    selected: &[SourceColumn],
) -> Result<Value> {
    snapshot_selected(
        connection,
        run_id,
        company_ids,
        selected,
        &IdentitySources::default(),
        &[],
    )
}

pub fn snapshot_selected(
    connection: &Connection,
    run_id: &str,
    company_ids: &[String],
    selected: &[SourceColumn],
    identity: &IdentitySources,
    requested_inputs: &[String],
) -> Result<Value> {
    for choices in [&identity.name, &identity.website, &identity.description] {
        if choices.iter().collect::<BTreeSet<_>>().len() != choices.len()
            || choices
                .iter()
                .any(|s| !["PB", "MID", "ISCC"].contains(&s.as_str()))
        {
            return Err(Error::Validation(
                "identity sources must be unique selections from PB, MID and ISCC".into(),
            ));
        }
    }
    if run_id.trim().is_empty() || run_id.len() > 160 || run_id != run_id.trim() {
        return Err(Error::Validation(
            "run_id must be nonblank, trimmed, and at most 160 bytes".into(),
        ));
    }
    if company_ids.len() > 100_000 || selected.len() > 200 {
        return Err(Error::Validation(
            "projection scope exceeds supported limit".into(),
        ));
    }
    let profile: Option<i64> = connection
        .query_row(
            "SELECT version FROM screening_profiles WHERE run_id=? AND status='APPROVED'",
            [run_id],
            |r| r.get(0),
        )
        .optional()?;
    let mut candidate_stmt = connection.prepare(
        "SELECT company_id,status,updated_at,considered,consideration_reason FROM candidates WHERE run_id=? ORDER BY company_id",
    )?;
    let candidates: Vec<Value> = candidate_stmt.query_map([run_id], |r| Ok(json!({"pk":r.get::<_,String>(0)?,"status":r.get::<_,String>(1)?,"updated_at":r.get::<_,String>(2)?,"considered":r.get::<_,i64>(3)?!=0,"consideration_reason":r.get::<_,Option<String>>(4)?})))?.collect::<std::result::Result<_,_>>()?;
    let membership: BTreeSet<_> = candidates
        .iter()
        .filter(|r| r["considered"] == true)
        .filter_map(|r| r["pk"].as_str().map(str::to_owned))
        .collect();
    let requested: BTreeSet<_> = company_ids.iter().cloned().collect();
    if requested.len() != company_ids.len() || requested.iter().any(|id| !membership.contains(id)) {
        return Err(Error::Validation(
            "company scope contains duplicates or companies outside this run".into(),
        ));
    }
    let mut raw = Vec::new();
    let mut cursor: Option<String> = None;
    let mut bytes = 0;
    loop {
        let page = candidate_source_page(connection, run_id, cursor.as_deref(), 100, false, false)?;
        for row in page["rows"]
            .as_array()
            .ok_or_else(|| Error::Internal("source page rows missing".into()))?
        {
            bytes += serde_json::to_vec(row)?.len();
            if bytes > MAX_SNAPSHOT_BYTES {
                return Err(Error::Validation("full run source snapshot exceeds 64 MB; no companies were dropped, this run requires a streaming projection reader".into()));
            }
            raw.push(row.clone());
        }
        match page["next_cursor"].as_str() {
            Some(next) if cursor.as_deref() != Some(next) => cursor = Some(next.to_owned()),
            None => break,
            _ => {
                return Err(Error::Internal(
                    "source reader cursor did not advance".into(),
                ))
            }
        }
    }
    if raw.len() != candidates.len() {
        return Err(Error::Conflict(
            "candidate scope changed during snapshot".into(),
        ));
    }
    let mut canonical = Vec::new();
    for row in &raw {
        let record: Value = connection.query_row("SELECT name,website,description,metadata_json,updated_at FROM companies WHERE company_id=?", [row["pk"].as_str().expect("source pk")], |r| Ok(json!({"pk":row["pk"],"name":r.get::<_,String>(0)?,"website":r.get::<_,Option<String>>(1)?,"description":r.get::<_,Option<String>>(2)?,"metadata":r.get::<_,String>(3)?,"updated_at":r.get::<_,String>(4)?})))?;
        canonical.push(record);
    }
    let review_columns = crate::review::review_columns(connection, run_id)?;
    let mut catalog = Vec::new();
    for source in ["MID", "ISCC", "PB", "ROGO", "RESULTS", "BING"] {
        let mut columns = BTreeMap::<String, (usize, Value)>::new();
        // Analyst-selected result schemas remain usable after all companies
        // with values are hidden. Remaining rows deliberately project nulls.
        if source == "RESULTS" {
            for (plan, selected) in &review_columns {
                for column in selected {
                    columns.insert(format!("{plan}:{column}"), (0, Value::Null));
                }
            }
        }
        let mut source_count = 0;
        for row in raw
            .iter()
            .filter(|r| membership.contains(r["pk"].as_str().unwrap_or_default()))
        {
            if let Some(fields) = row["sources"][source].as_object() {
                if fields.values().any(usable) {
                    source_count += 1;
                }
                for (name, value) in fields {
                    let entry = columns.entry(name.clone()).or_insert((0, Value::Null));
                    if usable(value) {
                        entry.0 += 1;
                        if entry.1.is_null() {
                            entry.1 = value.clone();
                        }
                    }
                }
            }
        }
        catalog.push(json!({"source":source,"available":source_count>0,"company_count":source_count,"total":membership.len(),"columns":columns.into_iter().map(|(name,(present,sample))| json!({"name":name,"present":present,"missing":membership.len()-present,"sample":sample})).collect::<Vec<_>>()}));
    }
    let mut source_fields = Vec::new();
    let mut seen = BTreeSet::new();
    let mut selected_columns = selected.to_vec();
    if catalog.iter().any(|entry| {
        entry["source"] == "BING"
            && entry["columns"]
                .as_array()
                .is_some_and(|cols| cols.iter().any(|col| col["name"] == "Research"))
    }) && !selected_columns
        .iter()
        .any(|field| field.source.eq_ignore_ascii_case("BING") && field.column == "Research")
    {
        selected_columns.push(SourceColumn {
            source: "BING".into(),
            column: "Research".into(),
        });
    }
    for (plan, columns) in review_columns {
        for column in columns {
            let field = SourceColumn {
                source: "RESULTS".into(),
                column: format!("{plan}:{column}"),
            };
            if !selected_columns
                .iter()
                .any(|s| s.source.eq_ignore_ascii_case("RESULTS") && s.column == field.column)
            {
                selected_columns.push(field);
            }
        }
    }
    for field in &selected_columns {
        let source = field.source.to_ascii_uppercase();
        if !["MID", "ISCC", "PB", "ROGO", "RESULTS", "BING"].contains(&source.as_str())
            || field.column.is_empty()
            || field.column.len() > 200
        {
            return Err(Error::Validation(
                "select a valid MID, ISCC, PB, ROGO, RESULTS, or BING source column".into(),
            ));
        }
        let catalog_source = catalog
            .iter()
            .find(|s| s["source"] == source)
            .expect("catalog source");
        if !catalog_source["columns"]
            .as_array()
            .expect("catalog columns")
            .iter()
            .any(|c| c["name"] == field.column)
        {
            return Err(Error::Validation(format!(
                "source column {source}.{} is unavailable; upload and rehydrate first",
                field.column
            )));
        }
        let alias = format!("{source}:{}", field.column);
        if !seen.insert(alias.clone()) {
            return Err(Error::Validation("duplicate selected source column".into()));
        }
        source_fields.push((source, field.column.clone(), alias));
    }
    let mut input_columns: Vec<String> = DEFAULT_INPUT_COLUMNS
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    input_columns.extend(source_fields.iter().map(|(_, _, alias)| alias.clone()));
    let active_config: Option<String> = connection.query_row(
        "SELECT config_json FROM mid_bundles WHERE status='active'", [], |r| r.get(0),
    ).optional()?;
    let mid_columns: Vec<String> = if let Some(raw_config) = active_config {
        serde_json::from_str::<crate::mid_config::MidIndexConfig>(&raw_config)?.description_columns
    } else {
        vec!["Description".into(), "Business Description".into(), "Company Description".into()]
    };
    let mid_column_refs = mid_columns.iter().map(String::as_str).collect::<Vec<_>>();
    let mut rows = Vec::new();
    let mut selected_hashes = Vec::new();
    let mut pb_linkedin_count = 0;
    for row in &raw {
        let pk = row["pk"]
            .as_str()
            .ok_or_else(|| Error::Internal("source row pk missing".into()))?;
        if !membership.contains(pk) || (!requested.is_empty() && !requested.contains(pk)) {
            continue;
        }
        let pb = &row["sources"]["PB"];
        let mid = &row["sources"]["MID"];
        let iscc = &row["sources"]["ISCC"];
        let choose = |sources: &[String], fields: &[&str]| {
            ["PB", "MID", "ISCC"]
                .iter()
                .filter(|s| sources.iter().any(|choice| choice == **s))
                .find_map(|s| text_field(&row["sources"][*s], fields))
        };
        let mut name = choose(
            &identity.name,
            &[
                "PB_Name",
                "Companies",
                "Company Name",
                "Name",
                "Company",
                "Firm Name",
            ],
        );
        let mut website = choose(
            &identity.website,
            &["PB_Website", "Website", "Websites", "Company Website"],
        );
        let (mut descriptions, legacy_sources) = description_lines_with_columns(pb, mid, iscc, identity, &mid_column_refs);
        let linkedin =
            text_field(pb, &["PB_LinkedIn URL", "LinkedIn URL"]).filter(|v| valid_pb_linkedin(v));
        if linkedin.is_some() {
            pb_linkedin_count += 1;
        }
        let pb_hydrated = pb.as_object().is_some_and(|v| v.values().any(usable));
        let legacy = legacy_sources;
        if legacy {
            let record = canonical
                .iter()
                .find(|r| r["pk"] == pk)
                .expect("canonical row");
            if !identity.name.is_empty() {
                name = record["name"].as_str().map(str::to_owned);
            }
            if !identity.website.is_empty() {
                website = record["website"].as_str().map(str::to_owned);
            }
            legacy_description(&mut descriptions, record["description"].as_str(), identity);
        }
        let mut projected = json!({"index":rows.len()+1,"pk":pk,"PBId":if pb_hydrated {row["PBId"].clone()} else {Value::Null},"Company Name":name,"Website":website,"Description":join_descriptions(&descriptions),"LinkedIn URL":linkedin});
        for (source, column, alias) in &source_fields {
            projected[alias] = row["sources"][source][column].clone();
        }
        selected_hashes.push(json!({"pk":pk,"row_hash":digest(row)?,"sources":row["provenance"],"legacy_fallback":legacy}));
        rows.push(projected);
    }
    if !requested_inputs.is_empty() {
        if requested_inputs.first().is_none_or(|s| s != "index")
            || requested_inputs.iter().collect::<BTreeSet<_>>().len() != requested_inputs.len()
            || requested_inputs.iter().any(|s| !input_columns.contains(s))
        {
            return Err(Error::Validation("input_columns must begin with index and contain unique available projected columns".into()));
        }
        input_columns = requested_inputs.to_vec();
        for row in &mut rows {
            row.as_object_mut()
                .expect("projected row")
                .retain(|key, _| key == "pk" || input_columns.contains(key));
        }
    }
    let mut coverage = Map::new();
    for column in &input_columns {
        let present = rows.iter().filter(|r| usable(&r[column])).count();
        coverage.insert(
            column.clone(),
            json!({"present":present,"missing":rows.len()-present,"total":rows.len()}),
        );
    }
    let config = crate::retrieval::RetrievalConfig::from_env()?.status();
    let retrieval_configuration = json!({"embedder":config["embedder"]["identity"],"reranker":config["reranker"],"retrieval_limit":1000,"rerank_limit":500,"embedding_endpoint_hash":digest(&json!(std::env::var("MNA_EMBED_ENDPOINT").unwrap_or_default()))?,"rerank_endpoint_hash":digest(&json!(std::env::var("MNA_RERANK_ENDPOINT").unwrap_or_default()))?});
    Ok(
        json!({"run_id":run_id,"profile_version":profile.unwrap_or(0),"candidate_hash":digest(&json!({"candidates":candidates,"review":crate::review::selection_fingerprint(connection,run_id)?}))?,"data_hash":digest(&json!({"source_rows":raw,"canonical":canonical}))?,"input_hash":digest(&json!({"columns":input_columns,"rows":rows,"retrieval":retrieval_configuration}))?,"input_columns":input_columns,"rows":rows,"coverage":coverage,"selected_row_hashes":selected_hashes,"pb_linkedin_count":pb_linkedin_count,"catalog":catalog,"retrieval_configuration":retrieval_configuration,"executed":false,"implementation_status":"implemented"}),
    )
}
