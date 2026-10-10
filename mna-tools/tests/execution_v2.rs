use mna_tools::{execution::ExecutionService, Store};
use serde_json::{json, Value};

fn fixture() -> (Store, ExecutionService) {
    let store = Store::open(":memory:").unwrap();
    store.execute("ingest_companies", &json!({"companies":[
        {"company_id":"C1","name":"Alpha","website":"alpha.example","description":"Insurance services"},
        {"company_id":"C2","name":"Beta","website":"beta.example","description":"Claims software"}
    ]})).unwrap();
    store.execute("create_run",&json!({"run_id":"R1","objective":"Find fit","original_criteria":{"business":"insurance"},"initial_profile":{"core_business_query":"insurance","core_business_criteria":["insurance"],"unused_criteria":[]}})).unwrap();
    store
        .execute(
            "approve_screening_profile",
            &json!({"run_id":"R1","version":1,"approved_by":"analyst"}),
        )
        .unwrap();
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R1","companies":["C1","C2"],"discovery_source":"MID"}),
        )
        .unwrap();
    let service = ExecutionService::new(store.clone());
    (store, service)
}
fn propose(service: &ExecutionService) -> Value {
    service.execute("propose_prepared_plan",&json!({"run_id":"R1","mode":"screening","provider":"llm_suite","deployment":"test-deployment","prompt":"Score each business","output_columns":["fit_score","rationale"],"score_columns":["fit_score"],"batch_size":2})).unwrap()
}
fn approve(service: &ExecutionService, plan: &Value) -> Value {
    service.execute("approve_prepared_plan",&json!({"plan_id":plan["plan_id"],"digest":plan["digest"],"approved_by":"analyst","approval_key":"approval-1"})).unwrap()
}

#[test]
fn approval_freezes_scope_and_rejects_stale_source() {
    let (store, service) = fixture();
    let plan = propose(&service);
    store
        .with_connection(|conn| {
            conn.execute(
                "UPDATE companies SET description='Changed' WHERE company_id='C1'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let err=service.execute("approve_prepared_plan",&json!({"plan_id":plan["plan_id"],"digest":plan["digest"],"approved_by":"analyst","approval_key":"approval-1"})).unwrap_err();
    assert!(err.to_string().contains("stale"));
    assert_eq!(
        service
            .execute("get_prepared_plan", &json!({"plan_id":plan["plan_id"]}))
            .unwrap()["status"],
        "STALE"
    );
    let jobs: i64 = store
        .with_connection(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM execution_jobs", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(jobs, 0);
}

#[test]
fn shuffled_indices_are_mapped_to_frozen_pks_and_invalid_table_is_quarantined() {
    let (store, service) = fixture();
    let plan = propose(&service);
    approve(&service, &plan);
    let jobs = service
        .execute("get_prepared_plan", &json!({"plan_id":plan["plan_id"]}))
        .unwrap();
    let job = jobs["jobs"][0]["job_id"].as_str().unwrap();
    let lease = service
        .execute(
            "lease_execution_job",
            &json!({"job_id":job,"controller_id":"controller"}),
        )
        .unwrap();
    assert_eq!(lease["executed"], false);
    // A transport callback after dispatch: database state is seeded to isolate
    // the parser/storage invariant from provider configuration.
    store
        .with_connection(|conn| {
            conn.execute(
                "UPDATE execution_jobs SET state='RUNNING',attempt=1 WHERE job_id=?",
                [job],
            )?;
            Ok(())
        })
        .unwrap();
    let bad="| index | fit_score | rationale |\n| --- | --- | --- |\n| 999 | 8 | wrong |\n| 2 | 7 | Fit |";
    let quarantine = service
        .execute(
            "record_execution_response",
            &json!({"job_id":job,"lease_token":lease["lease_token"],"response_text":bad}),
        )
        .unwrap();
    assert_eq!(quarantine["state"], "PARSE_REVIEW");
    let count: i64 = store
        .with_connection(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM model_assessments", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(
        service
            .execute(
                "record_execution_response",
                &json!({"job_id":job,"lease_token":lease["lease_token"],"response_text":bad})
            )
            .unwrap()["idempotent"],
        true
    );
    let repair_lease = service
        .execute(
            "lease_execution_job",
            &json!({"job_id":job,"controller_id":"controller"}),
        )
        .unwrap();
    store
        .with_connection(|conn| {
            conn.execute(
                "UPDATE execution_jobs SET state='RUNNING',attempt=2 WHERE job_id=?",
                [job],
            )?;
            Ok(())
        })
        .unwrap();
    let good="| index | fit_score | rationale |\n| --- | --- | --- |\n| 2 | 7 | Beta fit |\n| 1 | CHECK | Alpha review |";
    let accepted = service
        .execute(
            "record_execution_response",
            &json!({"job_id":job,"lease_token":repair_lease["lease_token"],"response_text":good}),
        )
        .unwrap();
    assert_eq!(accepted["state"], "SUCCEEDED");
    assert_eq!(service.execute("record_execution_response",&json!({"job_id":job,"lease_token":repair_lease["lease_token"],"response_text":good})).unwrap()["idempotent"],true);
    let results = service
        .execute("get_model_assessments", &json!({"run_id":"R1"}))
        .unwrap();
    assert_eq!(results["count"], 2);
    assert_eq!(results["assessments"][0]["company_id"], "C1");
    assert_eq!(results["assessments"][0]["result"]["fit_score"], "CHECK");
    assert_eq!(results["assessments"][1]["company_id"], "C2");
    assert!(service.execute("record_execution_response",&json!({"job_id":job,"lease_token":repair_lease["lease_token"],"response_text":"different"})).is_err());
}

#[test]
fn leases_survive_reopen_and_llmsuite_gate_is_shared_across_roles() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("execution.db");
    let store = Store::open(&path).unwrap();
    store
        .execute(
            "create_run",
            &json!({"run_id":"R1","objective":"Question","original_criteria":{}}),
        )
        .unwrap();
    let service = ExecutionService::new(store.clone());
    let plan=service.execute("propose_prepared_plan",&json!({"run_id":"R1","mode":"question","provider":"llm_suite","deployment":"test","prompt":"Answer carefully","question":"What is the market size?"})).unwrap();
    approve(&service, &plan);
    let jobs = service
        .execute("get_prepared_plan", &json!({"plan_id":plan["plan_id"]}))
        .unwrap();
    let job = jobs["jobs"][0]["job_id"].as_str().unwrap().to_owned();
    let leased = service
        .execute(
            "lease_execution_job",
            &json!({"job_id":job,"controller_id":"controller"}),
        )
        .unwrap();
    drop(service);
    drop(store);
    let reopened = ExecutionService::new(Store::open(&path).unwrap());
    assert!(reopened
        .execute(
            "lease_execution_job",
            &json!({"job_id":job,"controller_id":"other"})
        )
        .is_err());
    assert_eq!(
        reopened
            .execute("get_execution_job", &json!({"job_id":job}))
            .unwrap()["state"],
        "LEASED"
    );
    assert!(leased["lease_token"]
        .as_str()
        .unwrap()
        .starts_with("LEASE_"));
    for (n, purpose) in [
        "orchestrator",
        "subagent",
        "screening",
        "question",
        "repair",
        "orchestrator",
        "subagent",
    ]
    .iter()
    .enumerate()
    {
        reopened
            .reserve_llmsuite_slot(purpose, &format!("request-{n}"))
            .unwrap();
    }
    assert!(reopened
        .reserve_llmsuite_slot("repair", "request-8")
        .is_err());
    assert_eq!(
        reopened
            .reserve_llmsuite_slot("orchestrator", "request-0")
            .unwrap()["idempotent"],
        true
    );
}

#[test]
fn all_2001_candidates_get_global_indices_without_a_top_50_cutoff() {
    let store = Store::open(":memory:").unwrap();
    let companies:Vec<_>=(0..2001).map(|n|json!({"company_id":format!("C{n:04}"),"name":"Example","description":"Claims software"})).collect();
    for batch in companies.chunks(1000) {
        store
            .execute("ingest_companies", &json!({"companies":batch}))
            .unwrap();
    }
    store.execute("create_run",&json!({"run_id":"R","objective":"Screen all","original_criteria":{},"initial_profile":{"core_business_query":"Claims software"}})).unwrap();
    store
        .execute(
            "approve_screening_profile",
            &json!({"run_id":"R","version":1,"approved_by":"Analyst"}),
        )
        .unwrap();
    let ids: Vec<_> = companies.iter().map(|c| c["company_id"].clone()).collect();
    for batch in ids.chunks(1000) {
        store
            .execute(
                "add_candidates",
                &json!({"run_id":"R","companies":batch,"discovery_source":"MID"}),
            )
            .unwrap();
    }
    let svc = ExecutionService::new(store.clone());
    let plan=svc.execute("propose_prepared_plan",&json!({"run_id":"R","mode":"screening","provider":"llm_suite","deployment":"fixture","prompt":"Screen core business","output_columns":["Score"],"score_columns":["Score"],"batch_size":200})).unwrap();
    assert_eq!(plan["snapshot"]["rows"].as_array().unwrap().len(), 2001);
    svc.execute("approve_prepared_plan",&json!({"plan_id":plan["plan_id"],"digest":plan["digest"],"approved_by":"Analyst","approval_key":"all"})).unwrap();
    let saved = svc
        .execute("get_prepared_plan", &json!({"plan_id":plan["plan_id"]}))
        .unwrap();
    assert_eq!(saved["jobs"].as_array().unwrap().len(), 11);
    let last = svc
        .execute(
            "get_execution_job",
            &json!({"job_id":saved["jobs"][10]["job_id"]}),
        )
        .unwrap();
    assert_eq!(last["payload"]["indices"], json!([2001]));
    assert_eq!(last["payload"]["rows"][0]["pk"], "C2000");
}

#[test]
fn cached_freshness_recomputes_when_sources_or_research_change_on_a_file_database() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("fresh.db")).unwrap();
    store.execute("ingest_companies", &json!({"companies":[
        {"company_id":"C1","name":"Alpha","website":"alpha.example","description":"Insurance services"},
        {"company_id":"C2","name":"Beta","website":"beta.example","description":"Claims software"}
    ]})).unwrap();
    store.execute("create_run",&json!({"run_id":"R1","objective":"Find fit","original_criteria":{"business":"insurance"},"initial_profile":{"core_business_query":"insurance","core_business_criteria":["insurance"],"unused_criteria":[]}})).unwrap();
    store
        .execute(
            "approve_screening_profile",
            &json!({"run_id":"R1","version":1,"approved_by":"analyst"}),
        )
        .unwrap();
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R1","companies":["C1","C2"],"discovery_source":"MID"}),
        )
        .unwrap();
    let service = ExecutionService::new(store.clone());
    let plan = propose(&service);
    approve(&service, &plan);
    let progress = || {
        service
            .execute(
                "get_execution_progress",
                &json!({"plan_id":plan["plan_id"]}),
            )
            .unwrap()
    };
    // Repeated reads reuse the cached verdict.
    assert_eq!(progress()["fresh"], true);
    assert_eq!(progress()["fresh"], true);
    // A changed company input invalidates the cache.
    store
        .with_connection(|conn| {
            conn.execute(
                "UPDATE companies SET description='Changed' WHERE company_id='C1'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(progress()["fresh"], false);
    assert_eq!(progress()["source_fresh"], false);
    // Restoring the input makes the plan fresh again: the verdict is recomputed, not stuck.
    store
        .with_connection(|conn| {
            conn.execute(
                "UPDATE companies SET description='Insurance services' WHERE company_id='C1'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(progress()["fresh"], true);
}
