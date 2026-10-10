use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use mna_tools::{
    router,
    runtime::{tool_definitions, ToolCall},
    Runtime, Store,
};
use serde_json::{json, Value};
use tower::ServiceExt;

const API_KEY: &str = "test-service-key-with-at-least-24-characters";
const ANALYST_KEY: &str = "test-analyst-key-with-at-least-24-characters";

fn fixture() -> (Store, Runtime, Router) {
    let store = Store::open(":memory:").unwrap();
    store.execute("ingest_companies", &json!({"companies":[
        {"company_id":"C1","name":"Carrier Cloud","country":"India","industry":"Insurance Software","description":"Insurance policy administration SaaS","products":["policy administration"],"embedding":[1.0,0.0,0.0]},
        {"company_id":"C2","name":"Claims Suite","country":"India","description":"Insurance claims software SaaS","embedding":[0.99,0.05,0.0]},
        {"company_id":"C3","name":"Generic Services","country":"USA","industry":"IT Consulting","description":"Technology consulting","embedding":[0.0,1.0,0.0]}
    ]})).unwrap();
    for run_id in ["R1", "R2"] {
        store.execute("create_run", &json!({"run_id":run_id,"objective":"Find insurance software businesses","original_criteria":{"country":["India"],"software_core":true}})).unwrap();
        store
            .execute(
                "approve_screening_profile",
                &json!({"run_id":run_id,"version":1,"approved_by":"fixture-analyst"}),
            )
            .unwrap();
        store
            .execute(
                "add_candidates",
                &json!({"run_id":run_id,"companies":["C1","C2"],"discovery_source":"ANALYST"}),
            )
            .unwrap();
    }
    let runtime = Runtime::new(store.clone()).unwrap();
    let app = router(runtime.clone(), API_KEY.into(), Some(ANALYST_KEY.into())).unwrap();
    (store, runtime, app)
}

async fn request(
    app: Router,
    path: &str,
    payload: Value,
    authenticated: bool,
    analyst: bool,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json");
    if authenticated {
        builder = builder.header("authorization", format!("Bearer {API_KEY}"));
    }
    if analyst {
        builder = builder.header("x-mna-analyst-key", ANALYST_KEY);
    }
    let response = app
        .oneshot(builder.body(Body::from(payload.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn requires_auth_and_rejects_raw_sql_and_unknown_arguments() {
    let (_, _, app) = fixture();
    assert_eq!(
        request(
            app.clone(),
            "/tools/get-company",
            json!({"company_id":"C1"}),
            false,
            false
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, result) = request(
        app.clone(),
        "/tools/execute-sql",
        json!({"sql":"DELETE FROM companies"}),
        true,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(result["error"]["code"], "INVALID_ARGUMENTS");
    assert_eq!(
        request(
            app.clone(),
            "/tools/get-company",
            json!({"company_id":"C1","unrecognized":true}),
            true,
            false
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            app,
            "/tools/call",
            json!({"tool":"get_company","arguments":{"company_id":"C1"},"extra":true}),
            true,
            false
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn analyst_labels_require_human_credentials_on_every_tool_route() {
    let (store, runtime, app) = fixture();
    let args = json!({"run_id":"R1","company_id":"C1","label":"BEST_FIT","analyst_note":"Actual analyst feedback forwarded by trusted controller"});
    assert!(matches!(
        runtime
            .execute(ToolCall {
                tool: "label_company".into(),
                arguments: args.clone()
            })
            .await,
        Err(mna_tools::error::Error::AnalystAuthRequired)
    ));
    for (path, payload) in [
        ("/tools/label-company", args.clone()),
        (
            "/tools/call",
            json!({"tool":"label_company","arguments":args}),
        ),
        ("/admin/labels", args.clone()),
    ] {
        assert_eq!(
            request(app.clone(), path, payload.clone(), true, false)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request(app.clone(), path, payload, true, true).await.0,
            StatusCode::OK
        );
    }
    let (status,batch)=request(app.clone(),"/tools/batch",json!({"calls":[{"tool":"label_company","arguments":args},{"tool":"get_company","arguments":{"company_id":"C1"}}]}),true,false).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        batch["results"][0]["error"]["code"],
        "ANALYST_AUTH_REQUIRED"
    );
    assert_eq!(batch["results"][1]["ok"], true);
    assert_eq!(
        request(
            app,
            "/tools/batch",
            json!({"calls":[{"tool":"label_company","arguments":args}]}),
            true,
            true
        )
        .await
        .1["results"][0]["ok"],
        true
    );
    assert_eq!(
        store
            .execute("get_labelled_examples", &json!({"run_id":"R1"}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn proposed_profile_cannot_be_activated_by_agent_credentials() {
    let (store, _, app) = fixture();
    let proposal = store.execute("propose_screening_profile", &json!({"run_id":"R1","content":{"saas_preferred":true},"rationale":"Analyst example feedback"})).unwrap();
    let version = proposal["version"].as_u64().unwrap();
    let arguments = json!({"run_id":"R1","version":version,"approved_by":"analyst-test"});
    assert_eq!(
        request(
            app.clone(),
            "/tools/approve-screening-profile",
            arguments.clone(),
            true,
            false
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            app.clone(),
            "/admin/profiles/approve",
            arguments.clone(),
            true,
            false
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        store
            .execute("get_active_screening_profile", &json!({"run_id":"R1"}))
            .unwrap()["version"],
        1
    );
    assert_eq!(
        request(app, "/admin/profiles/approve", arguments, true, true)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        store
            .execute("get_active_screening_profile", &json!({"run_id":"R1"}))
            .unwrap()["version"],
        version
    );
    assert_eq!(
        store
            .execute("get_original_criteria", &json!({"run_id":"R1"}))
            .unwrap()["software_core"],
        true
    );
}

#[tokio::test]
async fn evidence_and_context_are_isolated_between_runs() {
    let (store, _, app) = fixture();
    for (run_id, value) in [("R1", "Founder owned"), ("R2", "Private equity owned")] {
        store.execute("save_evidence", &json!({"run_id":run_id,"company_id":"C1","claim":"ownership","value":value,"source_type":"company_website","source_reference":"https://example.com/about","source_url":"https://example.com/about","confidence":"high"})).unwrap();
    }
    let (status, result) = request(
        app.clone(),
        "/tools/get-evidence",
        json!({"run_id":"R1","company_id":"C1"}),
        true,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result.as_array().unwrap().len(), 1);
    assert_eq!(result[0]["value"], "Founder owned");
    let (status, packet) = request(app, "/tools/build-context-packet", json!({"run_id":"R1","task_type":"SCREEN_CANDIDATES","subject_ids":["C1"],"token_budget":16000}), true, false).await;
    assert_eq!(status, StatusCode::OK);
    assert!(serde_json::to_vec(&packet).unwrap().len() <= 16000);
    assert!(!packet.to_string().contains("Private equity owned"));
    assert!(packet.to_string().contains("Founder owned"));
}

#[tokio::test]
async fn local_semantic_search_retains_scores_and_query_provenance() {
    let (store, runtime, _) = fixture();
    let result = runtime.execute(ToolCall {tool:"search_companies".into(),arguments:json!({"run_id":"R1","query":"insurance","mode":"semantic","query_vector":[1.0,0.0,0.0],"filters":{"country":["India"]},"prefer_meilisearch":false,"limit":10})}).await.unwrap();
    assert!(result["query_id"].is_string());
    assert!(result.to_string().contains("C1"));
    assert!(result["results"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["company"]["company_id"] == "C3"));
    assert_eq!(result["ignored_search_filters"], json!(["country"]));
    let history = store
        .execute("get_search_history", &json!({"run_id":"R1"}))
        .unwrap();
    assert_eq!(history.as_array().unwrap().len(), 1);
    assert_eq!(history[0]["query_id"], result["query_id"]);
}

#[tokio::test]
async fn batch_preserves_individual_failures_without_negative_business_evidence() {
    let (_, _, app) = fixture();
    let (status, results) = request(
        app,
        "/tools/batch",
        json!({"calls":[
            {"tool":"get_company","arguments":{"company_id":"C1"}},
            {"tool":"get_company","arguments":{"company_id":"MISSING"}}
        ]}),
        true,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(results["results"][0]["ok"], true);
    assert_eq!(results["results"][1]["error"]["code"], "NOT_FOUND");
    assert_eq!(results["atomic"], false);
}

#[test]
fn discovery_contains_real_argument_schemas_for_every_tool() {
    let definitions = tool_definitions();
    assert_eq!(definitions.len(), 89);
    for definition in definitions {
        assert!(
            definition.input_schema.get("properties").is_some(),
            "missing schema for {}",
            definition.name
        );
        assert_eq!(
            definition.input_schema["additionalProperties"], false,
            "open argument schema for {}",
            definition.name
        );
    }
}

#[tokio::test]
async fn model_text_command_repairs_once_without_execution_and_caches_success() {
    let (_, _, app) = fixture();
    let broken = json!({"request_id":"text-1","run_id":"R1","response":"Use get_run_context please","allowed_tools":["get_run_context"]});
    let (status, repair) = request(app.clone(), "/agent/commands", broken, true, false).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(repair["executed"], false);
    assert!(repair["repair_prompt"].is_string());
    let fixed = json!({"request_id":"text-1","run_id":"R1","attempt":1,"response":"BEGIN TOOL v1 get_run_context\nrun_id:text = \"R1\"\nEND TOOL","allowed_tools":["get_run_context"]});
    let (_, ok) = request(app.clone(), "/agent/commands", fixed.clone(), true, false).await;
    assert_eq!(ok["ok"], true);
    let (_, cached) = request(app, "/agent/commands", fixed, true, false).await;
    assert_eq!(ok, cached);
}

#[tokio::test]
async fn model_cannot_approve_dispatch_or_read_another_runs_prepared_plan() {
    let (store, _, app) = fixture();
    let plan=mna_tools::execution::ExecutionService::new(store).execute("propose_prepared_plan",&json!({"run_id":"R2","mode":"question","provider":"llm_suite","deployment":"fixture","prompt":"Explain","question":"What is known?"})).unwrap();
    let (_,rejected)=request(app.clone(),"/agent/commands",json!({"request_id":"cross-run","run_id":"R1","response":format!("BEGIN TOOL v1 get_prepared_plan\nplan_id:text = \"{}\"\nEND TOOL",plan["plan_id"].as_str().unwrap()),"allowed_tools":["get_prepared_plan"]}),true,false).await;
    assert_eq!(rejected["executed"], false);
    assert_eq!(rejected["ok"], false);
    let (status, _) = request(
        app.clone(),
        "/admin/execution-dispatch",
        json!({"job_id":"unknown","controller_id":"agent"}),
        true,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status,_)=request(app,"/agent/commands",json!({"request_id":"escalation","run_id":"R1","response":"BEGIN TOOL v1 approve_prepared_plan\nEND TOOL","allowed_tools":["approve_prepared_plan"]}),true,false).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn evidence_confidence_does_not_verify_a_research_lead() {
    let (_, _, app) = fixture();
    let (status,saved)=request(app.clone(),"/tools/save_evidence",json!({"run_id":"R1","company_id":"C1","claim":"products","value":"Claims platform","evidence_confidence":"high","source_type":"company_website","source_reference":"https://example.com/product","source_url":"https://example.com/product","claim_provenance":{"provider":"bing","claim":"Company product page states claims platform"}}),true,false).await;
    assert_eq!(status, StatusCode::OK);
    let evidence = saved["evidence_id"].as_str().unwrap();
    let (_, missing) = request(
        app.clone(),
        "/tools/get_missing_evidence",
        json!({"run_id":"R1","company_id":"C1","required_attributes":["products"]}),
        true,
        false,
    )
    .await;
    assert!(!missing["missing"].as_array().unwrap().is_empty());
    let (status,_)=request(app.clone(),"/admin/evidence-review",json!({"run_id":"R1","evidence_id":evidence,"reviewed_by":"Analyst","decision":"VERIFIED","reason":"Checked the source"}),true,false).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status,_)=request(app.clone(),"/admin/evidence-review",json!({"run_id":"R1","evidence_id":evidence,"reviewed_by":"Analyst","decision":"VERIFIED","reason":"Checked the source"}),true,true).await;
    assert_eq!(status, StatusCode::OK);
    let (_, missing) = request(
        app,
        "/tools/get_missing_evidence",
        json!({"run_id":"R1","company_id":"C1","required_attributes":["products"]}),
        true,
        false,
    )
    .await;
    assert!(missing["missing"].as_array().unwrap().is_empty());
}

#[test]
fn state_and_checkpoint_survive_reopening_database() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("agent.db");
    {
        let store = Store::open(&path).unwrap();
        store.execute("create_run", &json!({"run_id":"durable","objective":"Recover after restart","original_criteria":{"mandate":"insurance"}})).unwrap();
        store.execute("save_checkpoint", &json!({"run_id":"durable","namespace":"planner","state":{"iteration":4,"next":"research"},"expected_sequence":0})).unwrap();
    }
    let reopened = Store::open(&path).unwrap();
    let checkpoint = reopened
        .execute(
            "get_checkpoint",
            &json!({"run_id":"durable","namespace":"planner"}),
        )
        .unwrap();
    assert_eq!(checkpoint["state"]["iteration"], 4);
    assert_eq!(
        reopened
            .execute("get_original_criteria", &json!({"run_id":"durable"}))
            .unwrap()["mandate"],
        "insurance"
    );
    assert!(reopened
        .execute(
            "save_checkpoint",
            &json!({"run_id":"durable","namespace":"planner","state":{},"expected_sequence":0})
        )
        .is_err());
}

#[test]
fn candidate_batches_are_atomic_and_discovery_is_idempotent() {
    let (store, _, _) = fixture();
    let add = json!({"run_id":"R1","companies":["C1"],"discovery_source":"ANALYST"});
    assert_eq!(
        store.execute("add_candidates", &add).unwrap()["discovery_records_added"],
        0
    );
    assert!(store
        .execute(
            "add_candidates",
            &json!({"run_id":"R1","companies":["C3","missing"],"discovery_source":"ISCC"})
        )
        .is_err());
    let candidates = store
        .execute("get_candidate_set", &json!({"run_id":"R1"}))
        .unwrap();
    assert_eq!(candidates["count"], 2);
    assert_eq!(
        candidates["candidates"][0]["discovery"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn evidence_is_idempotent_and_question_resolution_rejects_wrong_company() {
    let (store, _, _) = fixture();
    let args = json!({"run_id":"R1","company_id":"C1","claim":"ownership","value":"Founder","source_type":"analyst","source_reference":"analyst observation","confidence":"high"});
    let first = store.execute("save_evidence", &args).unwrap();
    let repeated = store.execute("save_evidence", &args).unwrap();
    assert_eq!(first["evidence_id"], repeated["evidence_id"]);
    assert_eq!(repeated["created"], false);
    let question = store
        .execute(
            "add_open_question",
            &json!({"run_id":"R1","company_id":"C2","question":"Who owns C2?","priority":"high"}),
        )
        .unwrap();
    assert!(store.execute("resolve_open_question", &json!({"question_id":question["question_id"],"answer":"Founder","evidence_ids":[first["evidence_id"]]})).is_err());
    assert_eq!(
        store
            .execute(
                "get_open_questions",
                &json!({"run_id":"R1","company_id":"C2"})
            )
            .unwrap()[0]["status"],
        "OPEN"
    );
}

#[test]
fn original_criteria_and_profile_content_are_immutable_at_database_boundary() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("immutable.db");
    let store = Store::open(&path).unwrap();
    store.execute("create_run", &json!({"run_id":"R1","objective":"Original mandate","original_criteria":{"country":"India"}})).unwrap();
    let connection = rusqlite::Connection::open(path).unwrap();
    assert!(connection
        .execute(
            "UPDATE screening_runs SET original_criteria_json='{}' WHERE run_id='R1'",
            []
        )
        .is_err());
    assert!(connection
        .execute(
            "UPDATE screening_profiles SET content_json='{}' WHERE run_id='R1'",
            []
        )
        .is_err());
}

#[tokio::test]
async fn context_packets_preserve_anchors_and_omit_verbose_optional_details() {
    let (store, runtime, _) = fixture();
    store.execute("ingest_companies", &json!({"companies":[{"company_id":"C1","name":"Carrier Cloud","description":"保険会社🔎".repeat(1000),"embedding":[1.0,0.0]}]})).unwrap();
    let packet = runtime.execute(ToolCall { tool:"build_context_packet".into(), arguments:json!({"run_id":"R1","task_type":"SCREEN_CANDIDATES","subject_ids":["C1"],"token_budget":2400}) }).await.unwrap();
    assert!(serde_json::to_vec(&packet).unwrap().len() <= 2400);
    assert_eq!(packet["context"]["mandate"]["software_core"], true);
    assert_eq!(
        packet["context"]["task"]["subjects"][0]["company"]["name"],
        "Carrier Cloud"
    );
    assert!(packet["metadata"]["omitted"]
        .as_array()
        .unwrap()
        .contains(&json!("subject_details")));
    let too_small = runtime.execute(ToolCall { tool:"build_context_packet".into(), arguments:json!({"run_id":"R1","task_type":"PLANNER","subject_ids":[],"token_budget":128}) }).await;
    assert!(too_small.is_err());
}

#[test]
fn concurrent_checkpoint_writers_detect_stale_sequence() {
    let (store, _, _) = fixture();
    let handles: Vec<_> = (0..2).map(|worker| { let store=store.clone(); std::thread::spawn(move || store.execute("save_checkpoint", &json!({"run_id":"R1","namespace":"concurrent","expected_sequence":0,"state":{"worker":worker}})).is_ok()) }).collect();
    let successes = handles
        .into_iter()
        .map(|h| usize::from(h.join().unwrap()))
        .sum::<usize>();
    assert_eq!(successes, 1);
}

#[test]
fn research_memory_includes_analyst_notes_and_resolved_questions() {
    let (store, _, _) = fixture();
    let label=store.execute("label_company", &json!({"run_id":"R1","company_id":"C1","label":"FIT","analyst_note":"Founder ownership confirmed"})).unwrap();
    let updated=store.execute("label_company", &json!({"run_id":"R1","company_id":"C1","label":"BEST_FIT","analyst_note":"Founder ownership confirmed"})).unwrap();
    assert_eq!(label["label_id"], updated["label_id"]);
    let question=store.execute("add_open_question", &json!({"run_id":"R1","company_id":"C1","question":"Verify founder ownership","priority":"high"})).unwrap();
    store.execute("resolve_open_question", &json!({"question_id":question["question_id"],"answer":"Founder owns the business","evidence_ids":[]})).unwrap();
    let memory = store
        .execute(
            "search_research_memory",
            &json!({"run_id":"R1","company_id":"C1","query":"founder"}),
        )
        .unwrap();
    let kinds: Vec<_> = memory
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|record| record["memory_type"].as_str())
        .collect();
    assert!(kinds.contains(&"analyst_label"));
    assert!(kinds.contains(&"research_question"));
}
