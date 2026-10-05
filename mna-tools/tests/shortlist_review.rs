use mna_tools::{context::ContextService, data::DataService, projection, Store};
use serde_json::json;

fn seeded() -> Store {
    let store = Store::open(":memory:").unwrap();
    store
        .execute(
            "create_run",
            &json!({"run_id":"R","objective":"Screen","original_criteria":{}}),
        )
        .unwrap();
    store
        .execute(
            "create_run",
            &json!({"run_id":"OTHER","objective":"Other","original_criteria":{}}),
        )
        .unwrap();
    store.execute("ingest_companies",&json!({"companies":[{"company_id":"A","name":"Alpha"},{"company_id":"B","name":"Beta"}]})).unwrap();
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R","companies":["A","B"],"discovery_source":"MID"}),
        )
        .unwrap();
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"OTHER","companies":["B"],"discovery_source":"MID"}),
        )
        .unwrap();
    store
}

#[test]
fn review_hides_restores_and_guards_run_scope() {
    let store = seeded();
    let before =
        projection::execute(&store, "get_run_source_projection", &json!({"run_id":"R"})).unwrap();
    assert_eq!(before["rows"].as_array().unwrap().len(), 2);
    assert!(store
        .execute(
            "review_shortlist",
            &json!({"run_id":"R","keep_company_ids":["B","X"]})
        )
        .is_err());
    let reviewed = store
        .execute(
            "review_shortlist",
            &json!({"run_id":"R","keep_company_ids":["A"],"reason":"Analyst scope"}),
        )
        .unwrap();
    assert_eq!(reviewed["hidden_count"], 1);
    assert!(store
        .execute(
            "review_shortlist",
            &json!({"run_id":"R","keep_company_ids":["A","B"],"expected_selection_revision":0})
        )
        .is_err());
    let visible = store
        .execute("get_shortlist_context", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(visible["candidates"].as_array().unwrap().len(), 1);
    let all = store
        .execute(
            "get_shortlist_context",
            &json!({"run_id":"R","include_hidden":true}),
        )
        .unwrap();
    assert_eq!(all["candidates"].as_array().unwrap().len(), 2);
    assert_eq!(all["candidates"][1]["considered"], false);
    let after =
        projection::execute(&store, "get_run_source_projection", &json!({"run_id":"R"})).unwrap();
    assert_eq!(after["rows"].as_array().unwrap().len(), 1);
    assert_ne!(before["candidate_hash"], after["candidate_hash"]);
    store
        .execute(
            "review_shortlist",
            &json!({"run_id":"R","keep_company_ids":["A","B"]}),
        )
        .unwrap();
    assert_eq!(
        store
            .execute("get_shortlist_context", &json!({"run_id":"R"}))
            .unwrap()["considered_count"],
        2
    );
    assert_eq!(
        store
            .execute("get_shortlist_context", &json!({"run_id":"OTHER"}))
            .unwrap()["considered_count"],
        1
    );
}

#[test]
fn candidate_list_and_reasoning_context_exclude_hidden_by_default() {
    let store = seeded();
    store
        .execute(
            "review_shortlist",
            &json!({"run_id":"R","keep_company_ids":["A"]}),
        )
        .unwrap();
    let visible = store
        .execute("get_candidate_set", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(visible["count"], 1);
    assert_eq!(visible["candidates"][0]["considered"], true);
    let history = store
        .execute(
            "get_candidate_set",
            &json!({"run_id":"R","include_hidden":true}),
        )
        .unwrap();
    assert_eq!(history["count"], 2);
    assert!(history["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["company_id"] == "B" && c["considered"] == false));
    let context = ContextService::new(store.clone());
    assert!(context
        .execute(
            "get_candidate_context",
            &json!({"run_id":"R","company_id":"B"})
        )
        .is_err());
    assert!(context.execute("get_candidate_batch_context",&json!({"run_id":"R","company_ids":["A","B"],"fields":["candidate"],"max_per_company":4000})).is_err());
    let explicit = context
        .execute(
            "get_company_context",
            &json!({"run_id":"R","company_id":"B","sections":["screening_history"]}),
        )
        .unwrap();
    assert_eq!(
        explicit["sections"]["screening_history"]["candidate"]["considered"],
        false
    );
    let run = store
        .execute("get_run_context", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(run["candidate_total"], 2);
    assert_eq!(run["considered_total"], 1);
    assert_eq!(run["hidden_total"], 1);
}

#[test]
fn criteria_revisions_are_immutable_and_latest_approval_is_guarded() {
    let store = seeded();
    let draft = store
        .execute(
            "save_criteria_revision",
            &json!({"run_id":"R","criteria_text":"","business_definition":""}),
        )
        .unwrap();
    assert!(store.execute("approve_criteria_revision",&json!({"run_id":"R","revision":draft["revision"],"digest":draft["digest"],"approved_by":"Analyst"})).is_err());
    let one=store.execute("save_criteria_revision",&json!({"run_id":"R","criteria_text":"Claims focus","business_definition":"Builds claims tools","good_fit_examples":["Claims software"]})).unwrap();
    let before =
        projection::execute(&store, "get_run_source_projection", &json!({"run_id":"R"})).unwrap();
    let two=store.execute("save_criteria_revision",&json!({"run_id":"R","criteria_text":"Benefits focus","business_definition":"Builds benefits tools"})).unwrap();
    assert!(store.execute("approve_criteria_revision",&json!({"run_id":"R","revision":one["revision"],"digest":one["digest"],"approved_by":"Analyst"})).is_err());
    store.execute("approve_criteria_revision",&json!({"run_id":"R","revision":two["revision"],"digest":two["digest"],"approved_by":"Analyst"})).unwrap();
    let history = store
        .execute("get_criteria_history", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(history["count"], 3);
    assert_eq!(history["revisions"][0]["approved"], false);
    assert_eq!(history["revisions"][2]["approved"], true);
    let after =
        projection::execute(&store, "get_run_source_projection", &json!({"run_id":"R"})).unwrap();
    assert_ne!(before["candidate_hash"], after["candidate_hash"]);
}

#[test]
fn explicit_pb_hide_never_restores_manual_review() {
    let store = seeded();
    store
        .with_connection(|conn| {
            mna_tools::review::hide_explicit_unmapped_pb(conn, "R", "A", "pitchbook_unmapped")
                .map(|_| ())
        })
        .unwrap();
    assert_eq!(
        store
            .execute("get_shortlist_context", &json!({"run_id":"R"}))
            .unwrap()["considered_count"],
        1
    );
    store
        .execute(
            "review_shortlist",
            &json!({"run_id":"R","keep_company_ids":["A"]}),
        )
        .unwrap();
    store
        .with_connection(|conn| {
            mna_tools::review::hide_explicit_unmapped_pb(conn, "R", "A", "pitchbook_unmapped")
                .map(|_| ())
        })
        .unwrap();
    assert_eq!(
        store
            .execute("get_shortlist_context", &json!({"run_id":"R"}))
            .unwrap()["considered_count"],
        0
    );
}

#[test]
fn discovery_summary_counts_only_considered_companies_and_preserves_saved_total() {
    let store = seeded();
    store
        .execute(
            "review_shortlist",
            &json!({"run_id":"R","keep_company_ids":["B"]}),
        )
        .unwrap();
    let summary = DataService::new(store)
        .execute("get_discovery_summary", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(summary["total_unique"], 1);
    assert_eq!(summary["saved_total"], 2);
    assert_eq!(summary["hidden_total"], 1);
    assert_eq!(
        summary["recommended_steps"],
        json!(["PITCHBOOK_ENRICHMENT", "BING_HYDRATION"])
    );
}

#[test]
fn selected_assessment_columns_are_hydrated_and_validated() {
    let store = seeded();
    store.with_connection(|conn|{
        conn.execute("INSERT INTO prepared_plans(plan_id,run_id,schema_version,digest,status,spec_json,snapshot_json,proposed_at) VALUES('P','R',2,'hash','APPROVED',?,'{}','now')",[json!({"output_columns":["Verdict","Reason"]}).to_string()])?;
        conn.execute("INSERT INTO execution_jobs(job_id,plan_id,run_id,ordinal,state,payload_json,input_hash,created_at,updated_at) VALUES('J','P','R',1,'SUCCEEDED','{}','hash','now','now')",[])?;
        conn.execute("INSERT INTO model_assessments(assessment_id,run_id,plan_id,job_id,company_id,row_index,provider,prompt,result_json,created_at) VALUES('M','R','P','J','A',1,'fixture','Screen',?,'now')",[json!({"Verdict":"Yes","Reason":"Core business"}).to_string()])?;
        Ok(())
    }).unwrap();
    assert!(store
        .execute(
            "review_shortlist",
            &json!({"run_id":"R","keep_company_ids":["A","B"],"review_columns":{"P":["Unknown"]}})
        )
        .is_err());
    store
        .execute(
            "review_shortlist",
            &json!({"run_id":"R","keep_company_ids":["A","B"],"review_columns":{"P":["Verdict"]}}),
        )
        .unwrap();
    let projection =
        projection::execute(&store, "get_run_source_projection", &json!({"run_id":"R"})).unwrap();
    assert!(projection["input_columns"]
        .as_array()
        .unwrap()
        .contains(&json!("RESULTS:P:Verdict")));
    assert_eq!(projection["rows"][0]["RESULTS:P:Verdict"], "Yes");
    assert!(projection["rows"][1]["RESULTS:P:Verdict"].is_null());
    store
        .execute(
            "review_shortlist",
            &json!({"run_id":"R","keep_company_ids":["B"],"review_columns":{"P":["Verdict"]}}),
        )
        .unwrap();
    let empty_values =
        projection::execute(&store, "get_run_source_projection", &json!({"run_id":"R"})).unwrap();
    assert_eq!(empty_values["rows"].as_array().unwrap().len(), 1);
    assert!(empty_values["rows"][0]["RESULTS:P:Verdict"].is_null());
    assert_eq!(empty_values["coverage"]["RESULTS:P:Verdict"]["present"], 0);
    let results = empty_values["catalog"]
        .as_array()
        .unwrap()
        .iter()
        .find(|source| source["source"] == "RESULTS")
        .unwrap();
    assert_eq!(results["columns"][0]["name"], "P:Verdict");
    assert_eq!(results["columns"][0]["missing"], 1);
    let source_data = DataService::new(store)
        .execute("get_candidate_source_data", &json!({"run_id":"R"}))
        .unwrap();
    assert!(source_data["rows"][0]["sources"]["RESULTS"]
        .as_object()
        .unwrap()
        .contains_key("P:Verdict"));
    assert!(source_data["rows"][0]["sources"]["RESULTS"]["P:Verdict"].is_null());
}

#[test]
fn schema_revision_survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("review.sqlite");
    let store = Store::open(&path).unwrap();
    store
        .execute(
            "create_run",
            &json!({"run_id":"R","objective":"Screen","original_criteria":{}}),
        )
        .unwrap();
    drop(store);
    let reopened = Store::open(&path).unwrap();
    let version: i64 = reopened
        .with_connection(|conn| Ok(conn.pragma_query_value(None, "user_version", |r| r.get(0))?))
        .unwrap();
    assert_eq!(version, 7);
    drop(reopened);
    assert!(Store::open(&path).is_ok());
}

#[test]
fn source_hash_is_run_wide_and_tracks_description_changes() {
    let store = seeded();
    let first = store
        .execute("get_shortlist_context", &json!({"run_id":"R","limit":1}))
        .unwrap();
    let second = store
        .execute(
            "get_shortlist_context",
            &json!({"run_id":"R","limit":1,"after_company_id":first["next_after_company_id"]}),
        )
        .unwrap();
    assert_eq!(first["source_hash"], second["source_hash"]);
    store
        .with_connection(|conn| {
            conn.execute(
                "UPDATE companies SET description='New core business' WHERE company_id='B'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let changed = store
        .execute("get_shortlist_context", &json!({"run_id":"R","limit":1}))
        .unwrap();
    assert_ne!(first["source_hash"], changed["source_hash"]);
}

#[test]
fn pb_mapping_auto_hide_and_correction_preserve_manual_hides() {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("MNA_IMPORT_DIR", dir.path());
    let store = seeded();
    let data = DataService::new(store.clone());
    let header="pk,PBId,Firm Name from PitchBook,Website from PitchBook,Company Profile,Investor Profile,Limited Partner Profile,Service Provider Profile\n";
    std::fs::write(
        dir.path().join("first.csv"),
        format!("{header}A,PB1,Alpha,alpha.example,No,No,No,No\n"),
    )
    .unwrap();
    let first = data
        .execute(
            "import_enrichment_files",
            &json!({"run_id":"R","files":["first.csv"],"exclude_unmapped":true}),
        )
        .unwrap();
    assert_eq!(first["considered_count"], 0);
    assert_eq!(first["hidden_count"], 2);
    store
        .execute(
            "review_shortlist",
            &json!({"run_id":"R","keep_company_ids":[]}),
        )
        .unwrap();
    assert_eq!(
        store
            .execute(
                "get_shortlist_context",
                &json!({"run_id":"R","include_hidden":true})
            )
            .unwrap()["candidates"][0]["consideration_reason"],
        "pitchbook_non_company"
    );
    std::fs::write(
        dir.path().join("corrected.csv"),
        format!("{header}A,PB1,Alpha,alpha.example,Yes,No,No,No\n"),
    )
    .unwrap();
    let corrected = data
        .execute(
            "import_enrichment_files",
            &json!({"run_id":"R","files":["corrected.csv"],"exclude_unmapped":true}),
        )
        .unwrap();
    assert_eq!(corrected["considered_count"], 1);
    store
        .execute(
            "review_shortlist",
            &json!({"run_id":"R","keep_company_ids":[]}),
        )
        .unwrap();
    let after = data
        .execute(
            "import_enrichment_files",
            &json!({"run_id":"R","files":["corrected.csv"],"exclude_unmapped":true}),
        )
        .unwrap();
    assert_eq!(after["considered_count"], 0);
    assert_eq!(
        store
            .execute(
                "get_shortlist_context",
                &json!({"run_id":"R","include_hidden":true})
            )
            .unwrap()["candidates"][0]["consideration_reason"],
        "manual"
    );
}

#[test]
fn bing_observations_enter_unverified_projection_without_staling_research_scope() {
    let store = seeded();
    let before = store
        .execute("get_shortlist_context", &json!({"run_id":"R"}))
        .unwrap();
    store.execute("save_evidence",&json!({"run_id":"R","company_id":"A","claim":"bing_research_observation","value":{"question":"What does Alpha sell?","answer":"Claims workflow software","sources":[{"title":"Alpha","url":"https://alpha.example","snippet":"Claims workflow"}]},"source_type":"bing","source_reference":"Q-1","confidence":"low"})).unwrap();
    let after = store
        .execute("get_shortlist_context", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(before["source_hash"], after["source_hash"]);
    assert_eq!(after["coverage"]["BING"], 1);
    let projection =
        projection::execute(&store, "get_run_source_projection", &json!({"run_id":"R"})).unwrap();
    assert!(projection["input_columns"]
        .as_array()
        .unwrap()
        .contains(&json!("BING:Research")));
    let text = projection["rows"][0]["BING:Research"].as_str().unwrap();
    assert!(text.contains("https://alpha.example"));
    assert!(text.contains("unverified"));
}
