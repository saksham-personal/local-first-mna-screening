use axum::{body::Body, http::Request};
use calamine::{open_workbook_auto, Reader};
use http_body_util::BodyExt;
use mna_tools::{
    data::DataService,
    execution::ExecutionService,
    gateway::{self, DispatchRequest},
    providers::Providers,
    runtime::ToolCall,
    simulate,
    workflow::WorkflowService,
    Runtime, Store,
};
use serde_json::{json, Value};
use std::sync::Mutex;
use tower::ServiceExt;

static ENV: Mutex<()> = Mutex::new(());
const API_KEY: &str = "simulation-test-service-key-24-characters";

struct Environment(Vec<(&'static str, Option<std::ffi::OsString>)>);
impl Environment {
    fn isolate() -> Self {
        let keys = [
            "MNA_SIMULATE",
            "MNA_ENABLE_EXTERNAL",
            "MNA_IMPORT_DIR",
            "MNA_EXPORT_DIR",
            "MNA_LLMSUITE_ENDPOINT",
            "MNA_LLMSUITE_TOKEN",
            "MNA_M365_ENDPOINT",
            "MNA_M365_TOKEN",
        ];
        let saved = keys.into_iter().map(|k| (k, std::env::var_os(k))).collect();
        for key in keys {
            std::env::remove_var(key);
        }
        Self(saved)
    }
}
impl Drop for Environment {
    fn drop(&mut self) {
        for (key, value) in &self.0 {
            if let Some(value) = value {
                std::env::set_var(key, value);
            } else {
                std::env::remove_var(key);
            }
        }
    }
}

fn fixture() -> (tempfile::TempDir, Store, DataService) {
    let dir = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
    std::env::set_var("MNA_IMPORT_DIR", dir.path());
    std::env::set_var("MNA_EXPORT_DIR", dir.path());
    let mut csv = String::from("ECID,CID,Company Name,Description\n");
    for i in 0..150 {
        csv.push_str(&format!(
            "E{i},C{i},Policy Vendor {i},Insurance policy software\n"
        ));
    }
    std::fs::write(dir.path().join("mid.csv"), csv).unwrap();
    let store = Store::open(":memory:").unwrap();
    let data = DataService::new(store.clone());
    data.execute("import_company_files", &json!({"files":["mid.csv"]}))
        .unwrap();
    for run in ["discovery", "screening", "research", "clean"] {
        store.execute("create_run", &json!({"run_id":run,"objective":"Find insurance software","original_criteria":{},"initial_profile":{"core_business_query":"insurance policy software"}})).unwrap();
        store
            .execute(
                "approve_screening_profile",
                &json!({"run_id":run,"version":1,"approved_by":"test analyst"}),
            )
            .unwrap();
        let ids: Vec<_> = (0..100).map(|i| format!("E{i}-C{i}")).collect();
        store
            .execute(
                "add_candidates",
                &json!({"run_id":run,"companies":ids,"discovery_source":"MID"}),
            )
            .unwrap();
    }
    (dir, store, data)
}

fn propose(service: &ExecutionService, provider: &str) -> Value {
    service.execute("propose_prepared_plan", &json!({"run_id":"screening","mode":"screening","provider":provider,"deployment":"simulated-dev","prompt":"Assess insurance policy software","output_columns":["Fit Score","Reason"],"score_columns":["Fit Score"],"batch_size":100})).unwrap()
}

fn approve(service: &ExecutionService, plan: &Value) -> Value {
    service.execute("approve_prepared_plan", &json!({"plan_id":plan["plan_id"],"digest":plan["digest"],"approval_key":plan["digest"],"approved_by":"test analyst"})).unwrap();
    service
        .execute("get_prepared_plan", &json!({"plan_id":plan["plan_id"]}))
        .unwrap()
}

async fn status(runtime: &Runtime) -> Value {
    let app = mna_tools::router(runtime.clone(), API_KEY.into(), None).unwrap();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/providers/status")
                .header("authorization", format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

fn export(
    data: &DataService,
    run: &str,
    kind: &str,
    allow: bool,
    name: &str,
) -> mna_tools::error::Result<Value> {
    data.execute(
        "export_candidate_set",
        &json!({"run_id":run,"export_type":kind,"file_name":name,"allow_simulated":allow}),
    )
}

fn assert_watermark(value: &Value, full: bool) {
    let path = value["path"].as_str().unwrap();
    assert!(path.ends_with("-SIMULATED.xlsx"));
    let mut workbook = open_workbook_auto(path).unwrap();
    let names = workbook.sheet_names();
    if full {
        assert!(names.contains(&"SIMULATED".to_owned()));
    }
    for name in names {
        let range = workbook.worksheet_range(&name).unwrap();
        if name == "SIMULATED" {
            assert!(range
                .get_value((0, 0))
                .unwrap()
                .to_string()
                .starts_with("SIMULATED:"));
        } else {
            assert_eq!(range.get_value((0, 0)).unwrap().to_string(), "Data origin");
            for row in range.rows().skip(1) {
                assert_eq!(row[0].to_string(), "SIMULATED");
            }
            if name == "LLM" {
                assert_eq!(range.get_value((1, 1)).unwrap().to_string(), "1");
            }
        }
    }
}

#[tokio::test(flavor = "current_thread")]
#[allow(clippy::await_holding_lock)] // Serializes all environment writes in this test binary.
async fn labelled_simulation_uses_normal_ingestion_approval_dispatch_and_export_paths() {
    let _lock = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let _env = Environment::isolate();
    std::env::set_var("MNA_SIMULATE", "1");
    let (_dir, store, data) = fixture();
    let query = "insurance policy workflow software";
    let rows = simulate::iscc_rows(&store, "discovery", query).unwrap();
    assert_eq!(
        rows,
        simulate::iscc_rows(&store, "discovery", query).unwrap()
    );
    assert_eq!(rows.len(), 250);
    for row in &rows {
        assert_eq!(row.as_object().unwrap().len(), simulate::ISCC_HEADERS.len());
        for header in simulate::ISCC_HEADERS {
            assert!(row.get(*header).is_some(), "{header}");
        }
        let text = row["Relevancy Score"].as_str().unwrap();
        assert_eq!(text.split('.').nth(1).unwrap().len(), 2);
        assert!((0.0..=1.0).contains(&text.parse::<f64>().unwrap()));
        assert_eq!(row["Company Description Source"], "Simulated");
        assert!(row["iQ Link"]
            .as_str()
            .unwrap()
            .starts_with("https://iq.example.invalid/"));
    }
    let missing_ecid = rows[150..].iter().filter(|r| r["ECI"] == "-").count();
    assert!((5..=25).contains(&missing_ecid));
    let runtime = Runtime::new(store.clone()).unwrap();
    assert_eq!(status(&runtime).await["simulated"], true);
    assert!(status(&runtime).await["paths"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["simulated"] == true && p["execution_enabled"] == true));
    let call = || ToolCall {
        tool: "search_iscc".into(),
        arguments: json!({"run_id":"discovery","query":query}),
    };
    let found = runtime.execute(call()).await.unwrap();
    assert_eq!(found["simulated"], true);
    assert_eq!(found["result_count"], 250);
    assert_eq!(
        found["results"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["source"] == "both")
            .count(),
        150
    );
    let ids: Vec<_> = found["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["company_id"].clone())
        .collect();
    store.execute("add_candidates", &json!({"run_id":"discovery","companies":ids,"discovery_source":"ISCC","query_id":found["query_id"]})).unwrap();
    assert_eq!(
        found["results"],
        runtime.execute(call()).await.unwrap()["results"]
    );
    assert_eq!(
        store
            .with_connection(|c| Ok(c.query_row(
                "SELECT COUNT(*) FROM source_rows WHERE source='ISCC' AND simulated=1",
                [],
                |r| r.get::<_, i64>(0)
            )?))
            .unwrap(),
        500
    );
    assert_eq!(
        store
            .with_connection(|c| Ok(c.query_row(
                "SELECT COUNT(*) FROM source_rows WHERE source='MID' AND simulated=1",
                [],
                |r| r.get::<_, i64>(0)
            )?))
            .unwrap(),
        0
    );
    assert!(runtime
        .execute(ToolCall {
            tool: "search_iscc".into(),
            arguments: json!({"run_id":"discovery","query":query,"limit":0})
        })
        .await
        .is_err());

    let execution = ExecutionService::new(store.clone());
    for provider in ["llm_suite", "copilot"] {
        let plan = propose(&execution, provider);
        assert!(execution.execute("approve_prepared_plan", &json!({"plan_id":plan["plan_id"],"digest":"wrong","approval_key":"wrong","approved_by":"analyst"})).is_err());
        let approved = approve(&execution, &plan);
        let job = approved["jobs"][0]["job_id"].as_str().unwrap();
        let payload = execution
            .execute("get_execution_job", &json!({"job_id":job}))
            .unwrap()["payload"]
            .clone();
        let text = simulate::screening_response(&payload).unwrap();
        assert_eq!(text, simulate::screening_response(&payload).unwrap());
        let parsed = mna_tools::result_parser::parse_markdown_results(
            &text,
            &["Fit Score".into(), "Reason".into()],
            &(1..=100).collect::<Vec<_>>(),
            &["Fit Score".into()],
        )
        .unwrap();
        let checks = parsed.iter().filter(|r| r["Fit Score"] == "CHECK").count();
        assert!((2..=25).contains(&checks), "CHECK count: {checks}");
        for row in parsed {
            assert!(
                row["Fit Score"] == "CHECK"
                    || row["Fit Score"]
                        .as_f64()
                        .is_some_and(|n| (0.0..=10.0).contains(&n) && n.fract() == 0.0)
            );
        }
        assert!(execution
            .execute(
                "mark_execution_dispatch",
                &json!({"job_id":job,"lease_token":"wrong","request_key":"wrong"})
            )
            .is_err());
        let result = gateway::dispatch(
            store.clone(),
            DispatchRequest {
                job_id: job.into(),
                controller_id: "test controller".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(result["state"], "SUCCEEDED");
        assert_eq!(result["simulated"], true);
        assert_eq!(
            execution
                .execute("get_execution_job", &json!({"job_id":job}))
                .unwrap()["raw_response"],
            text
        );
    }
    assert_eq!(
        store
            .with_connection(|c| Ok(c.query_row(
                "SELECT COUNT(*) FROM model_assessments WHERE simulated=1",
                [],
                |r| r.get::<_, i64>(0)
            )?))
            .unwrap(),
        200
    );
    assert_eq!(
        store
            .with_connection(|c| Ok(c.query_row(
                "SELECT COUNT(*) FROM execution_transport_receipts",
                [],
                |r| r.get::<_, i64>(0)
            )?))
            .unwrap(),
        2
    );
    let rounds = execution
        .execute("get_screening_rounds", &json!({"run_id":"screening"}))
        .unwrap();
    assert!(rounds["rounds"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["simulated"] == true && r["assessed_companies"] == 100));

    let workflow = WorkflowService::new(store.clone());
    let action = workflow.execute("propose_action_plan", &json!({"run_id":"research","rationale":"Development research","steps":[{"step_id":"bing","kind":"bing_research","company_ids":["E1-C1"],"query_templates":["{company_name} products"]}]})).unwrap();
    workflow.execute("approve_action_plan", &json!({"run_id":"research","plan_id":action["plan_id"],"approve":true,"approved_by":"test analyst"})).unwrap();
    let prepared = workflow.execute("prepare_bing_queries", &json!({"run_id":"research","plan_id":action["plan_id"],"step_id":"bing","company_ids":["E1-C1"]})).unwrap();
    let args = json!({"run_id":"research","plan_id":action["plan_id"],"step_id":"bing","company_id":"E1-C1","query":prepared["queries"][0]["query"]});
    let bing = runtime
        .execute(ToolCall {
            tool: "bing_search".into(),
            arguments: args.clone(),
        })
        .await
        .unwrap();
    assert_eq!(bing["simulated"], true);
    assert!((3..=5).contains(&bing["results"].as_array().unwrap().len()));
    for lead in bing["results"].as_array().unwrap() {
        assert!(lead["title"].as_str().unwrap().starts_with("Simulated:"));
        assert!(lead["snippet"].as_str().unwrap().starts_with("Simulated:"));
        assert!(lead["url"]
            .as_str()
            .unwrap()
            .starts_with("https://example.invalid/"));
    }
    assert_eq!(
        bing["results"],
        runtime
            .execute(ToolCall {
                tool: "bing_search".into(),
                arguments: args
            })
            .await
            .unwrap()["results"]
    );
    assert_eq!(
        store
            .with_connection(|c| Ok(c.query_row(
                "SELECT simulated FROM evidence WHERE evidence_id=?",
                [bing["evidence_id"].as_str().unwrap()],
                |r| r.get::<_, i64>(0)
            )?))
            .unwrap(),
        1
    );
    assert!(runtime.execute(ToolCall {tool:"bing_search".into(),arguments:json!({"run_id":"research","plan_id":action["plan_id"],"step_id":"bing","company_id":"E1-C1","query":"unapproved question"})}).await.is_err());
    assert!(Providers::new()
        .unwrap()
        .execute("m365_research", &json!({"question":"Development question"}))
        .await
        .is_err());

    std::env::remove_var("MNA_SIMULATE"); // Contaminated exports stay blocked when dev mode is off.
    for run in ["discovery", "screening", "research"] {
        for kind in ["PITCHBOOK", "LLM", "FULL"] {
            let name = format!("{run}-{kind}.xlsx");
            let error = export(&data, run, kind, false, &name).unwrap_err();
            assert!(
                matches!(error, mna_tools::error::Error::Validation(ref message) if message == "This export includes simulated data. Turn off simulation or pass allow_simulated to export a labelled copy.")
            );
            assert_watermark(
                &export(&data, run, kind, true, &name).unwrap(),
                kind == "FULL",
            );
        }
    }
    let clean = export(&data, "clean", "LLM", false, "clean.xlsx").unwrap();
    assert!(clean["path"].as_str().unwrap().ends_with("clean.xlsx"));
    let mut workbook = open_workbook_auto(clean["path"].as_str().unwrap()).unwrap();
    assert_eq!(
        workbook
            .worksheet_range("LLM")
            .unwrap()
            .get_value((0, 0))
            .unwrap()
            .to_string(),
        "index"
    );
}

#[tokio::test(flavor = "current_thread")]
#[allow(clippy::await_holding_lock)]
async fn simulation_is_opt_in_and_adapter_changes_stale_plans_in_both_directions() {
    let _lock = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let _env = Environment::isolate();
    let (_dir, store, _) = fixture();
    let runtime = Runtime::new(store.clone()).unwrap();
    assert!(!simulate::enabled());
    for value in ["true", "0", "01"] {
        std::env::set_var("MNA_SIMULATE", value);
        assert!(!simulate::enabled());
    }
    std::env::remove_var("MNA_SIMULATE");
    let disabled = status(&runtime).await;
    assert_eq!(disabled["simulated"], false);
    assert!(disabled["paths"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["execution_enabled"] == false && p["simulated"] == false));
    assert!(runtime
        .execute(ToolCall {
            tool: "search_iscc".into(),
            arguments: json!({"run_id":"discovery","query":"insurance software"})
        })
        .await
        .is_err());
    let providers = Providers::new().unwrap();
    assert!(providers
        .execute("bing_search", &json!({"query":"insurance software"}))
        .await
        .is_err());
    let service = ExecutionService::new(store.clone());
    for provider in ["llm_suite", "copilot"] {
        let real = approve(&service, &propose(&service, provider));
        std::env::set_var("MNA_SIMULATE", "1");
        assert!(service
            .execute(
                "lease_execution_job",
                &json!({"job_id":real["jobs"][0]["job_id"],"controller_id":"test"})
            )
            .is_err());
        assert_eq!(
            service
                .execute("get_prepared_plan", &json!({"plan_id":real["plan_id"]}))
                .unwrap()["status"],
            "STALE"
        );
        let simulated = approve(&service, &propose(&service, provider));
        std::env::remove_var("MNA_SIMULATE");
        assert!(service
            .execute(
                "lease_execution_job",
                &json!({"job_id":simulated["jobs"][0]["job_id"],"controller_id":"test"})
            )
            .is_err());
        assert_eq!(
            service
                .execute(
                    "get_prepared_plan",
                    &json!({"plan_id":simulated["plan_id"]})
                )
                .unwrap()["status"],
            "STALE"
        );
    }
    assert_eq!(
        store
            .with_connection(|c| Ok(c.query_row(
                "SELECT COUNT(*) FROM model_assessments",
                [],
                |r| r.get::<_, i64>(0)
            )?))
            .unwrap(),
        0
    );
}
