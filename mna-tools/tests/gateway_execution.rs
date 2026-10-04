use axum::{extract::State, routing::post, Json, Router};
use mna_tools::{
    execution::ExecutionService,
    gateway::{self, DispatchRequest},
    Store,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
type MockState = (Arc<AtomicUsize>, Arc<std::sync::Mutex<(Store, String)>>);

#[tokio::test]
async fn approved_gateway_repairs_parsing_and_keeps_stale_inflight_response() {
    let store = Store::open(":memory:").unwrap();
    store.execute("ingest_companies",&json!({"companies":[{"company_id":"C1","name":"Alpha","description":"Claims software"},{"company_id":"C2","name":"Beta","description":"Insurance administration"}]})).unwrap();
    store.execute("create_run",&json!({"run_id":"R","objective":"Screen","original_criteria":{},"initial_profile":{"core_business_query":"Claims software"}})).unwrap();
    store
        .execute(
            "approve_screening_profile",
            &json!({"run_id":"R","version":1,"approved_by":"Analyst"}),
        )
        .unwrap();
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R","companies":["C1","C2"],"discovery_source":"MID"}),
        )
        .unwrap();
    let service = ExecutionService::new(store.clone());
    let calls = Arc::new(AtomicUsize::new(0));
    let shared = Arc::new(std::sync::Mutex::new((store.clone(), String::new())));
    let state = (calls.clone(), shared.clone());
    let app=Router::new().route("/execute",post(|State((calls,shared)):State<MockState>,Json(body):Json<Value>|async move {
        assert!(body["prompt"].as_str().unwrap().contains("OUTPUT CONTRACT"));
        assert!(!body["input_table"].as_str().unwrap().contains("C1"));
        let n=calls.fetch_add(1,Ordering::SeqCst);
        if n==0 {return Json(json!({"response_text":"| index | Fit Score | Reason |\n| --- | --- | --- |\n| 999 | 8 | Wrong index |"}));}
        if n==2 {
            let guard=shared.lock().unwrap();let (store,sibling)=&*guard;
            store.with_connection(|conn|{conn.execute("UPDATE companies SET description='Changed source' WHERE company_id='C1'",[])?;Ok(())}).unwrap();
            assert!(ExecutionService::new(store.clone()).execute("lease_execution_job",&json!({"job_id":sibling,"controller_id":"parallel-worker"})).is_err());
        }
        Json(json!({"response_text":"| index | Fit Score | Reason |\n| --- | --- | --- |\n| 1 | 8 | Fits supplied business context |"}))
    })).with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    // All calls in this test target the loopback fixture, never a real provider.
    std::env::set_var("MNA_ENABLE_EXTERNAL", "true");
    std::env::set_var("MNA_LLMSUITE_ENDPOINT", format!("http://{address}/execute"));
    std::env::set_var("MNA_LLMSUITE_TOKEN", "fixture-only");
    let propose = || {
        service.execute("propose_prepared_plan",&json!({"run_id":"R","mode":"screening","provider":"llm_suite","deployment":"fixture","prompt":"Score claims software","input_columns":["index","Description"],"output_columns":["Fit Score","Reason"],"score_columns":["Fit Score"],"batch_size":1})).unwrap()
    };
    let approve = |plan: &Value| {
        service.execute("approve_prepared_plan",&json!({"plan_id":plan["plan_id"],"digest":plan["digest"],"approved_by":"Analyst","approval_key":plan["digest"]})).unwrap();
        service
            .execute("get_prepared_plan", &json!({"plan_id":plan["plan_id"]}))
            .unwrap()
    };
    let plan = propose();
    let approved = approve(&plan);
    let job = approved["jobs"][0]["job_id"].as_str().unwrap();
    let result = gateway::dispatch(
        store.clone(),
        DispatchRequest {
            job_id: job.to_owned(),
            controller_id: "controller".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(result["state"], "SUCCEEDED");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        service
            .execute("get_execution_job", &json!({"job_id":job}))
            .unwrap()["repair_attempt"],
        1
    );
    let second = propose();
    let approved = approve(&second);
    let first = approved["jobs"][0]["job_id"].as_str().unwrap();
    shared.lock().unwrap().1 = approved["jobs"][1]["job_id"].as_str().unwrap().to_owned();
    let historical = gateway::dispatch(
        store.clone(),
        DispatchRequest {
            job_id: first.into(),
            controller_id: "controller".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(historical["state"], "SUCCEEDED");
    assert_eq!(historical["historical"], true);
    assert_eq!(
        service
            .execute("get_execution_job", &json!({"job_id":first}))
            .unwrap()["attempt"],
        1
    );
    let count: i64 = store
        .with_connection(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM execution_transport_receipts",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(count, 3);
    for key in [
        "MNA_ENABLE_EXTERNAL",
        "MNA_LLMSUITE_ENDPOINT",
        "MNA_LLMSUITE_TOKEN",
    ] {
        std::env::remove_var(key);
    }
    server.abort();
}

#[test]
fn provider_payload_contains_only_selected_columns_and_escapes_source_text() {
    let request=gateway::provider_request(&json!({"input_columns":["index","Description"],"rows":[{"index":7,"pk":"Secret identity","Description":"a|b\\c\nnext"}],"output_columns":["Answer"],"score_columns":[],"prompt":"Explain","deployment":"fixture"}),None).unwrap();
    assert_eq!(request["output_columns"], json!(["index", "Answer"]));
    let table = request["input_table"].as_str().unwrap();
    assert!(!table.contains("Secret identity"));
    assert!(table.contains("a\\|b\\\\c<br>next"));
}
