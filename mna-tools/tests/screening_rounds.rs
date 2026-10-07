use mna_tools::{execution::ExecutionService, Store};
use rusqlite::params;
use serde_json::{json, Value};

fn fixture() -> (Store, ExecutionService) {
    let store = Store::open(":memory:").unwrap();
    store
        .execute(
            "ingest_companies",
            &json!({"companies":[
                {"company_id":"C1","name":"Alpha","website":"alpha.example","description":"Insurance services"},
                {"company_id":"C2","name":"Beta","website":"beta.example","description":"Insurance services"},
                {"company_id":"C3","name":"Gamma","website":"gamma.example","description":"Insurance services"},
                {"company_id":"C4","name":"Delta","website":"delta.example","description":"Insurance services"},
                {"company_id":"C5","name":"Epsilon","website":"epsilon.example","description":"Insurance services"},
                {"company_id":"C6","name":"Zeta","website":"zeta.example","description":"Insurance services"},
                {"company_id":"C7","name":"Eta","website":"eta.example","description":"Insurance services"}
            ]}),
        )
        .unwrap();
    store
        .execute(
            "create_run",
            &json!({"run_id":"R1","objective":"Find fit","original_criteria":{"business":"insurance"},"initial_profile":{"core_business_query":"insurance","core_business_criteria":["insurance"],"unused_criteria":[]}}),
        )
        .unwrap();
    store
        .execute(
            "approve_screening_profile",
            &json!({"run_id":"R1","version":1,"approved_by":"analyst"}),
        )
        .unwrap();
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R1","companies":["C1","C2","C3","C4","C5","C6","C7"],"discovery_source":"MID"}),
        )
        .unwrap();
    let service = ExecutionService::new(store.clone());
    (store, service)
}

fn screening_plan(service: &ExecutionService, provider: &str) -> Value {
    service
        .execute(
            "propose_prepared_plan",
            &json!({
                "run_id":"R1",
                "mode":"screening",
                "provider":provider,
                "deployment":"test-deployment",
                "prompt":"Score each business",
                "output_columns":["fit_score","rationale"],
                "score_columns":["fit_score"],
                "batch_size":1
            }),
        )
        .unwrap()
}

fn approve(service: &ExecutionService, plan: &Value, approval_key: &str) -> Value {
    service
        .execute(
            "approve_prepared_plan",
            &json!({
                "plan_id":plan["plan_id"],
                "digest":plan["digest"],
                "approved_by":"analyst",
                "approval_key":approval_key
            }),
        )
        .unwrap()
}

fn record_scores(store: &Store, service: &ExecutionService, plan: &Value) {
    let prepared = service
        .execute("get_prepared_plan", &json!({"plan_id":plan["plan_id"]}))
        .unwrap();
    let job_id = prepared["jobs"][0]["job_id"].as_str().unwrap();
    let execution = service
        .execute("get_execution_job", &json!({"job_id":job_id}))
        .unwrap();
    let indices: Vec<i64> =
        serde_json::from_value(execution["payload"]["indices"].clone()).unwrap();
    assert_eq!(indices.len(), 1);
    let lease = service
        .execute(
            "lease_execution_job",
            &json!({"job_id":job_id,"controller_id":"test-controller"}),
        )
        .unwrap();
    store
        .with_connection(|conn| {
            conn.execute(
                "UPDATE execution_jobs SET state='RUNNING',attempt=1 WHERE job_id=?",
                [job_id],
            )?;
            Ok(())
        })
        .unwrap();

    let response = format!(
        "| index | fit_score | rationale |\n| --- | --- | --- |\n| {} | 7 | accepted response |\n",
        indices[0]
    );
    let accepted = service
        .execute(
            "record_execution_response",
            &json!({"job_id":job_id,"lease_token":lease["lease_token"],"response_text":response}),
        )
        .unwrap();
    assert_eq!(accepted["state"], "SUCCEEDED");

    let plan_id = plan["plan_id"].as_str().unwrap();
    let score_fixtures = [
        ("C2", json!("7.0"), 0),
        ("C3", json!(7.0), 0),
        ("C4", json!("CHECK"), 0),
        ("C5", json!("check"), 0),
        ("C6", json!(""), 0),
        ("C7", json!("x"), 1),
    ];
    store
        .with_connection(|conn| {
            let first_company: String = conn.query_row(
                "SELECT company_id FROM execution_index_map WHERE plan_id=? AND job_id=?",
                params![plan_id, job_id],
                |row| row.get(0),
            )?;
            assert_eq!(first_company, "C1");
            // Accepted results are immutable, and the response parser rejects malformed score
            // values. Insert fixtures for the remaining frozen job rows to exercise defensive
            // bucketing without changing that parsing contract.
            for (company_id, score, simulated) in score_fixtures {
                let (row_index, fixture_job): (i64, String) = conn.query_row(
                    "SELECT row_index,job_id FROM execution_index_map WHERE plan_id=? AND company_id=?",
                    params![plan_id, company_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let result_json = serde_json::to_string(&json!({
                    "index":row_index,
                    "fit_score":score,
                    "rationale":"seeded fixture"
                }))
                .unwrap();
                conn.execute(
                    "INSERT INTO model_assessments(assessment_id,run_id,plan_id,job_id,company_id,row_index,provider,prompt,result_json,created_at,simulated) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    params![
                        format!("ASSESSMENT-{company_id}"),
                        "R1",
                        plan_id,
                        fixture_job,
                        company_id,
                        row_index,
                        "llm_suite",
                        "Score each business",
                        result_json,
                        "2026-01-01T00:00:00Z",
                        simulated
                    ],
                )?;
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn approved_screening_plans_become_numbered_rounds_with_progress_and_distributions() {
    let (store, service) = fixture();
    let first = screening_plan(&service, "llm_suite");
    let first_approval = approve(&service, &first, "approval-1");
    assert_eq!(first_approval["round_no"], 1);
    assert_eq!(first_approval["idempotent"], false);

    let second = screening_plan(&service, "copilot");
    let second_approval = approve(&service, &second, "approval-2");
    assert_eq!(second_approval["round_no"], 2);

    let repeated = approve(&service, &first, "approval-1");
    assert_eq!(repeated["idempotent"], true);
    assert_eq!(repeated["round_no"], 1);
    let round_count: i64 = store
        .with_connection(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM screening_rounds", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(round_count, 2);

    let question = service
        .execute(
            "propose_prepared_plan",
            &json!({"run_id":"R1","mode":"question","provider":"llm_suite","deployment":"test-deployment","prompt":"Answer carefully","question":"What is the market size?"}),
        )
        .unwrap();
    let question_approval = approve(&service, &question, "question-approval");
    assert!(question_approval.get("round_no").is_none());

    record_scores(&store, &service, &first);
    let rounds = service
        .execute("get_screening_rounds", &json!({"run_id":"R1"}))
        .unwrap();
    assert_eq!(rounds["run_id"], "R1");
    assert_eq!(rounds["rounds"].as_array().unwrap().len(), 2);

    let first_round = &rounds["rounds"][0];
    assert_eq!(first_round["round_no"], 1);
    assert_eq!(first_round["provider"], "llm_suite");
    assert_eq!(first_round["provider_label"], "LLM Suite");
    assert_eq!(first_round["approved_by"], "analyst");
    assert_eq!(first_round["deployment"], "test-deployment");
    assert_eq!(
        first_round["output_columns"],
        json!(["fit_score", "rationale"])
    );
    assert_eq!(first_round["score_columns"], json!(["fit_score"]));
    assert_eq!(first_round["jobs"]["total"], 7);
    assert_eq!(first_round["jobs"]["done"], 1);
    assert_eq!(first_round["jobs"]["ready"], 6);
    assert_eq!(first_round["assessed_companies"], 7);
    assert_eq!(first_round["score_distribution"]["fit_score"]["7"], 3);
    assert_eq!(first_round["score_distribution"]["fit_score"]["CHECK"], 2);
    assert_eq!(first_round["score_distribution"]["fit_score"]["blank"], 2);
    assert_eq!(first_round["score_distribution"]["fit_score"]["0"], 0);
    assert_eq!(first_round["simulated"], true);

    let second_round = &rounds["rounds"][1];
    assert_eq!(second_round["round_no"], 2);
    assert_eq!(second_round["provider"], "copilot");
    assert_eq!(second_round["provider_label"], "M365 Copilot");
    assert_eq!(second_round["jobs"]["total"], 7);
    assert_eq!(second_round["jobs"]["ready"], 7);
    assert_eq!(second_round["assessed_companies"], 0);
    assert_eq!(second_round["simulated"], false);
}
