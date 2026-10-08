use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

use mna_tools::{
    data::DataService, grid, mid_config::MidIndexConfig, runtime::ToolCall,
    source_mapping::SourceMapping, Runtime, Store,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

fn fixture() -> Store {
    let store = Store::open(":memory:").unwrap();
    store
        .execute(
            "create_run",
            &json!({"run_id":"R","objective":"Claims software","original_criteria":{}}),
        )
        .unwrap();
    store
}

fn candidate(conn: &Connection, id: &str, considered: bool) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO companies(company_id,name,created_at,updated_at) VALUES(?,?, '2026-01-01','2026-01-01')", params![id,format!("Company {id}")])?;
    conn.execute("INSERT INTO candidates(run_id,company_id,status,discovered_at,updated_at,considered) VALUES('R',?,'DISCOVERED','2026-01-01','2026-01-01',?)",params![id,considered])?;
    Ok(())
}

fn source(
    conn: &Connection,
    id: &str,
    source: &str,
    suffix: &str,
    row: Value,
) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO source_rows(source_row_id,source,run_scope,company_id,row_hash,row_json,imported_at,relevance_score) VALUES(?,?,'R',?,?,?,?,?)",params![format!("{source}-{id}-{suffix}"),source,id,format!("{source}-{id}-{suffix}"),row.to_string(),format!("2026-01-{suffix}T00:00:00Z"),row["Relevancy Score"].as_f64()])?;
    Ok(())
}

fn bundle(conn: &Connection, headers: &[String]) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO mid_bundles(bundle_id,fts_id,name,status,source_file,config_json,config_hash,created_at) VALUES('B',1,'fixture','active','fixture.xlsx',?,'fixture','2026-01-01')",[json!({"workbook_columns":headers}).to_string()])?;
    Ok(())
}

fn page(store: &Store, view: &str) -> Value {
    DataService::new(store.clone())
        .execute("get_screening_grid", &json!({"run_id":"R","view":view}))
        .unwrap()
}

fn ids(page: &Value) -> Vec<String> {
    page["columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_owned())
        .collect()
}

fn scores(page: &Value) -> Vec<String> {
    page["columns"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["group"] == "scores")
        .map(|c| c["id"].as_str().unwrap().to_owned())
        .collect()
}

fn group<'a>(page: &'a Value, id: &str) -> &'a str {
    page["columns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap()["group"]
        .as_str()
        .unwrap()
}

fn seed_both(store: &Store) {
    store.with_connection(|conn| {
        candidate(conn,"C1",true)?;
        let mapping = SourceMapping::load()?;
        let mut mid = json!({"Unmapped MID":"MID only","Company Description":"MID description","Annual Revenue":"1,234.5","Banker Name":"Banker A","Last Call Date":"10/08/2026"});
        let mut iscc = json!({"Unmapped ISCC":"ISCC only","iQ Link":"discard","Company Description":"ISCC description","Quality of Connection":"Good","CB Banker":"Banker B","Total R12 Call Count":4,"Last Call Date":"2026-10-07","Relevancy Score":0.72});
        for (from,to) in &mapping.iscc_to_mid {
            mid[to] = json!(format!("MID {to}"));
            iscc[from] = json!(format!("ISCC {from}"));
        }
        // Missing MID values fall back to the mapped ISCC value, including real zero.
        mid["HQ City"]=Value::Null;
        mid["HQ State"]=json!("-");
        iscc["City"]=json!("ISCC City");
        iscc["State"]=json!("ISCC State");
        bundle(conn,&mid.as_object().unwrap().keys().cloned().collect::<Vec<_>>())?;
        source(conn,"C1","MID","01",mid)?;
        source(conn,"C1","ISCC","01",iscc)?;
        conn.execute("INSERT INTO mid_keyword_queries(query_id,run_id,bundle_id,rationale,keywords_json,expression,created_at) VALUES('Q','R','B','Claims','[]','claims','2026-01-01')",[])?;
        conn.execute("INSERT INTO mid_keyword_hits(query_id,run_id,company_id,matched_json,match_pct,hit_count) VALUES('Q','R','C1','[]',87,1)",[])?;
        conn.execute("INSERT INTO mid_semantic_scores(run_id,company_id,criteria_revision,score,cosine,model,computed_at) VALUES('R','C1',1,8.4,0.84,'fixture','2026-01-01')",[])?;
        conn.execute("INSERT INTO company_enrichment(company_id,pb_name,pb_description,pb_linkedin_url,rogo_json,updated_at) VALUES('C1','PB company','PB description','https://linkedin.example/company',?, '2026-01-01')",[json!({"Revenue":"ROGO revenue","Description":"ROGO description"}).to_string()])?;
        Ok(())
    }).unwrap();
}

#[test]
fn mid_view_has_only_plain_mid_scores_and_all_mid_columns() {
    let store = fixture();
    seed_both(&store);
    let page = page(&store, "mid");
    assert_eq!(scores(&page), ["MID Score", "MID Semantic Score"]);
    assert_eq!(page["rows"][0]["values"]["MID Score"], 0.87);
    assert_eq!(page["rows"][0]["values"]["MID Semantic Score"], 8.4);
    assert!(!ids(&page)
        .iter()
        .any(|id| id.starts_with("MID_") || id.starts_with("ISCC_")));
    assert_eq!(page["rows"][0]["values"]["Unmapped MID"], "MID only");
    assert!(!ids(&page).contains(&"MID keyword match %".to_owned()));
    let config = MidIndexConfig::load().unwrap();
    for column in page["columns"].as_array().unwrap() {
        if config.display_columns.iter().any(|id| column["id"] == *id) {
            assert_eq!(column["default_visible"], true);
        }
    }
}

#[test]
fn iscc_view_has_only_plain_iscc_score_and_drops_iq_link() {
    let store = fixture();
    seed_both(&store);
    let page = page(&store, "iscc");
    assert_eq!(scores(&page), ["ISCC Score"]);
    assert_eq!(page["rows"][0]["values"]["ISCC Score"], 0.72);
    assert!(!ids(&page)
        .iter()
        .any(|id| id.starts_with("MID_") || id.starts_with("ISCC_") || id == "iQ Link"));
    assert_eq!(
        page["rows"][0]["values"]["Company Name"],
        "ISCC Company Name"
    );
}

#[test]
fn all_both_sources_merges_every_mapping_with_mid_precedence_and_prefixed_scores() {
    let store = fixture();
    seed_both(&store);
    let page = page(&store, "all");
    assert_eq!(
        scores(&page),
        ["MID_Keyword Score", "MID_Semantic Score", "ISCC_Score"]
    );
    let values = &page["rows"][0]["values"];
    assert_eq!(values["MID_Keyword Score"], 0.87);
    assert_eq!(values["MID_Semantic Score"], 8.4);
    assert_eq!(values["ISCC_Score"], 0.72);
    let mapping = SourceMapping::load().unwrap();
    for (iscc, mid) in &mapping.iscc_to_mid {
        let expected = match mid.as_str() {
            "HQ City" => "ISCC City".to_owned(),
            "HQ State" => "ISCC State".to_owned(),
            _ => format!("MID {mid}"),
        };
        assert_eq!(values[mid], expected, "mapping {iscc} -> {mid}");
        assert!(!ids(&page).contains(&format!("ISCC_{iscc}")));
        assert!(!ids(&page).contains(&format!("MID_{mid}")));
    }
    assert_eq!(values["MID_Unmapped MID"], "MID only");
    assert_eq!(values["ISCC_Unmapped ISCC"], "ISCC only");
    assert!(!ids(&page).iter().any(|id| id.contains("iQ Link")));
    let unique: HashSet<_> = ids(&page).into_iter().collect();
    assert_eq!(unique.len(), page["columns"].as_array().unwrap().len());
}

#[test]
fn all_mid_only_is_exact_mid_catalog_plus_null_iscc_score() {
    let store = fixture();
    store
        .with_connection(|conn| {
            candidate(conn, "C1", true)?;
            source(
                conn,
                "C1",
                "MID",
                "01",
                json!({"Company":"MID company","Custom":"value"}),
            )?;
            Ok(())
        })
        .unwrap();
    let mid = page(&store, "mid");
    let all = page(&store, "all");
    assert_eq!(
        scores(&all),
        ["MID Score", "MID Semantic Score", "ISCC_Score"]
    );
    let columns: Vec<_> = all["columns"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["id"] != "ISCC_Score")
        .cloned()
        .collect();
    assert_eq!(json!(columns), mid["columns"]);
    let mut values = all["rows"][0]["values"].clone();
    assert_eq!(
        values.as_object_mut().unwrap().remove("ISCC_Score"),
        Some(Value::Null)
    );
    assert_eq!(values, mid["rows"][0]["values"]);
}

#[test]
fn all_iscc_only_is_exact_iscc_catalog_plus_null_mid_scores() {
    let store = fixture();
    store
        .with_connection(|conn| {
            candidate(conn, "C1", true)?;
            source(
                conn,
                "C1",
                "ISCC",
                "01",
                json!({"Company Name":"ISCC company","Relevancy Score":0.0,"iQ Link":"discard"}),
            )?;
            Ok(())
        })
        .unwrap();
    let iscc = page(&store, "iscc");
    let all = page(&store, "all");
    assert_eq!(
        scores(&all),
        ["MID_Keyword Score", "MID_Semantic Score", "ISCC Score"]
    );
    let columns: Vec<_> = all["columns"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["id"] != "MID_Keyword Score" && c["id"] != "MID_Semantic Score")
        .cloned()
        .collect();
    assert_eq!(json!(columns), iscc["columns"]);
    let mut values = all["rows"][0]["values"].clone();
    for id in ["MID_Keyword Score", "MID_Semantic Score"] {
        assert_eq!(
            values.as_object_mut().unwrap().remove(id),
            Some(Value::Null)
        );
    }
    assert_eq!(values, iscc["rows"][0]["values"]);
    assert_eq!(values["ISCC Score"], 0.0);
}

#[test]
fn banker_coverage_is_separate_from_hydration_and_types_are_parsed() {
    let store = fixture();
    seed_both(&store);
    let page = page(&store, "all");
    for id in [
        "MID_Banker Name",
        "MID_Last Call Date",
        "ISCC_CB Banker",
        "ISCC_Quality of Connection",
        "ISCC_Total R12 Call Count",
    ] {
        assert_eq!(group(&page, id), "coverage");
    }
    for id in [
        "PBID",
        "pb_name",
        "pb_description",
        "pb_linkedin_url",
        "rogo_hydrated",
        "rogo_Revenue",
        "bing_hydrated",
    ] {
        assert_eq!(group(&page, id), "hydration");
    }
    assert_eq!(page["rows"][0]["values"]["MID_Annual Revenue"], 1234.5);
    assert_eq!(
        page["rows"][0]["values"]["MID_Last Call Date"],
        "2026-10-08"
    );
    assert_eq!(
        page["rows"][0]["values"]["ISCC_Last Call Date"],
        "2026-10-07"
    );
    assert_eq!(page["rows"][0]["values"]["rogo_Revenue"], "ROGO revenue");
    assert!(page["rows"][0]["values"]
        .get("MID_Company Description")
        .is_none());
    assert!(page["rows"][0]["values"].get("pb_description").is_none());
    let selected = DataService::new(store.clone())
        .execute(
            "get_screening_grid",
            &json!({"run_id":"R","columns":["MID_Company Description","pb_description"]}),
        )
        .unwrap();
    assert_eq!(
        selected["rows"][0]["values"],
        json!({"MID_Company Description":"MID description","pb_description":"PB description"})
    );
    let detail = DataService::new(store)
        .execute(
            "get_company_detail",
            &json!({"run_id":"R","company_id":"C1","view":"all"}),
        )
        .unwrap();
    assert_eq!(
        detail["values"]["MID_Company Description"],
        "MID description"
    );
    assert_eq!(detail["values"]["pb_description"], "PB description");
    assert_eq!(detail["values"]["ISCC_Score"], 0.72);
}

#[test]
fn descriptions_keep_single_and_dual_sources_separate_and_skip_empty_fields() {
    let store = fixture();
    seed_both(&store);
    store.with_connection(|conn| {
        candidate(conn,"C2",true)?; candidate(conn,"C3",false)?;
        source(conn,"C2","MID","01",json!({"Company Description":"MID single","Pitchbook Description":"-","Factset Description":" "}))?;
        source(conn,"C3","ISCC","01",json!({"Company Description":"ISCC single","Offerings":"claims","Pitchbook Description":""}))?;
        Ok(())
    }).unwrap();
    let result = grid::grid_descriptions(
        &store,
        &json!({"run_id":"R","company_ids":["C1","C2","C3","UNKNOWN"]}),
    )
    .unwrap();
    let companies = result["companies"].as_array().unwrap();
    assert_eq!(companies.len(), 3);
    assert_eq!(companies[0]["sources"].as_array().unwrap().len(), 2);
    assert_eq!(
        companies[1]["sources"],
        json!([{"source":"MID","items":[{"label":"Company Description","text":"MID single"}]}])
    );
    assert_eq!(
        companies[2]["sources"],
        json!([{"source":"ISCC","items":[{"label":"Company Description","text":"ISCC single"},{"label":"Offerings","text":"claims"}]}])
    );
    assert!(
        grid::grid_descriptions(&store, &json!({"run_id":"R","company_ids":vec!["C1";501]}))
            .is_err()
    );
}

#[tokio::test]
async fn descriptions_tool_is_registered_and_readable_through_runtime() {
    let store = fixture();
    seed_both(&store);
    let runtime = Runtime::new(store).unwrap();
    let response = runtime
        .execute(ToolCall {
            tool: "get_grid_descriptions".into(),
            arguments: json!({"run_id":"R","company_ids":["C1"]}),
        })
        .await
        .unwrap();
    assert_eq!(
        response["companies"][0]["sources"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let definition = mna_tools::runtime::tool_definitions()
        .into_iter()
        .find(|d| d.name == "get_grid_descriptions")
        .unwrap();
    assert!(!definition.mutates_state);
    assert_eq!(
        definition.input_schema["properties"]["company_ids"]["maxItems"],
        500
    );
}

#[test]
fn rounds_are_present_in_every_view_without_duplicate_score_columns() {
    let store = fixture();
    seed_both(&store);
    store.with_connection(|conn| {
        conn.execute("INSERT INTO prepared_plans(plan_id,run_id,schema_version,digest,status,spec_json,snapshot_json,proposed_at) VALUES('P','R',2,'digest','APPROVED',?,'{}','2026-01-01')",[json!({"output_columns":["Fit","Rationale"],"score_columns":["Fit"]}).to_string()])?;
        conn.execute("INSERT INTO screening_rounds(run_id,round_no,plan_id,provider,created_at) VALUES('R',1,'P','llm_suite','2026-01-01')",[])?;
        conn.execute("INSERT INTO execution_jobs(job_id,plan_id,run_id,ordinal,state,payload_json,input_hash,created_at,updated_at) VALUES('J','P','R',1,'SUCCEEDED','{}','hash','2026-01-01','2026-01-01')",[])?;
        conn.execute("INSERT INTO model_assessments(assessment_id,run_id,plan_id,job_id,company_id,row_index,provider,prompt,result_json,created_at) VALUES('A','R','P','J','C1',1,'llm_suite','Fit',?,'2026-01-01')",[json!({"Fit":"CHECK","Rationale":"Review manually"}).to_string()])?;
        Ok(())
    }).unwrap();
    for view in ["mid", "iscc", "all"] {
        let page = page(&store, view);
        assert_eq!(
            ids(&page)
                .iter()
                .filter(|id| *id == "R1 LLM Suite Fit")
                .count(),
            1
        );
        assert_eq!(page["rows"][0]["values"]["R1 LLM Suite Fit"], "CHECK");
        assert_eq!(
            page["rows"][0]["values"]["R1 LLM Suite Rationale"],
            "Review manually"
        );
    }
}

#[test]
fn latest_source_wins_and_bundle_only_rows_preserve_workbook_order_and_nulls() {
    let store = fixture();
    store.with_connection(|conn| {
        candidate(conn,"C1",true)?; candidate(conn,"C2",false)?;
        bundle(conn,&["Custom Z".into(),"Company".into(),"Annual Revenue".into(),"Last Call Date".into(),"Company Description".into()])?;
        conn.execute("INSERT INTO mid_rows(bundle_id,company_id,row_json,desc_hash) VALUES('B','C1',?,'hash')",[json!({"Custom Z":"bundle","Company":"Bundle company","Annual Revenue":0,"Last Call Date":46303,"Company Description":"Bundle description"}).to_string()])?;
        source(conn,"C2","MID","01",json!({"Custom Z":"old","Company":"old"}))?;
        source(conn,"C2","MID","02",json!({"Custom Z":"new","Company":"new","Annual Revenue":"-"}))?;
        Ok(())
    }).unwrap();
    let data = DataService::new(store.clone());
    let first = data
        .execute(
            "get_screening_grid",
            &json!({"run_id":"R","view":"mid","limit":1}),
        )
        .unwrap();
    assert_eq!(
        &ids(&first)[..5],
        [
            "Custom Z",
            "Company",
            "Annual Revenue",
            "Last Call Date",
            "Company Description"
        ]
    );
    assert_eq!(first["rows"][0]["values"]["Annual Revenue"], 0.0);
    assert!(first["rows"][0]["values"]["Last Call Date"]
        .as_str()
        .unwrap()
        .starts_with("2026-"));
    let next = data
        .execute(
            "get_screening_grid",
            &json!({"run_id":"R","view":"mid","after_company_id":first["next_cursor"],"limit":1}),
        )
        .unwrap();
    assert_eq!(next["rows"][0]["values"]["Custom Z"], "new");
    assert!(next["rows"][0]["values"]["Annual Revenue"].is_null());
    for key in ["source_hash", "criteria_revision", "selection_revision"] {
        assert_eq!(first[key], next[key]);
    }
    assert_eq!(page(&store, "mid")["hidden_count"], 1);
    let visible = data
        .execute(
            "get_screening_grid",
            &json!({"run_id":"R","include_hidden":false}),
        )
        .unwrap();
    assert_eq!(visible["rows"].as_array().unwrap().len(), 1);
    assert_eq!(visible["total"], 2);
    let detail = data
        .execute(
            "get_company_detail",
            &json!({"run_id":"R","company_id":"C1","view":"mid"}),
        )
        .unwrap();
    assert_eq!(
        detail["values"]["Company Description"],
        "Bundle description"
    );
    let description =
        grid::grid_descriptions(&store, &json!({"run_id":"R","company_ids":["C1"]})).unwrap();
    assert_eq!(
        description["companies"][0]["sources"][0]["items"][0]["text"],
        "Bundle description"
    );
}

#[test]
fn oversized_pages_shrink_and_keyset_paging_covers_every_row_once() {
    let store = fixture();
    store.with_connection(|conn| {
        let tx=conn.unchecked_transaction()?;
        for n in 0..180 {
            let id=format!("C{n:04}"); candidate(&tx,&id,true)?;
            source(&tx,&id,"MID","01",json!({"Company":id,"Company Description":"description".repeat(1500),"Wide text":"wide".repeat(3000)}))?;
        }
        tx.commit()?; Ok(())
    }).unwrap();
    let data = DataService::new(store);
    for payload in [false, true] {
        let mut cursor = Value::Null;
        let mut seen = HashSet::new();
        let mut pages = 0;
        loop {
            let result=data.execute("get_screening_grid",&json!({"run_id":"R","view":"mid","limit":500,"after_company_id":cursor,"include_company_payload":payload})).unwrap();
            let rows = result["rows"].as_array().unwrap();
            assert!(!rows.is_empty());
            assert!(serde_json::to_vec(&result).unwrap().len() <= 1536 * 1024);
            if pages == 0 {
                assert!(rows.len() < 180);
                assert!(!result["next_cursor"].is_null());
            }
            for row in rows {
                assert!(seen.insert(row["company_id"].as_str().unwrap().to_owned()));
            }
            pages += 1;
            cursor = result["next_cursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        assert!(pages > 1);
        assert_eq!(seen.len(), 180);
    }
}

#[test]
fn a_single_large_row_advances_without_soft_size_error() {
    let store = fixture();
    store
        .with_connection(|conn| {
            candidate(conn, "C1", true)?;
            candidate(conn, "C2", true)?;
            source(
                conn,
                "C1",
                "MID",
                "01",
                json!({"Large field":"x".repeat(2*1024*1024)}),
            )?;
            source(conn, "C2", "MID", "01", json!({"Large field":"small"}))?;
            Ok(())
        })
        .unwrap();
    let data = DataService::new(store);
    let result = data
        .execute("get_screening_grid", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(result["rows"].as_array().unwrap().len(), 1);
    assert_eq!(result["next_cursor"], "C1");
    assert!(serde_json::to_vec(&result).unwrap().len() > 1536 * 1024);
    let result = data
        .execute(
            "get_screening_grid",
            &json!({"run_id":"R","after_company_id":"C1"}),
        )
        .unwrap();
    assert_eq!(result["rows"][0]["company_id"], "C2");
    assert!(result["next_cursor"].is_null());
}

#[test]
fn grid_page_500_of_6000_candidates_with_75_workbook_columns_is_fast() {
    let store = fixture();
    store.with_connection(|conn| {
        let tx=conn.unchecked_transaction()?;
        let headers:Vec<_>=(0..75).map(|n|format!("Column {n:02}")).collect();
        bundle(&tx,&headers)?;
        let mut row=json!({});for name in &headers{row[name]=json!("value");}
        let raw=row.to_string();
        let mut companies=tx.prepare("INSERT INTO companies(company_id,name,created_at,updated_at) VALUES(?,'Claims company','2026-01-01','2026-01-01')")?;
        let mut candidates=tx.prepare("INSERT INTO candidates(run_id,company_id,status,discovered_at,updated_at) VALUES('R',?,'DISCOVERED','2026-01-01','2026-01-01')")?;
        let mut sources=tx.prepare("INSERT INTO source_rows(source_row_id,source,company_id,row_hash,row_json,imported_at) VALUES(?,'MID',?,?,?,'2026-01-01')")?;
        for n in 0..6000 {
            let id=format!("C{n:05}");companies.execute([&id])?;candidates.execute([&id])?;sources.execute(params![id,id,id,raw])?;
        }
        drop(companies);drop(candidates);drop(sources);tx.commit()?;Ok(())
    }).unwrap();
    let started = Instant::now();
    let result = DataService::new(store)
        .execute("get_screening_grid", &json!({"run_id":"R","limit":500}))
        .unwrap();
    let elapsed = started.elapsed();
    println!(
        "grid_v3 debug page: 500 of 6000 candidates, 75 MID columns: {:.2} ms",
        elapsed.as_secs_f64() * 1000.0
    );
    assert_eq!(result["rows"].as_array().unwrap().len(), 500);
    assert_eq!(result["total"], 6000);
    assert!(!result["next_cursor"].is_null());
    assert!(elapsed < Duration::from_secs(3), "page took {elapsed:?}");
}

#[test]
fn identity_falls_back_and_unparsed_typed_values_stay_text() {
    let store = fixture();
    store.with_connection(|conn| {
        candidate(conn,"C1",true)?;
        bundle(conn,&["Company".into(),"Annual Revenue".into(),"Last Call Date".into(),"Description".into()])?;
        source(conn,"C1","MID","01",json!({"Annual Revenue":"unknown","Last Call Date":"invalid","Description":"large text"}))?;
        Ok(())
    }).unwrap();
    let result = page(&store, "mid");
    assert_eq!(result["rows"][0]["values"]["Company"], "Company C1");
    assert_eq!(result["rows"][0]["values"]["Annual Revenue"], "unknown");
    assert_eq!(result["rows"][0]["values"]["Last Call Date"], "invalid");
    assert!(result["rows"][0]["values"].get("Description").is_none());
}

#[test]
fn source_aliases_and_run_scopes_are_preserved_for_values_and_descriptions() {
    let store = fixture();
    store.with_connection(|conn| {
        candidate(conn,"CURRENT",true)?;
        conn.execute("INSERT INTO company_identifiers(kind,identifier,company_id,first_seen_at) VALUES('PK','OLD','CURRENT','2026-01-01')",[])?;
        conn.pragma_update(None,"foreign_keys",false)?;
        source(conn,"OLD","MID","01",json!({"Company":"Aliased MID","Company Description":"Alias description"}))?;
        source(conn,"OLD","ISCC","01",json!({"Company Name":"Aliased ISCC","Company Description":"Aliased ISCC description","Relevancy Score":0.5}))?;
        conn.execute("INSERT INTO screening_runs(run_id,objective,status,original_criteria_json,created_at,updated_at) VALUES('OTHER','Other','DRAFT','{}','2026-01-01','2026-01-01')",[])?;
        conn.execute("INSERT INTO source_rows(source_row_id,source,run_scope,company_id,row_hash,row_json,imported_at,relevance_score) VALUES('OTHER-ISCC','ISCC','OTHER','CURRENT','other',?, '2099-01-01',0.9)",[json!({"Company Name":"Other run","Relevancy Score":0.9}).to_string()])?;
        conn.pragma_update(None,"foreign_keys",true)?;Ok(())
    }).unwrap();
    let result = page(&store, "all");
    assert_eq!(result["rows"][0]["values"]["Company"], "Aliased MID");
    assert_eq!(result["rows"][0]["values"]["ISCC_Score"], 0.5);
    let result = page(&store, "iscc");
    assert_eq!(result["rows"][0]["values"]["Company Name"], "Aliased ISCC");
    let descriptions =
        grid::grid_descriptions(&store, &json!({"run_id":"R","company_ids":["CURRENT"]})).unwrap();
    assert_eq!(
        descriptions["companies"][0]["sources"][0]["items"][0]["text"],
        "Alias description"
    );
    assert_eq!(
        descriptions["companies"][0]["sources"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn grid_arguments_validate_limit_view_and_requested_columns() {
    let store = fixture();
    let data = DataService::new(store);
    for extra in [
        json!({"limit":0}),
        json!({"view":"invalid"}),
        json!({"columns":["unknown"]}),
    ] {
        let mut args = json!({"run_id":"R"});
        args.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(data.execute("get_screening_grid", &args).is_err());
    }
    for limit in [1000, 2000] {
        assert!(data
            .execute("get_screening_grid", &json!({"run_id":"R","limit":limit}))
            .is_ok());
    }
}
