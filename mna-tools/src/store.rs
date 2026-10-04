use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{Error, Result};

const MIGRATION: &str = include_str!("../migrations/001_init.sql");
const SOURCE_MIGRATION: &str = include_str!("../migrations/002_sources.sql");
const WORKFLOW_MIGRATION: &str = include_str!("../migrations/003_workflow.sql");
const EXECUTION_MIGRATION: &str = include_str!("../migrations/004_execution.sql");
const TRUST_MIGRATION: &str = include_str!("../migrations/005_trust.sql");
const RETRIEVAL_RECOVERY_MIGRATION: &str = include_str!("../migrations/006_retrieval_recovery.sql");
const MAX_TEXT: usize = 100_000;
const MAX_LIST: usize = 1_000;

#[derive(Clone)]
pub struct Store {
    connection: Arc<Mutex<Connection>>,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let mut connection = Connection::open(path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "busy_timeout", 5_000)?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version > 6 {
            return Err(Error::Conflict(
                "Database schema is newer than this service supports".into(),
            ));
        }
        let transaction = connection.transaction()?;
        transaction.execute_batch(MIGRATION)?;
        transaction.execute_batch(SOURCE_MIGRATION)?;
        transaction.execute_batch(WORKFLOW_MIGRATION)?;
        transaction.execute_batch(EXECUTION_MIGRATION)?;
        // Early v4/v5 prototypes used second timestamps and had no consumption
        // column. Preserve their attempts conservatively; CREATE IF NOT EXISTS
        // cannot upgrade an existing table.
        let has_consumed:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('llmsuite_slots') WHERE name='consumed_epoch')",[],|r|r.get(0))?;
        if !has_consumed {
            transaction.execute_batch("ALTER TABLE llmsuite_slots ADD COLUMN consumed_epoch INTEGER; UPDATE llmsuite_slots SET window_epoch=CASE WHEN window_epoch<1000000000000 THEN window_epoch*1000 ELSE window_epoch END; UPDATE llmsuite_slots SET consumed_epoch=window_epoch;")?;
        }
        let old_index_fk:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_list('execution_index_map') WHERE \"table\"='companies')",[],|r|r.get(0))?;
        if old_index_fk {
            transaction.execute_batch("CREATE TABLE execution_index_map_v6(plan_id TEXT NOT NULL REFERENCES prepared_plans(plan_id),row_index INTEGER NOT NULL,company_id TEXT NOT NULL,job_id TEXT NOT NULL REFERENCES execution_jobs(job_id),row_hash TEXT NOT NULL,PRIMARY KEY(plan_id,row_index),UNIQUE(plan_id,company_id)); INSERT INTO execution_index_map_v6 SELECT * FROM execution_index_map; DROP TABLE execution_index_map; ALTER TABLE execution_index_map_v6 RENAME TO execution_index_map;")?;
        }
        let old_assessment_fk:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_list('model_assessments') WHERE \"table\"='companies')",[],|r|r.get(0))?;
        if old_assessment_fk {
            transaction.execute_batch("CREATE TABLE model_assessments_v6(assessment_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES screening_runs(run_id),plan_id TEXT NOT NULL REFERENCES prepared_plans(plan_id),job_id TEXT NOT NULL REFERENCES execution_jobs(job_id),company_id TEXT NOT NULL,row_index INTEGER NOT NULL,provider TEXT NOT NULL,prompt TEXT NOT NULL,result_json TEXT NOT NULL CHECK(json_valid(result_json)),created_at TEXT NOT NULL,UNIQUE(plan_id,row_index)); INSERT INTO model_assessments_v6 SELECT * FROM model_assessments; DROP TABLE model_assessments; ALTER TABLE model_assessments_v6 RENAME TO model_assessments;")?;
        }
        transaction.execute_batch(TRUST_MIGRATION)?;
        transaction.execute_batch(RETRIEVAL_RECOVERY_MIGRATION)?;
        transaction.commit()?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    fn conn(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| Error::Internal("database lock poisoned".into()))
    }

    pub fn with_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T>,
    ) -> Result<T> {
        let mut connection = self.conn()?;
        operation(&mut connection)
    }

    pub fn resolve_company_id(&self, supplied: &str) -> Result<String> {
        bounded("company identifier", supplied, 160)?;
        let conn = self.conn()?;
        if let Some(id) = conn
            .query_row(
                "SELECT company_id FROM companies WHERE company_id=?",
                [supplied],
                |row| row.get(0),
            )
            .optional()?
        {
            return Ok(id);
        }
        let (kind, raw_identifier) = supplied
            .split_once(':')
            .filter(|(kind, _)| {
                ["ECID", "CID", "PBID", "PK"].contains(&kind.to_ascii_uppercase().as_str())
            })
            .map(|(kind, value)| (kind.to_ascii_uppercase(), value.trim().to_owned()))
            .unwrap_or_else(|| ("PK".to_owned(), supplied.trim().to_owned()));
        let identifier = crate::identity::normalized_identifier(Some(&json!(raw_identifier)))
            .ok_or_else(|| {
                Error::NotFound(format!("Invalid or missing company identifier: {supplied}"))
            })?;
        conn.query_row(
            "SELECT company_id FROM company_identifiers WHERE kind=? AND identifier=?",
            params![kind, identifier],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| Error::NotFound(format!("company not found: {supplied}")))
    }

    pub fn normalize_company_references(&self, arguments: &Value) -> Value {
        fn visit(store: &Store, value: &mut Value) {
            match value {
                Value::Object(map) => {
                    for (key, child) in map {
                        if key == "company_id" {
                            if let Some(id) = child.as_str() {
                                if let Ok(resolved) = store.resolve_company_id(id) {
                                    *child = json!(resolved);
                                }
                            }
                        } else if [
                            "company_ids",
                            "subject_ids",
                            "positive_company_ids",
                            "negative_company_ids",
                            "supporting_example_ids",
                        ]
                        .contains(&key.as_str())
                        {
                            if let Some(ids) = child.as_array_mut() {
                                for id in ids {
                                    if let Some(text) = id.as_str() {
                                        if let Ok(resolved) = store.resolve_company_id(text) {
                                            *id = json!(resolved);
                                        }
                                    }
                                }
                            }
                        } else {
                            visit(store, child);
                        }
                    }
                }
                Value::Array(items) => {
                    for child in items {
                        visit(store, child)
                    }
                }
                _ => {}
            }
        }
        let mut result = arguments.clone();
        visit(self, &mut result);
        result
    }

    pub fn get_search_query(&self, query_id: &str) -> Result<Value> {
        bounded("query_id", query_id, 160)?;
        self.conn()?.query_row(
            "SELECT query_id,run_id,source,query,parameters_json,results_json,created_at FROM search_queries WHERE query_id=?",
            [query_id],
            |row| Ok(json!({"query_id":row.get::<_,String>(0)?,"run_id":row.get::<_,Option<String>>(1)?,"source":row.get::<_,String>(2)?,"query":row.get::<_,String>(3)?,"parameters":decode(row.get(4)?)?,"results":decode(row.get(5)?)?,"created_at":row.get::<_,String>(6)?})),
        ).optional()?.ok_or_else(|| Error::NotFound(format!("query not found: {query_id}")))
    }

    pub fn execute(&self, tool: &str, arguments: &Value) -> Result<Value> {
        if !arguments.is_object() {
            return Err(Error::Validation("tool arguments must be an object".into()));
        }
        if serde_json::to_vec(arguments)?.len() > 1_000_000 {
            return Err(Error::Validation("arguments exceed 1 MB".into()));
        }
        for key in [
            "run_id",
            "company_id",
            "question_id",
            "query_id",
            "namespace",
        ] {
            if let Some(value) = arguments.get(key).and_then(Value::as_str) {
                bounded(key, value, 160)?;
            }
        }
        let normalized = self.normalize_company_references(arguments);
        let arguments = &normalized;
        match tool {
            "ingest_companies" => self.ingest_companies(parse(tool, arguments)?),
            "create_run" => self.create_run(parse(tool, arguments)?),
            "get_company" => self.get_company(parse(tool, arguments)?),
            "get_original_criteria" => self.get_original_criteria(parse(tool, arguments)?),
            "get_active_screening_profile" => self.get_active_profile(parse(tool, arguments)?),
            "get_screening_profile_version" => self.get_profile_version(parse(tool, arguments)?),
            "compare_profile_versions" => self.compare_profiles(parse(tool, arguments)?),
            "propose_screening_profile" => self.propose_profile(parse(tool, arguments)?),
            "approve_screening_profile" => self.approve_profile(parse(tool, arguments)?),
            "get_labelled_examples" => self.get_labels(parse(tool, arguments)?),
            "get_representative_examples" => self.get_representative(parse(tool, arguments)?),
            "label_company" => self.label_company(parse(tool, arguments)?),
            "get_evidence" => self.get_evidence(parse(tool, arguments)?),
            "save_evidence" => self.save_evidence(parse(tool, arguments)?),
            "get_missing_evidence" => self.get_missing_evidence(parse(tool, arguments)?),
            "search_research_memory" => self.search_memory(parse(tool, arguments)?),
            "get_previous_research" => self.get_previous_research(parse(tool, arguments)?),
            "get_recent_agent_events" => self.get_events(parse(tool, arguments)?),
            "get_search_history" => self.get_search_history(parse(tool, arguments)?),
            "get_open_questions" => self.get_questions(parse(tool, arguments)?),
            "add_open_question" => self.add_question(parse(tool, arguments)?),
            "resolve_open_question" => self.resolve_question(parse(tool, arguments)?),
            "add_candidates" => self.add_candidates(parse(tool, arguments)?),
            "update_candidate_status" => self.update_candidate(parse(tool, arguments)?),
            "get_candidate_set" => self.get_candidates(parse(tool, arguments)?),
            "get_run_context" => self.get_run_context(parse(tool, arguments)?),
            "save_checkpoint" => self.save_checkpoint(parse(tool, arguments)?),
            "get_checkpoint" => self.get_checkpoint(parse(tool, arguments)?),
            _ => Err(Error::Validation(format!("unknown state tool: {tool}"))),
        }
    }

    pub fn all_companies(&self) -> Result<Vec<Value>> {
        let conn = self.conn()?;
        let mut statement = conn.prepare("SELECT company_id,name,website,linkedin_url,industry,sub_industry,country,city,description,revenue,employees,ownership,services_json,products_json,keywords_json,embedding_json,metadata_json,created_at,updated_at FROM companies ORDER BY company_id")?;
        let values = statement
            .query_map([], company_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(values)
    }

    pub fn visit_companies(
        &self,
        include_embedding: bool,
        mut visitor: impl FnMut(Value) -> Result<()>,
    ) -> Result<()> {
        let conn = self.conn()?;
        let embedding = if include_embedding {
            "embedding_json"
        } else {
            "NULL"
        };
        let sql=format!("SELECT company_id,name,website,linkedin_url,industry,sub_industry,country,city,description,revenue,employees,ownership,services_json,products_json,keywords_json,{embedding},metadata_json,created_at,updated_at FROM companies ORDER BY company_id");
        let mut statement = conn.prepare(&sql)?;
        for company in statement.query_map([], company_row)? {
            visitor(company?)?;
        }
        Ok(())
    }

    pub fn company_page_after(&self, after_id: Option<&str>, limit: usize) -> Result<Vec<Value>> {
        if !(1..=5000).contains(&limit) {
            return Err(Error::Validation(
                "Company page limit must be 1..=5000".into(),
            ));
        }
        let conn = self.conn()?;
        let mut statement=conn.prepare("SELECT company_id,name,website,linkedin_url,industry,sub_industry,country,city,description,revenue,employees,ownership,services_json,products_json,keywords_json,embedding_json,metadata_json,created_at,updated_at FROM companies WHERE (? IS NULL OR company_id>?) ORDER BY company_id LIMIT ?")?;
        let rows = statement
            .query_map(params![after_id, after_id, limit as i64], company_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Stream model-specific vectors; stale text or incompatible models never
    /// enter semantic scoring. The heap in SearchEngine retains only top K.
    pub fn visit_embedding_companies(
        &self,
        identity: &crate::retrieval::ModelIdentity,
        mut visitor: impl FnMut(Value) -> Result<()>,
    ) -> Result<()> {
        let conn = self.conn()?;
        let mut stmt=conn.prepare("SELECT c.company_id,c.name,c.website,c.linkedin_url,c.industry,c.sub_industry,c.country,c.city,c.description,c.revenue,c.employees,c.ownership,c.services_json,c.products_json,c.keywords_json,NULL,c.metadata_json,c.created_at,c.updated_at,e.dimensions,e.text_hash,e.vector_blob FROM companies c LEFT JOIN embedding_vectors e ON e.company_id=c.company_id AND e.model=? AND e.model_version=? ORDER BY c.company_id")?;
        let mut rows = stmt.query(params![identity.model, identity.version])?;
        while let Some(row) = rows.next()? {
            let mut company = company_row(row)?;
            let dimensions: Option<usize> = row.get(19)?;
            let text_hash: Option<String> = row.get(20)?;
            let blob: Option<Vec<u8>> = row.get(21)?;
            if dimensions == Some(identity.dimensions)
                && text_hash.as_deref()
                    == Some(&crate::retrieval::text_hash(
                        &crate::retrieval::document_text(&company),
                    ))
            {
                if let Some(blob) = blob.filter(|b| b.len() == identity.dimensions * 4) {
                    let vector: Vec<f32> = blob
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                        .collect();
                    if crate::retrieval::validate_vector(&vector, identity).is_ok() {
                        company["embedding"] = json!(vector);
                    }
                }
            }
            visitor(company)?;
        }
        Ok(())
    }

    pub fn save_model_embeddings(
        &self,
        identity: &crate::retrieval::ModelIdentity,
        entries: &[(String, String, Vec<f32>)],
    ) -> Result<usize> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let mut saved = 0;
        for (company_id, expected_hash, vector) in entries {
            crate::retrieval::validate_vector(vector, identity)?;
            let description: Option<String> = tx
                .query_row(
                    "SELECT description FROM companies WHERE company_id=?",
                    [company_id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            if crate::retrieval::text_hash(description.as_deref().unwrap_or_default().trim())
                != *expected_hash
            {
                continue;
            }
            let blob: Vec<u8> = vector.iter().flat_map(|v| v.to_le_bytes()).collect();
            tx.execute("INSERT INTO embedding_vectors(company_id,model,model_version,dimensions,text_hash,vector_blob,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(company_id,model,model_version) DO UPDATE SET dimensions=excluded.dimensions,text_hash=excluded.text_hash,vector_blob=excluded.vector_blob,created_at=excluded.created_at",params![company_id,identity.model,identity.version,identity.dimensions as i64,expected_hash,blob,now()])?;
            saved += 1;
        }
        tx.commit()?;
        Ok(saved)
    }

    pub fn model_embedding(
        &self,
        identity: &crate::retrieval::ModelIdentity,
        company_id: &str,
    ) -> Result<Option<Vec<f32>>> {
        let conn = self.conn()?;
        let row:Option<(Option<String>,usize,String,Vec<u8>)>=conn.query_row("SELECT c.description,e.dimensions,e.text_hash,e.vector_blob FROM companies c JOIN embedding_vectors e ON c.company_id=e.company_id WHERE c.company_id=? AND e.model=? AND e.model_version=?",params![company_id,identity.model,identity.version],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let Some((description, dimensions, text_hash, blob)) = row else {
            return Ok(None);
        };
        if dimensions != identity.dimensions
            || blob.len() != dimensions * 4
            || text_hash
                != crate::retrieval::text_hash(description.as_deref().unwrap_or_default().trim())
        {
            return Ok(None);
        }
        let vector: Vec<f32> = blob
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        Ok(crate::retrieval::validate_vector(&vector, identity)
            .is_ok()
            .then_some(vector))
    }

    pub fn stored_embedding_dimensions(&self) -> Result<Vec<usize>> {
        let conn = self.conn()?;
        let mut statement=conn.prepare("SELECT DISTINCT json_array_length(embedding_json) FROM companies WHERE embedding_json IS NOT NULL")?;
        let rows = statement
            .query_map([], |row| row.get::<_, usize>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn record_search(
        &self,
        run_id: Option<&str>,
        source: &str,
        query: &str,
        parameters: &Value,
        results: &Value,
    ) -> Result<Value> {
        bounded("source", source, 128)?;
        if query.len() > 20_000 {
            return Err(Error::Validation("query exceeds 20000 bytes".into()));
        }
        if let Some(run_id) = run_id {
            self.require_run(run_id)?;
        }
        let query_id = id("QRY");
        let created_at = now();
        self.conn()?.execute(
            "INSERT INTO search_queries(query_id,run_id,source,query,normalized_query,parameters_json,results_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
            params![query_id, run_id, source, query, normalize(query), encode(parameters)?, encode(results)?, created_at],
        )?;
        Ok(
            json!({"query_id":query_id,"run_id":run_id,"source":source,"query":query,"parameters":parameters,"results":results,"created_at":created_at}),
        )
    }

    pub fn audit(&self, tool: &str, arguments: &Value, status: &str, result: &Value) -> Result<()> {
        bounded("tool", tool, 128)?;
        let redacted = redact(arguments.clone());
        self.conn()?.execute(
            "INSERT INTO tool_runs(tool_run_id,tool,arguments_json,status,result_json,created_at) VALUES(?,?,?,?,?,?)",
            params![id("TOOL"), tool, encode(&redacted)?, status, encode(result)?, now()],
        )?;
        Ok(())
    }

    pub fn record_document(&self, run_id: Option<&str>, result: &Value) -> Result<Value> {
        if let Some(run_id) = run_id {
            self.require_run(run_id)?;
        }
        let document_id = id("DOC");
        self.conn()?.execute("INSERT INTO source_documents(document_id,run_id,source_url,artifact_ref,content_hash,metadata_json,retrieved_at) VALUES(?,?,?,?,?,?,?)", params![document_id,run_id,result["url"].as_str(),result["artifact_ref"].as_str(),result.get("sha256").or_else(||result.get("content_sha256")).and_then(Value::as_str),encode(result)?,now()])?;
        Ok(json!({"document_id":document_id}))
    }

    pub fn index_hashes(&self, index_key: &str) -> Result<BTreeMap<String, String>> {
        let conn = self.conn()?;
        let mut statement = conn.prepare(
            "SELECT company_id,content_hash FROM meilisearch_sync_state WHERE index_key=?",
        )?;
        let rows = statement
            .query_map([index_key], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<BTreeMap<_, _>, _>>()?;
        Ok(rows)
    }
    pub fn mark_indexed(&self, index_key: &str, records: &[(String, String)]) -> Result<()> {
        let mut conn = self.conn()?;
        let transaction = conn.transaction()?;
        for (company_id, content_hash) in records {
            transaction.execute("INSERT INTO meilisearch_sync_state(index_key,company_id,content_hash,updated_at) VALUES(?,?,?,?) ON CONFLICT(index_key,company_id) DO UPDATE SET content_hash=excluded.content_hash,updated_at=excluded.updated_at", params![index_key,company_id,content_hash,now()])?;
        }
        transaction.commit()?;
        Ok(())
    }

    fn require_run(&self, run_id: &str) -> Result<()> {
        let exists = self
            .conn()?
            .query_row(
                "SELECT 1 FROM screening_runs WHERE run_id=?",
                [run_id],
                |_| Ok(()),
            )
            .optional()?;
        exists.ok_or_else(|| Error::NotFound(format!("run not found: {run_id}")))
    }

    fn require_company(&self, company_id: &str) -> Result<()> {
        let exists = self
            .conn()?
            .query_row(
                "SELECT 1 FROM companies WHERE company_id=?",
                [company_id],
                |_| Ok(()),
            )
            .optional()?;
        exists.ok_or_else(|| Error::NotFound(format!("company not found: {company_id}")))
    }

    fn event(
        tx: &Transaction<'_>,
        run_id: Option<&str>,
        event_type: &str,
        payload: &Value,
        major: bool,
    ) -> Result<()> {
        tx.execute("INSERT INTO agent_events(event_id,run_id,event_type,payload_json,major,created_at) VALUES(?,?,?,?,?,?)", params![id("EVT"),run_id,event_type,encode(payload)?,major as i32,now()])?;
        Ok(())
    }
}

fn parse<T: DeserializeOwned>(tool: &str, value: &Value) -> Result<T> {
    serde_json::from_value(value.clone())
        .map_err(|error| Error::Validation(format!("invalid {tool} arguments: {error}")))
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn id(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::new_v4())
}
fn encode(value: &Value) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}
fn decode(value: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}
fn bounded(field: &str, value: &str, limit: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > limit {
        return Err(Error::Validation(format!(
            "{field} must contain 1..={limit} bytes"
        )));
    }
    Ok(())
}
fn limit(value: Option<usize>, default: usize, max: usize) -> Result<usize> {
    let value = value.unwrap_or(default);
    if value == 0 || value > max {
        return Err(Error::Validation(format!("limit must be within 1..={max}")));
    }
    Ok(value)
}
fn normalize(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn redact(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        for (key, child) in object.iter_mut() {
            if [
                "api_key",
                "authorization",
                "token",
                "secret",
                "password",
                "analyst_key",
            ]
            .contains(&key.to_ascii_lowercase().as_str())
            {
                *child = Value::String("[REDACTED]".into());
            } else {
                *child = redact(child.take());
            }
        }
    } else if let Some(array) = value.as_array_mut() {
        for child in array {
            *child = redact(child.take());
        }
    }
    value
}

fn company_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "company_id":row.get::<_,String>(0)?, "name":row.get::<_,String>(1)?,
        "website":row.get::<_,Option<String>>(2)?, "linkedin_url":row.get::<_,Option<String>>(3)?,
        "industry":row.get::<_,Option<String>>(4)?, "sub_industry":row.get::<_,Option<String>>(5)?,
        "country":row.get::<_,Option<String>>(6)?, "city":row.get::<_,Option<String>>(7)?,
        "description":row.get::<_,Option<String>>(8)?, "revenue":row.get::<_,Option<f64>>(9)?,
        "employees":row.get::<_,Option<i64>>(10)?, "ownership":row.get::<_,Option<String>>(11)?,
        "services":decode(row.get(12)?)?, "products":decode(row.get(13)?)?, "keywords":decode(row.get(14)?)?,
        "embedding":row.get::<_,Option<String>>(15)?.map(decode).transpose()?, "metadata":decode(row.get(16)?)?,
        "created_at":row.get::<_,String>(17)?, "updated_at":row.get::<_,String>(18)?
    }))
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct IngestArgs {
    companies: Vec<CompanyInput>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CompanyInput {
    company_id: String,
    name: String,
    #[serde(default)]
    website: Option<String>,
    #[serde(default)]
    linkedin_url: Option<String>,
    #[serde(default)]
    industry: Option<String>,
    #[serde(default)]
    sub_industry: Option<String>,
    #[serde(default)]
    country: Option<String>,
    #[serde(default)]
    city: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    revenue: Option<f64>,
    #[serde(default)]
    employees: Option<i64>,
    #[serde(default)]
    ownership: Option<String>,
    #[serde(default)]
    services: Vec<String>,
    #[serde(default)]
    products: Vec<String>,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default)]
    embedding: Option<Vec<f32>>,
    #[serde(default)]
    metadata: Value,
}

impl Store {
    fn ingest_companies(&self, args: IngestArgs) -> Result<Value> {
        if args.companies.is_empty() || args.companies.len() > MAX_LIST {
            return Err(Error::Validation(format!(
                "companies must contain 1..={MAX_LIST} records"
            )));
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let timestamp = now();
        for company in &args.companies {
            bounded("company_id", &company.company_id, 128)?;
            bounded("name", &company.name, 500)?;
            for (field, value) in [
                ("description", &company.description),
                ("website", &company.website),
                ("linkedin_url", &company.linkedin_url),
                ("industry", &company.industry),
                ("sub_industry", &company.sub_industry),
                ("country", &company.country),
                ("city", &company.city),
                ("ownership", &company.ownership),
            ] {
                if let Some(value) = value {
                    if value.len() > MAX_TEXT {
                        return Err(Error::Validation(format!(
                            "{field} exceeds {MAX_TEXT} bytes"
                        )));
                    }
                }
            }
            if let Some(vector) = &company.embedding {
                if vector.is_empty()
                    || vector.len() > 4096
                    || vector.iter().any(|v| !v.is_finite())
                    || !vector.iter().any(|v| *v != 0.0)
                {
                    return Err(Error::Validation(
                        "embedding must contain 1..=4096 finite values with nonzero magnitude"
                            .into(),
                    ));
                }
            }
            if company
                .services
                .len()
                .max(company.products.len())
                .max(company.keywords.len())
                > MAX_LIST
            {
                return Err(Error::Validation(
                    "company list fields exceed 1000 entries".into(),
                ));
            }
            if company.revenue.is_some_and(|v| !v.is_finite() || v < 0.0)
                || company.employees.is_some_and(|v| v < 0)
            {
                return Err(Error::Validation(
                    "revenue and employees must be non-negative".into(),
                ));
            }
            let metadata = if company.metadata.is_null() {
                json!({})
            } else if company.metadata.is_object() {
                company.metadata.clone()
            } else {
                return Err(Error::Validation("metadata must be an object".into()));
            };
            tx.execute("INSERT INTO companies(company_id,name,website,linkedin_url,industry,sub_industry,country,city,description,revenue,employees,ownership,services_json,products_json,keywords_json,embedding_json,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id) DO UPDATE SET name=excluded.name,website=excluded.website,linkedin_url=excluded.linkedin_url,industry=excluded.industry,sub_industry=excluded.sub_industry,country=excluded.country,city=excluded.city,description=excluded.description,revenue=excluded.revenue,employees=excluded.employees,ownership=excluded.ownership,services_json=excluded.services_json,products_json=excluded.products_json,keywords_json=excluded.keywords_json,embedding_json=excluded.embedding_json,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at",
                params![company.company_id,company.name,company.website,company.linkedin_url,company.industry,company.sub_industry,company.country,company.city,company.description,company.revenue,company.employees,company.ownership,serde_json::to_string(&company.services)?,serde_json::to_string(&company.products)?,serde_json::to_string(&company.keywords)?,company.embedding.as_ref().map(serde_json::to_string).transpose()?,encode(&metadata)?,timestamp,timestamp])?;
        }
        tx.commit()?;
        Ok(json!({"ingested":args.companies.len(),"updated_at":timestamp}))
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CreateRunArgs {
    #[serde(default)]
    run_id: Option<String>,
    objective: String,
    original_criteria: Value,
    #[serde(default)]
    initial_profile: Option<Value>,
    #[serde(default)]
    status: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RunArgs {
    run_id: String,
    #[serde(default)]
    detail_level: Option<String>,
}

impl Store {
    fn create_run(&self, args: CreateRunArgs) -> Result<Value> {
        bounded("objective", &args.objective, 20_000)?;
        if !args.original_criteria.is_object() {
            return Err(Error::Validation(
                "original_criteria must be an object".into(),
            ));
        }
        if encode(&args.original_criteria)?.len() > MAX_TEXT
            || args
                .initial_profile
                .as_ref()
                .is_some_and(|p| !p.is_object())
        {
            return Err(Error::Validation(
                "original criteria exceed size limit or initial_profile is not an object".into(),
            ));
        }
        let run_id = args.run_id.unwrap_or_else(|| id("RUN"));
        bounded("run_id", &run_id, 128)?;
        let status = args.status.unwrap_or_else(|| "DRAFT".into());
        bounded("status", &status, 64)?;
        let timestamp = now();
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        tx.execute("INSERT INTO screening_runs(run_id,objective,status,original_criteria_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",params![run_id,args.objective,status,encode(&args.original_criteria)?,timestamp,timestamp]).map_err(|e| match e { rusqlite::Error::SqliteFailure(ref err,_) if err.extended_code == 1555 => Error::Conflict(format!("run already exists: {run_id}")), _=>e.into() })?;
        let profile = args
            .initial_profile
            .unwrap_or_else(|| args.original_criteria.clone());
        tx.execute("INSERT INTO screening_profiles(profile_id,run_id,version,content_json,rationale,status,proposed_at) VALUES(?,?,?,?,?,'PROPOSED',?)",params![id("PROF"),run_id,1,encode(&profile)?,"Initial interpretation awaits analyst approval",timestamp])?;
        Self::event(
            &tx,
            Some(&run_id),
            "RUN_CREATED",
            &json!({"objective":args.objective}),
            true,
        )?;
        tx.commit()?;
        Ok(
            json!({"run_id":run_id,"objective":args.objective,"status":status,"active_criteria_version":1,"active_profile_version":0,"proposed_profile_version":1,"criteria_approval_required":true,"created_at":timestamp}),
        )
    }

    fn get_company(&self, args: GetCompanyArgs) -> Result<Value> {
        let conn = self.conn()?;
        let mut stmt=conn.prepare("SELECT company_id,name,website,linkedin_url,industry,sub_industry,country,city,description,revenue,employees,ownership,services_json,products_json,keywords_json,embedding_json,metadata_json,created_at,updated_at FROM companies WHERE company_id=?")?;
        let mut company = stmt
            .query_row([&args.company_id], company_row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("company not found: {}", args.company_id)))?;
        drop(stmt);
        let enrichment = conn.query_row("SELECT pb_website,pb_name,pb_description,pb_linkedin_url,pb_hq_location,pb_active_investors,pb_universe,rogo_json FROM company_enrichment WHERE company_id=?",[&args.company_id],|row|Ok(json!({"PB_Website":row.get::<_,Option<String>>(0)?,"PB_Name":row.get::<_,Option<String>>(1)?,"PB_Description":row.get::<_,Option<String>>(2)?,"PB_LinkedIn URL":row.get::<_,Option<String>>(3)?,"PB_HQ Location":row.get::<_,Option<String>>(4)?,"PB_Active Investors":row.get::<_,Option<String>>(5)?,"PB_Universe":row.get::<_,Option<String>>(6)?,"ROGO":decode(row.get(7)?)?}))).optional()?;
        if let Some(enrichment) = enrichment {
            company
                .as_object_mut()
                .expect("company object")
                .extend(enrichment.as_object().expect("enrichment object").clone());
        }
        let mut stmt = conn.prepare("SELECT kind,identifier FROM company_identifiers WHERE company_id=? ORDER BY kind,identifier")?;
        company["identifiers"] = json!(stmt
            .query_map([&args.company_id], |row| Ok(
                json!({"kind":row.get::<_,String>(0)?,"value":row.get::<_,String>(1)?})
            ))?
            .collect::<std::result::Result<Vec<_>, _>>()?);
        let mut stmt = conn.prepare(
            "SELECT DISTINCT source FROM source_rows WHERE company_id=? ORDER BY source",
        )?;
        company["sources"] = json!(stmt
            .query_map([&args.company_id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?);
        if let Some(state) = company["metadata"].get("hq_state").cloned() {
            company["hq_state"] = state;
        }
        Ok(company)
    }
    fn get_original_criteria(&self, args: RunOnly) -> Result<Value> {
        self.conn()?
            .query_row(
                "SELECT original_criteria_json FROM screening_runs WHERE run_id=?",
                [&args.run_id],
                |r| decode(r.get(0)?),
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("run not found: {}", args.run_id)))
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct GetCompanyArgs {
    company_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RunOnly {
    run_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ProfileVersionArgs {
    run_id: String,
    version: i64,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CompareProfileArgs {
    run_id: String,
    version_a: i64,
    version_b: i64,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ProposeProfileArgs {
    run_id: String,
    content: Value,
    #[serde(default)]
    rationale: Option<String>,
    #[serde(default)]
    supporting_example_ids: Vec<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ApproveProfileArgs {
    run_id: String,
    version: i64,
    #[serde(default)]
    approved_by: Option<String>,
}

fn profile_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"profile_id":row.get::<_,String>(0)?,"run_id":row.get::<_,String>(1)?,"version":row.get::<_,i64>(2)?,"content":decode(row.get(3)?)?,"rationale":row.get::<_,Option<String>>(4)?,"supporting_example_ids":decode(row.get(5)?)?,"status":row.get::<_,String>(6)?,"proposed_at":row.get::<_,String>(7)?,"approved_at":row.get::<_,Option<String>>(8)?,"approved_by":row.get::<_,Option<String>>(9)?}),
    )
}

impl Store {
    fn get_active_profile(&self, args: RunOnly) -> Result<Value> {
        self.require_run(&args.run_id)?;
        let conn = self.conn()?;
        let mut stmt=conn.prepare("SELECT profile_id,run_id,version,content_json,rationale,supporting_examples_json,status,proposed_at,approved_at,approved_by FROM screening_profiles WHERE run_id=? AND status='APPROVED' ORDER BY version DESC LIMIT 1")?;
        stmt.query_row([&args.run_id], profile_row)
            .optional()?
            .ok_or_else(|| {
                Error::NotFound(format!(
                    "approved profile not found for run: {}",
                    args.run_id
                ))
            })
    }
    fn get_profile_version(&self, args: ProfileVersionArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        if args.version < 1 {
            return Err(Error::Validation("version must be positive".into()));
        }
        let conn = self.conn()?;
        let mut stmt=conn.prepare("SELECT profile_id,run_id,version,content_json,rationale,supporting_examples_json,status,proposed_at,approved_at,approved_by FROM screening_profiles WHERE run_id=? AND version=?")?;
        stmt.query_row(params![args.run_id, args.version], profile_row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("profile version not found: {}", args.version)))
    }
    fn compare_profiles(&self, args: CompareProfileArgs) -> Result<Value> {
        let a = self.get_profile_version(ProfileVersionArgs {
            run_id: args.run_id.clone(),
            version: args.version_a,
        })?;
        let b = self.get_profile_version(ProfileVersionArgs {
            run_id: args.run_id.clone(),
            version: args.version_b,
        })?;
        let am = a["content"].as_object().cloned().unwrap_or_default();
        let bm = b["content"].as_object().cloned().unwrap_or_default();
        let added: Map<String, Value> = bm
            .iter()
            .filter(|(k, _)| !am.contains_key(*k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let removed: Map<String, Value> = am
            .iter()
            .filter(|(k, _)| !bm.contains_key(*k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let changed: Map<String, Value> = bm
            .iter()
            .filter_map(|(k, v)| {
                am.get(k)
                    .filter(|old| *old != v)
                    .map(|old| (k.clone(), json!({"from":old,"to":v})))
            })
            .collect();
        Ok(
            json!({"run_id":args.run_id,"version_a":args.version_a,"version_b":args.version_b,"added_preferences":added,"removed_preferences":removed,"changed_constraints":changed,"reason_for_changes":b["rationale"],"supporting_analyst_examples":b["supporting_example_ids"]}),
        )
    }
    fn propose_profile(&self, args: ProposeProfileArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        if !args.content.is_object() {
            return Err(Error::Validation("content must be an object".into()));
        }
        if args.supporting_example_ids.len() > MAX_LIST {
            return Err(Error::Validation("too many supporting examples".into()));
        }
        if encode(&args.content)?.len() > MAX_TEXT {
            return Err(Error::Validation(
                "profile content exceeds size limit".into(),
            ));
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        for company_id in &args.supporting_example_ids {
            let exists = tx
                .query_row(
                    "SELECT 1 FROM company_labels WHERE run_id=? AND company_id=?",
                    params![args.run_id, company_id],
                    |_| Ok(()),
                )
                .optional()?;
            if exists.is_none() {
                return Err(Error::Validation(format!(
                    "supporting example must be labelled in this run: {company_id}"
                )));
            }
        }
        let version: i64 = tx.query_row(
            "SELECT COALESCE(MAX(version),0)+1 FROM screening_profiles WHERE run_id=?",
            [&args.run_id],
            |r| r.get(0),
        )?;
        let timestamp = now();
        let profile_id = id("PROF");
        tx.execute("INSERT INTO screening_profiles(profile_id,run_id,version,content_json,rationale,supporting_examples_json,status,proposed_at) VALUES(?,?,?,?,?,?,'PROPOSED',?)",params![profile_id,args.run_id,version,encode(&args.content)?,args.rationale,serde_json::to_string(&args.supporting_example_ids)?,timestamp])?;
        Self::event(
            &tx,
            Some(&args.run_id),
            "SCREENING_PROFILE_PROPOSED",
            &json!({"version":version,"profile_id":profile_id}),
            true,
        )?;
        tx.commit()?;
        Ok(
            json!({"profile_id":profile_id,"run_id":args.run_id,"version":version,"content":args.content,"rationale":args.rationale,"supporting_example_ids":args.supporting_example_ids,"status":"PROPOSED","proposed_at":timestamp}),
        )
    }
    fn approve_profile(&self, args: ApproveProfileArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        let approved_by = args.approved_by.unwrap_or_else(|| "analyst".into());
        bounded("approved_by", &approved_by, 256)?;
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let status: Option<String> = tx
            .query_row(
                "SELECT status FROM screening_profiles WHERE run_id=? AND version=?",
                params![args.run_id, args.version],
                |r| r.get(0),
            )
            .optional()?;
        match status.as_deref() {
            None => {
                return Err(Error::NotFound(format!(
                    "profile version not found: {}",
                    args.version
                )))
            }
            Some("PROPOSED") => {}
            Some(other) => {
                return Err(Error::Conflict(format!(
                    "profile must be PROPOSED, is {other}"
                )))
            }
        }
        tx.execute("UPDATE screening_profiles SET status='SUPERSEDED' WHERE run_id=? AND status='APPROVED'",[&args.run_id])?;
        let timestamp = now();
        tx.execute("UPDATE screening_profiles SET status='APPROVED',approved_at=?,approved_by=? WHERE run_id=? AND version=?",params![timestamp,approved_by,args.run_id,args.version])?;
        tx.execute("UPDATE screening_runs SET status='ACTIVE',updated_at=? WHERE run_id=? AND status='DRAFT'",params![timestamp,args.run_id])?;
        Self::event(
            &tx,
            Some(&args.run_id),
            "SCREENING_PROFILE_APPROVED",
            &json!({"version":args.version,"approved_by":approved_by}),
            true,
        )?;
        tx.commit()?;
        drop(conn);
        self.get_profile_version(ProfileVersionArgs {
            run_id: args.run_id,
            version: args.version,
        })
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct LabelsArgs {
    run_id: String,
    #[serde(default)]
    labels: Option<Vec<String>>,
    #[serde(default)]
    company_id: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RepresentativeArgs {
    run_id: String,
    #[serde(default)]
    target_query: Option<String>,
    #[serde(default)]
    labels: Option<Vec<String>>,
    #[serde(default)]
    per_label: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct LabelCompanyArgs {
    run_id: String,
    company_id: String,
    label: String,
    #[serde(default)]
    analyst_note: Option<String>,
}

impl Store {
    fn get_labels(&self, args: LabelsArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        let cap = limit(args.limit, 50, 500)?;
        let wanted = args.labels.unwrap_or_default();
        for label in &wanted {
            valid_label(label)?;
        }
        let conn = self.conn()?;
        let mut stmt=conn.prepare("SELECT l.label_id,l.run_id,l.company_id,l.label,l.analyst_note,l.created_at,l.updated_at,c.name,c.description,c.industry,c.website FROM company_labels l JOIN companies c ON c.company_id=l.company_id WHERE l.run_id=? ORDER BY l.updated_at DESC")?;
        let rows=stmt.query_map([&args.run_id],|r|Ok(json!({"label_id":r.get::<_,String>(0)?,"run_id":r.get::<_,String>(1)?,"company_id":r.get::<_,String>(2)?,"label":r.get::<_,String>(3)?,"analyst_note":r.get::<_,Option<String>>(4)?,"created_at":r.get::<_,String>(5)?,"updated_at":r.get::<_,String>(6)?,"company":{"company_id":r.get::<_,String>(2)?,"name":r.get::<_,String>(7)?,"description":r.get::<_,Option<String>>(8)?,"industry":r.get::<_,Option<String>>(9)?,"website":r.get::<_,Option<String>>(10)?}})))?;
        let mut out = Vec::new();
        for row in rows {
            let row = row?;
            if args
                .company_id
                .as_ref()
                .is_some_and(|id| row["company_id"] != *id)
            {
                continue;
            }
            if !wanted.is_empty() && !wanted.iter().any(|l| row["label"] == *l) {
                continue;
            }
            out.push(row);
            if out.len() == cap {
                break;
            }
        }
        Ok(Value::Array(out))
    }
    fn get_representative(&self, args: RepresentativeArgs) -> Result<Value> {
        let per = limit(args.per_label, 3, 50)?;
        let total = limit(args.limit, per.saturating_mul(4).max(1), 200)?;
        let labels = args.labels.unwrap_or_else(|| {
            vec![
                "BEST_FIT".into(),
                "FIT".into(),
                "BORDERLINE".into(),
                "MISFIT".into(),
            ]
        });
        let mut rows = self
            .get_labels(LabelsArgs {
                run_id: args.run_id,
                labels: Some(labels.clone()),
                company_id: None,
                limit: Some(500),
            })?
            .as_array()
            .cloned()
            .unwrap_or_default();
        if let Some(query) = args.target_query {
            let terms: Vec<String> = normalize(&query)
                .split_whitespace()
                .map(str::to_owned)
                .collect();
            rows.sort_by_key(|r| {
                std::cmp::Reverse(
                    terms
                        .iter()
                        .filter(|t| r.to_string().to_lowercase().contains(t.as_str()))
                        .count(),
                )
            });
        }
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        let mut out = Vec::new();
        for row in rows {
            let label = row["label"].as_str().unwrap_or_default().to_owned();
            let count = counts.entry(label).or_default();
            if *count < per {
                out.push(row);
                *count += 1;
            }
            if out.len() == total {
                break;
            }
        }
        Ok(Value::Array(out))
    }
    fn label_company(&self, args: LabelCompanyArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        self.require_company(&args.company_id)?;
        valid_label(&args.label)?;
        if let Some(note) = &args.analyst_note {
            bounded("analyst_note", note, 20_000)?;
        }
        let timestamp = now();
        let label_id = id("LBL");
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        tx.execute("INSERT INTO company_labels(label_id,run_id,company_id,label,analyst_note,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,company_id) DO UPDATE SET label=excluded.label,analyst_note=excluded.analyst_note,updated_at=excluded.updated_at",params![label_id,args.run_id,args.company_id,args.label,args.analyst_note,timestamp,timestamp])?;
        let label_id: String = tx.query_row(
            "SELECT label_id FROM company_labels WHERE run_id=? AND company_id=?",
            params![args.run_id, args.company_id],
            |r| r.get(0),
        )?;
        Self::event(
            &tx,
            Some(&args.run_id),
            "COMPANY_LABELLED",
            &json!({"company_id":args.company_id,"label":args.label}),
            true,
        )?;
        tx.commit()?;
        Ok(
            json!({"label_id":label_id,"run_id":args.run_id,"company_id":args.company_id,"label":args.label,"analyst_note":args.analyst_note,"updated_at":timestamp}),
        )
    }
}
fn valid_label(value: &str) -> Result<()> {
    if ["BEST_FIT", "FIT", "BORDERLINE", "MISFIT"].contains(&value) {
        Ok(())
    } else {
        Err(Error::Validation(format!("invalid label: {value}")))
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct EvidenceArgs {
    run_id: String,
    company_id: String,
    #[serde(default)]
    claims: Option<Vec<String>>,
    #[serde(default)]
    source_types: Option<Vec<String>>,
    #[serde(default)]
    limit: Option<usize>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SaveEvidenceArgs {
    run_id: String,
    company_id: String,
    claim: String,
    value: Value,
    source_type: String,
    source_reference: String,
    #[serde(default)]
    source_url: Option<String>,
    #[serde(rename = "evidence_confidence", alias = "confidence")]
    confidence: String,
    #[serde(default)]
    extraction_method: Option<String>,
    #[serde(default)]
    claim_provenance: Value,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct MissingEvidenceArgs {
    run_id: String,
    company_id: String,
    #[serde(default)]
    required_attributes: Option<Vec<String>>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SearchMemoryArgs {
    run_id: String,
    query: String,
    #[serde(default)]
    company_id: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct PreviousResearchArgs {
    company_id: String,
    #[serde(default)]
    limit: Option<usize>,
}

fn evidence_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"evidence_id":row.get::<_,String>(0)?,"run_id":row.get::<_,String>(1)?,"company_id":row.get::<_,String>(2)?,"claim":row.get::<_,String>(3)?,"value":decode(row.get(4)?)?,"source_type":row.get::<_,String>(5)?,"source_reference":row.get::<_,String>(6)?,"source_url":row.get::<_,Option<String>>(7)?,"confidence":row.get::<_,String>(8)?,"extraction_method":row.get::<_,Option<String>>(9)?,"retrieved_at":row.get::<_,String>(10)?,"content_hash":row.get::<_,String>(11)?}),
    )
}

impl Store {
    fn get_evidence(&self, args: EvidenceArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        self.require_company(&args.company_id)?;
        let cap = limit(args.limit, 200, 1000)?;
        let claims = args.claims.unwrap_or_default();
        let sources = args.source_types.unwrap_or_default();
        let conn = self.conn()?;
        let mut stmt=conn.prepare("SELECT evidence_id,run_id,company_id,claim,value_json,source_type,source_reference,source_url,confidence,extraction_method,retrieved_at,content_hash FROM evidence WHERE run_id=? AND company_id=? ORDER BY retrieved_at DESC")?;
        let rows = stmt.query_map(params![args.run_id, args.company_id], evidence_row)?;
        let mut out = Vec::new();
        for row in rows {
            let mut row = row?;
            crate::trust::attach(&conn, &mut row)?;
            if !claims.is_empty() && !claims.iter().any(|v| row["claim"] == *v) {
                continue;
            }
            if !sources.is_empty() && !sources.iter().any(|v| row["source_type"] == *v) {
                continue;
            }
            out.push(row);
            if out.len() == cap {
                break;
            }
        }
        Ok(Value::Array(out))
    }
    fn save_evidence(&self, args: SaveEvidenceArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        self.require_company(&args.company_id)?;
        bounded("claim", &args.claim, 500)?;
        bounded("source_type", &args.source_type, 128)?;
        bounded("source_reference", &args.source_reference, 10_000)?;
        if !["low", "medium", "high"].contains(&args.confidence.as_str()) {
            return Err(Error::Validation(
                "confidence must be low, medium, or high".into(),
            ));
        }
        let encoded_value = encode(&args.value)?;
        if !args.claim_provenance.is_null() && !args.claim_provenance.is_object() {
            return Err(Error::Validation(
                "claim_provenance must be an object".into(),
            ));
        }
        if serde_json::to_vec(&args.claim_provenance)?.len() > 20_000 {
            return Err(Error::Validation("claim_provenance exceeds 20 KB".into()));
        }
        if encoded_value.len() > MAX_TEXT {
            return Err(Error::Validation("evidence value is too large".into()));
        }
        let mut hash = Sha256::new();
        hash.update(args.claim.as_bytes());
        hash.update(encoded_value.as_bytes());
        hash.update(args.source_reference.as_bytes());
        let content_hash = format!("{:x}", hash.finalize());
        let evidence_id = id("EVD");
        let timestamp = now();
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let inserted=tx.execute("INSERT OR IGNORE INTO evidence(evidence_id,run_id,company_id,claim,value_json,source_type,source_reference,source_url,confidence,extraction_method,retrieved_at,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",params![evidence_id,args.run_id,args.company_id,args.claim,encoded_value,args.source_type,args.source_reference,args.source_url,args.confidence,args.extraction_method,timestamp,content_hash])?;
        let actual_id = if inserted == 1 {
            evidence_id
        } else {
            tx.query_row("SELECT evidence_id FROM evidence WHERE run_id=? AND company_id=? AND claim=? AND source_type=? AND source_reference=? AND content_hash=?",params![args.run_id,args.company_id,args.claim,args.source_type,args.source_reference,content_hash],|r|r.get(0))?
        };
        let provenance = json!({"source_type":args.source_type,"source_reference":args.source_reference,"source_url":args.source_url,"extraction_method":args.extraction_method,"content_hash":content_hash,"details":args.claim_provenance});
        tx.execute("INSERT OR IGNORE INTO evidence_claim_state(evidence_id,claim_provenance_json) VALUES(?,?)",params![actual_id,encode(&provenance)?])?;
        if inserted == 1 {
            Self::event(
                &tx,
                Some(&args.run_id),
                "EVIDENCE_SAVED",
                &json!({"evidence_id":actual_id,"company_id":args.company_id,"claim":args.claim}),
                false,
            )?;
        }
        tx.commit()?;
        drop(conn);
        let conn = self.conn()?;
        let mut result = conn.query_row("SELECT evidence_id,run_id,company_id,claim,value_json,source_type,source_reference,source_url,confidence,extraction_method,retrieved_at,content_hash FROM evidence WHERE evidence_id=?", [&actual_id], evidence_row)?;
        crate::trust::attach(&conn, &mut result)?;
        result["created"] = json!(inserted == 1);
        Ok(result)
    }
    fn get_missing_evidence(&self, args: MissingEvidenceArgs) -> Result<Value> {
        let required = args.required_attributes.unwrap_or_else(|| {
            vec![
                "products".into(),
                "business_model".into(),
                "customer_segment".into(),
            ]
        });
        if required.len() > MAX_LIST {
            return Err(Error::Validation("too many required attributes".into()));
        }
        let evidence = self.get_evidence(EvidenceArgs {
            run_id: args.run_id.clone(),
            company_id: args.company_id.clone(),
            claims: None,
            source_types: None,
            limit: Some(1000),
        })?;
        let found: BTreeSet<&str> = evidence
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| v["verification_status"] == "VERIFIED")
            .filter(|v| {
                !v["value"].is_null() && v["value"].as_str().is_none_or(|s| !s.trim().is_empty())
            })
            .filter_map(|v| v["claim"].as_str())
            .collect();
        let missing: Vec<String> = required
            .into_iter()
            .filter(|claim| !found.contains(claim.as_str()))
            .collect();
        Ok(json!({"run_id":args.run_id,"company_id":args.company_id,"missing":missing}))
    }
    fn search_memory(&self, args: SearchMemoryArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        bounded("query", &args.query, 10_000)?;
        let cap = limit(args.limit, 20, 200)?;
        let terms: Vec<String> = normalize(&args.query)
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        let conn = self.conn()?;
        let mut stmt=conn.prepare("SELECT evidence_id,run_id,company_id,claim,value_json,source_type,source_reference,source_url,confidence,extraction_method,retrieved_at,content_hash FROM evidence WHERE run_id=? ORDER BY retrieved_at DESC")?;
        let rows = stmt.query_map([&args.run_id], evidence_row)?;
        let mut scored = Vec::new();
        for row in rows {
            let mut row = row?;
            crate::trust::attach(&conn, &mut row)?;
            if args
                .company_id
                .as_ref()
                .is_some_and(|id| row["company_id"] != *id)
            {
                continue;
            }
            let text = row.to_string().to_lowercase();
            let score = terms.iter().filter(|t| text.contains(t.as_str())).count();
            if score > 0 {
                scored.push((score, row));
            }
        }
        drop(stmt);
        drop(conn);
        let labels = self.get_labels(LabelsArgs {
            run_id: args.run_id.clone(),
            labels: None,
            company_id: args.company_id.clone(),
            limit: Some(500),
        })?;
        let questions = self.get_questions(QuestionsArgs {
            run_id: args.run_id,
            company_id: args.company_id,
            include_resolved: Some(true),
            limit: Some(500),
        })?;
        for (kind, records) in [("analyst_label", labels), ("research_question", questions)] {
            for mut record in records.as_array().cloned().unwrap_or_default() {
                let text = record.to_string().to_lowercase();
                let score = terms
                    .iter()
                    .filter(|term| text.contains(term.as_str()))
                    .count();
                if score > 0 {
                    record["memory_type"] = json!(kind);
                    scored.push((score, record));
                }
            }
        }
        scored.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
        Ok(Value::Array(
            scored.into_iter().take(cap).map(|(_, v)| v).collect(),
        ))
    }
    fn get_previous_research(&self, args: PreviousResearchArgs) -> Result<Value> {
        self.require_company(&args.company_id)?;
        let cap = limit(args.limit, 100, 500)?;
        let conn = self.conn()?;
        let mut stmt=conn.prepare("SELECT evidence_id,run_id,company_id,claim,value_json,source_type,source_reference,source_url,confidence,extraction_method,retrieved_at,content_hash FROM evidence WHERE company_id=? ORDER BY retrieved_at DESC LIMIT ?")?;
        let mut rows = stmt
            .query_map(params![args.company_id, cap as i64], evidence_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for row in &mut rows {
            crate::trust::attach(&conn, row)?;
        }
        Ok(Value::Array(rows))
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct EventsArgs {
    run_id: String,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    event_types: Option<Vec<String>>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SearchHistoryArgs {
    run_id: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct QuestionsArgs {
    run_id: String,
    #[serde(default)]
    company_id: Option<String>,
    #[serde(default)]
    include_resolved: Option<bool>,
    #[serde(default)]
    limit: Option<usize>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct AddQuestionArgs {
    run_id: String,
    #[serde(default)]
    company_id: Option<String>,
    question: String,
    priority: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ResolveQuestionArgs {
    question_id: String,
    answer: String,
    #[serde(default)]
    evidence_ids: Vec<String>,
}

impl Store {
    fn get_events(&self, args: EventsArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        let cap = limit(args.limit, 25, 500)?;
        let wanted = args.event_types.unwrap_or_default();
        let conn = self.conn()?;
        let mut stmt=conn.prepare("SELECT event_id,run_id,event_type,payload_json,major,created_at FROM agent_events WHERE run_id=? ORDER BY created_at DESC")?;
        let rows=stmt.query_map([&args.run_id],|r|Ok(json!({"event_id":r.get::<_,String>(0)?,"run_id":r.get::<_,Option<String>>(1)?,"event_type":r.get::<_,String>(2)?,"payload":decode(r.get(3)?)?,"major":r.get::<_,i64>(4)?!=0,"created_at":r.get::<_,String>(5)?})))?;
        let mut out = Vec::new();
        for row in rows {
            let row = row?;
            if !wanted.is_empty() && !wanted.iter().any(|t| row["event_type"] == *t) {
                continue;
            }
            out.push(row);
            if out.len() == cap {
                break;
            }
        }
        Ok(Value::Array(out))
    }
    fn get_search_history(&self, args: SearchHistoryArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        let cap = limit(args.limit, 50, 500)?;
        let conn = self.conn()?;
        let mut stmt=conn.prepare("SELECT query_id,run_id,source,query,parameters_json,results_json,created_at FROM search_queries WHERE run_id=? ORDER BY created_at DESC")?;
        let rows=stmt.query_map([&args.run_id],|r|Ok(json!({"query_id":r.get::<_,String>(0)?,"run_id":r.get::<_,Option<String>>(1)?,"source":r.get::<_,String>(2)?,"query":r.get::<_,String>(3)?,"parameters":decode(r.get(4)?)?,"results":decode(r.get(5)?)?,"created_at":r.get::<_,String>(6)?})))?;
        let mut out = Vec::new();
        for row in rows {
            let row = row?;
            if args.source.as_ref().is_some_and(|s| row["source"] != *s) {
                continue;
            }
            out.push(row);
            if out.len() == cap {
                break;
            }
        }
        Ok(Value::Array(out))
    }
    fn get_questions(&self, args: QuestionsArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        let cap = limit(args.limit, 100, 500)?;
        let conn = self.conn()?;
        let mut stmt=conn.prepare("SELECT question_id,run_id,company_id,question,priority,status,answer,evidence_ids_json,created_at,resolved_at FROM research_questions WHERE run_id=? ORDER BY created_at DESC")?;
        let rows = stmt.query_map([&args.run_id], question_row)?;
        let mut out = Vec::new();
        for row in rows {
            let row = row?;
            if args
                .company_id
                .as_ref()
                .is_some_and(|id| row["company_id"] != *id)
            {
                continue;
            }
            if args.include_resolved != Some(true) && row["status"] != "OPEN" {
                continue;
            }
            out.push(row);
            if out.len() == cap {
                break;
            }
        }
        Ok(Value::Array(out))
    }
    fn add_question(&self, args: AddQuestionArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        if let Some(id) = &args.company_id {
            self.require_company(id)?;
        }
        bounded("question", &args.question, 10_000)?;
        if !["low", "medium", "high", "critical"].contains(&args.priority.as_str()) {
            return Err(Error::Validation(
                "priority must be low, medium, high, or critical".into(),
            ));
        }
        let question_id = id("QUE");
        let timestamp = now();
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        tx.execute("INSERT INTO research_questions(question_id,run_id,company_id,question,priority,status,created_at) VALUES(?,?,?,?,?,'OPEN',?)",params![question_id,args.run_id,args.company_id,args.question,args.priority,timestamp])?;
        Self::event(
            &tx,
            Some(&args.run_id),
            "OPEN_QUESTION_ADDED",
            &json!({"question_id":question_id,"company_id":args.company_id}),
            false,
        )?;
        tx.commit()?;
        Ok(
            json!({"question_id":question_id,"run_id":args.run_id,"company_id":args.company_id,"question":args.question,"priority":args.priority,"status":"OPEN","created_at":timestamp}),
        )
    }
    fn resolve_question(&self, args: ResolveQuestionArgs) -> Result<Value> {
        bounded("answer", &args.answer, 50_000)?;
        if args.evidence_ids.len() > MAX_LIST {
            return Err(Error::Validation("too many evidence ids".into()));
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let info: Option<(String, String, Option<String>)> = tx
            .query_row(
                "SELECT run_id,status,company_id FROM research_questions WHERE question_id=?",
                [&args.question_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let (run_id, status, company_id) = info
            .ok_or_else(|| Error::NotFound(format!("question not found: {}", args.question_id)))?;
        if status != "OPEN" {
            return Err(Error::Conflict("question is already resolved".into()));
        }
        for evidence_id in &args.evidence_ids {
            let valid: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM evidence WHERE evidence_id=? AND run_id=? AND (? IS NULL OR company_id=?)",
                    params![evidence_id, run_id, company_id, company_id],
                    |r| r.get(0),
                )
                .optional()?;
            if valid.is_none() {
                return Err(Error::Validation(format!(
                    "evidence is missing or belongs to another run or company: {evidence_id}"
                )));
            }
        }
        let timestamp = now();
        tx.execute("UPDATE research_questions SET status='RESOLVED',answer=?,evidence_ids_json=?,resolved_at=? WHERE question_id=?",params![args.answer,serde_json::to_string(&args.evidence_ids)?,timestamp,args.question_id])?;
        Self::event(
            &tx,
            Some(&run_id),
            "OPEN_QUESTION_RESOLVED",
            &json!({"question_id":args.question_id}),
            false,
        )?;
        tx.commit()?;
        Ok(
            json!({"question_id":args.question_id,"run_id":run_id,"status":"RESOLVED","answer":args.answer,"evidence_ids":args.evidence_ids,"resolved_at":timestamp}),
        )
    }
}
fn question_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"question_id":r.get::<_,String>(0)?,"run_id":r.get::<_,String>(1)?,"company_id":r.get::<_,Option<String>>(2)?,"question":r.get::<_,String>(3)?,"priority":r.get::<_,String>(4)?,"status":r.get::<_,String>(5)?,"answer":r.get::<_,Option<String>>(6)?,"evidence_ids":decode(r.get(7)?)?,"created_at":r.get::<_,String>(8)?,"resolved_at":r.get::<_,Option<String>>(9)?}),
    )
}

#[derive(Deserialize, JsonSchema)]
#[serde(untagged, deny_unknown_fields)]
enum CandidateInput {
    Id(String),
    Detailed {
        company_id: String,
        #[serde(default)]
        retrieval_score: Option<f64>,
        #[serde(default)]
        rank: Option<i64>,
    },
}
impl CandidateInput {
    fn parts(&self) -> (&str, Option<f64>, Option<i64>) {
        match self {
            Self::Id(id) => (id, None, None),
            Self::Detailed {
                company_id,
                retrieval_score,
                rank,
            } => (company_id, *retrieval_score, *rank),
        }
    }
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct AddCandidatesArgs {
    run_id: String,
    companies: Vec<CandidateInput>,
    discovery_source: String,
    #[serde(default)]
    query_id: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct UpdateCandidateArgs {
    run_id: String,
    company_id: String,
    status: String,
    #[serde(default)]
    reason: Option<String>,
}
#[derive(Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CandidateFilters {
    #[serde(default)]
    company_ids: Option<Vec<String>>,
    #[serde(default)]
    country: Option<Vec<String>>,
    #[serde(default)]
    industry: Option<Vec<String>>,
    #[serde(default)]
    revenue_min: Option<f64>,
    #[serde(default)]
    revenue_max: Option<f64>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CandidateSetArgs {
    run_id: String,
    #[serde(default)]
    statuses: Option<Vec<String>>,
    #[serde(default)]
    filters: CandidateFilters,
    #[serde(default)]
    limit: Option<usize>,
}

fn valid_candidate_status(value: &str) -> Result<()> {
    if [
        "DISCOVERED",
        "PRE_SCREENED",
        "RESEARCH_REQUIRED",
        "LIKELY_FIT",
        "LIKELY_MISFIT",
        "HUMAN_REVIEW",
        "FINAL_SHORTLIST",
        "REJECTED",
    ]
    .contains(&value)
    {
        Ok(())
    } else {
        Err(Error::Validation(format!(
            "invalid candidate status: {value}"
        )))
    }
}

impl Store {
    fn add_candidates(&self, args: AddCandidatesArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        bounded("discovery_source", &args.discovery_source, 128)?;
        if args.companies.is_empty() || args.companies.len() > MAX_LIST {
            return Err(Error::Validation(format!(
                "companies must contain 1..={MAX_LIST} entries"
            )));
        }
        let mut ids = BTreeSet::new();
        for company in &args.companies {
            let (company_id, score, rank) = company.parts();
            bounded("company_id", company_id, 128)?;
            if !ids.insert(company_id.to_owned()) {
                return Err(Error::Validation(format!(
                    "duplicate company_id in request: {company_id}"
                )));
            }
            if score.is_some_and(|s| !s.is_finite()) {
                return Err(Error::Validation("retrieval_score must be finite".into()));
            }
            if rank.is_some_and(|r| r < 1) {
                return Err(Error::Validation("rank must be positive".into()));
            }
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        for company_id in &ids {
            let exists: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM companies WHERE company_id=?",
                    [company_id],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_none() {
                return Err(Error::NotFound(format!("company not found: {company_id}")));
            }
        }
        if let Some(query_id) = &args.query_id {
            let query_run: Option<Option<String>> = tx
                .query_row(
                    "SELECT run_id FROM search_queries WHERE query_id=?",
                    [query_id],
                    |r| r.get(0),
                )
                .optional()?;
            match query_run {
                None => return Err(Error::NotFound(format!("query not found: {query_id}"))),
                Some(Some(run)) if run != args.run_id => {
                    return Err(Error::Validation("query belongs to another run".into()))
                }
                _ => {}
            }
        }
        let timestamp = now();
        let mut added = 0usize;
        let mut discovery_added = 0usize;
        for company in &args.companies {
            let (company_id, score, rank) = company.parts();
            added+=tx.execute("INSERT OR IGNORE INTO candidates(run_id,company_id,status,discovered_at,updated_at) VALUES(?,?,'DISCOVERED',?,?)",params![args.run_id,company_id,timestamp,timestamp])?;
            let existing: Option<i64> = if let Some(query_id) = &args.query_id {
                tx.query_row("SELECT 1 FROM candidate_discovery WHERE run_id=? AND company_id=? AND discovery_source=? AND query_id=?",params![args.run_id,company_id,args.discovery_source,query_id],|r|r.get(0)).optional()?
            } else {
                tx.query_row("SELECT 1 FROM candidate_discovery WHERE run_id=? AND company_id=? AND discovery_source=? AND query_id IS NULL",params![args.run_id,company_id,args.discovery_source],|r|r.get(0)).optional()?
            };
            if existing.is_none() {
                tx.execute("INSERT INTO candidate_discovery(discovery_id,run_id,company_id,discovery_source,query_id,retrieval_score,rank,discovered_at) VALUES(?,?,?,?,?,?,?,?)",params![id("DISC"),args.run_id,company_id,args.discovery_source,args.query_id,score,rank,timestamp])?;
                discovery_added += 1;
            }
        }
        Self::event(
            &tx,
            Some(&args.run_id),
            "CANDIDATES_ADDED",
            &json!({"requested":args.companies.len(),"new_candidates":added,"discovery_records":discovery_added,"source":args.discovery_source}),
            false,
        )?;
        tx.commit()?;
        Ok(
            json!({"run_id":args.run_id,"requested":args.companies.len(),"added":added,"already_present":args.companies.len()-added,"discovery_records_added":discovery_added,"discovery_source":args.discovery_source,"query_id":args.query_id}),
        )
    }
    fn update_candidate(&self, args: UpdateCandidateArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        self.require_company(&args.company_id)?;
        valid_candidate_status(&args.status)?;
        if let Some(reason) = &args.reason {
            bounded("reason", reason, 20_000)?;
        }
        let timestamp = now();
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "UPDATE candidates SET status=?,reason=?,updated_at=? WHERE run_id=? AND company_id=?",
            params![
                args.status,
                args.reason,
                timestamp,
                args.run_id,
                args.company_id
            ],
        )?;
        if changed == 0 {
            return Err(Error::NotFound(format!(
                "candidate not found in run: {}",
                args.company_id
            )));
        }
        Self::event(
            &tx,
            Some(&args.run_id),
            "CANDIDATE_STATUS_UPDATED",
            &json!({"company_id":args.company_id,"status":args.status,"reason":args.reason}),
            false,
        )?;
        tx.commit()?;
        Ok(
            json!({"run_id":args.run_id,"company_id":args.company_id,"status":args.status,"reason":args.reason,"updated_at":timestamp}),
        )
    }
    fn get_candidates(&self, args: CandidateSetArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        let cap = limit(args.limit, 100, 1000)?;
        let statuses = args.statuses.unwrap_or_default();
        for status in &statuses {
            valid_candidate_status(status)?;
        }
        let mut ignored = Vec::new();
        if args.filters.country.as_ref().is_some_and(|v| !v.is_empty()) {
            ignored.push("country");
        }
        if args
            .filters
            .industry
            .as_ref()
            .is_some_and(|v| !v.is_empty())
        {
            ignored.push("industry");
        }
        if args.filters.revenue_min.is_some() {
            ignored.push("revenue_min");
        }
        if args.filters.revenue_max.is_some() {
            ignored.push("revenue_max");
        }
        let conn = self.conn()?;
        let mut stmt=conn.prepare("SELECT x.run_id,x.company_id,x.status,x.reason,x.discovered_at,x.updated_at,c.name,c.website,c.industry,c.country,c.revenue FROM candidates x JOIN companies c ON c.company_id=x.company_id WHERE x.run_id=? ORDER BY x.updated_at DESC,x.company_id")?;
        let rows=stmt.query_map([&args.run_id],|r|Ok(json!({"run_id":r.get::<_,String>(0)?,"company_id":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"reason":r.get::<_,Option<String>>(3)?,"discovered_at":r.get::<_,String>(4)?,"updated_at":r.get::<_,String>(5)?,"company":{"company_id":r.get::<_,String>(1)?,"name":r.get::<_,String>(6)?,"website":r.get::<_,Option<String>>(7)?,"industry":r.get::<_,Option<String>>(8)?,"country":r.get::<_,Option<String>>(9)?,"revenue":r.get::<_,Option<f64>>(10)?}})))?;
        let mut out = Vec::new();
        for row in rows {
            let row = row?;
            if !statuses.is_empty() && !statuses.iter().any(|s| row["status"] == *s) {
                continue;
            }
            if args
                .filters
                .company_ids
                .as_ref()
                .is_some_and(|v| !v.iter().any(|id| row["company_id"] == *id))
            {
                continue;
            }
            out.push(row);
            if out.len() == cap {
                break;
            }
        }
        for candidate in &mut out {
            let mut discovery = conn.prepare("SELECT discovery_source,query_id,retrieval_score,rank,discovered_at FROM candidate_discovery WHERE run_id=? AND company_id=? ORDER BY discovered_at")?;
            candidate["discovery"] = Value::Array(discovery.query_map(params![args.run_id,candidate["company_id"].as_str()], |r| Ok(json!({"source":r.get::<_,String>(0)?,"query_id":r.get::<_,Option<String>>(1)?,"retrieval_score":r.get::<_,Option<f64>>(2)?,"rank":r.get::<_,Option<i64>>(3)?,"timestamp":r.get::<_,String>(4)?})))?.collect::<std::result::Result<Vec<_>,_>>()?);
        }
        Ok(
            json!({"run_id":args.run_id,"candidates":out,"count":out.len(),"ignored_search_filters":ignored,"search_scope":"qualitative_core_business","criteria_notice":"Financial, geographical, and source classification fields are not used to filter the candidate funnel."}),
        )
    }
    fn get_run_context(&self, args: RunArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        if let Some(level) = &args.detail_level {
            if !["summary", "full"].contains(&level.as_str()) {
                return Err(Error::Validation(
                    "detail_level must be summary or full".into(),
                ));
            }
        }
        let conn = self.conn()?;
        let (objective, status, criteria_version): (String, String, i64) = conn.query_row(
            "SELECT objective,status,active_criteria_version FROM screening_runs WHERE run_id=?",
            [&args.run_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let profile_version:i64=conn.query_row("SELECT COALESCE(MAX(version),0) FROM screening_profiles WHERE run_id=? AND status='APPROVED'",[&args.run_id],|r|r.get(0))?;
        let mut counts = Map::new();
        for candidate_status in [
            "DISCOVERED",
            "PRE_SCREENED",
            "RESEARCH_REQUIRED",
            "LIKELY_FIT",
            "LIKELY_MISFIT",
            "HUMAN_REVIEW",
            "FINAL_SHORTLIST",
            "REJECTED",
        ] {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM candidates WHERE run_id=? AND status=?",
                params![args.run_id, candidate_status],
                |r| r.get(0),
            )?;
            counts.insert(candidate_status.to_lowercase(), json!(count));
        }
        drop(conn);
        let open = self.get_questions(QuestionsArgs {
            run_id: args.run_id.clone(),
            company_id: None,
            include_resolved: Some(false),
            limit: Some(if args.detail_level.as_deref() == Some("full") {
                100
            } else {
                20
            }),
        })?;
        let events = self.get_events(EventsArgs {
            run_id: args.run_id.clone(),
            limit: Some(if args.detail_level.as_deref() == Some("full") {
                100
            } else {
                20
            }),
            event_types: None,
        })?;
        Ok(
            json!({"run_id":args.run_id,"objective":objective,"status":status,"active_criteria_version":criteria_version,"active_profile_version":profile_version,"candidate_counts":counts,"open_questions":open,"recent_major_events":events}),
        )
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SaveCheckpointArgs {
    run_id: String,
    #[serde(default = "default_namespace")]
    namespace: String,
    state: Value,
    #[serde(default)]
    expected_sequence: Option<i64>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct GetCheckpointArgs {
    run_id: String,
    #[serde(default = "default_namespace")]
    namespace: String,
    #[serde(default)]
    sequence: Option<i64>,
}
fn default_namespace() -> String {
    "default".into()
}

impl Store {
    fn save_checkpoint(&self, args: SaveCheckpointArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        bounded("namespace", &args.namespace, 128)?;
        let encoded = encode(&args.state)?;
        if encoded.len() > 1_000_000 {
            return Err(Error::Validation("checkpoint exceeds 1 MB".into()));
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let current: i64 = tx.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM checkpoints WHERE run_id=? AND namespace=?",
            params![args.run_id, args.namespace],
            |r| r.get(0),
        )?;
        if args
            .expected_sequence
            .is_some_and(|expected| expected != current)
        {
            return Err(Error::Conflict(format!(
                "checkpoint sequence changed: expected {:?}, current {current}",
                args.expected_sequence
            )));
        }
        let sequence = current + 1;
        let checkpoint_id = id("CHK");
        let timestamp = now();
        tx.execute("INSERT INTO checkpoints(checkpoint_id,run_id,namespace,sequence,state_json,created_at) VALUES(?,?,?,?,?,?)",params![checkpoint_id,args.run_id,args.namespace,sequence,encoded,timestamp])?;
        Self::event(
            &tx,
            Some(&args.run_id),
            "CHECKPOINT_SAVED",
            &json!({"namespace":args.namespace,"sequence":sequence}),
            false,
        )?;
        tx.commit()?;
        Ok(
            json!({"checkpoint_id":checkpoint_id,"run_id":args.run_id,"namespace":args.namespace,"sequence":sequence,"state":args.state,"created_at":timestamp}),
        )
    }
    fn get_checkpoint(&self, args: GetCheckpointArgs) -> Result<Value> {
        self.require_run(&args.run_id)?;
        bounded("namespace", &args.namespace, 128)?;
        let conn = self.conn()?;
        let sql = if args.sequence.is_some() {
            "SELECT checkpoint_id,run_id,namespace,sequence,state_json,created_at FROM checkpoints WHERE run_id=? AND namespace=? AND sequence=?"
        } else {
            "SELECT checkpoint_id,run_id,namespace,sequence,state_json,created_at FROM checkpoints WHERE run_id=? AND namespace=? ORDER BY sequence DESC LIMIT 1"
        };
        let value = if let Some(sequence) = args.sequence {
            conn.query_row(
                sql,
                params![args.run_id, args.namespace, sequence],
                checkpoint_row,
            )
            .optional()?
        } else {
            conn.query_row(sql, params![args.run_id, args.namespace], checkpoint_row)
                .optional()?
        };
        value.ok_or_else(|| Error::NotFound("checkpoint not found".into()))
    }
}
fn checkpoint_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"checkpoint_id":r.get::<_,String>(0)?,"run_id":r.get::<_,String>(1)?,"namespace":r.get::<_,String>(2)?,"sequence":r.get::<_,i64>(3)?,"state":decode(r.get(4)?)?,"created_at":r.get::<_,String>(5)?}),
    )
}

pub fn input_schema(tool: &str) -> Option<Value> {
    macro_rules! schema {
        ($args:ty) => {
            serde_json::to_value(schemars::schema_for!($args)).ok()
        };
    }
    match tool {
        "ingest_companies" => schema!(IngestArgs),
        "create_run" => schema!(CreateRunArgs),
        "get_company" => schema!(GetCompanyArgs),
        "get_original_criteria" | "get_active_screening_profile" => schema!(RunOnly),
        "get_screening_profile_version" => schema!(ProfileVersionArgs),
        "compare_profile_versions" => schema!(CompareProfileArgs),
        "propose_screening_profile" => schema!(ProposeProfileArgs),
        "approve_screening_profile" => schema!(ApproveProfileArgs),
        "get_labelled_examples" => schema!(LabelsArgs),
        "get_representative_examples" => schema!(RepresentativeArgs),
        "label_company" => schema!(LabelCompanyArgs),
        "get_evidence" => schema!(EvidenceArgs),
        "save_evidence" => schema!(SaveEvidenceArgs),
        "get_missing_evidence" => schema!(MissingEvidenceArgs),
        "search_research_memory" => schema!(SearchMemoryArgs),
        "get_previous_research" => schema!(PreviousResearchArgs),
        "get_recent_agent_events" => schema!(EventsArgs),
        "get_search_history" => schema!(SearchHistoryArgs),
        "get_open_questions" => schema!(QuestionsArgs),
        "add_open_question" => schema!(AddQuestionArgs),
        "resolve_open_question" => schema!(ResolveQuestionArgs),
        "add_candidates" => schema!(AddCandidatesArgs),
        "update_candidate_status" => schema!(UpdateCandidateArgs),
        "get_candidate_set" => schema!(CandidateSetArgs),
        "get_run_context" => schema!(RunArgs),
        "save_checkpoint" => schema!(SaveCheckpointArgs),
        "get_checkpoint" => schema!(GetCheckpointArgs),
        _ => None,
    }
}
