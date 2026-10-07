use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use mna_tools::{
    index_build,
    runtime::{administrator_definitions, tool_definitions},
    Store,
};
use rusqlite::params;
use rust_xlsxwriter::Workbook;
use serde_json::{json, Value};
use tempfile::TempDir;

static ENV: Mutex<()> = Mutex::new(());

struct Fixture {
    store: Store,
    dir: TempDir,
    previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::var_os("CARGO_TARGET_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap());
        let dir = TempDir::new_in(root).unwrap();
        let mut previous = Vec::new();
        for key in [
            "MNA_IMPORT_DIR",
            "MNA_EMBED_ENDPOINT",
            "MNA_MID_INDEX_CONFIG",
            "MNA_EMBED_MODEL",
            "MNA_EMBED_VERSION",
            "MNA_EMBED_DIMENSIONS",
            "MNA_RERANK_ENDPOINT",
            "MNA_RERANK_MODEL",
            "MNA_RERANK_VERSION",
        ] {
            previous.push((key, std::env::var_os(key)));
            std::env::remove_var(key);
        }
        std::env::set_var("MNA_IMPORT_DIR", dir.path());
        let store = Store::open(dir.path().join("builds.db")).unwrap();
        Self {
            dir,
            store,
            previous,
        }
    }
    fn workbook(&self, file: &str, rows: u32, name: bool) {
        let mut workbook = Workbook::new();
        let sheet = workbook.add_worksheet();
        let headers = [
            "Crescendo ID",
            "ECID",
            if name { "Company" } else { "Other" },
            "Website",
            "Company Description",
            "Pitchbook Description",
            "Pitchbook Keywords",
            "Offerings",
        ];
        for (col, header) in headers.iter().enumerate() {
            sheet.write_string(0, col as u16, *header).unwrap();
        }
        for r in 1..=rows {
            sheet.write_string(r, 0, format!("C{r}")).unwrap();
            sheet
                .write_string(r, 1, if r == 2 { "-".into() } else { format!("E{r}") })
                .unwrap();
            sheet.write_string(r, 2, format!("Company {r}")).unwrap();
            sheet
                .write_string(r, 3, format!("https://company{r}.example"))
                .unwrap();
            sheet
                .write_string(
                    r,
                    4,
                    if r % 2 == 0 {
                        "claims processing"
                    } else {
                        "claim processing"
                    },
                )
                .unwrap();
            sheet.write_string(r, 5, "insurance software").unwrap();
            sheet.write_string(r, 6, "insurance").unwrap();
            sheet.write_string(r, 7, "processing services").unwrap();
        }
        // Duplicate and quarantined rows are deliberately beyond the regular records.
        sheet.write_string(rows + 1, 0, "C1").unwrap();
        sheet.write_string(rows + 1, 1, "E1").unwrap();
        sheet.write_string(rows + 1, 2, "Duplicate").unwrap();
        sheet
            .write_string(rows + 1, 4, "changed duplicate description")
            .unwrap();
        sheet.write_string(rows + 2, 2, "No identifiers").unwrap();
        sheet.write_string(rows + 2, 4, "claim").unwrap();
        workbook.save(self.dir.path().join(file)).unwrap();
    }
    fn start(&self, file: &str, activate: bool) -> Value {
        index_build::execute(
            &self.store,
            "start_index_build",
            &json!({"file":file,"name":"Test MID","activate_on_success":activate}),
        )
        .unwrap()
    }
    fn get(&self, build: &Value) -> Value {
        index_build::execute(
            &self.store,
            "get_index_build",
            &json!({"build_id":build["build_id"]}),
        )
        .unwrap()
    }
    fn wait(&self, build: &Value) -> Value {
        let start = Instant::now();
        loop {
            let value = self.get(build);
            if value["status"] != "running" && value["status"] != "queued" {
                return value;
            }
            assert!(
                start.elapsed() < Duration::from_secs(60),
                "build timed out: {value}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn fts(&self, build: &Value) -> i64 {
        self.store
            .with_connection(|c| {
                Ok(c.query_row(
                    "SELECT fts_id FROM mid_bundles WHERE bundle_id=?",
                    [build["bundle_id"].as_str().unwrap()],
                    |r| r.get(0),
                )?)
            })
            .unwrap()
    }
    fn exists(&self, table: &str) -> bool {
        self.store
            .with_connection(|c| {
                Ok(c.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?)",
                    [table],
                    |r| r.get(0),
                )?)
            })
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for (key, value) in &self.previous {
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }
}

#[test]
fn streams_identity_and_indexes_and_retains_one_rollback() {
    let _env = ENV.lock().unwrap();
    let f = Fixture::new();
    f.workbook("mid.xlsx", 300, true);
    let first = f.start("mid.xlsx", true);
    let result = f.wait(&first);
    assert_eq!(result["status"], "succeeded", "{result}");
    assert_eq!(result["bundle"]["status"], "active");
    assert_eq!(result["bundle"]["row_count"], 300);
    assert_eq!(result["rows_done"], 302);
    assert_eq!(result["rows_total"], 302);
    for (index, step) in result["steps"].as_array().unwrap().iter().enumerate() {
        assert_eq!(
            step["status"],
            if index == 5 { "skipped" } else { "done" },
            "{step}"
        );
        assert!(step["started_at"].is_string());
        assert!(step["finished_at"].is_string());
    }
    assert_eq!(
        result["steps"][5]["detail"],
        "Embedding model not configured (set MNA_EMBED_ENDPOINT)."
    );
    assert_eq!(result["bundle"]["semantic_status"], "skipped");
    assert!(result["log"]
        .as_array()
        .unwrap()
        .iter()
        .any(|l| l["message"]
            .as_str()
            .unwrap()
            .contains("1 duplicates; 1 quarantined")));
    assert!(result["log"]
        .as_array()
        .unwrap()
        .iter()
        .any(|l| l["level"] == "warn"
            && l["message"]
                .as_str()
                .unwrap()
                .contains("columns not present")));
    let fts = f.fts(&first);
    f.store.with_connection(|c| {
        assert_eq!(c.query_row("SELECT COUNT(*) FROM mid_rows WHERE bundle_id=?",[first["bundle_id"].as_str().unwrap()],|r|r.get::<_,i64>(0))?,300);
        assert_eq!(c.query_row("SELECT company_id FROM mid_rows WHERE company_id='X-C2'",[],|r|r.get::<_,String>(0))?,"X-C2");
        assert_eq!(c.query_row("SELECT json_extract(row_json,'$.Company') FROM mid_rows WHERE bundle_id=? AND company_id='E1-C1'",[first["bundle_id"].as_str().unwrap()],|r|r.get::<_,String>(0))?,"Company 1");
        for (table,query,expected) in [(format!("mid_fts_{fts}"),"claim*",300),(format!("mid_fts_{fts}"),"claim",300),(format!("mid_fts_exact_{fts}"),"claim",150),(format!("mid_fts_exact_{fts}"),"claims",150)] {
            let ids=c.prepare(&format!("SELECT rowid FROM {table} WHERE {table} MATCH ?"))?.query_map([query],|r|r.get::<_,i64>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
            assert_eq!(ids.len(),expected);
        }
        Ok(())
    }).unwrap();
    let status = index_build::execute(&f.store, "get_mid_index_status", &json!({})).unwrap();
    assert_eq!(status["active"]["bundle_id"], first["bundle_id"]);
    assert!(status["running_build"].is_null());
    assert_eq!(status["active"]["fts_id"], fts);
    assert_eq!(
        status["config"]["search_columns"].as_array().unwrap().len(),
        12
    );
    let second = f.start("mid.xlsx", true);
    assert_eq!(f.wait(&second)["status"], "succeeded");
    assert_eq!(f.get(&first)["bundle"]["status"], "superseded");
    assert!(f.exists(&format!("mid_fts_{fts}")));
    // Roll back, then activate the second bundle again; both remain usable.
    for build in [&first, &second] {
        index_build::execute(
            &f.store,
            "activate_mid_bundle",
            &json!({"bundle_id":build["bundle_id"]}),
        )
        .unwrap();
    }
    let third = f.start("mid.xlsx", true);
    assert_eq!(f.wait(&third)["status"], "succeeded");
    assert!(!f.exists(&format!("mid_fts_{fts}")));
    assert!(!f.exists(&format!("mid_fts_exact_{fts}")));
    assert!(f.exists(&format!("mid_fts_{}", f.fts(&second))));
    assert!(index_build::execute(
        &f.store,
        "activate_mid_bundle",
        &json!({"bundle_id":first["bundle_id"]})
    )
    .is_err());
    assert!(index_build::execute(
        &f.store,
        "delete_mid_bundle",
        &json!({"bundle_id":third["bundle_id"]})
    )
    .unwrap_err()
    .to_string()
    .contains("active"));
    let list = index_build::execute(&f.store, "list_index_builds", &json!({})).unwrap();
    assert_eq!(list["builds"].as_array().unwrap().len(), 3);
    index_build::execute(
        &f.store,
        "delete_mid_bundle",
        &json!({"bundle_id":first["bundle_id"]}),
    )
    .unwrap();
    assert!(f.get_deleted(&first));
}
impl Fixture {
    fn get_deleted(&self, build: &Value) -> bool {
        index_build::execute(
            &self.store,
            "get_index_build",
            &json!({"build_id":build["build_id"]}),
        )
        .is_err()
    }
}

#[test]
fn cancellation_preserves_identity_and_cleans_index() {
    let _env = ENV.lock().unwrap();
    let f = Fixture::new();
    f.workbook("large.xlsx", 30_000, true);
    let build = f.start("large.xlsx", true);
    assert!(index_build::execute(
        &f.store,
        "start_index_build",
        &json!({"file":"large.xlsx","name":"Other"})
    )
    .unwrap_err()
    .to_string()
    .contains("already running"));
    assert!(index_build::execute(
        &f.store,
        "delete_mid_bundle",
        &json!({"bundle_id":build["bundle_id"]})
    )
    .is_err());
    let start = Instant::now();
    loop {
        let value = f.get(&build);
        assert_eq!(
            value["status"], "running",
            "cancel missed the running build: {value}"
        );
        if value["rows_done"].as_u64().unwrap() >= 5_000 {
            assert!(value["steps"][3]["rate_per_sec"].as_f64().unwrap() > 0.0);
            assert!(value["steps"][3]["eta_seconds"].as_f64().unwrap() >= 0.0);
            index_build::execute(
                &f.store,
                "cancel_index_build",
                &json!({"build_id":build["build_id"]}),
            )
            .unwrap();
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(60));
        std::thread::sleep(Duration::from_millis(5));
    }
    let result = f.wait(&build);
    assert_eq!(result["status"], "cancelled", "{result}");
    assert_eq!(result["bundle"]["status"], "cancelled");
    assert_eq!(result["cancel_requested"], true);
    assert!(!f.exists(&format!("mid_fts_{}", f.fts(&build))));
    assert!(!f.exists(&format!("mid_fts_exact_{}", f.fts(&build))));
    f.store
        .with_connection(|c| {
            assert_eq!(
                c.query_row(
                    "SELECT COUNT(*) FROM mid_rows WHERE bundle_id=?",
                    [build["bundle_id"].as_str().unwrap()],
                    |r| r.get::<_, i64>(0)
                )?,
                0
            );
            assert!(
                c.query_row(
                    "SELECT COUNT(*) FROM source_rows WHERE source='MID'",
                    [],
                    |r| r.get::<_, i64>(0)
                )? >= 5_000
            );
            Ok(())
        })
        .unwrap();
    assert!(result["log"]
        .as_array()
        .unwrap()
        .iter()
        .any(|l| l["message"]
            .as_str()
            .unwrap()
            .contains("valid identity data")));
    index_build::execute(
        &f.store,
        "delete_mid_bundle",
        &json!({"bundle_id":build["bundle_id"]}),
    )
    .unwrap();
}

#[test]
fn ready_activation_header_failure_and_restart_recovery() {
    let _env = ENV.lock().unwrap();
    let f = Fixture::new();
    f.workbook("ready.xlsx", 10, true);
    let ready = f.start("ready.xlsx", false);
    let result = f.wait(&ready);
    assert_eq!(result["status"], "succeeded", "{result}");
    assert_eq!(result["bundle"]["status"], "ready");
    assert_eq!(result["steps"][7]["status"], "skipped");
    assert_eq!(result["steps"][7]["detail"], "Activation not requested");
    index_build::execute(
        &f.store,
        "activate_mid_bundle",
        &json!({"bundle_id":ready["bundle_id"]}),
    )
    .unwrap();
    f.workbook("bad.xlsx", 10, false);
    let bad = f.start("bad.xlsx", true);
    let result = f.wait(&bad);
    assert_eq!(result["status"], "failed");
    assert!(result["error"]
        .as_str()
        .unwrap()
        .contains("Missing name columns"));
    assert_eq!(result["steps"][1]["status"], "failed");
    assert_eq!(result["bundle"]["status"], "failed");
    f.store.with_connection(|c| {
        c.execute("INSERT INTO mid_bundles(bundle_id,fts_id,name,status,source_file,config_json,config_hash,created_at) VALUES('fake',999,'Fake','building','fake.xlsx','{}','hash','now')",[])?;
        c.execute("INSERT INTO index_builds(build_id,bundle_id,status,steps_json,started_at,updated_at) VALUES('interrupted','fake','running',?,'now','now')",params![json!([{"id":"store_rows","status":"running"}]).to_string()])?;
        c.execute_batch("CREATE VIRTUAL TABLE mid_fts_999 USING fts5(description,content=''); CREATE VIRTUAL TABLE mid_fts_exact_999 USING fts5(description,content='');")?;
        Ok(())
    }).unwrap();
    // Runtime startup must invoke recovery, not just expose the helper.
    mna_tools::Runtime::new(f.store.clone()).unwrap();
    let interrupted = index_build::execute(
        &f.store,
        "get_index_build",
        &json!({"build_id":"interrupted"}),
    )
    .unwrap();
    assert_eq!(interrupted["status"], "interrupted");
    assert_eq!(interrupted["bundle"]["status"], "failed");
    assert_eq!(
        interrupted["error"],
        "Interrupted by a restart. Start the build again."
    );
    assert!(!f.exists("mid_fts_999"));
    assert!(!f.exists("mid_fts_exact_999"));
    index_build::recover_interrupted(&f.store).unwrap();
}

#[test]
fn schemas_bounds_and_file_database_requirement() {
    let _env = ENV.lock().unwrap();
    let f = Fixture::new();
    let memory = Store::open(":memory:").unwrap();
    assert_eq!(
        index_build::execute(
            &memory,
            "start_index_build",
            &json!({"file":"anything.xlsx","name":"MID"})
        )
        .unwrap_err()
        .to_string(),
        "Index builds need a file database"
    );
    assert!(index_build::execute(&f.store, "list_index_builds", &json!({"limit":0})).is_err());
    assert!(index_build::execute(&f.store, "list_index_builds", &json!({"limit":51})).is_err());
    assert!(index_build::execute(&f.store, "get_mid_index_status", &json!({"unknown":1})).is_err());
    for tool in [
        "get_mid_index_status",
        "get_index_build",
        "list_index_builds",
    ] {
        let definition = tool_definitions()
            .into_iter()
            .find(|d| d.name == tool)
            .unwrap();
        assert_eq!(definition.category, "data");
        assert!(!definition.mutates_state);
    }
    for (tool, route) in [
        ("start_index_build", "/admin/index-build-start"),
        ("cancel_index_build", "/admin/index-build-cancel"),
        ("activate_mid_bundle", "/admin/mid-bundle-activate"),
        ("delete_mid_bundle", "/admin/mid-bundle-delete"),
    ] {
        let definition = administrator_definitions()
            .into_iter()
            .find(|d| d["name"] == tool)
            .unwrap();
        assert_eq!(definition["endpoint"], route);
        assert_eq!(definition["controller_only"], false);
        assert!(definition["input_schema"].is_object());
    }
}

#[test]
fn configured_local_embeddings_cache_by_bundle_description_hash() {
    use std::io::{BufRead, Read, Write};
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    let _env = ENV.lock().unwrap();
    let f = Fixture::new();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    std::env::set_var(
        "MNA_EMBED_ENDPOINT",
        format!("http://{}/embed", listener.local_addr().unwrap()),
    );
    std::env::set_var("MNA_EMBED_DIMENSIONS", "2");
    let stop = Arc::new(AtomicBool::new(false));
    let stop_worker = stop.clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_worker = calls.clone();
    let server = std::thread::spawn(move || {
        while !stop_worker.load(Ordering::SeqCst) {
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(e) => panic!("local mock accept failed: {e}"),
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(30)))
                .unwrap();
            let mut reader = std::io::BufReader::new(&mut stream);
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let request: Value = serde_json::from_slice(&body).unwrap();
            let texts = request["texts"].as_array().unwrap();
            assert!(!texts.is_empty() && texts.len() <= 32);
            assert!(texts
                .iter()
                .all(|text| text.as_str().unwrap().starts_with("Company Description: ")));
            assert_eq!(request["dimensions"], 2);
            calls_worker.fetch_add(1, Ordering::SeqCst);
            let payload=json!({"model":request["model"],"version":request["version"],"dimensions":2,"vectors":vec![vec![1.0f32,0.0];texts.len()]}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",payload.len(),payload).unwrap();
        }
    });
    f.workbook("semantic.xlsx", 70, true);
    let first = f.start("semantic.xlsx", true);
    let result = f.wait(&first);
    stop.store(true, Ordering::SeqCst);
    server.join().unwrap();
    assert_eq!(result["status"], "succeeded", "{result}");
    assert_eq!(result["bundle"]["semantic_status"], "ready");
    assert_eq!(result["steps"][5]["status"], "done");
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    f.store.with_connection(|c| {
        assert_eq!(c.query_row("SELECT COUNT(*) FROM embedding_vectors e JOIN mid_rows r ON r.company_id=e.company_id AND r.desc_hash=e.text_hash WHERE r.bundle_id=? AND length(e.vector_blob)=8",[first["bundle_id"].as_str().unwrap()],|r|r.get::<_,i64>(0))?,70);
        Ok(())
    }).unwrap();
    // With the server stopped, success proves unchanged hashes bypass inference.
    let second = f.start("semantic.xlsx", true);
    let result = f.wait(&second);
    assert_eq!(result["status"], "succeeded", "{result}");
    assert!(result["steps"][5]["detail"]
        .as_str()
        .unwrap()
        .contains("70 unchanged"));
    // A changed hash requires inference and a stopped endpoint must fail honestly.
    f.store
        .with_connection(|c| {
            c.execute(
                "UPDATE embedding_vectors SET text_hash='outdated' WHERE company_id='E1-C1'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let third = f.start("semantic.xlsx", true);
    let result = f.wait(&third);
    assert_eq!(result["status"], "failed", "{result}");
    assert_eq!(result["bundle"]["semantic_status"], "failed");
    assert_eq!(result["steps"][5]["status"], "failed");
    let status = index_build::execute(&f.store, "get_mid_index_status", &json!({})).unwrap();
    assert_eq!(status["active"]["bundle_id"], second["bundle_id"]);
}

#[test]
fn admin_routes_require_analyst_auth_and_read_tools_dispatch() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let _env = ENV.lock().unwrap();
    let f = Fixture::new();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let runtime = mna_tools::Runtime::new(f.store.clone()).unwrap();
    let app = mna_tools::router(
        runtime,
        "index-build-service-key-00000".into(),
        Some("index-build-analyst-key-00000".into()),
    )
    .unwrap();
    let request = |route: &str, args: Value, analyst: bool| {
        let mut request = Request::builder()
            .method("POST")
            .uri(route)
            .header("content-type", "application/json")
            .header("authorization", "Bearer index-build-service-key-00000");
        if analyst {
            request = request.header("x-mna-analyst-key", "index-build-analyst-key-00000");
        }
        rt.block_on(async {
            let response = app
                .clone()
                .oneshot(request.body(Body::from(args.to_string())).unwrap())
                .await
                .unwrap();
            let status = response.status();
            let body = response.into_body().collect().await.unwrap().to_bytes();
            (status, serde_json::from_slice::<Value>(&body).unwrap())
        })
    };
    for route in [
        "/admin/index-build-start",
        "/admin/index-build-cancel",
        "/admin/mid-bundle-activate",
        "/admin/mid-bundle-delete",
    ] {
        assert_eq!(request(route, json!({}), false).0, StatusCode::FORBIDDEN);
    }
    assert_eq!(
        request("/tools/start_index_build", json!({}), true).0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request("/tools/get_mid_index_status", json!({}), false).0,
        StatusCode::OK
    );
    f.workbook("admin.xlsx", 10, true);
    let (status, build) = request(
        "/admin/index-build-start",
        json!({"file":"admin.xlsx","name":"Admin MID","activate_on_success":false}),
        true,
    );
    assert_eq!(status, StatusCode::OK, "{build}");
    assert_eq!(f.wait(&build)["status"], "succeeded");
    assert_eq!(
        request(
            "/tools/get_index_build",
            json!({"build_id":build["build_id"]}),
            false
        )
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request("/tools/list_index_builds", json!({}), false).0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            "/admin/mid-bundle-activate",
            json!({"bundle_id":build["bundle_id"]}),
            true
        )
        .0,
        StatusCode::OK
    );
}
