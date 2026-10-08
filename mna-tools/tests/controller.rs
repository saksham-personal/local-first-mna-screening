use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
use mna_tools::{
    controller::{self, TurnRequest},
    gateway, index_build, Runtime, Store,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tempfile::TempDir;

static ENV: Mutex<()> = Mutex::new(());
const SEARCH: &str = "## Context\nFind insurance vendors.\n## Reasoning\nUse approved core business.\n## Instruction set\n1. **search_mid** — Find claims vendors\n   - rationale: Broad claims software discovery\n   - keywords: claims; software\n";
const SUMMARY: &str = "## Context\nRead counts.\n## Reasoning\nUse saved state.\n## Instruction set\n1. **get_discovery_summary** — Read counts";

#[derive(Clone, Default)]
struct Fake {
    replies: Arc<Mutex<VecDeque<String>>>,
    requests: Arc<Mutex<Vec<Value>>>,
}
struct Fixture {
    store: Store,
    runtime: Runtime,
    rt: tokio::runtime::Runtime,
    fake: Fake,
    server: tokio::task::JoinHandle<()>,
    dir: TempDir,
    previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
}
impl Fixture {
    fn new(build: bool) -> Self {
        let root = std::env::var_os("CARGO_TARGET_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap());
        let dir = TempDir::new_in(root).unwrap();
        let mut previous = Vec::new();
        for key in [
            "MNA_ENABLE_EXTERNAL",
            "MNA_SIMULATE",
            "MNA_LLMSUITE_ENDPOINT",
            "MNA_LLMSUITE_TOKEN",
            "MNA_LLMSUITE_DEPLOYMENT",
            "MNA_LLMSUITE_ROTATE_TOKENS",
            "MNA_IMPORT_DIR",
            "MNA_EMBED_ENDPOINT",
            "MNA_MID_INDEX_CONFIG",
            "MNA_CONTROLLER_KEY",
        ] {
            previous.push((key, std::env::var_os(key)));
            std::env::remove_var(key);
        }
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let fake = Fake::default();
        let (server, address) = rt.block_on(async {
            async fn send(
                State(fake): State<Fake>,
                headers: HeaderMap,
                Json(body): Json<Value>,
            ) -> ([(&'static str, &'static str); 1], String) {
                assert_eq!(headers["authorization"], "Bearer fixture");
                assert!(headers.contains_key("idempotency-key"));
                fake.requests.lock().unwrap().push(body);
                let reply = fake
                    .replies
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("fixture reply");
                ([("content-type", "application/json")], reply)
            }
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let app = Router::new()
                .route("/chat", post(send))
                .with_state(fake.clone());
            (
                tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }),
                address,
            )
        });
        std::env::set_var("MNA_ENABLE_EXTERNAL", "true");
        std::env::set_var("MNA_LLMSUITE_ENDPOINT", format!("http://{address}/chat"));
        std::env::set_var("MNA_LLMSUITE_TOKEN", "fixture");
        std::env::set_var("MNA_LLMSUITE_DEPLOYMENT", "fixture-model");
        std::env::set_var("MNA_IMPORT_DIR", dir.path());
        let store = Store::open(dir.path().join("controller.db")).unwrap();
        store
            .execute(
                "create_run",
                &json!({"run_id":"R","objective":"Insurance software","original_criteria":{}}),
            )
            .unwrap();
        let revision=store.execute("save_criteria_revision",&json!({"run_id":"R","criteria_text":"Claims software","business_definition":"Insurance claims software","core_business_exclusions":["consulting"]})).unwrap();
        store.execute("approve_criteria_revision",&json!({"run_id":"R","revision":revision["revision"],"digest":revision["digest"],"approved_by":"Analyst"})).unwrap();
        let runtime = Runtime::new(store.clone()).unwrap();
        let fixture = Self {
            store,
            runtime,
            rt,
            fake,
            server,
            dir,
            previous,
        };
        if build {
            fixture.build();
        }
        fixture
    }
    // Same small workbook/build fixture pattern as tests/mid_search.rs; those
    // private helpers cannot be imported from a separate integration-test crate.
    fn build(&self) {
        let mut workbook = rust_xlsxwriter::Workbook::new();
        let sheet = workbook.add_worksheet();
        for (col, title) in [
            "Crescendo ID",
            "ECID",
            "Company",
            "Company Description",
            "Pitchbook Description",
            "Offerings",
        ]
        .iter()
        .enumerate()
        {
            sheet.write_string(0, col as u16, *title).unwrap();
        }
        for (i, desc) in [
            "insurance claims software",
            "claim management",
            "claims consulting",
            "policy administration",
        ]
        .iter()
        .enumerate()
        {
            for (col, value) in [
                format!("C{}", i + 1),
                format!("E{}", i + 1),
                format!("Company {}", i + 1),
                desc.to_string(),
                "insurance software".into(),
                "software".into(),
            ]
            .iter()
            .enumerate()
            {
                sheet
                    .write_string((i + 1) as u32, col as u16, value)
                    .unwrap();
            }
        }
        workbook.save(self.dir.path().join("mid.xlsx")).unwrap();
        let build = index_build::execute(
            &self.store,
            "start_index_build",
            &json!({"file":"mid.xlsx","name":"Fixture","activate_on_success":true}),
        )
        .unwrap();
        let start = Instant::now();
        loop {
            let status = index_build::execute(
                &self.store,
                "get_index_build",
                &json!({"build_id":build["build_id"]}),
            )
            .unwrap();
            if status["status"] != "queued" && status["status"] != "running" {
                assert_eq!(status["status"], "succeeded", "{status}");
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(60));
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn reply(&self, text: &str) {
        self.fake
            .replies
            .lock()
            .unwrap()
            .push_back(json!({"response_text":text}).to_string());
    }
    fn turn(&self, new_conversation: bool) -> mna_tools::error::Result<Value> {
        self.rt.block_on(controller::run_controller_turn(
            &self.runtime,
            &self.store,
            TurnRequest {
                run_id: "R".into(),
                analyst_message: "Find insurance software".into(),
                allowed_actions: None,
                new_conversation,
            },
        ))
    }
    fn count(&self, sql: &str) -> i64 {
        self.store
            .with_connection(|c| Ok(c.query_row(sql, [], |r| r.get(0))?))
            .unwrap()
    }
    fn stored(&self) -> Value {
        controller::get_controller_turns(&self.store, &json!({"run_id":"R","limit":100})).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        for (key, value) in &self.previous {
            if let Some(value) = value {
                std::env::set_var(key, value);
            } else {
                std::env::remove_var(key);
            }
        }
    }
}

#[test]
fn offline_node_stub_runs_through_real_parser_and_feedback_loop() {
    struct Stub(std::process::Child);
    impl Drop for Stub {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let _guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let f = Fixture::new(true);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../mna-ui/server/llmsuite-stub.mjs");
    let _stub = Stub(
        std::process::Command::new("node")
            .arg(script)
            .env("SCREENING_LLMSUITE_STUB_PORT", port.to_string())
            .env("STUB_DEVIATIONS", "1")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    f.rt.block_on(async {
        let start = Instant::now();
        loop {
            if reqwest::get(format!("http://127.0.0.1:{port}/health"))
                .await
                .is_ok()
            {
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(5));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });
    std::env::set_var("MNA_SIMULATE", "1");
    std::env::set_var(
        "MNA_LLMSUITE_ENDPOINT",
        format!("http://127.0.0.1:{port}/v1/chat"),
    );
    std::env::set_var("MNA_LLMSUITE_TOKEN", "stub");
    for _ in 0..2 {
        let result = f.turn(false).unwrap();
        assert_eq!(
            result["turns"][0]["instructions"][0]["action"],
            "search_mid"
        );
        assert_eq!(result["turns"][0]["instructions"][0]["status"], "executed");
        assert_eq!(result["turns"][0]["simulated"], true);
    }
    let result = f.turn(false).unwrap();
    assert_eq!(result["turns"].as_array().unwrap().len(), 2);
    assert_eq!(result["turns"][0]["instructions"][0]["status"], "rejected");
    assert_eq!(
        result["turns"][1]["instructions"][0]["action"],
        "search_mid"
    );
    assert_eq!(result["turns"][1]["instructions"][0]["status"], "executed");
    assert_eq!(
        f.count("SELECT COUNT(*) FROM llmsuite_slots WHERE consumed_epoch IS NOT NULL"),
        4
    );
}

#[test]
fn canonical_search_executes_and_persists_exact_reply_and_bounded_results() {
    let _guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let f = Fixture::new(true);
    f.reply(SEARCH);
    let result = f.turn(false).unwrap();
    let turn = &result["turns"][0];
    assert_eq!(turn["instructions"][0]["status"], "executed");
    assert_eq!(turn["instructions"][0]["arguments"]["run_id"], "R");
    assert_eq!(turn["instructions"][0]["result_summary"]["returned"], 4);
    assert_eq!(turn["reply_markdown"], SEARCH);
    assert_eq!(turn["prompt_id"], "controller-instruction-set");
    assert_eq!(turn["simulated"], false);
    assert_eq!(
        f.count("SELECT COUNT(*) FROM controller_turns WHERE status='executed'"),
        1
    );
    assert_eq!(
        f.count("SELECT COUNT(*) FROM candidates WHERE run_id='R'"),
        4
    );
    assert_eq!(
        f.count("SELECT COUNT(*) FROM agent_events WHERE event_type='PROVIDER_TEXT_RECEIPT'"),
        1
    );
    assert_eq!(f.stored()["turns"], result["turns"]);
    let requests = f.fake.requests.lock().unwrap();
    assert_eq!(requests[0]["conversation_id"], result["conversation_id"]);
    assert_eq!(requests[0]["model"], "fixture-model");
    let prompt = requests[0]["prompt"].as_str().unwrap();
    assert!(prompt.contains("approved: true"));
    assert!(prompt.contains("Insurance claims software"));
    let summary = controller::summarize(
        &json!({"rows":(0..100).map(|n|json!({"id":n,"description":"x".repeat(4000)})).collect::<Vec<_>>()}),
    );
    assert_eq!(summary["rows"]["count"], 100);
    assert_eq!(summary["rows"]["rows"].as_array().unwrap().len(), 20);
    assert_eq!(
        summary["rows"]["rows"][0]["description"]
            .as_str()
            .unwrap()
            .len(),
        600
    );
}

#[test]
fn unknown_action_repairs_on_same_conversation_without_repeating_valid_calls() {
    let _guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let f = Fixture::new(false);
    f.reply(&format!("{SUMMARY}\n2. **invented_action** — Wrong action"));
    f.reply(SUMMARY);
    let result = f.turn(false).unwrap();
    let turns = result["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["instructions"][0]["status"], "executed");
    assert_eq!(turns[0]["instructions"][1]["status"], "rejected");
    assert_eq!(turns[0]["feedback_sent"], true);
    assert_eq!(turns[1]["kind"], "feedback");
    assert_eq!(turns[1]["parent_turn_id"], turns[0]["turn_id"]);
    assert_eq!(turns[1]["instructions"][0]["status"], "executed");
    let requests = f.fake.requests.lock().unwrap();
    assert_eq!(
        requests[0]["conversation_id"],
        requests[1]["conversation_id"]
    );
    assert!(requests[1]["prompt"]
        .as_str()
        .unwrap()
        .contains("Correct only the rejected instructions"));
}

#[test]
fn forbidden_actions_never_approve_and_feedback_stops_after_two_rounds() {
    let _guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let f = Fixture::new(false);
    f.store
        .execute(
            "save_criteria_revision",
            &json!({"run_id":"R","criteria_text":"Changed","business_definition":"Changed"}),
        )
        .unwrap();
    for _ in 0..3 {
        f.reply("## Instruction set\n1. **approve_criteria_revision** — Self approve");
    }
    let result = f.turn(false).unwrap();
    assert_eq!(result["turns"].as_array().unwrap().len(), 3);
    for turn in result["turns"].as_array().unwrap() {
        assert_eq!(turn["instructions"][0]["status"], "rejected");
        assert!(turn["calls"].as_array().unwrap().is_empty());
    }
    assert_eq!(
        f.count("SELECT COUNT(*) FROM criteria_revision_approvals"),
        1
    );
    assert_eq!(f.fake.requests.lock().unwrap().len(), 3);
    assert!(f
        .rt
        .block_on(controller::run_controller_turn(
            &f.runtime,
            &f.store,
            TurnRequest {
                run_id: "R".into(),
                analyst_message: "Approve".into(),
                allowed_actions: Some(vec!["approve_criteria_revision".into()]),
                new_conversation: false
            }
        ))
        .is_err());
}

#[test]
fn changed_criteria_fail_discovery_and_later_valid_calls_still_execute() {
    let _guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let f = Fixture::new(false);
    f.store
        .execute(
            "save_criteria_revision",
            &json!({"run_id":"R","criteria_text":"Changed","business_definition":"Changed"}),
        )
        .unwrap();
    f.reply(&format!(
        "{SEARCH}\n2. **get_discovery_summary** — Read counts"
    ));
    let result = f.turn(false).unwrap();
    assert_eq!(result["turns"][0]["instructions"][0]["status"], "failed");
    assert_eq!(result["turns"][0]["instructions"][1]["status"], "executed");
    assert_eq!(f.count("SELECT COUNT(*) FROM candidates"), 0);
}

#[test]
fn explicit_new_context_closes_and_threshold_rotation_sends_nonexecuting_handoff() {
    let _guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let f = Fixture::new(false);
    f.reply(SUMMARY);
    let first = f.turn(false).unwrap();
    f.reply(SUMMARY);
    let second = f.turn(true).unwrap();
    assert_ne!(first["conversation_id"], second["conversation_id"]);
    assert_eq!(second["rotated"], true);
    assert_eq!(
        f.count("SELECT COUNT(*) FROM llm_conversations WHERE status='closed'"),
        1
    );
    std::env::set_var("MNA_LLMSUITE_ROTATE_TOKENS", "1");
    f.reply(
        "## Context\nSaved handoff.\n## Instruction set\n1. **search_mid** — Never execute handoff",
    );
    f.reply(SUMMARY);
    let third = f.turn(false).unwrap();
    assert_ne!(second["conversation_id"], third["conversation_id"]);
    assert_eq!(third["rotated"], true);
    assert_eq!(third["turns"][0]["kind"], "handoff");
    assert!(third["turns"][0]["instructions"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        f.count("SELECT COUNT(*) FROM llm_conversations WHERE status='rotated'"),
        1
    );
    f.store
        .with_connection(|c| {
            let from: String = c.query_row(
                "SELECT rotated_from FROM llm_conversations WHERE status='active'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(from, second["conversation_id"]);
            Ok(())
        })
        .unwrap();
    let requests = f.fake.requests.lock().unwrap();
    assert_eq!(requests[2]["conversation_id"], third["conversation_id"]);
    assert_eq!(requests[3]["conversation_id"], third["conversation_id"]);
    assert!(requests[2]["prompt"]
        .as_str()
        .unwrap()
        .contains("Recent decisions:"));
}

#[test]
fn controller_and_direct_provider_questions_share_seven_actual_sends_gate() {
    let _guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let f = Fixture::new(false);
    f.reply("Direct answer");
    f.rt.block_on(gateway::provider_text(
        f.store.clone(),
        gateway::ProviderTextRequest {
            run_id: Some("R".into()),
            provider: "llm_suite".into(),
            deployment: Some("fixture-model".into()),
            prompt: "Question".into(),
            request_id: Some("shared-question".into()),
            expected_format: None,
            purpose: None,
            attachments: vec![],
        },
    ))
    .unwrap();
    for _ in 0..6 {
        f.reply(SUMMARY);
        f.turn(false).unwrap();
    }
    let error = f.turn(false).unwrap_err();
    assert_eq!(error.code(), "RATE_LIMITED");
    assert_eq!(f.fake.requests.lock().unwrap().len(), 7);
    assert_eq!(
        f.count("SELECT COUNT(*) FROM llmsuite_slots WHERE consumed_epoch IS NOT NULL"),
        7
    );
    assert_eq!(
        f.stored()["turns"].as_array().unwrap().last().unwrap()["status"],
        "failed"
    );
}

#[test]
fn oversized_response_fails_and_garbage_is_stored_with_parser_warnings() {
    let _guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let f = Fixture::new(false);
    f.reply(&"x".repeat(2_000_001));
    assert!(f.turn(false).unwrap_err().to_string().contains("2 MB"));
    assert_eq!(f.stored()["turns"][0]["status"], "failed");
    f.reply("totally unstructured nonsense");
    let result = f.turn(false).unwrap();
    let turn = &result["turns"][0];
    assert_eq!(result["turns"].as_array().unwrap().len(), 1);
    assert_eq!(turn["reply_markdown"], "totally unstructured nonsense");
    assert_eq!(turn["status"], "executed");
    assert!(turn["calls"].as_array().unwrap().is_empty());
    assert!(turn["instructions"].as_array().unwrap().is_empty());
    assert!(turn["warnings"].as_array().unwrap().iter().any(|warning| {
        warning
            .as_str()
            .is_some_and(|text| text.starts_with("No instruction set was found in the reply"))
    }));
    assert_eq!(turn["feedback_sent"], false);
    let stored = f.stored();
    assert_eq!(stored["turns"].as_array().unwrap().len(), 2);
    assert_eq!(stored["turns"][1], *turn);
    assert_eq!(f.fake.requests.lock().unwrap().len(), 2);
    assert_eq!(f.count("SELECT COUNT(*) FROM execution_provider_audit"), 2);
}

#[test]
fn admin_turn_requires_controller_credentials_and_read_tool_is_public_catalogued() {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let _guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let f = Fixture::new(false);
    const KEY: &str = "controller-fixture-key-with-24-characters";
    const API: &str = "service-fixture-key-with-24-characters";
    const ANALYST: &str = "analyst-fixture-key-with-24-characters";
    std::env::set_var("MNA_CONTROLLER_KEY", KEY);
    let app = mna_tools::router(f.runtime.clone(), API.into(), Some(ANALYST.into())).unwrap();
    for controller in [false, true] {
        if controller {
            f.reply(SUMMARY);
        }
        let mut request = Request::builder()
            .method("POST")
            .uri("/admin/controller-turn")
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {API}"))
            .header("x-mna-analyst-key", ANALYST);
        if controller {
            request = request.header("x-mna-controller-key", KEY);
        }
        let response =
            f.rt.block_on(
                app.clone().oneshot(
                    request
                        .body(Body::from(
                            json!({"run_id":"R","analyst_message":"Summary"}).to_string(),
                        ))
                        .unwrap(),
                ),
            )
            .unwrap();
        assert_eq!(
            response.status().as_u16(),
            if controller { 200 } else { 403 }
        );
        let _ = f.rt.block_on(response.into_body().collect()).unwrap();
    }
    let response =
        f.rt.block_on(f.runtime.execute(mna_tools::runtime::ToolCall {
            tool: "get_controller_turns".into(),
            arguments: json!({"run_id":"R"}),
        }))
        .unwrap();
    assert_eq!(response["turns"].as_array().unwrap().len(), 1);
    let admin = mna_tools::runtime::administrator_definitions()
        .into_iter()
        .find(|d| d["name"] == "run_controller_turn")
        .unwrap();
    assert_eq!(admin["controller_only"], true);
}
