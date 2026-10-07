use mna_tools::{data::DataService, Store};
use rusqlite::params;
use serde_json::{json, Value};

struct RoundFixture<'a> {
    round_no: i64,
    plan_id: &'a str,
    provider: &'a str,
    output_columns: &'a [&'a str],
    score_columns: &'a [&'a str],
    assessment_company_id: &'a str,
    result: Value,
}

fn prepared_round(conn: &rusqlite::Connection, round: RoundFixture<'_>) -> rusqlite::Result<()> {
    let spec = json!({
        "output_columns": round.output_columns,
        "score_columns": round.score_columns,
    });
    conn.execute(
        "INSERT INTO prepared_plans(plan_id,run_id,schema_version,digest,status,spec_json,snapshot_json,proposed_at)
         VALUES(?, 'R', 2, ?, 'APPROVED', ?, '{}', '2026-01-01T00:00:00Z')",
        params![round.plan_id, format!("digest-{}", round.plan_id), spec.to_string()],
    )?;
    conn.execute(
        "INSERT INTO screening_rounds(run_id,round_no,plan_id,provider,created_at)
         VALUES('R',?,?,?,'2026-01-01T00:00:00Z')",
        params![round.round_no, round.plan_id, round.provider],
    )?;
    let job_id = format!("JOB-{}", round.plan_id);
    conn.execute(
        "INSERT INTO execution_jobs(job_id,plan_id,run_id,ordinal,state,payload_json,input_hash,created_at,updated_at)
         VALUES(?,?,'R',1,'SUCCEEDED','{}','hash','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
        params![job_id, round.plan_id],
    )?;
    conn.execute(
        "INSERT INTO model_assessments(assessment_id,run_id,plan_id,job_id,company_id,row_index,provider,prompt,result_json,created_at)
         VALUES(?, 'R', ?, ?, ?, ?, ?, 'Score core fit', ?, ?)",
        params![
            format!("ASSESSMENT-{}", round.plan_id),
            round.plan_id,
            job_id,
            round.assessment_company_id,
            round.round_no,
            round.provider,
            round.result.to_string(),
            format!("2026-01-0{}T00:00:00Z", round.round_no),
        ],
    )?;
    Ok(())
}

#[test]
fn grid_v2_projects_keywords_semantic_iscc_rounds_aliases_and_simulation() {
    let store = Store::open(":memory:").unwrap();
    store
        .execute(
            "create_run",
            &json!({"run_id":"R","objective":"Claims software","original_criteria":{}}),
        )
        .unwrap();
    store
        .execute(
            "ingest_companies",
            &json!({"companies":[{"company_id":"NO-FEATURES","name":"Plain Company","description":"A company without score data"}]}),
        )
        .unwrap();
    let data = DataService::new(store.clone());
    data.ingest_iscc_rows(
        Some("R"),
        None,
        &[json!({"CID":"77","Company Name":"Provisional Claims","Description":"Claims workflow software","Relevancy Score":0.41})],
    )
    .unwrap();
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R","companies":["X-77"],"discovery_source":"ISCC"}),
        )
        .unwrap();
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R","companies":["NO-FEATURES"],"discovery_source":"MID"}),
        )
        .unwrap();
    let promoted = data
        .ingest_iscc_rows(
            Some("R"),
            None,
            &[json!({"ECID":"88","CID":"77","Company Name":"Canonical Claims","Description":"Claims workflow platform","Relevancy Score":0.83})],
        )
        .unwrap();
    assert_eq!(promoted["promoted"], 1);

    let revision = store
        .execute(
            "save_criteria_revision",
            &json!({"run_id":"R","criteria_text":"Claims workflow","business_definition":"Claims workflow platform"}),
        )
        .unwrap();
    store
        .execute(
            "approve_criteria_revision",
            &json!({"run_id":"R","revision":revision["revision"],"digest":revision["digest"],"approved_by":"Analyst"}),
        )
        .unwrap();

    store
        .with_connection(|conn| {
            conn.execute(
                "INSERT INTO mid_bundles(bundle_id,fts_id,name,status,source_file,config_json,config_hash,created_at)
                 VALUES('BUNDLE',1,'fixture','ready','fixture.csv','{}','config-hash','2026-01-01T00:00:00Z')",
                [],
            )?;
            for (query_id, rationale, expression, keywords, match_pct, hit_count, matched, created_at) in [
                (
                    "Q1",
                    "Claims workflows",
                    "kw1 AND kw2",
                    json!([{"id":"kw1","text":"claims"},{"id":"kw2","text":"workflow"}]),
                    74.0,
                    3,
                    json!([{"id":"kw1","text":"claims"},{"id":"kw2","text":"workflow"}]),
                    "2026-01-01T00:00:00Z",
                ),
                (
                    "Q2",
                    "Claims automation",
                    "kwA OR kwB",
                    json!([{"id":"kwA","text":"claims"},{"id":"kwB","text":"automation"}]),
                    91.5,
                    5,
                    json!([{"id":"kwA","text":"claims"},{"id":"kwB","text":"automation"}]),
                    "2026-01-02T00:00:00Z",
                ),
            ] {
                conn.execute(
                    "INSERT INTO mid_keyword_queries(query_id,run_id,bundle_id,rationale,keywords_json,expression,hit_count,created_at)
                     VALUES(?, 'R','BUNDLE',?,?,?,?,?)",
                    params![query_id, rationale, keywords.to_string(), expression, hit_count, created_at],
                )?;
                conn.execute(
                    "INSERT INTO mid_keyword_hits(query_id,run_id,company_id,matched_json,match_pct,hit_count,bm25)
                     VALUES(?, 'R','88-77',?,?,?,NULL)",
                    params![query_id, matched.to_string(), match_pct, hit_count],
                )?;
            }
            conn.execute(
                "INSERT INTO mid_semantic_scores(run_id,company_id,criteria_revision,score,cosine,model,computed_at)
                 VALUES('R','88-77',?,?,?,'fixture-model','2026-01-02T00:00:00Z')",
                params![revision["revision"].as_i64().unwrap(), 8.26, 0.826],
            )?;
            conn.execute(
                "INSERT INTO source_rows(source_row_id,source,run_scope,query_scope,company_id,row_hash,row_json,relevance_score,imported_at,simulated)
                 VALUES('ISCC-SIM','ISCC','R','Q-SIM','88-77','sim-hash',?,0.83,'2026-01-03T00:00:00Z',1)",
                [json!({"ECID":"88","CID":"77","Company Name":"Canonical Claims","Relevancy Score":0.83}).to_string()],
            )?;
            prepared_round(
                conn,
                RoundFixture {
                    round_no: 1,
                    plan_id: "P1",
                    provider: "llm_suite",
                    output_columns: &["Fit", "Rationale"],
                    score_columns: &["Fit"],
                    assessment_company_id: "X-77",
                    result: json!({"Fit":"8","Rationale":"Strong claims workflow fit"}),
                },
            )?;
            prepared_round(
                conn,
                RoundFixture {
                    round_no: 2,
                    plan_id: "P2",
                    provider: "copilot",
                    output_columns: &["Fit", "Rationale"],
                    score_columns: &["Fit"],
                    assessment_company_id: "88-77",
                    result: json!({"Fit":"CHECK","Rationale":"Review needed"}),
                },
            )?;
            Ok(())
        })
        .unwrap();

    let page = data
        .execute(
            "get_screening_grid",
            &json!({"run_id":"R","include_hidden":true,"limit":2000}),
        )
        .unwrap();
    let company = page["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["company_id"] == "88-77")
        .unwrap();
    assert_eq!(company["mid_keyword"]["best_match_pct"], 91.5);
    assert_eq!(company["mid_keyword"]["hit_count"], 5);
    assert_eq!(
        company["mid_keyword"]["matched"].as_array().unwrap().len(),
        3
    );
    assert_eq!(company["mid_keyword"]["matched"][0]["text"], "claims");
    assert_eq!(company["mid_keyword"]["matched"][1]["text"], "automation");
    assert_eq!(company["mid_keyword"]["matched"][2]["text"], "workflow");
    assert_eq!(
        company["mid_keyword"]["queries"].as_array().unwrap().len(),
        2
    );
    assert_eq!(company["mid_keyword"]["queries"][0]["query_id"], "Q2");
    assert_eq!(
        company["mid_keyword"]["queries"][0]["display_query"],
        "Claims automation (claims OR automation)"
    );
    assert_eq!(company["mid_semantic_score"], 8.3);
    assert_eq!(company["iscc_relevancy"], 0.83);
    assert_eq!(company["iscc_score"], 0.83);
    assert_eq!(company["simulated"], true);
    assert_eq!(company["rounds"]["R1"]["provider_label"], "LLM Suite");
    assert_eq!(
        company["rounds"]["R1"]["values"]["Rationale"],
        "Strong claims workflow fit"
    );
    assert_eq!(company["rounds"]["R1"]["scores"]["Fit"], 8);
    assert_eq!(company["rounds"]["R2"]["scores"]["Fit"], "CHECK");
    assert_eq!(page["rounds"].as_array().unwrap().len(), 2);
    assert_eq!(page["rounds"][0]["key"], "R1");
    assert_eq!(page["has_mid_keyword"], true);
    assert_eq!(page["has_semantic"], true);
    assert_eq!(page["has_iscc"], true);

    let plain = page["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["company_id"] == "NO-FEATURES")
        .unwrap();
    assert!(plain["mid_keyword"].is_null());
    assert!(plain["mid_semantic_score"].is_null());
    assert!(plain["iscc_relevancy"].is_null());
    assert_eq!(plain["simulated"], false);
    assert_eq!(plain["rounds"], json!({}));

    let detail = data
        .execute(
            "get_company_detail",
            &json!({"run_id":"R","company_id":"X-77"}),
        )
        .unwrap();
    assert_eq!(detail["company_id"], "88-77");
    assert_eq!(
        detail["mid_keyword"]["queries"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        detail["mid_keyword"]["queries"][0]["matched"][1]["text"],
        "automation"
    );
    assert_eq!(detail["mid_semantic"]["score"], 8.26);
    assert_eq!(
        detail["mid_semantic"]["criteria_revision"],
        revision["revision"]
    );
    assert_eq!(detail["iscc"]["relevancy"], 0.83);
    assert_eq!(detail["iscc"]["row"]["Relevancy Score"], 0.83);
    assert_eq!(detail["rounds"]["R1"]["result"]["Fit"], "8");
    assert_eq!(detail["rounds"]["R2"]["created_at"], "2026-01-02T00:00:00Z");
    assert_eq!(detail["simulated"], true);

    let plain_detail = data
        .execute(
            "get_company_detail",
            &json!({"run_id":"R","company_id":"NO-FEATURES"}),
        )
        .unwrap();
    assert!(plain_detail["mid_keyword"].is_null());
    assert!(plain_detail["mid_semantic"].is_null());
    assert!(plain_detail["iscc"].is_null());
    assert_eq!(plain_detail["rounds"], json!({}));
    assert_eq!(plain_detail["simulated"], false);
}
