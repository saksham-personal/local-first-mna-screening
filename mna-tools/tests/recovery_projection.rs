use mna_tools::{
    execution::ExecutionService,
    retrieval::{self, ModelIdentity},
    Store,
};
use serde_json::{json, Value};

fn question(store: &Store) -> (ExecutionService, Value, String, Value) {
    store
        .execute(
            "create_run",
            &json!({"run_id":"R","objective":"Question","original_criteria":{}}),
        )
        .unwrap();
    let svc = ExecutionService::new(store.clone());
    let plan=svc.execute("propose_prepared_plan",&json!({"run_id":"R","mode":"question","provider":"llm_suite","deployment":"fixture","prompt":"Explain this market","question":"What is known?"})).unwrap();
    svc.execute("approve_prepared_plan",&json!({"plan_id":plan["plan_id"],"digest":plan["digest"],"approved_by":"Analyst","approval_key":"a"})).unwrap();
    let job = svc
        .execute("get_prepared_plan", &json!({"plan_id":plan["plan_id"]}))
        .unwrap()["jobs"][0]["job_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let lease = svc
        .execute(
            "lease_execution_job",
            &json!({"job_id":job,"controller_id":"worker"}),
        )
        .unwrap();
    (svc, plan, job, lease)
}

#[test]
fn ambiguous_late_answer_is_saved_with_historical_marker_after_profile_edit() {
    let store = Store::open(":memory:").unwrap();
    let (svc, _plan, job, _lease) = question(&store);
    store
        .with_connection(|conn| {
            conn.execute(
                "UPDATE execution_jobs SET state='AMBIGUOUS',attempt=1 WHERE job_id=?",
                [&job],
            )?;
            Ok(())
        })
        .unwrap();
    store.execute("propose_screening_profile",&json!({"run_id":"R","content":{"core_business_query":"Updated"},"rationale":"Analyst clarification"})).unwrap();
    store
        .execute(
            "approve_screening_profile",
            &json!({"run_id":"R","version":1,"approved_by":"Analyst"}),
        )
        .unwrap();
    let accepted=svc.execute("reconcile_execution_job",&json!({"job_id":job,"attempt":1,"outcome":"response_received","reason":"Retrieved existing provider response","response_text":"The market details remain uncertain."})).unwrap();
    assert_eq!(accepted["historical"], true);
    let history = svc
        .execute("get_model_assessments", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(
        history["question_answers"][0]["eligible_for_current_use"],
        false
    );
    assert_eq!(
        svc.execute("get_execution_job", &json!({"job_id":job}))
            .unwrap()["attempt"],
        1
    );
}

#[test]
fn confirmed_unsent_ambiguity_returns_ready_but_never_redispatches() {
    let store = Store::open(":memory:").unwrap();
    let (svc, _plan, job, _lease) = question(&store);
    store
        .with_connection(|conn| {
            conn.execute(
                "UPDATE execution_jobs SET state='AMBIGUOUS',attempt=1 WHERE job_id=?",
                [&job],
            )?;
            Ok(())
        })
        .unwrap();
    let result=svc.execute("reconcile_execution_job",&json!({"job_id":job,"attempt":1,"outcome":"confirmed_not_sent","reason":"Provider and gateway confirmed no send"})).unwrap();
    assert_eq!(result["state"], "READY");
    assert_eq!(result["automatically_redispatched"], false);
}

#[test]
fn legacy_schema_slots_are_upgraded_conservatively() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.db");
    let store = Store::open(&path).unwrap();
    store.with_connection(|conn|{conn.execute_batch("DROP TABLE llmsuite_slots; CREATE TABLE llmsuite_slots(request_key TEXT PRIMARY KEY,purpose TEXT NOT NULL,reserved_at TEXT NOT NULL,window_epoch INTEGER NOT NULL); PRAGMA user_version=5;")?;
        conn.execute("INSERT INTO llmsuite_slots VALUES('old','orchestrator','old',?)",[chrono::Utc::now().timestamp()])?;Ok(())}).unwrap();
    drop(store);
    let reopened = Store::open(&path).unwrap();
    let svc = ExecutionService::new(reopened);
    assert_eq!(
        svc.reserve_llmsuite_slot("orchestrator", "old").unwrap()["consumed"],
        true
    );
    assert!(svc
        .execute(
            "consume_llmsuite_slot",
            &json!({"purpose":"orchestrator","request_key":"old"})
        )
        .is_err());
}

#[test]
fn selected_model_and_description_hash_invalidate_embedding_cache() {
    let store = Store::open(":memory:").unwrap();
    store.execute("ingest_companies",&json!({"companies":[{"company_id":"X-1","name":"Example","description":"Claims software"}]})).unwrap();
    let model = ModelIdentity {
        model: "fixture".into(),
        version: "1".into(),
        dimensions: 2,
    };
    let saved = store
        .save_model_embeddings(
            &model,
            &[(
                "X-1".into(),
                retrieval::text_hash("Claims software"),
                vec![1.0, 0.0],
            )],
        )
        .unwrap();
    assert_eq!(saved, 1);
    assert!(store.model_embedding(&model, "X-1").unwrap().is_some());
    let changed = ModelIdentity {
        version: "2".into(),
        ..model.clone()
    };
    assert!(store.model_embedding(&changed, "X-1").unwrap().is_none());
    store
        .with_connection(|conn| {
            conn.execute(
                "UPDATE companies SET description='New description' WHERE company_id='X-1'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    assert!(store.model_embedding(&model, "X-1").unwrap().is_none());
}

#[test]
fn legacy_company_foreign_keys_are_removed_without_changing_frozen_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old_identity.db");
    let store = Store::open(&path).unwrap();
    store.execute("create_run",&json!({"run_id":"R","objective":"Screen","original_criteria":{},"initial_profile":{"core_business_query":"Claims"}})).unwrap();
    let q1 = store
        .record_search(Some("R"), "ISCC", "Claims", &json!({}), &json!({}))
        .unwrap();
    let data = mna_tools::data::DataService::new(store.clone());
    data.ingest_iscc_rows(
        Some("R"),
        q1["query_id"].as_str(),
        &[json!({"CID":"1","Company Name":"Alpha","Description":"Claims"})],
    )
    .unwrap();
    store
        .execute(
            "approve_screening_profile",
            &json!({"run_id":"R","version":1,"approved_by":"Analyst"}),
        )
        .unwrap();
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R","companies":["X-1"],"discovery_source":"ISCC"}),
        )
        .unwrap();
    let svc = ExecutionService::new(store.clone());
    let plan=svc.execute("propose_prepared_plan",&json!({"run_id":"R","mode":"screening","provider":"llm_suite","deployment":"fixture","prompt":"Screen","output_columns":["Answer"]})).unwrap();
    svc.execute("approve_prepared_plan",&json!({"plan_id":plan["plan_id"],"digest":plan["digest"],"approved_by":"Analyst","approval_key":"a"})).unwrap();
    let job = svc
        .execute("get_prepared_plan", &json!({"plan_id":plan["plan_id"]}))
        .unwrap()["jobs"][0]["job_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let lease = svc
        .execute(
            "lease_execution_job",
            &json!({"job_id":job,"controller_id":"controller"}),
        )
        .unwrap();
    store
        .with_connection(|conn| {
            conn.execute(
                "UPDATE execution_jobs SET state='RUNNING',attempt=1 WHERE job_id=?",
                [&job],
            )?;
            Ok(())
        })
        .unwrap();
    svc.execute("record_execution_response",&json!({"job_id":job,"lease_token":lease["lease_token"],"response_text":"| index | Answer |\n| --- | --- |\n| 1 | Unknown |"})).unwrap();
    store.with_connection(|conn|{
        conn.execute_batch("CREATE TABLE old_index_map(plan_id TEXT NOT NULL REFERENCES prepared_plans(plan_id),row_index INTEGER NOT NULL,company_id TEXT NOT NULL REFERENCES companies(company_id),job_id TEXT NOT NULL REFERENCES execution_jobs(job_id),row_hash TEXT NOT NULL,PRIMARY KEY(plan_id,row_index),UNIQUE(plan_id,company_id)); INSERT INTO old_index_map SELECT * FROM execution_index_map; DROP TABLE execution_index_map; ALTER TABLE old_index_map RENAME TO execution_index_map; CREATE TABLE old_assessments(assessment_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES screening_runs(run_id),plan_id TEXT NOT NULL REFERENCES prepared_plans(plan_id),job_id TEXT NOT NULL REFERENCES execution_jobs(job_id),company_id TEXT NOT NULL REFERENCES companies(company_id),row_index INTEGER NOT NULL,provider TEXT NOT NULL,prompt TEXT NOT NULL,result_json TEXT NOT NULL CHECK(json_valid(result_json)),created_at TEXT NOT NULL,UNIQUE(plan_id,row_index)); INSERT INTO old_assessments SELECT * FROM model_assessments; DROP TABLE model_assessments; ALTER TABLE old_assessments RENAME TO model_assessments; PRAGMA user_version=5;")?;Ok(())
    }).unwrap();
    drop(data);
    drop(svc);
    drop(store);
    let reopened = Store::open(&path).unwrap();
    let q2 = reopened
        .record_search(Some("R"), "ISCC", "Claims", &json!({}), &json!({}))
        .unwrap();
    mna_tools::data::DataService::new(reopened.clone())
        .ingest_iscc_rows(
            Some("R"),
            q2["query_id"].as_str(),
            &[json!({"ECID":"100","CID":"1","Company Name":"Alpha","Description":"Claims"})],
        )
        .unwrap();
    assert_eq!(reopened.resolve_company_id("X-1").unwrap(), "100-1");
    reopened
        .with_connection(|conn| {
            let frozen: String =
                conn.query_row("SELECT company_id FROM execution_index_map", [], |r| {
                    r.get(0)
                })?;
            let assessed: String =
                conn.query_row("SELECT company_id FROM model_assessments", [], |r| r.get(0))?;
            assert_eq!(frozen, "X-1");
            assert_eq!(assessed, "X-1");
            Ok(())
        })
        .unwrap();
}
