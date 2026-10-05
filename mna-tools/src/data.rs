use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    error::{Error, Result},
    identity::{company_key, field_text, get_field, normalize_header, normalized_identifier},
    store::Store,
    tabular::{self, SheetRows},
};

#[derive(Clone)]
pub struct DataService {
    store: Store,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ImportCompanyFilesArgs {
    files: Vec<String>,
    #[serde(default)]
    source: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ImportEnrichmentFilesArgs {
    run_id: String,
    files: Vec<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct InspectEnrichmentFilesArgs {
    files: Vec<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ExportCandidateSetArgs {
    run_id: String,
    export_type: String,
    #[serde(default)]
    file_name: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RunArgs {
    run_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CompanyArgs {
    company_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SourceRowsArgs {
    company_id: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CandidateSourceDataArgs {
    run_id: String,
    #[serde(default)]
    after_company_id: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

pub fn input_schema(tool: &str) -> Option<Value> {
    let schema = match tool {
        "import_company_files" => schemars::schema_for!(ImportCompanyFilesArgs),
        "import_enrichment_files" => schemars::schema_for!(ImportEnrichmentFilesArgs),
        "inspect_enrichment_files" => schemars::schema_for!(InspectEnrichmentFilesArgs),
        "export_candidate_set" => schemars::schema_for!(ExportCandidateSetArgs),
        "get_discovery_summary" => schemars::schema_for!(RunArgs),
        "get_company_identifiers" => schemars::schema_for!(CompanyArgs),
        "get_source_rows" => schemars::schema_for!(SourceRowsArgs),
        "get_candidate_source_data" => schemars::schema_for!(CandidateSourceDataArgs),
        _ => return None,
    };
    serde_json::to_value(schema).ok()
}

impl DataService {
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    pub fn execute(&self, tool: &str, arguments: &Value) -> Result<Value> {
        match tool {
            "import_company_files" => self.import_company_files(parse(arguments)?),
            "import_enrichment_files" => self.import_enrichment_files(parse(arguments)?),
            "inspect_enrichment_files" => self.inspect_enrichment_files(parse(arguments)?),
            "export_candidate_set" => self.export_candidate_set(parse(arguments)?),
            "get_discovery_summary" => self.get_discovery_summary(parse(arguments)?),
            "get_company_identifiers" => self.get_company_identifiers(parse(arguments)?),
            "get_source_rows" => self.get_source_rows(parse(arguments)?),
            "get_candidate_source_data" => self.get_candidate_source_data(parse(arguments)?),
            _ => Err(Error::Validation(format!("unknown data tool: {tool}"))),
        }
    }

    /// The search gateway sends original ISCC row objects here after obtaining
    /// a bounded provider response. The returned companies are canonical.
    pub fn ingest_iscc_rows(
        &self,
        run_id: Option<&str>,
        query_id: Option<&str>,
        rows: &[Value],
    ) -> Result<Value> {
        if rows.len() > 1_000 {
            return Err(Error::Validation("ISCC response exceeds 1000 rows".into()));
        }
        self.ingest_source_rows("ISCC", run_id.unwrap_or(""), query_id.unwrap_or(""), rows)
    }

    fn import_company_files(&self, args: ImportCompanyFilesArgs) -> Result<Value> {
        validate_files(&args.files)?;
        let source = args
            .source
            .unwrap_or_else(|| "MID".into())
            .to_ascii_uppercase();
        if source != "MID" {
            return Err(Error::Validation("file import source must be MID".into()));
        }
        let mut rows = Vec::new();
        let mut sheets = Vec::new();
        for file in &args.files {
            let path = tabular::resolve_import_path(file)?;
            for sheet in tabular::read_file(&path)? {
                if tabular::sheet_kind(&sheet) == Some("COMPANY") {
                    if rows.len() + sheet.rows.len() > 250_000 {
                        return Err(Error::Validation("MID import exceeds 250000 rows".into()));
                    }
                    sheets.push(json!({"file":sheet.file_name,"sheet":sheet.sheet_name,"header_row":sheet.header_row,"rows":sheet.rows.len()}));
                    rows.extend(sheet.rows);
                }
            }
        }
        if rows.is_empty() {
            return Err(Error::Validation(
                "no MID company sheets with ECID or CID found".into(),
            ));
        }
        if rows.len() > 250_000 {
            return Err(Error::Validation("MID import exceeds 250000 rows".into()));
        }
        let mut result = self.ingest_source_rows("MID", "", "", &rows)?;
        result["sheets"] = Value::Array(sheets);
        Ok(result)
    }

    fn ingest_source_rows(
        &self,
        source: &str,
        run_scope: &str,
        query_scope: &str,
        rows: &[Value],
    ) -> Result<Value> {
        if !matches!(source, "MID" | "ISCC") {
            return Err(Error::Validation("source must be MID or ISCC".into()));
        }
        let mut result = IngestCounters::default();
        let mut observed_scores = BTreeMap::<String, Option<f64>>::new();
        self.store.with_connection(|connection| {
            let tx = connection.transaction()?;
            if !run_scope.is_empty() {
                require_run(&tx, run_scope)?;
            }
            if !query_scope.is_empty() {
                let found:Option<Option<String>>=tx.query_row("SELECT run_id FROM search_queries WHERE query_id=?",[query_scope],|r|r.get(0)).optional()?;
                match found {Some(Some(id)) if id==run_scope=>{},Some(None) if run_scope.is_empty()=>{},Some(_)=>return Err(Error::Validation("query_id does not belong to run".into())),None=>return Err(Error::NotFound(format!("query not found: {query_scope}")))}
            }
            for row in rows {
                result.processed += 1;
                let ecid = normalized_identifier(get_field(row, &["ECID", "E C I D"]));
                let cid = normalized_identifier(get_field(row, &["CID", "C I D"]));
                if ecid.as_deref()==Some("X") || cid.as_deref()==Some("X") {
                    quarantine(&tx, source, "literal X is reserved for a missing identifier component", row)?;
                    result.quarantined+=1;
                    continue;
                }
                let Some(key) = company_key(ecid.as_deref(), cid.as_deref()) else {
                    quarantine(&tx, source, "missing both ECID and CID", row)?;
                    result.quarantined += 1;
                    continue;
                };
                let Some(name) = field_text(row, &["Company Name", "Company", "Name", "Companies", "Firm Name"]) else {
                    quarantine(&tx, source, "missing company name", row)?;
                    result.quarantined += 1;
                    continue;
                };
                tx.execute_batch("SAVEPOINT identity_row")?;
                let found = match resolve_or_create_company(&tx, &key, ecid.as_deref(), cid.as_deref(), &name, source, row) {
                    Ok(found) => {tx.execute_batch("RELEASE identity_row")?;found},
                    Err(Error::Conflict(reason)) => {
                        tx.execute_batch("ROLLBACK TO identity_row; RELEASE identity_row")?;
                        quarantine(&tx, source, &reason, row)?;
                        result.quarantined += 1;
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                if found.created { result.inserted += 1; } else { result.matched += 1; }
                if found.promoted { result.promoted += 1; }
                let raw = serde_json::to_string(row)?;
                let hash = hex_hash(raw.as_bytes());
                let score = get_field(row, &["Relevance Score", "Relevance", "Score"]).and_then(as_score);
                result.source_rows_added += tx.execute("INSERT OR IGNORE INTO source_rows(source_row_id,source,run_scope,query_scope,company_id,row_hash,row_json,relevance_score,imported_at) VALUES(?,?,?,?,?,?,?,?,?)",
                    params![id("SRC"),source,run_scope,query_scope,found.company_id,hash,raw,score,now()])?;
                if source == "MID" || found.created || !has_source(&tx, &found.company_id, "MID")? {
                    update_canonical(&tx, &found.company_id, source, row)?;
                }
                if source == "ISCC" {
                    retain_best_score(&mut observed_scores,found.company_id,score);
                }
            }
            tx.commit()?;
            Ok(())
        })?;
        let mut canonical_scores = BTreeMap::new();
        for (id, score) in observed_scores {
            retain_best_score(
                &mut canonical_scores,
                self.store.resolve_company_id(&id)?,
                score,
            );
        }
        let mut companies = Vec::new();
        for (id, score) in canonical_scores {
            let mut company = self
                .store
                .execute("get_company", &json!({"company_id":id}))?;
            let has_mid = company["sources"]
                .as_array()
                .is_some_and(|sources| sources.iter().any(|source| source == "MID"));
            company
                .as_object_mut()
                .expect("canonical company object")
                .remove("embedding");
            company["source"] = json!(if has_mid { "both" } else { "ISCC" });
            company["relevance_score"] = json!(score);
            company["provisional"] = json!(is_provisional(&id));
            companies.push(company);
        }
        companies.sort_by(|left, right| {
            right["relevance_score"]
                .as_f64()
                .unwrap_or(-1.0)
                .total_cmp(&left["relevance_score"].as_f64().unwrap_or(-1.0))
                .then_with(|| {
                    left["company_id"]
                        .as_str()
                        .cmp(&right["company_id"].as_str())
                })
        });
        for (index, company) in companies.iter_mut().enumerate() {
            company["rank"] = json!(index + 1);
        }
        Ok(
            json!({"source":source,"processed":result.processed,"inserted":result.inserted,"matched":result.matched,"promoted":result.promoted,"quarantined":result.quarantined,"source_rows_added":result.source_rows_added,"companies":companies}),
        )
    }

    fn get_company_identifiers(&self, args: CompanyArgs) -> Result<Value> {
        let company_id = self.store.resolve_company_id(&args.company_id)?;
        self.store.with_connection(|connection| {
            let mut statement = connection.prepare("SELECT kind,identifier,first_seen_at FROM company_identifiers WHERE company_id=? ORDER BY kind,identifier")?;
            let identifiers = statement.query_map([&company_id], |r| Ok(json!({"kind":r.get::<_,String>(0)?,"identifier":r.get::<_,String>(1)?,"first_seen_at":r.get::<_,String>(2)?})))?
                .collect::<std::result::Result<Vec<_>,_>>()?;
            let enriched: Option<Value> = connection.query_row("SELECT pb_website,pb_name,pb_description,pb_linkedin_url,pb_hq_location,pb_active_investors,pb_universe,rogo_json FROM company_enrichment WHERE company_id=?", [&company_id], |r| Ok(json!({"pb_website":r.get::<_,Option<String>>(0)?,"pb_name":r.get::<_,Option<String>>(1)?,"pb_description":r.get::<_,Option<String>>(2)?,"pb_linkedin_url":r.get::<_,Option<String>>(3)?,"pb_hq_location":r.get::<_,Option<String>>(4)?,"pb_active_investors":r.get::<_,Option<String>>(5)?,"pb_universe":r.get::<_,Option<String>>(6)?,"rogo":serde_json::from_str::<Value>(&r.get::<_,String>(7)?).unwrap_or_else(|_|json!({}))}))) .optional()?;
            Ok(json!({"company_id":company_id,"provisional":company_id.starts_with("X-")||company_id.ends_with("-X"),"identifiers":identifiers,"enrichment":enriched}))
        })
    }

    fn get_source_rows(&self, args: SourceRowsArgs) -> Result<Value> {
        let company_id = self.store.resolve_company_id(&args.company_id)?;
        let source = args.source.map(|s| s.to_ascii_uppercase());
        if source
            .as_deref()
            .is_some_and(|s| !matches!(s, "MID" | "ISCC"))
        {
            return Err(Error::Validation("source must be MID or ISCC".into()));
        }
        let limit = args.limit.unwrap_or(20);
        if !(1..=100).contains(&limit) {
            return Err(Error::Validation("limit must be 1..=100".into()));
        }
        self.store.with_connection(|connection| {
            let mut statement = connection.prepare("SELECT source,run_scope,query_scope,row_json,relevance_score,imported_at FROM source_rows WHERE company_id=? AND (? IS NULL OR source=?) ORDER BY imported_at DESC,source_row_id DESC LIMIT ?")?;
            let rows = statement.query_map(params![company_id,source,source,limit as i64],|r| Ok(json!({"source":r.get::<_,String>(0)?,"run_scope":r.get::<_,String>(1)?,"query_id":r.get::<_,String>(2)?,"row":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(Value::Null),"relevance_score":r.get::<_,Option<f64>>(4)?,"imported_at":r.get::<_,String>(5)?})))?
                .collect::<std::result::Result<Vec<_>,_>>()?;
            Ok(json!({"company_id":company_id,"rows":rows}))
        })
    }

    fn get_candidate_source_data(&self, args: CandidateSourceDataArgs) -> Result<Value> {
        if args.run_id.trim().is_empty() || args.run_id != args.run_id.trim() {
            return Err(Error::Validation(
                "run_id must be nonblank and trimmed".into(),
            ));
        }
        let limit = args.limit.unwrap_or(50);
        if !(1..=100).contains(&limit) {
            return Err(Error::Validation("limit must be 1..=100".into()));
        }
        if args
            .after_company_id
            .as_deref()
            .is_some_and(|cursor| cursor.trim().is_empty() || cursor != cursor.trim())
        {
            return Err(Error::Validation(
                "after_company_id must be nonblank and trimmed".into(),
            ));
        }
        self.store.with_connection(|connection| {
            candidate_source_page(
                connection,
                &args.run_id,
                args.after_company_id.as_deref(),
                limit,
                true,
            )
        })
    }

    fn get_discovery_summary(&self, args: RunArgs) -> Result<Value> {
        self.store.with_connection(|connection| {
            require_run(connection,&args.run_id)?;
            let mut statement = connection.prepare("SELECT c.company_id,c.status,EXISTS(SELECT 1 FROM source_rows s WHERE s.company_id=c.company_id AND s.source='MID'),EXISTS(SELECT 1 FROM source_rows s WHERE s.company_id=c.company_id AND s.source='ISCC' AND s.run_scope=c.run_id) FROM candidates c WHERE c.run_id=?")?;
            let mut total=0usize; let mut mid=0usize; let mut iscc=0usize; let mut both=0usize; let mut other=0usize;
            let records = statement.query_map([&args.run_id],|r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?!=0,r.get::<_,i64>(3)?!=0)))?;
            let mut statuses = BTreeMap::<String,usize>::new();
            for record in records {
                let (_,status,has_mid,has_iscc)=record?;
                total+=1; *statuses.entry(status).or_default()+=1;
                match (has_mid,has_iscc) { (true,true)=>both+=1,(true,false)=>mid+=1,(false,true)=>iscc+=1,_=>other+=1 }
            }
            let recommendation=if total>=2000 {"LLM_SCREENING"} else {"PITCHBOOK_ENRICHMENT"};
            Ok(json!({"run_id":args.run_id,"total_unique":total,"mid_only":mid,"iscc_only":iscc,"both":both,"other":other,"status_counts":statuses,"recommended_next_step":recommendation}))
        })
    }

    fn inspect_enrichment_files(&self, args: InspectEnrichmentFilesArgs) -> Result<Value> {
        validate_files(&args.files)?;
        let mut files = Vec::with_capacity(args.files.len());
        let mut import_files = Vec::new();
        let mut pending_files = Vec::new();
        let mut counts = BTreeMap::<&str, usize>::from([
            ("mapping", 0),
            ("pitchbook", 0),
            ("rogo", 0),
            ("company", 0),
            ("unrecognized", 0),
        ]);
        for file in args.files {
            let sheets = tabular::inspect_file(&tabular::resolve_import_path(&file)?)?;
            let inspected = sheets
                .iter()
                .map(|sheet| {
                    let kind = tabular::sheet_kind(sheet);
                    let counter = match kind {
                        Some("PB_MAPPING") => "mapping",
                        Some("PB_DATA") => "pitchbook",
                        Some("ROGO") => "rogo",
                        Some("COMPANY") => "company",
                        _ => "unrecognized",
                    };
                    *counts.get_mut(counter).expect("known inspection count") += 1;
                    json!({
                        "sheet": sheet.sheet_name,
                        "header_row": sheet.header_row,
                        "kind": kind,
                        "rows": sheet.rows.len(),
                        "headers": sheet.headers,
                    })
                })
                .collect::<Vec<_>>();
            let eligible = !inspected.is_empty()
                && inspected.iter().all(|sheet| {
                    matches!(
                        sheet["kind"].as_str(),
                        Some("PB_MAPPING" | "PB_DATA" | "ROGO")
                    )
                });
            let roles = inspected
                .iter()
                .filter_map(|sheet| sheet["kind"].as_str())
                .collect::<BTreeSet<_>>();
            let reason = if eligible {
                None
            } else if inspected.is_empty() {
                Some("no populated sheets")
            } else {
                Some("contains a non-enrichment or unrecognized sheet")
            };
            if eligible {
                import_files.push(file.clone());
            } else {
                pending_files.push(file.clone());
            }
            files.push(json!({
                "file": file,
                "eligible": eligible,
                "roles": roles,
                "sheets": inspected,
                "reason": reason,
            }));
        }
        Ok(json!({
            "files": files,
            "import_files": import_files,
            "pending_files": pending_files,
            "counts": counts,
        }))
    }

    fn import_enrichment_files(&self, args: ImportEnrichmentFilesArgs) -> Result<Value> {
        validate_files(&args.files)?;
        let mut mappings = Vec::<SheetRows>::new();
        let mut pb_data = Vec::<SheetRows>::new();
        let mut rogo = Vec::<SheetRows>::new();
        let mut total_rows = 0usize;
        for file in &args.files {
            for sheet in tabular::read_file(&tabular::resolve_import_path(file)?)? {
                total_rows += sheet.rows.len();
                if total_rows > 250_000 {
                    return Err(Error::Validation(
                        "Enrichment import exceeds 250000 total rows".into(),
                    ));
                }
                match tabular::sheet_kind(&sheet) {
                    Some("PB_MAPPING") => mappings.push(sheet),
                    Some("PB_DATA") => pb_data.push(sheet),
                    Some("ROGO") => rogo.push(sheet),
                    _ => {
                        return Err(Error::Validation(format!(
                            "unrecognized enrichment sheet: {}/{}",
                            sheet.file_name, sheet.sheet_name
                        )))
                    }
                }
            }
        }
        if mappings.is_empty() && pb_data.is_empty() && rogo.is_empty() {
            return Err(Error::Validation("no enrichment sheets found".into()));
        }
        let mut parquet_paths = Vec::new();
        let mut new_parquet_paths = Vec::new();
        for sheet in &pb_data {
            let fingerprint = json_fingerprint(&sheet.rows)?;
            let path = tabular::resolve_export_path(&format!("pb-{fingerprint}.parquet"))?;
            if !path.exists() {
                write_json_parquet(&path, &sheet.rows)?;
                new_parquet_paths.push(path.clone());
            }
            parquet_paths.push(path);
        }
        let mut result = EnrichmentCounters::default();
        let mut mapped_companies = BTreeSet::new();
        let mut pb_companies = BTreeSet::new();
        let mut rogo_companies = BTreeSet::new();
        let outcome = self.store.with_connection(|connection| {
            let tx = connection.transaction()?;
            require_run(&tx, &args.run_id)?;
            for sheet in &mappings {
                for row in &sheet.rows {
                    result.mapping_rows += 1;
                    let profile = field_text(row, &["Company Profile"]);
                    let pk = field_text(row, &["pk"]);
                    let pbid = normalized_identifier(get_field(row, &["PBId"]));
                    let company_id = pk
                        .as_deref()
                        .map(|pk| resolve_pk_in_tx(&tx, pk))
                        .transpose()?
                        .flatten();
                    let company_id = match company_id {
                        Some(id) if is_candidate(&tx, &args.run_id, &id)? => Some(id),
                        _ => None,
                    };
                    save_enrichment_row(&tx, "PB_MAPPING", company_id.as_deref(), row, None)?;
                    if !profile
                        .as_deref()
                        .is_some_and(|p| p.eq_ignore_ascii_case("yes"))
                    {
                        result.mapping_skipped_non_company += 1;
                        continue;
                    }
                    match (company_id, pbid) {
                        (Some(company_id), Some(pbid)) => {
                            let already_mapped = lookup_identifier(&tx, "PBID", &pbid)?.is_some();
                            match put_identifier(&tx, "PBID", &pbid, &company_id) {
                                Ok(()) => {
                                    mapped_companies.insert(company_id);
                                    if !already_mapped {
                                        result.pbid_populated += 1;
                                    }
                                }
                                Err(Error::Conflict(reason)) => {
                                    quarantine(&tx, "PB_MAPPING", &reason, row)?;
                                    result.quarantined += 1;
                                }
                                Err(e) => return Err(e),
                            }
                        }
                        _ => {
                            quarantine(
                                &tx,
                                "PB_MAPPING",
                                "Company Profile Yes row lacks resolvable pk or PBId",
                                row,
                            )?;
                            result.quarantined += 1;
                        }
                    }
                }
            }
            for (sheet, path) in pb_data.iter().zip(&parquet_paths) {
                for row in &sheet.rows {
                    result.pb_data_rows += 1;
                    let pbid = normalized_identifier(get_field(row, &["Company ID"]));
                    let company_id = pbid
                        .as_deref()
                        .map(|p| lookup_identifier(&tx, "PBID", p))
                        .transpose()?
                        .flatten();
                    let company_id = match company_id {
                        Some(id) if is_candidate(&tx, &args.run_id, &id)? => Some(id),
                        _ => None,
                    };
                    save_enrichment_row(&tx, "PB_DATA", company_id.as_deref(), row, Some(path))?;
                    if let Some(company_id) = company_id {
                        upsert_pb_compact(&tx, &company_id, row)?;
                        pb_companies.insert(company_id);
                        result.pb_hydrated += 1;
                    } else {
                        result.pb_unmatched += 1;
                    }
                }
            }
            let (pb_sites, canonical_sites) = website_maps(&tx, &args.run_id)?;
            for sheet in &rogo {
                for row in &sheet.rows {
                    result.rogo_rows += 1;
                    let site = field_text(row, &["Website", "Websites"]);
                    let normalized = site.as_deref().and_then(normalize_website);
                    let selected = normalized
                        .as_deref()
                        .and_then(|key| pb_sites.get(key).or_else(|| canonical_sites.get(key)));
                    let company_id = match selected {
                        Some(ids) if ids.len() == 1 => ids.first().cloned(),
                        Some(_) => {
                            quarantine(&tx, "ROGO", "website matches multiple companies", row)?;
                            result.quarantined += 1;
                            None
                        }
                        None => {
                            result.rogo_unmatched += 1;
                            None
                        }
                    };
                    save_enrichment_row(&tx, "ROGO", company_id.as_deref(), row, None)?;
                    if let Some(company_id) = company_id {
                        merge_rogo(&tx, &company_id, row)?;
                        rogo_companies.insert(company_id);
                        result.rogo_hydrated += 1;
                    }
                }
            }
            tx.commit()?;
            Ok(())
        });
        if outcome.is_err() {
            for path in &new_parquet_paths {
                let _ = std::fs::remove_file(path);
            }
        }
        outcome?;
        Ok(
            json!({"run_id":args.run_id,"mapping_rows":result.mapping_rows,"mapping_skipped_non_company":result.mapping_skipped_non_company,"pbid_populated":result.pbid_populated,"mapping_unique_companies":mapped_companies.len(),"pb_data_rows":result.pb_data_rows,"pb_hydrated":result.pb_hydrated,"pb_unique_companies":pb_companies.len(),"pb_unmatched":result.pb_unmatched,"rogo_rows":result.rogo_rows,"rogo_hydrated":result.rogo_hydrated,"rogo_unique_companies":rogo_companies.len(),"rogo_unmatched":result.rogo_unmatched,"quarantined":result.quarantined,"parquet_files":parquet_paths.iter().map(|p|p.to_string_lossy().to_string()).collect::<Vec<_>>() }),
        )
    }

    fn export_candidate_set(&self, args: ExportCandidateSetArgs) -> Result<Value> {
        let export_type = args.export_type.to_ascii_uppercase();
        if !matches!(export_type.as_str(), "PITCHBOOK" | "LLM" | "FULL") {
            return Err(Error::Validation(
                "export_type must be PITCHBOOK, LLM or FULL".into(),
            ));
        }
        let file_name = args.file_name.unwrap_or_else(|| {
            format!(
                "{}-{}-{}.xlsx",
                args.run_id,
                export_type.to_ascii_lowercase(),
                Uuid::new_v4()
            )
        });
        if !file_name.to_ascii_lowercase().ends_with(".xlsx") {
            return Err(Error::Validation(
                "export filename must end in .xlsx".into(),
            ));
        }
        let path = tabular::resolve_export_path(&file_name)?;
        if path.exists() {
            return Err(Error::Conflict(format!(
                "export file already exists: {}",
                path.display()
            )));
        }
        let temporary = path.with_file_name(format!(
            ".{}-{}.tmp.xlsx",
            Uuid::new_v4(),
            export_type.to_ascii_lowercase()
        ));
        if export_type == "FULL" {
            let outcome = self.store.with_connection(|connection| {
                write_full_export(connection, &args.run_id, &temporary)
            });
            let (companies, mid_rows, iscc_rows) = match outcome {
                Ok(outcome) => outcome,
                Err(error) => {
                    let _ = std::fs::remove_file(&temporary);
                    return Err(error);
                }
            };
            publish_export(&temporary, &path)?;
            return Ok(
                json!({"run_id":args.run_id,"export_type":export_type,"path":path.to_string_lossy(),"companies":companies,"mid_rows":mid_rows,"iscc_rows":iscc_rows}),
            );
        }
        let data=self.store.with_connection(|connection|{
            require_run(connection,&args.run_id)?;
            let mut statement=connection.prepare("SELECT c.company_id,c.name,c.website,c.city,c.description,json_extract(c.metadata_json,'$.hq_state') FROM candidates x JOIN companies c ON c.company_id=x.company_id WHERE x.run_id=? ORDER BY c.company_id")?;
            let companies=statement.query_map([&args.run_id],|r|Ok(ExportCompany{company_id:r.get(0)?,name:r.get(1)?,website:r.get(2)?,city:r.get(3)?,description:r.get(4)?,state:r.get(5)?}))?
                .collect::<std::result::Result<Vec<_>,_>>()?;
            let mut sources=HashMap::new();
            let mut source_query=connection.prepare("SELECT c.company_id,MAX(CASE WHEN s.source='MID' THEN 1 ELSE 0 END),MAX(CASE WHEN s.source='ISCC' AND s.run_scope=? THEN 1 ELSE 0 END) FROM candidates c LEFT JOIN source_rows s ON s.company_id=c.company_id WHERE c.run_id=? GROUP BY c.company_id")?;
            for row in source_query.query_map(params![args.run_id,args.run_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?)))? {
                let (id,mid,iscc)=row?;
                sources.insert(id,match(mid!=0,iscc!=0){(true,true)=>"both",(true,false)=>"MID",(false,true)=>"ISCC",_=>"UNKNOWN"}.to_owned());
            }
            let mut raw_mid=Vec::new();let mut raw_iscc=Vec::new();
            if export_type=="FULL" {
                let mut statement=connection.prepare("SELECT s.source,s.company_id,s.row_json FROM source_rows s JOIN candidates c ON c.company_id=s.company_id WHERE c.run_id=? AND (s.source='MID' OR s.run_scope=c.run_id) ORDER BY s.source,s.company_id,s.imported_at")?;
                for row in statement.query_map([&args.run_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))? {
                    let (source,company_id,json)=row?;
                    let record=(company_id,serde_json::from_str::<Value>(&json)?);
                    if source=="MID"{raw_mid.push(record);}else{raw_iscc.push(record);}
                }
            }
            Ok((companies,sources,raw_mid,raw_iscc))
        })?;
        if data.0.len() >= 1_048_576 || data.2.len() >= 1_048_576 || data.3.len() >= 1_048_576 {
            return Err(Error::Validation("Excel sheet row limit exceeded".into()));
        }
        let written = write_export(&temporary, &export_type, &data);
        if let Err(error) = written {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        publish_export(&temporary, &path)?;
        Ok(
            json!({"run_id":args.run_id,"export_type":export_type,"path":path.to_string_lossy(),"companies":data.0.len(),"mid_rows":data.2.len(),"iscc_rows":data.3.len()}),
        )
    }
}

fn source_value_present(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(text) => {
            let compact = text.trim().to_ascii_uppercase().replace(' ', "");
            !matches!(
                compact.as_str(),
                "" | "-"
                    | "--"
                    | "N/A"
                    | "NA"
                    | "#N/A"
                    | "NULL"
                    | "NONE"
                    | "NAN"
                    | "UNDEFINED"
                    | "NOTAVAILABLE"
            )
        }
        _ => true,
    }
}

fn hydrate_pb_parquet(
    rows: &mut [Value],
    locators: BTreeMap<String, Vec<(usize, String, usize)>>,
) -> Result<()> {
    use parquet::{
        file::reader::{FileReader, SerializedFileReader},
        record::Field,
    };
    use std::fs::File;
    let mut wide_by_row = vec![BTreeMap::<usize, Value>::new(); rows.len()];
    for (stored_path, requested) in locators {
        let path = tabular::resolve_export_path(&stored_path)?;
        let file = File::open(&path).map_err(|error| {
            Error::Internal(format!(
                "PitchBook Parquet file {} cannot be opened: {error}",
                path.display()
            ))
        })?;
        let reader = SerializedFileReader::new(file).map_err(|error| {
            Error::Internal(format!(
                "PitchBook Parquet file {} is corrupt: {error}",
                path.display()
            ))
        })?;
        let metadata = reader
            .metadata()
            .file_metadata()
            .key_value_metadata()
            .and_then(|items| items.iter().find(|item| item.key == "original_columns"))
            .and_then(|item| item.value.as_deref())
            .ok_or_else(|| {
                Error::Internal(format!(
                    "PitchBook Parquet file {} lacks original columns",
                    path.display()
                ))
            })?;
        let columns: Vec<String> = serde_json::from_str(metadata)?;
        let mut wanted = HashMap::<String, Vec<(usize, usize)>>::new();
        for (index, hash, rank) in requested {
            wanted.entry(hash).or_default().push((index, rank));
        }
        let mut found = BTreeSet::new();
        for record in reader
            .get_row_iter(None)
            .map_err(|error| Error::Internal(format!("PitchBook Parquet scan failed: {error}")))?
        {
            let record = record.map_err(|error| {
                Error::Internal(format!("PitchBook Parquet row is corrupt: {error}"))
            })?;
            let mut original = serde_json::Map::new();
            for (column, (_, field)) in columns.iter().zip(record.get_column_iter()) {
                match field {
                    Field::Null => {
                        original.insert(column.clone(), json!(""));
                    }
                    Field::Str(value) => {
                        original.insert(column.clone(), json!(value));
                    }
                    other => {
                        return Err(Error::Internal(format!(
                            "unexpected PitchBook Parquet field {other:?}"
                        )))
                    }
                }
            }
            let value = Value::Object(original);
            let row_hash = hex_hash(serde_json::to_string(&value)?.as_bytes());
            if let Some(targets) = wanted.get(&row_hash) {
                for (index, rank) in targets {
                    wide_by_row[*index].insert(*rank, value.clone());
                }
                found.insert(row_hash);
            }
        }
        for row_hash in wanted.keys() {
            if !found.contains(row_hash) {
                return Err(Error::Internal(format!(
                    "PitchBook row {row_hash} is missing from Parquet file {}",
                    path.display()
                )));
            }
        }
    }
    for (row, wide_rows) in rows.iter_mut().zip(wide_by_row) {
        let pb = row["sources"]["PB"].as_object_mut().expect("PB object");
        for (_, wide) in wide_rows {
            for (column, value) in wide.as_object().expect("wide PB object") {
                if pb
                    .get(column)
                    .is_none_or(|existing| !source_value_present(existing))
                {
                    pb.insert(column.clone(), value.clone());
                }
            }
        }
    }
    Ok(())
}

#[derive(Default)]
struct IngestCounters {
    processed: usize,
    inserted: usize,
    matched: usize,
    promoted: usize,
    quarantined: usize,
    source_rows_added: usize,
}
#[derive(Default)]
struct EnrichmentCounters {
    mapping_rows: usize,
    mapping_skipped_non_company: usize,
    pbid_populated: usize,
    pb_data_rows: usize,
    pb_hydrated: usize,
    pb_unmatched: usize,
    rogo_rows: usize,
    rogo_hydrated: usize,
    rogo_unmatched: usize,
    quarantined: usize,
}
struct ExportCompany {
    company_id: String,
    name: String,
    website: Option<String>,
    city: Option<String>,
    description: Option<String>,
    state: Option<String>,
}
struct IdentityResult {
    company_id: String,
    created: bool,
    promoted: bool,
}

fn parse<T: serde::de::DeserializeOwned>(arguments: &Value) -> Result<T> {
    Ok(serde_json::from_value(arguments.clone())?)
}
fn validate_files(files: &[String]) -> Result<()> {
    if files.is_empty() || files.len() > tabular::MAX_FILES {
        Err(Error::Validation(format!(
            "files must contain 1..={} paths",
            tabular::MAX_FILES
        )))
    } else {
        Ok(())
    }
}
fn now() -> String {
    Utc::now().to_rfc3339()
}
fn id(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::new_v4())
}
fn hex_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn json_fingerprint(value: &impl Serialize) -> Result<String> {
    struct DigestWriter(Sha256);
    impl std::io::Write for DigestWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = DigestWriter(Sha256::new());
    serde_json::to_writer(&mut writer, value)?;
    Ok(format!("{:x}", writer.0.finalize()))
}

fn retain_best_score(scores: &mut BTreeMap<String, Option<f64>>, id: String, score: Option<f64>) {
    scores
        .entry(id)
        .and_modify(|old| {
            if score.is_some_and(|value| old.is_none_or(|existing| value > existing)) {
                *old = score;
            }
        })
        .or_insert(score);
}
fn as_score(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|x| x.is_finite()),
        Value::String(s) => s.trim().parse::<f64>().ok().filter(|x| x.is_finite()),
        _ => None,
    }
}
fn require_run(connection: &Connection, run_id: &str) -> Result<()> {
    let found: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM screening_runs WHERE run_id=?",
            [run_id],
            |r| r.get(0),
        )
        .optional()?;
    if found.is_some() {
        Ok(())
    } else {
        Err(Error::NotFound(format!("run not found: {run_id}")))
    }
}
fn quarantine(tx: &Transaction<'_>, source: &str, reason: &str, row: &Value) -> Result<()> {
    tx.execute("INSERT INTO identity_quarantine(quarantine_id,source,reason,row_json,created_at) VALUES(?,?,?,?,?)",params![id("Q"),source,reason,serde_json::to_string(row)?,now()])?;
    Ok(())
}
fn has_source(tx: &Transaction<'_>, company_id: &str, source: &str) -> Result<bool> {
    Ok(tx
        .query_row(
            "SELECT 1 FROM source_rows WHERE company_id=? AND source=? LIMIT 1",
            params![company_id, source],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_some())
}

fn lookup_identifier(tx: &Transaction<'_>, kind: &str, value: &str) -> Result<Option<String>> {
    Ok(tx
        .query_row(
            "SELECT company_id FROM company_identifiers WHERE kind=? AND identifier=?",
            params![kind, value],
            |r| r.get(0),
        )
        .optional()?)
}
fn put_identifier(tx: &Transaction<'_>, kind: &str, value: &str, company_id: &str) -> Result<()> {
    if let Some(existing) = lookup_identifier(tx, kind, value)? {
        if existing != company_id {
            return Err(Error::Conflict(format!(
                "{kind} {value} belongs to another company"
            )));
        }
    } else {
        tx.execute("INSERT INTO company_identifiers(kind,identifier,company_id,first_seen_at) VALUES(?,?,?,?)",params![kind,value,company_id,now()])?;
    }
    Ok(())
}

fn resolve_or_create_company(
    tx: &Transaction<'_>,
    key: &str,
    ecid: Option<&str>,
    cid: Option<&str>,
    name: &str,
    source: &str,
    row: &Value,
) -> Result<IdentityResult> {
    let mut matches = BTreeSet::<String>::new();
    for (kind, value) in [("PK", Some(key)), ("ECID", ecid), ("CID", cid)] {
        if let Some(value) = value {
            if let Some(found) = lookup_identifier(tx, kind, value)? {
                matches.insert(found);
            }
        }
    }
    let exact: Option<String> = tx
        .query_row(
            "SELECT company_id FROM companies WHERE company_id=?",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(found) = exact {
        matches.insert(found);
    }
    if matches.len() > 1 {
        return Err(Error::Conflict(format!("identifiers disagree: {key}")));
    }
    let existing = matches.into_iter().next();
    let mut created = false;
    let mut promoted = false;
    let company_id = if let Some(mut existing) = existing {
        for (kind, incoming) in [("ECID", ecid), ("CID", cid)] {
            if let Some(incoming) = incoming {
                let registered:Option<String>=tx.query_row("SELECT identifier FROM company_identifiers WHERE company_id=? AND kind=? LIMIT 1",params![existing,kind],|r|r.get(0)).optional()?;
                if registered.as_deref().is_some_and(|value| value != incoming) {
                    return Err(Error::Conflict(format!(
                        "concatenated key {key} collides with registered {kind}"
                    )));
                }
            }
        }
        if ecid.is_some() && cid.is_some() && existing != key && is_provisional(&existing) {
            promote_company(tx, &existing, key)?;
            existing = key.to_owned();
            promoted = true;
        } else if ecid.is_some() && cid.is_some() && existing != key && !is_provisional(&existing) {
            return Err(Error::Conflict(format!(
                "{key} conflicts with existing company {existing}"
            )));
        }
        existing
    } else {
        let website = field_text(row, &["Website", "Company Website"]);
        let city = field_text(row, &["HQ City", "City"]);
        let description = field_text(
            row,
            &["Description", "Descriptions", "Business Description"],
        );
        let metadata = json!({"source":source,"hq_state":field_text(row,&["HQ State","State"])});
        tx.execute("INSERT INTO companies(company_id,name,website,city,description,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",params![key,name,website,city,description,metadata.to_string(),now(),now()])?;
        created = true;
        key.to_owned()
    };
    put_identifier(tx, "PK", key, &company_id)?;
    if let Some(ecid) = ecid {
        put_identifier(tx, "ECID", ecid, &company_id)?;
    }
    if let Some(cid) = cid {
        put_identifier(tx, "CID", cid, &company_id)?;
    }
    Ok(IdentityResult {
        company_id,
        created,
        promoted,
    })
}

fn is_provisional(id: &str) -> bool {
    id.starts_with("X-") || id.ends_with("-X")
}

fn promote_company(tx: &Transaction<'_>, old: &str, new: &str) -> Result<()> {
    if tx
        .query_row("SELECT 1 FROM companies WHERE company_id=?", [new], |r| {
            r.get::<_, i64>(0)
        })
        .optional()?
        .is_some()
    {
        return Err(Error::Conflict(format!(
            "new company key already exists: {new}"
        )));
    }
    tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
    tx.execute(
        "UPDATE companies SET company_id=?,updated_at=? WHERE company_id=?",
        params![new, now(), old],
    )?;
    // 002 tables use ON UPDATE CASCADE. These older references do not.
    for table in [
        "company_labels",
        "evidence",
        "candidates",
        "candidate_discovery",
        "research_questions",
        "meilisearch_sync_state",
    ] {
        tx.execute(
            &format!("UPDATE {table} SET company_id=? WHERE company_id=?"),
            params![new, old],
        )?;
    }
    put_identifier(tx, "PK", old, new)?;
    Ok(())
}

fn update_canonical(
    tx: &Transaction<'_>,
    company_id: &str,
    source: &str,
    row: &Value,
) -> Result<()> {
    let name = field_text(
        row,
        &["Company Name", "Company", "Name", "Companies", "Firm Name"],
    );
    let website = field_text(row, &["Website", "Company Website"]);
    let city = field_text(row, &["HQ City", "City"]);
    let description = field_text(
        row,
        &["Description", "Descriptions", "Business Description"],
    );
    let state = field_text(row, &["HQ State", "State"]);
    tx.execute("UPDATE companies SET name=COALESCE(?,name),website=COALESCE(?,website),city=COALESCE(?,city),description=COALESCE(?,description),metadata_json=json_set(metadata_json,'$.preferred_source',?,'$.hq_state',COALESCE(?,json_extract(metadata_json,'$.hq_state'))),updated_at=? WHERE company_id=?",params![name,website,city,description,source,state,now(),company_id])?;
    Ok(())
}

fn resolve_pk_in_tx(tx: &Transaction<'_>, provided: &str) -> Result<Option<String>> {
    let normalized = provided.trim().to_ascii_uppercase();
    if let Some(found) = tx
        .query_row(
            "SELECT company_id FROM companies WHERE company_id=?",
            [&normalized],
            |r| r.get(0),
        )
        .optional()?
    {
        return Ok(Some(found));
    }
    lookup_identifier(tx, "PK", &normalized)
}

fn save_enrichment_row(
    tx: &Transaction<'_>,
    kind: &str,
    company_id: Option<&str>,
    row: &Value,
    parquet_path: Option<&Path>,
) -> Result<()> {
    let raw = serde_json::to_string(row)?;
    let fingerprint = hex_hash(raw.as_bytes());
    let stored = if kind == "PB_DATA" {
        // The wide PitchBook row lives in Parquet; SQLite only keeps a compact
        // locator so a 160-column sheet is not duplicated in the database.
        json!({"Company ID":field_text(row,&["Company ID"]),"row_hash":fingerprint}).to_string()
    } else {
        raw
    };
    tx.execute("INSERT INTO enrichment_rows(enrichment_id,kind,company_id,row_hash,row_json,parquet_path,imported_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,row_hash) DO UPDATE SET company_id=COALESCE(excluded.company_id,enrichment_rows.company_id),parquet_path=COALESCE(excluded.parquet_path,enrichment_rows.parquet_path)",
        params![id("ENR"),kind,company_id,fingerprint,stored,parquet_path.map(|p|p.to_string_lossy().to_string()),now()])?;
    Ok(())
}

fn upsert_pb_compact(tx: &Transaction<'_>, company_id: &str, row: &Value) -> Result<()> {
    tx.execute("INSERT INTO company_enrichment(company_id,pb_website,pb_name,pb_description,pb_linkedin_url,pb_hq_location,pb_active_investors,pb_universe,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id) DO UPDATE SET pb_website=COALESCE(excluded.pb_website,company_enrichment.pb_website),pb_name=COALESCE(excluded.pb_name,company_enrichment.pb_name),pb_description=COALESCE(excluded.pb_description,company_enrichment.pb_description),pb_linkedin_url=COALESCE(excluded.pb_linkedin_url,company_enrichment.pb_linkedin_url),pb_hq_location=COALESCE(excluded.pb_hq_location,company_enrichment.pb_hq_location),pb_active_investors=COALESCE(excluded.pb_active_investors,company_enrichment.pb_active_investors),pb_universe=COALESCE(excluded.pb_universe,company_enrichment.pb_universe),updated_at=excluded.updated_at",
        params![company_id,field_text(row,&["Website"]),field_text(row,&["Companies"]),field_text(row,&["Description"]),field_text(row,&["LinkedIn URL"]),field_text(row,&["HQ Location"]),field_text(row,&["Active Investors"]),field_text(row,&["Universe"]),now()])?;
    Ok(())
}

fn normalize_website(site: &str) -> Option<String> {
    let site = site.trim();
    if site.is_empty() {
        return None;
    }
    let candidate = if site.contains("://") {
        site.to_owned()
    } else {
        format!("https://{site}")
    };
    let parsed = url::Url::parse(&candidate).ok()?;
    let host = parsed
        .host_str()?
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

type WebsiteMap = HashMap<String, Vec<String>>;

fn website_maps(tx: &Transaction<'_>, run_id: &str) -> Result<(WebsiteMap, WebsiteMap)> {
    let mut pb = HashMap::<String, Vec<String>>::new();
    let mut statement=tx.prepare("SELECT e.company_id,e.pb_website FROM company_enrichment e JOIN candidates c ON c.company_id=e.company_id WHERE c.run_id=? AND e.pb_website IS NOT NULL")?;
    for row in statement.query_map([run_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (id, site) = row?;
        if let Some(key) = normalize_website(&site) {
            pb.entry(key).or_default().push(id);
        }
    }
    let mut canonical = HashMap::<String, Vec<String>>::new();
    let mut statement=tx.prepare("SELECT c.company_id,c.website,e.pb_website FROM companies c JOIN candidates x ON x.company_id=c.company_id LEFT JOIN company_enrichment e ON e.company_id=c.company_id WHERE x.run_id=? AND c.website IS NOT NULL")?;
    for row in statement.query_map([run_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })? {
        let (id, site, pb_site) = row?;
        let old = normalize_website(&site);
        let preferred = pb_site.as_deref().and_then(normalize_website);
        if let Some(key) = old.filter(|old| preferred.as_ref().is_none_or(|new| new == old)) {
            canonical.entry(key).or_default().push(id);
        }
    }
    Ok((pb, canonical))
}

fn is_candidate(tx: &Transaction<'_>, run_id: &str, company_id: &str) -> Result<bool> {
    Ok(tx
        .query_row(
            "SELECT 1 FROM candidates WHERE run_id=? AND company_id=?",
            params![run_id, company_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_some())
}

fn merge_rogo(tx: &Transaction<'_>, company_id: &str, row: &Value) -> Result<()> {
    let old: Option<String> = tx
        .query_row(
            "SELECT rogo_json FROM company_enrichment WHERE company_id=?",
            [company_id],
            |r| r.get(0),
        )
        .optional()?;
    let mut merged = old
        .map(|s| serde_json::from_str::<Value>(&s))
        .transpose()?
        .unwrap_or_else(|| json!({}));
    let object = merged
        .as_object_mut()
        .ok_or_else(|| Error::Internal("invalid ROGO JSON".into()))?;
    for (key, value) in row
        .as_object()
        .ok_or_else(|| Error::Validation("ROGO row must be an object".into()))?
    {
        if !matches!(normalize_header(key).as_str(), "website" | "websites")
            && !value.as_str().is_some_and(|v| v.trim().is_empty())
        {
            object.insert(key.clone(), value.clone());
        }
    }
    tx.execute("INSERT INTO company_enrichment(company_id,rogo_json,updated_at) VALUES(?,?,?) ON CONFLICT(company_id) DO UPDATE SET rogo_json=excluded.rogo_json,updated_at=excluded.updated_at",params![company_id,merged.to_string(),now()])?;
    Ok(())
}

fn write_json_parquet(path: &Path, rows: &[Value]) -> Result<()> {
    use parquet::{
        data_type::ByteArray,
        data_type::ByteArrayType,
        file::{metadata::KeyValue, properties::WriterProperties, writer::SerializedFileWriter},
        schema::parser::parse_message_type,
    };
    use std::{fs::File, sync::Arc};
    let mut column_names = BTreeSet::<String>::new();
    for row in rows {
        if let Some(object) = row.as_object() {
            column_names.extend(object.keys().cloned());
        }
    }
    if column_names.is_empty() {
        return Err(Error::Validation(
            "PitchBook data sheet has no columns".into(),
        ));
    }
    if column_names.len() > tabular::MAX_COLUMNS {
        return Err(Error::Validation(
            "PitchBook data sheet has too many columns".into(),
        ));
    }
    let original_columns = column_names.into_iter().collect::<Vec<_>>();
    let schema_text = format!(
        "message raw_pitchbook {{ {} }}",
        (0..original_columns.len())
            .map(|i| format!("OPTIONAL BYTE_ARRAY c{i:04} (UTF8);"))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let schema = Arc::new(
        parse_message_type(&schema_text)
            .map_err(|e| Error::Internal(format!("parquet schema: {e}")))?,
    );
    let props = Arc::new(
        WriterProperties::builder()
            .set_key_value_metadata(Some(vec![KeyValue::new(
                "original_columns".into(),
                serde_json::to_string(&original_columns)?,
            )]))
            .build(),
    );
    let file = File::create(path)?;
    let mut writer = SerializedFileWriter::new(file, schema, props)
        .map_err(|e| Error::Internal(format!("parquet writer: {e}")))?;
    for chunk in rows.chunks(1000) {
        let mut group = writer
            .next_row_group()
            .map_err(|e| Error::Internal(format!("parquet row group: {e}")))?;
        for original in &original_columns {
            let mut column = group
                .next_column()
                .map_err(|e| Error::Internal(format!("parquet column: {e}")))?
                .ok_or_else(|| Error::Internal("parquet column absent".into()))?;
            let mut values = Vec::new();
            let mut levels = Vec::new();
            for row in chunk {
                let value = row.get(original).and_then(|v| match v {
                    Value::Null => None,
                    Value::String(s) if s.is_empty() => None,
                    Value::String(s) => Some(s.clone()),
                    other => Some(other.to_string()),
                });
                if let Some(value) = value {
                    values.push(ByteArray::from(value.into_bytes()));
                    levels.push(1_i16);
                } else {
                    levels.push(0_i16);
                }
            }
            column
                .typed::<ByteArrayType>()
                .write_batch(&values, Some(&levels), None)
                .map_err(|e| Error::Internal(format!("parquet write: {e}")))?;
            column
                .close()
                .map_err(|e| Error::Internal(format!("parquet column close: {e}")))?;
        }
        group
            .close()
            .map_err(|e| Error::Internal(format!("parquet group close: {e}")))?;
    }
    writer
        .close()
        .map_err(|e| Error::Internal(format!("parquet close: {e}")))?;
    Ok(())
}

type ExportData = (
    Vec<ExportCompany>,
    HashMap<String, String>,
    Vec<(String, Value)>,
    Vec<(String, Value)>,
);

fn publish_export(temporary: &Path, target: &Path) -> Result<()> {
    let published = std::fs::hard_link(temporary, target);
    let _ = std::fs::remove_file(temporary);
    if let Err(error) = published {
        if target.exists() {
            return Err(Error::Conflict(format!(
                "export file already exists: {}",
                target.display()
            )));
        }
        return Err(Error::Io(error));
    }
    Ok(())
}

fn write_full_export(
    connection: &Connection,
    run_id: &str,
    path: &Path,
) -> Result<(usize, usize, usize)> {
    use rust_xlsxwriter::Workbook;
    require_run(connection, run_id)?;
    let companies: usize = connection.query_row(
        "SELECT COUNT(*) FROM candidates WHERE run_id=?",
        [run_id],
        |r| r.get(0),
    )?;
    let mut workbook = Workbook::new();
    let mut counts = [0usize, 0usize];
    for (index, source) in ["MID", "ISCC"].iter().enumerate() {
        let sql="SELECT s.company_id,s.row_json FROM source_rows s JOIN candidates c ON c.company_id=s.company_id WHERE c.run_id=? AND s.source=? AND (s.source='MID' OR s.run_scope=c.run_id) ORDER BY s.company_id,s.imported_at,s.source_row_id";
        let mut headers = BTreeSet::<String>::new();
        let mut statement = connection.prepare(sql)?;
        for raw in statement.query_map(params![run_id, source], |r| r.get::<_, String>(1))? {
            let row: Value = serde_json::from_str(&raw?)?;
            if let Some(object) = row.as_object() {
                headers.extend(object.keys().cloned());
            }
            counts[index] += 1;
            if counts[index] >= 1_048_576 {
                return Err(Error::Validation(format!(
                    "{source} export exceeds Excel sheet row limit"
                )));
            }
        }
        let headers = headers.into_iter().collect::<Vec<_>>();
        let sheet = workbook.add_worksheet_with_constant_memory();
        sheet.set_name(*source).map_err(xlsx_error)?;
        sheet.write_string(0, 0, "pk").map_err(xlsx_error)?;
        for (col, header) in headers.iter().enumerate() {
            sheet
                .write_string(0, (col + 1) as u16, header)
                .map_err(xlsx_error)?;
        }
        let mut statement = connection.prepare(sql)?;
        for (row_number, record) in
            (1u32..).zip(statement.query_map(params![run_id, source], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?)
        {
            let (company_id, raw) = record?;
            let row: Value = serde_json::from_str(&raw)?;
            sheet
                .write_string(
                    row_number,
                    0,
                    crate::identity::safe_spreadsheet_text(&company_id),
                )
                .map_err(xlsx_error)?;
            for (col, header) in headers.iter().enumerate() {
                let value = row
                    .get(header)
                    .map(|v| {
                        v.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| v.to_string())
                    })
                    .unwrap_or_default();
                sheet
                    .write_string(
                        row_number,
                        (col + 1) as u16,
                        crate::identity::safe_spreadsheet_text(&value),
                    )
                    .map_err(xlsx_error)?;
            }
        }
    }
    workbook.save(path).map_err(xlsx_error)?;
    Ok((companies, counts[0], counts[1]))
}

fn write_export(path: &Path, kind: &str, data: &ExportData) -> Result<()> {
    use rust_xlsxwriter::Workbook;
    let mut workbook = Workbook::new();
    if kind == "PITCHBOOK" || kind == "LLM" {
        let sheet = workbook.add_worksheet_with_constant_memory();
        sheet.set_name(kind).map_err(xlsx_error)?;
        let headers = if kind == "PITCHBOOK" {
            vec![
                "pk",
                "Company Name",
                "Website",
                "HQ City",
                "HQ State",
                "Source",
            ]
        } else {
            vec![
                "index",
                "pk",
                "Company Name",
                "Website",
                "Source",
                "Description",
            ]
        };
        for (col, header) in headers.iter().enumerate() {
            sheet
                .write_string(0, col as u16, *header)
                .map_err(xlsx_error)?;
        }
        for (i, company) in data.0.iter().enumerate() {
            let source = data
                .1
                .get(&company.company_id)
                .map(String::as_str)
                .unwrap_or("UNKNOWN");
            let values = if kind == "PITCHBOOK" {
                vec![
                    company.company_id.as_str(),
                    company.name.as_str(),
                    company.website.as_deref().unwrap_or(""),
                    company.city.as_deref().unwrap_or(""),
                    company.state.as_deref().unwrap_or(""),
                    source,
                ]
            } else {
                vec![
                    "",
                    company.company_id.as_str(),
                    company.name.as_str(),
                    company.website.as_deref().unwrap_or(""),
                    source,
                    company.description.as_deref().unwrap_or(""),
                ]
            };
            for (col, value) in values.iter().enumerate() {
                if kind == "LLM" && col == 0 {
                    sheet
                        .write_number((i + 1) as u32, 0, (i + 1) as f64)
                        .map_err(xlsx_error)?;
                } else {
                    sheet
                        .write_string(
                            (i + 1) as u32,
                            col as u16,
                            crate::identity::safe_spreadsheet_text(value),
                        )
                        .map_err(xlsx_error)?;
                }
            }
        }
    } else {
        for (name, rows) in [("MID", &data.2), ("ISCC", &data.3)] {
            let sheet = workbook.add_worksheet();
            sheet.set_name(name).map_err(xlsx_error)?;
            let mut headers = BTreeSet::<String>::new();
            for (_, row) in rows {
                if let Some(obj) = row.as_object() {
                    headers.extend(obj.keys().cloned());
                }
            }
            let headers = headers.into_iter().collect::<Vec<_>>();
            sheet.write_string(0, 0, "pk").map_err(xlsx_error)?;
            for (col, header) in headers.iter().enumerate() {
                sheet
                    .write_string(0, (col + 1) as u16, header)
                    .map_err(xlsx_error)?;
            }
            for (i, (company_id, row)) in rows.iter().enumerate() {
                sheet
                    .write_string(
                        (i + 1) as u32,
                        0,
                        crate::identity::safe_spreadsheet_text(company_id),
                    )
                    .map_err(xlsx_error)?;
                for (col, header) in headers.iter().enumerate() {
                    let value = row
                        .get(header)
                        .map(|v| {
                            v.as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| v.to_string())
                        })
                        .unwrap_or_default();
                    sheet
                        .write_string(
                            (i + 1) as u32,
                            (col + 1) as u16,
                            crate::identity::safe_spreadsheet_text(&value),
                        )
                        .map_err(xlsx_error)?;
                }
            }
        }
    }
    workbook.save(path).map_err(xlsx_error)?;
    Ok(())
}
fn xlsx_error(error: rust_xlsxwriter::XlsxError) -> Error {
    Error::Internal(format!("xlsx export: {error}"))
}

/// Read source rows under the caller's SQLite snapshot. The public page tool
/// remains bounded; prepared plans use this within their transaction.
pub(crate) fn candidate_source_page(
    connection: &Connection,
    run_id: &str,
    after_company_id: Option<&str>,
    limit: usize,
    enforce_page_limit: bool,
) -> Result<Value> {
    require_run(connection, run_id)?;
    if let Some(cursor) = &after_company_id {
        let exists: Option<i64> = connection
            .query_row(
                "SELECT 1 FROM candidates WHERE run_id=? AND company_id=?",
                params![run_id, cursor],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(Error::Validation(
                "after_company_id is not a candidate in this run".into(),
            ));
        }
    }
    let total: i64 = connection.query_row(
        "SELECT COUNT(*) FROM candidates WHERE run_id=?",
        [&run_id],
        |row| row.get(0),
    )?;
    let mut statement = connection.prepare(
                "SELECT company_id FROM candidates WHERE run_id=? AND (? IS NULL OR company_id>?) ORDER BY company_id LIMIT ?"
            )?;
    let ids = statement
        .query_map(
            params![
                run_id,
                after_company_id,
                after_company_id,
                (limit + 1) as i64
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let has_more = ids.len() > limit;
    let ids = ids.into_iter().take(limit).collect::<Vec<_>>();
    let mut rows = Vec::with_capacity(ids.len());
    let mut pb_locators = BTreeMap::<String, Vec<(usize, String, usize)>>::new();
    for company_id in &ids {
        let mut sources = json!({"MID":{},"ISCC":{},"PB":{},"ROGO":{}});
        let mut provenance = json!({"MID":[],"ISCC":[],"PB":[],"ROGO":[]});
        for source in ["MID", "ISCC"] {
            let mut query = connection.prepare(
                        "SELECT source_row_id,row_hash,row_json,imported_at,query_scope FROM source_rows WHERE company_id=? AND source=? AND (source='MID' OR run_scope=?) ORDER BY imported_at DESC,source_row_id DESC"
                    )?;
            let records = query
                .query_map(params![company_id, source, run_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let mut merged = serde_json::Map::new();
            let mut headers = BTreeSet::new();
            let mut lineage = Vec::new();
            for (source_row_id, row_hash, raw, imported_at, query_id) in records {
                let value: Value = serde_json::from_str(&raw)?;
                let object = value
                    .as_object()
                    .ok_or_else(|| Error::Internal("stored source row is not an object".into()))?;
                for (key, value) in object {
                    headers.insert(key.clone());
                    if !merged.contains_key(key) && source_value_present(value) {
                        merged.insert(key.clone(), value.clone());
                    }
                }
                lineage.push(json!({"source_row_id":source_row_id,"row_hash":row_hash,"imported_at":imported_at,"query_id":query_id}));
            }
            for key in headers {
                merged.entry(key).or_insert(Value::Null);
            }
            sources[source] = Value::Object(merged);
            provenance[source] = Value::Array(lineage);
        }
        let pbid: Option<String> = connection.query_row(
                    "SELECT identifier FROM company_identifiers WHERE company_id=? AND kind='PBID' ORDER BY identifier LIMIT 1",
                    [company_id], |row| row.get(0),
                ).optional()?;
        let enrichment = connection.query_row(
                    "SELECT pb_website,pb_name,pb_description,pb_linkedin_url,pb_hq_location,pb_active_investors,pb_universe,rogo_json,updated_at FROM company_enrichment WHERE company_id=?",
                    [company_id], |row| Ok((row.get::<_, Option<String>>(0)?,row.get::<_, Option<String>>(1)?,row.get::<_, Option<String>>(2)?,row.get::<_, Option<String>>(3)?,row.get::<_, Option<String>>(4)?,row.get::<_, Option<String>>(5)?,row.get::<_, Option<String>>(6)?,row.get::<_, String>(7)?,row.get::<_, String>(8)?)),
                ).optional()?;
        if let Some((
            website,
            name,
            description,
            linkedin,
            hq,
            investors,
            universe,
            rogo,
            updated_at,
        )) = enrichment
        {
            let compact = [
                ("PB_Website", website),
                ("PB_Name", name),
                ("PB_Description", description),
                ("PB_LinkedIn URL", linkedin),
                ("PB_HQ Location", hq),
                ("PB_Active Investors", investors),
                ("PB_Universe", universe),
            ];
            if compact.iter().any(|(_, value)| value.is_some()) {
                let pb = sources["PB"].as_object_mut().expect("PB object");
                for (key, value) in compact {
                    pb.insert(key.into(), json!(value));
                }
            }
            sources["ROGO"] = serde_json::from_str(&rogo)?;
            provenance["PB_updated_at"] = json!(updated_at);
            provenance["ROGO_updated_at"] = json!(updated_at);
        }
        let mut query = connection.prepare(
                    "SELECT enrichment_id,row_hash,parquet_path,imported_at FROM enrichment_rows WHERE company_id=? AND kind='PB_DATA' ORDER BY imported_at DESC,enrichment_id DESC"
                )?;
        let records = query
            .query_map([company_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (index, (enrichment_id, row_hash, path, imported_at)) in records.into_iter().enumerate()
        {
            let path = path.ok_or_else(|| {
                Error::Internal(format!(
                    "PitchBook row {enrichment_id} has no Parquet locator"
                ))
            })?;
            provenance["PB"].as_array_mut().expect("PB lineage").push(json!({"enrichment_id":enrichment_id,"row_hash":row_hash,"parquet_path":path,"imported_at":imported_at}));
            pb_locators
                .entry(path)
                .or_default()
                .push((rows.len(), row_hash, index));
        }
        let mut query = connection.prepare(
                    "SELECT enrichment_id,row_hash,imported_at FROM enrichment_rows WHERE company_id=? AND kind='ROGO' ORDER BY imported_at DESC,enrichment_id DESC"
                )?;
        let records = query.query_map([company_id], |row| Ok(json!({"enrichment_id":row.get::<_, String>(0)?,"row_hash":row.get::<_, String>(1)?,"imported_at":row.get::<_, String>(2)?})))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
        provenance["ROGO"] = Value::Array(records);
        rows.push(json!({"pk":company_id,"PBId":pbid,"sources":sources,"provenance":provenance}));
    }
    hydrate_pb_parquet(&mut rows, pb_locators)?;
    let next_cursor = if has_more { ids.last().cloned() } else { None };
    let response = json!({"run_id":run_id,"total":total,"rows":rows,"next_cursor":next_cursor});
    if enforce_page_limit && serde_json::to_vec(&response)?.len() > 2 * 1024 * 1024 {
        return Err(Error::Validation(
            "candidate source page exceeds 2 MB; retry with a smaller limit".into(),
        ));
    }
    Ok(response)
}
