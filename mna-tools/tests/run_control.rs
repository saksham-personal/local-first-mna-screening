use std::sync::{Mutex, OnceLock};

use mna_tools::{
    context::ContextService, data::DataService, execution::ExecutionService, projection,
    run_control, Store,
};
use serde_json::{json, Value};

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn fixture() -> Store {
    let store = Store::open(":memory:").unwrap();
    store
        .execute(
            "create_run",
            &json!({"run_id":"R","objective":"Screen target","original_criteria":{}}),
        )
        .unwrap();
    store
        .execute(
            "ingest_companies",
            &json!({"companies":[{"company_id":"C1","name":"Company One","description":"Claims software"}]}),
        )
        .unwrap();
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R","companies":["C1"],"discovery_source":"MID"}),
        )
        .unwrap();
    store
}

fn seed_bing(store: &Store, plan_id: &str) {
    store
        .with_connection(|connection| {
            connection.execute(
                "INSERT INTO action_plans(plan_id,run_id,profile_version,rationale,steps_json,status,proposed_at,approved_at,approved_by)
                 VALUES(?, 'R', 0, 'Research approved queries', ?, 'APPROVED', '2026-01-01', '2026-01-01', 'analyst')",
                rusqlite::params![plan_id, json!([{"step_id":"bing-grounding","kind":"bing_research","query_templates":["{company} products"],"company_ids":["C1"]}]).to_string()],
            )?;
            Ok(())
        })
        .unwrap();
    let search = store
        .record_search(
            Some("R"),
            "bing_search",
            "Company One products",
            &json!({"run_id":"R","plan_id":plan_id,"step_id":"bing-grounding","company_id":"C1","query":"Company One products"}),
            &json!({"answer":"A bounded unverified lead","results":[]}),
        )
        .unwrap();
    store
        .execute(
            "save_evidence",
            &json!({"run_id":"R","company_id":"C1","claim":"bing_research_observation","value":{"question":"Company One products","answer":"A bounded unverified lead","sources":[]},"source_type":"bing","source_reference":search["query_id"],"confidence":"low","extraction_method":"fixture"}),
        )
        .unwrap();
}

fn seed_screening(store: &Store, plan_id: &str, states: &[&str], simulated: bool) {
    store
        .with_connection(|connection| {
            let spec = json!({
                "run_id":"R", "mode":"screening", "provider":"llm_suite", "deployment":"fixture",
                "prompt":"Score the company", "company_ids":["C1"], "input_columns":["pk"],
                "output_columns":["Fit","Rationale"], "score_columns":["Fit"]
            });
            connection.execute(
                "INSERT INTO prepared_plans(plan_id,run_id,schema_version,digest,status,spec_json,snapshot_json,proposed_at,approved_at,approved_by)
                 VALUES(?, 'R', 2, 'digest', 'APPROVED', ?, '{}', '2026-01-01', '2026-01-01', 'analyst')",
                rusqlite::params![plan_id, spec.to_string()],
            )?;
            connection.execute(
                "INSERT INTO prepared_plan_approvals(plan_id,approval_key,digest,approved_by,approved_at) VALUES(?, 'key', 'digest', 'analyst', '2026-01-01')",
                [plan_id],
            )?;
            connection.execute(
                "INSERT INTO screening_rounds(run_id,round_no,plan_id,provider,created_at) VALUES('R',1,?,'llm_suite','2026-01-01')",
                [plan_id],
            )?;
            connection.execute(
                "INSERT INTO shortlist_review_columns(run_id,plan_id,columns_json) VALUES('R',?, '[\"Fit\"]')",
                [plan_id],
            )?;
            for (ordinal, state) in states.iter().enumerate() {
                let job_id = format!("{plan_id}-job-{ordinal}");
                connection.execute(
                    "INSERT INTO execution_jobs(job_id,plan_id,run_id,ordinal,state,payload_json,input_hash,created_at,updated_at)
                     VALUES(?,?, 'R', ?, ?, '{}', ?, '2026-01-01', '2026-01-01')",
                    rusqlite::params![job_id, plan_id, ordinal as i64, state, format!("hash-{ordinal}")],
                )?;
                if *state == "SUCCEEDED" {
                    connection.execute(
                        "INSERT INTO model_assessments(assessment_id,run_id,plan_id,job_id,company_id,row_index,provider,prompt,result_json,created_at,simulated)
                         VALUES(?, 'R', ?, ?, 'C1', ?, 'llm_suite', 'Score the company', ?, '2026-01-02', ?)",
                        rusqlite::params![format!("{plan_id}-assessment-{ordinal}"), plan_id, job_id, ordinal as i64,
                            json!({"Fit":"8","Rationale":"Relevant claims workflow"}).to_string(), simulated],
                    )?;
                }
            }
            Ok(())
        })
        .unwrap();
}

fn discard(
    store: &Store,
    run_id: &str,
    plan_id: &str,
    kind: &str,
) -> mna_tools::error::Result<Value> {
    run_control::execute(
        store,
        "discard_plan_results",
        &json!({"run_id":run_id,"plan_id":plan_id,"kind":kind,"reason":"Analyst decision"}),
        true,
    )
}

#[test]
fn research_discard_hides_coverage_detail_projection_and_evidence_but_can_be_read_explicitly() {
    let store = fixture();
    seed_bing(&store, "bing-plan");
    let data = DataService::new(store.clone());

    let grid = data
        .execute("get_screening_grid", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(grid["rows"][0]["coverage"]["bing"], true);
    let detail = data
        .execute(
            "get_company_detail",
            &json!({"run_id":"R","company_id":"C1"}),
        )
        .unwrap();
    assert_eq!(detail["values"]["bing_hydrated"], "true");
    assert!(detail["activity"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["kind"] == "bing"));
    let context = ContextService::new(store.clone())
        .execute(
            "get_company_context",
            &json!({"run_id":"R","company_id":"C1","sections":["previous_research"]}),
        )
        .unwrap();
    assert_eq!(
        context["sections"]["previous_research"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let projection =
        projection::execute(&store, "get_run_source_projection", &json!({"run_id":"R"})).unwrap();
    assert!(!projection["rows"][0]["BING:Research"].is_null());
    let shortlist = store
        .execute("get_shortlist_context", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(shortlist["coverage"]["BING"], 1);
    assert_eq!(
        data.execute("get_evidence", &json!({"run_id":"R","company_id":"C1"}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        data.execute("get_search_history", &json!({"run_id":"R"}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );

    discard(&store, "R", "bing-plan", "research").unwrap();
    let grid = data
        .execute("get_screening_grid", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(grid["rows"][0]["coverage"]["bing"], false);
    let detail = data
        .execute(
            "get_company_detail",
            &json!({"run_id":"R","company_id":"C1"}),
        )
        .unwrap();
    assert_eq!(detail["values"]["bing_hydrated"], "false");
    let context = ContextService::new(store.clone())
        .execute(
            "get_company_context",
            &json!({"run_id":"R","company_id":"C1","sections":["previous_research"]}),
        )
        .unwrap();
    assert!(context["sections"]["previous_research"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(!detail["activity"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["kind"] == "bing"));
    let source_page = data
        .execute("get_candidate_source_data", &json!({"run_id":"R"}))
        .unwrap();
    assert!(source_page["rows"][0]["sources"]["BING"]["Research"].is_null());
    let projection =
        projection::execute(&store, "get_run_source_projection", &json!({"run_id":"R"})).unwrap();
    assert!(projection["rows"][0]["BING:Research"].is_null());
    assert!(data
        .execute("get_evidence", &json!({"run_id":"R","company_id":"C1"}))
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    assert!(data
        .execute("get_search_history", &json!({"run_id":"R"}))
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    let history = data
        .execute(
            "get_evidence",
            &json!({"run_id":"R","company_id":"C1","include_discarded":true}),
        )
        .unwrap();
    assert_eq!(history.as_array().unwrap().len(), 1);
    let shortlist = store
        .execute("get_shortlist_context", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(shortlist["coverage"]["BING"], 0);
    assert!(matches!(
        run_control::execute(
            &store,
            "discard_plan_results",
            &json!({"run_id":"R","plan_id":"bing-plan","kind":"research"}),
            false
        ),
        Err(mna_tools::error::Error::AnalystAuthRequired)
    ));
}

#[test]
fn screening_discard_hides_rounds_grid_projection_and_allows_export_without_discarded_simulation() {
    let _guard = env_lock();
    let dir = tempfile::tempdir().unwrap();
    let previous = std::env::var_os("MNA_EXPORT_DIR");
    std::env::set_var("MNA_EXPORT_DIR", dir.path());
    let store = fixture();
    seed_screening(&store, "screen-plan", &["SUCCEEDED"], true);
    let data = DataService::new(store.clone());

    let rounds = ExecutionService::new(store.clone())
        .execute("get_screening_rounds", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(rounds["rounds"].as_array().unwrap().len(), 1);
    let grid = data
        .execute("get_screening_grid", &json!({"run_id":"R"}))
        .unwrap();
    assert!(grid["columns"]
        .as_array()
        .unwrap()
        .iter()
        .any(|column| column["group"] == "rounds"));
    assert!(grid["rounds"]
        .as_array()
        .unwrap()
        .iter()
        .any(|round| round["key"] == "R1"));
    let source_page = data
        .execute("get_candidate_source_data", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(
        source_page["rows"][0]["sources"]["RESULTS"]["screen-plan:Fit"],
        "8"
    );
    let projection =
        projection::execute(&store, "get_run_source_projection", &json!({"run_id":"R"})).unwrap();
    assert_eq!(projection["rows"][0]["RESULTS:screen-plan:Fit"], "8");

    discard(&store, "R", "screen-plan", "screening").unwrap();
    let repeated = discard(&store, "R", "screen-plan", "screening").unwrap();
    assert_eq!(repeated["idempotent"], true);
    let rounds = ExecutionService::new(store.clone())
        .execute("get_screening_rounds", &json!({"run_id":"R"}))
        .unwrap();
    assert!(rounds["rounds"].as_array().unwrap().is_empty());
    let grid = data
        .execute("get_screening_grid", &json!({"run_id":"R"}))
        .unwrap();
    assert!(!grid["columns"]
        .as_array()
        .unwrap()
        .iter()
        .any(|column| column["group"] == "rounds"));
    assert!(!grid["rounds"]
        .as_array()
        .unwrap()
        .iter()
        .any(|round| round["key"] == "R1"));
    let source_page = data
        .execute("get_candidate_source_data", &json!({"run_id":"R"}))
        .unwrap();
    assert!(source_page["rows"][0]["sources"]["RESULTS"]["screen-plan:Fit"].is_null());
    let projection =
        projection::execute(&store, "get_run_source_projection", &json!({"run_id":"R"})).unwrap();
    assert!(projection["rows"][0]
        .get("RESULTS:screen-plan:Fit")
        .is_none());
    let export = data
        .execute(
            "export_candidate_set",
            &json!({"run_id":"R","export_type":"LLM","file_name":"discarded.xlsx"}),
        )
        .unwrap();
    assert!(std::path::Path::new(export["path"].as_str().unwrap()).exists());
    let mut workbook = calamine::open_workbook_auto(export["path"].as_str().unwrap()).unwrap();
    use calamine::Reader;
    assert!(!workbook
        .sheet_names()
        .iter()
        .any(|name| name == "SIMULATED"));
    let mut content = String::new();
    for name in workbook.sheet_names().to_vec() {
        let range = workbook.worksheet_range(&name).unwrap();
        for row in range.rows() {
            for cell in row {
                content.push_str(&cell.to_string());
                content.push(' ');
            }
        }
    }
    assert!(!content.contains("SIMULATED"));
    assert!(!content.contains("Relevant claims workflow"));
    assert!(!content.contains("A bounded unverified lead"));
    if let Some(value) = previous {
        std::env::set_var("MNA_EXPORT_DIR", value);
    } else {
        std::env::remove_var("MNA_EXPORT_DIR");
    }
}

#[test]
fn discard_refuses_a_running_screening_plan_and_existing_cancel_keeps_finished_assessments() {
    let store = fixture();
    seed_screening(&store, "running-plan", &["RUNNING"], false);
    assert!(matches!(
        discard(&store, "R", "running-plan", "screening"),
        Err(mna_tools::error::Error::Conflict(_))
    ));

    let store = fixture();
    seed_screening(&store, "ambiguous-plan", &["AMBIGUOUS"], false);
    assert!(matches!(
        discard(&store, "R", "ambiguous-plan", "screening"),
        Err(mna_tools::error::Error::Conflict(_))
    ));

    let store = fixture();
    seed_screening(&store, "cancel-plan", &["SUCCEEDED", "READY"], false);
    let service = ExecutionService::new(store.clone());
    let cancelled = service
        .execute(
            "cancel_prepared_plan",
            &json!({"plan_id":"cancel-plan","cancelled_by":"analyst"}),
        )
        .unwrap();
    assert_eq!(cancelled["status"], "CANCELLED");
    let assessments = service
        .execute(
            "get_model_assessments",
            &json!({"run_id":"R","plan_id":"cancel-plan"}),
        )
        .unwrap();
    assert_eq!(assessments["assessments"].as_array().unwrap().len(), 1);
    assert_eq!(
        assessments["assessments"][0]["eligible_for_current_use"],
        false
    );
    discard(&store, "R", "cancel-plan", "screening").unwrap();
    assert!(service
        .execute(
            "get_model_assessments",
            &json!({"run_id":"R","plan_id":"cancel-plan"})
        )
        .unwrap()["assessments"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn question_mode_prepared_plans_can_be_discarded_without_deleting_answers() {
    let store = fixture();
    store
        .with_connection(|connection| {
            let spec = json!({"run_id":"R","mode":"question","provider":"llm_suite","question":"What is known?"});
            connection.execute(
                "INSERT INTO prepared_plans(plan_id,run_id,schema_version,digest,status,spec_json,snapshot_json,proposed_at,approved_at,approved_by)
                 VALUES('question-plan','R',2,'question-digest','APPROVED',?,'{}','2026-01-01','2026-01-01','analyst')",
                [spec.to_string()],
            )?;
            connection.execute(
                "INSERT INTO execution_jobs(job_id,plan_id,run_id,ordinal,state,payload_json,input_hash,created_at,updated_at)
                 VALUES('question-job','question-plan','R',0,'SUCCEEDED','{}','question-hash','2026-01-01','2026-01-02')",
                [],
            )?;
            connection.execute(
                "INSERT INTO execution_question_answers(answer_id,run_id,plan_id,job_id,provider,question,answer,attribution_json,created_at)
                 VALUES('question-answer','R','question-plan','question-job','llm_suite','What is known?','A saved answer','{}','2026-01-02')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let service = ExecutionService::new(store.clone());
    assert_eq!(
        service
            .execute(
                "get_model_assessments",
                &json!({"run_id":"R","plan_id":"question-plan"})
            )
            .unwrap()["question_answers"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    discard(&store, "R", "question-plan", "screening").unwrap();
    let answers = service
        .execute(
            "get_model_assessments",
            &json!({"run_id":"R","plan_id":"question-plan"}),
        )
        .unwrap();
    assert!(answers["question_answers"].as_array().unwrap().is_empty());
    assert_eq!(
        store
            .with_connection(|connection| Ok(connection.query_row(
                "SELECT COUNT(*) FROM execution_question_answers WHERE plan_id='question-plan'",
                [],
                |row| row.get::<_, i64>(0),
            )?))
            .unwrap(),
        1
    );
}

#[test]
fn stale_screening_plans_can_be_cancelled_but_running_attempts_still_refuse() {
    let store = fixture();
    seed_screening(&store, "stale-plan", &["READY"], false);
    store
        .with_connection(|connection| {
            connection.execute(
                "UPDATE prepared_plans SET status='STALE' WHERE plan_id='stale-plan'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let service = ExecutionService::new(store);
    let cancelled = service
        .execute(
            "cancel_prepared_plan",
            &json!({"plan_id":"stale-plan","cancelled_by":"analyst"}),
        )
        .unwrap();
    assert_eq!(cancelled["status"], "CANCELLED");
}

#[test]
fn discarded_plan_list_is_scoped_to_run_and_discard_is_idempotent() {
    let store = fixture();
    seed_bing(&store, "bing-plan");
    discard(&store, "R", "bing-plan", "research").unwrap();
    let plans =
        run_control::execute(&store, "get_discarded_plans", &json!({"run_id":"R"}), false).unwrap();
    assert_eq!(plans["count"], 1);
    assert_eq!(plans["plans"][0]["plan_id"], "bing-plan");
    assert_eq!(
        discard(&store, "R", "bing-plan", "research").unwrap()["idempotent"],
        true
    );
}
