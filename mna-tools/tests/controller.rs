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
            "MNA_EMBED_MODEL",
            "MNA_EMBED_VERSION",
            "MNA_EMBED_DIMENSIONS",
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
                .route("/embed", post(|Json(body): Json<Value>| async move {
                    Json(json!({"model":body["model"],"version":body["version"],"dimensions":2,"vectors":[[1.0,0.0]]}))
                }))
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
        self.build_fixture(false);
    }
    fn build_fixture(&self, semantic_candidate: bool) {
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
        let mut descriptions = vec![
            "insurance claims software",
            "claim management",
            "claims consulting",
            "policy administration",
        ];
        if semantic_candidate {
            descriptions.push("Owned workflow application for underwriters");
        }
        for (i, desc) in descriptions.iter().enumerate() {
            for (col, value) in [
                format!("C{}", i + 1),
                format!("E{}", i + 1),
                format!("Company {}", i + 1),
                desc.to_string(),
                if i == 4 {
                    "workflow"
                } else {
                    "insurance software"
                }
                .into(),
                if i == 4 { "workflow" } else { "software" }.into(),
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
    assert_eq!(second["rotated_from"], first["conversation_id"]);
    assert_eq!(second["rotation"], "new_conversation");
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
    assert_eq!(third["rotated_from"], second["conversation_id"]);
    assert_eq!(third["rotation"], "token_budget");
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

#[test]
fn discovery_loop_stub_completes_applies_and_is_reversible() {
    struct Stub(std::process::Child);
    impl Drop for Stub {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let _guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let f = Fixture::new(false);
    f.build_fixture(true);
    let endpoint = std::env::var("MNA_LLMSUITE_ENDPOINT")
        .unwrap()
        .replace("/chat", "/embed");
    std::env::set_var("MNA_EMBED_ENDPOINT", endpoint);
    std::env::set_var("MNA_EMBED_MODEL", "fixture");
    std::env::set_var("MNA_EMBED_VERSION", "1");
    std::env::set_var("MNA_EMBED_DIMENSIONS", "2");
    f.store.with_connection(|c| {
        c.execute("UPDATE mid_bundles SET semantic_status='ready'",[])?;
        for (id,vector) in [("E1-C1",[1.0f32,0.0]),("E2-C2",[0.8,0.6]),("E3-C3",[0.0,1.0]),("E4-C4",[-1.0,0.0]),("E5-C5",[1.0,0.0])] {
            let hash:String=c.query_row("SELECT desc_hash FROM mid_rows WHERE company_id=?",[id],|r|r.get(0))?;
            let blob=vector.iter().flat_map(|v|v.to_le_bytes()).collect::<Vec<_>>();
            c.execute("INSERT INTO embedding_vectors(company_id,model,model_version,dimensions,text_hash,vector_blob,created_at) VALUES(?,'fixture','1',2,?,?,datetime('now'))",rusqlite::params![id,hash,blob])?;
        }
        Ok(())
    }).unwrap();
    f.store.execute("ingest_companies",&json!({"companies":[{"company_id":"OUT","name":"Unrelated bakery","description":"Bread and pastries"}]})).unwrap();
    f.store
        .execute(
            "add_candidates",
            &json!({"run_id":"R","companies":["OUT"],"discovery_source":"MID"}),
        )
        .unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../mna-ui/server/llmsuite-stub.mjs");
    let _stub = Stub(
        std::process::Command::new("node")
            .arg(script)
            .env("SCREENING_LLMSUITE_STUB_PORT", port.to_string())
            .env("STUB_DEVIATIONS", "0")
            .env("STUB_LOOP_TURNS", "0")
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
    std::env::set_var(
        "MNA_LLMSUITE_ENDPOINT",
        format!("http://127.0.0.1:{port}/v1/chat"),
    );
    std::env::set_var("MNA_LLMSUITE_TOKEN", "stub");
    let v = mna_tools::controller_loop::start(
        &f.store,
        &json!({"run_id":"R","analyst_message":"Find claims software","max_turns":50}),
    )
    .unwrap();
    let loop_id = v["loop_id"].as_str().unwrap().to_owned();
    let id = loop_id.as_str();
    let mut result = v;
    for _ in 0..6 {
        result =
            f.rt.block_on(mna_tools::controller_loop::turn(&f.runtime, &f.store, id))
                .unwrap();
        if result["status"] == "completed" {
            break;
        }
    }
    assert_eq!(result["status"], "completed");
    assert_eq!(result["turns_used"], 4);
    assert_eq!(result["queries"].as_array().unwrap().len(), 3);
    assert!(result["queries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|q| q["source"] == "MID_SEMANTIC"));
    assert_eq!(result["simulated"], true);
    assert!(!result["applied_review_id"].is_null());
    let count = f.count("SELECT COUNT(*) FROM candidates WHERE run_id='R' AND considered=1");
    assert!(count > 0);
    assert!(f.count("SELECT COUNT(*) FROM candidates WHERE run_id='R' AND considered=0") > 0);
    println!("Real Rust + Node stub loop final considered count: {count}");
    assert!(
        result["turns"][0]["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["action"] == "search_mid_semantic"
                && r["status"] == "executed"
                && r["result_summary"]["returned"].as_i64().unwrap_or(0) > 0),
        "{result}"
    );
    f.rt.block_on(mna_tools::controller_loop::admin(
        &f.runtime,
        &f.store,
        "undo_controller_loop",
        &json!({"loop_id":id}),
    ))
    .unwrap();
    assert_eq!(
        f.count("SELECT COUNT(*) FROM candidates WHERE considered=1"),
        1
    );
    assert_eq!(f.count("SELECT COUNT(*) FROM candidates"), 6);
}

#[test]
fn discovery_loop_cap_without_keeps_and_two_none_replies_do_not_apply() {
    let _guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let f = Fixture::new(false);
    for max in [1, 50] {
        let v = mna_tools::controller_loop::start(
            &f.store,
            &json!({"run_id":"R","analyst_message":"Find claims software","max_turns":max}),
        )
        .unwrap();
        let id = v["loop_id"].as_str().unwrap();
        f.reply("## Instruction set\nNone.");
        let mut result =
            f.rt.block_on(mna_tools::controller_loop::turn(&f.runtime, &f.store, id))
                .unwrap();
        if max == 50 {
            assert_eq!(result["status"], "running");
            f.reply("## Instruction set\nNone.");
            result =
                f.rt.block_on(mna_tools::controller_loop::turn(&f.runtime, &f.store, id))
                    .unwrap();
        }
        assert_eq!(result["status"], "completed");
        assert!(result["applied_review_id"].is_null());
        assert_eq!(
            result["summary"],
            "No keep decisions were made; the shortlist was not changed."
        );
    }
    assert_eq!(f.count("SELECT COUNT(*) FROM shortlist_reviews"), 0);
    assert!(f.fake.requests.lock().unwrap()[0]["prompt"]
        .as_str()
        .unwrap()
        .contains("TURN BUDGET: 1 turns left"));
}

#[test]
fn discovery_loop_rotation_resends_state_and_rejects_forbidden_actions() {
    let _guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let f = Fixture::new(true);
    let v = mna_tools::controller_loop::start(
        &f.store,
        &json!({"run_id":"R","analyst_message":"Find claims software"}),
    )
    .unwrap();
    let id = v["loop_id"].as_str().unwrap();
    f.reply(SEARCH);
    f.rt.block_on(mna_tools::controller_loop::turn(&f.runtime, &f.store, id))
        .unwrap();
    std::env::set_var("MNA_LLMSUITE_ROTATE_TOKENS", "1");
    f.reply("## Approved state\nNo actions.\n## Instruction set\n1. **finish_loop**\n - summary: This handoff must not execute");
    f.reply("## Instruction set\n1. **approve_criteria_revision**\n2. **export_shortlist**");
    f.reply("## Instruction set\n1. **keep_query_results**\n - query_id: Q1\n - min_score: 0.5\n - note: Keep software fits");
    let result =
        f.rt.block_on(mna_tools::controller_loop::turn(&f.runtime, &f.store, id))
            .unwrap();
    assert_ne!(result["conversation_id"], v["conversation_id"]);
    assert_eq!(result["status"], "running");
    assert_eq!(result["keeps"].as_array().unwrap().len(), 1);
    let requests = f.fake.requests.lock().unwrap();
    let handoff = requests[1]["prompt"].as_str().unwrap();
    assert!(handoff.contains("Loop state:"));
    assert!(handoff.contains("Q1 · MID_KEYWORD"));
    assert_eq!(requests[1]["conversation_id"], v["conversation_id"]);
    let restarted = requests[2]["prompt"].as_str().unwrap();
    assert!(restarted.starts_with("You are running a discovery loop"));
    assert!(restarted.contains("Analyst request:"));
    assert!(restarted.contains("Histogram:"));
    assert_eq!(f.count("SELECT COUNT(*) FROM shortlist_reviews"), 0);
    assert_eq!(f.count("SELECT COUNT(*) FROM company_labels"), 0);
}

#[test]
fn discovery_loop_admin_boundaries_require_controller_key_and_actions_are_private() {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let _guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let f = Fixture::new(false);
    const KEY: &str = "loop-controller-key-with-24-characters";
    const API: &str = "loop-service-key-with-24-characters";
    const ANALYST: &str = "loop-analyst-key-with-24-characters";
    std::env::set_var("MNA_CONTROLLER_KEY", KEY);
    let app = mna_tools::router(f.runtime.clone(), API.into(), Some(ANALYST.into())).unwrap();
    for route in ["start", "turn", "consolidate", "cancel", "undo"] {
        let response =
            f.rt.block_on(
                app.clone().oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("/admin/controller-loop-{route}"))
                        .header("content-type", "application/json")
                        .header("authorization", format!("Bearer {API}"))
                        .header("x-mna-analyst-key", ANALYST)
                        .body(Body::from("{}"))
                        .unwrap(),
                ),
            )
            .unwrap();
        assert_eq!(response.status().as_u16(), 403);
    }
    let response =
        f.rt.block_on(
            app.oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/admin/controller-loop-start")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {API}"))
                    .header("x-mna-controller-key", KEY)
                    .body(Body::from(
                        json!({"run_id":"R","analyst_message":"Find claims"}).to_string(),
                    ))
                    .unwrap(),
            ),
        )
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let bytes =
        f.rt.block_on(response.into_body().collect())
            .unwrap()
            .to_bytes();
    let result: Value = serde_json::from_slice(&bytes).unwrap();
    let read =
        f.rt.block_on(f.runtime.execute(mna_tools::runtime::ToolCall {
            tool: "get_controller_loop".into(),
            arguments: json!({"loop_id":result["loop_id"]}),
        }))
        .unwrap();
    assert_eq!(read["status"], "running");
    let list =
        f.rt.block_on(f.runtime.execute(mna_tools::runtime::ToolCall {
            tool: "list_controller_loops".into(),
            arguments: json!({"run_id":"R"}),
        }))
        .unwrap();
    assert_eq!(list["loops"].as_array().unwrap().len(), 1);
    for action in [
        "keep_query_results",
        "drop_companies",
        "finish_loop",
        "inspect_band",
    ] {
        assert!(f
            .rt
            .block_on(f.runtime.execute(mna_tools::runtime::ToolCall {
                tool: action.into(),
                arguments: json!({"loop_id":result["loop_id"]})
            }))
            .is_err());
    }
    assert!(mna_tools::runtime::administrator_definitions()
        .iter()
        .filter(|v| v["name"]
            .as_str()
            .is_some_and(|s| s.contains("controller_loop")))
        .all(|v| v["controller_only"] == true));
}

#[test]
fn loop_provider_failures_pause_and_resume_including_saved_feedback() {
    let _guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
    let f = Fixture::new(true);
    let initial = mna_tools::controller_loop::start(
        &f.store,
        &json!({"run_id":"R","analyst_message":"Find claims"}),
    )
    .unwrap();
    let id = initial["loop_id"].as_str().unwrap();
    let model = std::env::var("MNA_LLMSUITE_DEPLOYMENT").unwrap();
    std::env::remove_var("MNA_LLMSUITE_DEPLOYMENT");
    assert!(matches!(
        f.rt.block_on(mna_tools::controller_loop::turn(&f.runtime, &f.store, id)),
        Err(mna_tools::error::Error::ProviderUnavailable(_))
    ));
    assert_eq!(
        mna_tools::controller_loop::get(&f.store, &json!({"loop_id":id})).unwrap()["status"],
        "paused"
    );
    std::env::set_var("MNA_LLMSUITE_DEPLOYMENT", model);
    let token = std::env::var("MNA_LLMSUITE_TOKEN").unwrap();
    std::env::remove_var("MNA_LLMSUITE_TOKEN");
    assert!(f
        .rt
        .block_on(mna_tools::controller_loop::turn(&f.runtime, &f.store, id))
        .is_err());
    assert_eq!(
        mna_tools::controller_loop::get(&f.store, &json!({"loop_id":id})).unwrap()["status"],
        "paused"
    );
    std::env::set_var("MNA_LLMSUITE_TOKEN", token);
    let endpoint = std::env::var("MNA_LLMSUITE_ENDPOINT").unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    std::env::set_var("MNA_LLMSUITE_ENDPOINT", format!("http://{address}/chat"));
    assert!(f
        .rt
        .block_on(mna_tools::controller_loop::turn(&f.runtime, &f.store, id))
        .is_err());
    assert_eq!(
        mna_tools::controller_loop::get(&f.store, &json!({"loop_id":id})).unwrap()["status"],
        "paused"
    );
    std::env::set_var("MNA_LLMSUITE_ENDPOINT", endpoint);
    f.reply(SEARCH);
    assert_eq!(
        f.rt.block_on(mna_tools::controller_loop::turn(&f.runtime, &f.store, id))
            .unwrap()["status"],
        "running"
    );
    // Both saved-turn resume paths must return running, without repeating searches.
    f.store
        .with_connection(|c| {
            c.execute(
                "UPDATE controller_loops SET turns_used=0,status='paused' WHERE loop_id=?",
                [id],
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        f.rt.block_on(mna_tools::controller_loop::turn(&f.runtime, &f.store, id))
            .unwrap()["status"],
        "running"
    );
    assert_eq!(f.count("SELECT COUNT(*) FROM search_queries"), 1);
    // Stop after a saved main turn, as if feedback hit a rate gate just before restart.
    f.store
        .with_connection(|c| {
            let turn_id: String = c.query_row(
                "SELECT ct.turn_id FROM controller_loop_turns lt JOIN controller_turns ct ON ct.turn_id=lt.turn_id WHERE lt.loop_id=? AND ct.status='executed' LIMIT 1",
                [id],
                |r| r.get(0),
            )?;
            c.execute(
                "UPDATE controller_loops SET turns_used=0,status='paused' WHERE loop_id=?",
                [id],
            )?;
            c.execute(
                "UPDATE controller_turns SET parsed_json=? WHERE turn_id=?",
                rusqlite::params![
                    serde_json::to_string(&mna_tools::instruction_set::parse_reply(
                        "## Instruction set\n1. **invented_action**"
                    ))
                    .unwrap(),
                    turn_id
                ],
            )?;
            Ok(())
        })
        .unwrap();
    f.reply("## Instruction set\n1. **keep_query_results**\n - query_id: q1\n - min_score: 0.5\n - note: Fit");
    let result =
        f.rt.block_on(mna_tools::controller_loop::turn(&f.runtime, &f.store, id))
            .unwrap();
    assert_eq!(result["status"], "running");
    assert_eq!(result["keeps"].as_array().unwrap().len(), 1);
    assert_eq!(f.count("SELECT COUNT(*) FROM search_queries"), 1);
}

#[test]
fn stale_apply_pauses_real_node_runner_and_can_resume_or_cancel() {
    let _guard = ENV.lock().unwrap_or_else(|error| error.into_inner());
    for action in ["resume", "discard", "keep"] {
        let f = Fixture::new(true);
        let initial = mna_tools::controller_loop::start(
            &f.store,
            &json!({"run_id":"R","analyst_message":"Find claims"}),
        )
        .unwrap();
        let id = initial["loop_id"].as_str().unwrap();
        f.reply(SEARCH);
        f.rt.block_on(mna_tools::controller_loop::turn(&f.runtime, &f.store, id))
            .unwrap();
        f.reply("## Instruction set\n1. **keep_query_results**\n - query_id: Q1\n - min_score: 0.5\n - note: Keep fits");
        f.rt.block_on(mna_tools::controller_loop::turn(&f.runtime, &f.store, id))
            .unwrap();
        f.store.execute("review_shortlist",&json!({"run_id":"R","keep_company_ids":[],"reason":"Analyst changed shortlist during loop"})).unwrap();
        f.store
            .with_connection(|c| {
                c.execute(
                    "UPDATE controller_loops SET finish_requested=1 WHERE loop_id=?",
                    [id],
                )?;
                Ok(())
            })
            .unwrap();
        std::env::set_var(
            "MNA_CONTROLLER_KEY",
            "loop-controller-key-with-24-characters",
        );
        let app = mna_tools::router(
            f.runtime.clone(),
            "loop-service-key-with-24-characters".into(),
            Some("loop-analyst-key-with-24-characters".into()),
        )
        .unwrap();
        let (server, address) = f.rt.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            (
                tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }),
                address,
            )
        });
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../mna-ui/tests/controller-loop-rust-e2e.mjs");
        let output = std::process::Command::new("node")
            .arg(script)
            .arg(format!("http://{address}"))
            .arg(id)
            .arg(action)
            .output()
            .unwrap();
        server.abort();
        println!("{}", String::from_utf8_lossy(&output.stdout));
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(f.count("SELECT COUNT(*) FROM candidates"), 4);
        if action == "discard" {
            assert_eq!(f.count("SELECT COUNT(*) FROM shortlist_reviews"), 1);
            assert!(mna_tools::controller_loop::start(
                &f.store,
                &json!({"run_id":"R","analyst_message":"Start again"})
            )
            .is_ok());
        } else {
            assert_eq!(f.count("SELECT COUNT(*) FROM shortlist_reviews"), 2);
        }
    }
}
