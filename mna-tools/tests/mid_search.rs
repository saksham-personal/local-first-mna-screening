use mna_tools::{index_build, runtime::ToolCall, search::SearchEngine, Runtime, Store};
use rusqlite::params;
use rust_xlsxwriter::Workbook;
use serde_json::{json, Value};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tempfile::TempDir;
static ENV: Mutex<()> = Mutex::new(());
struct Fixture {
    store: Store,
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
            "MNA_IMPORT_DIR",
            "MNA_EMBED_ENDPOINT",
            "MNA_MID_INDEX_CONFIG",
            "MNA_EMBED_MODEL",
            "MNA_EMBED_VERSION",
            "MNA_EMBED_DIMENSIONS",
        ] {
            previous.push((key, std::env::var_os(key)));
            std::env::remove_var(key);
        }
        std::env::set_var("MNA_IMPORT_DIR", dir.path());
        let store = Store::open(dir.path().join("search.db")).unwrap();
        store
            .execute(
                "create_run",
                &json!({"run_id":"R","objective":"Insurance software","original_criteria":{}}),
            )
            .unwrap();
        let revision=store.execute("save_criteria_revision",&json!({"run_id":"R","criteria_text":"Insurance claims software","business_definition":"Insurance claims software. Exclude consulting.","core_business_exclusions":["consulting"]})).unwrap();
        store.execute("approve_criteria_revision",&json!({"run_id":"R","revision":revision["revision"],"digest":revision["digest"],"approved_by":"Analyst"})).unwrap();
        let fixture = Self {
            store,
            dir,
            previous,
        };
        if build {
            fixture.build();
        }
        fixture
    }
    fn build(&self) {
        let mut workbook = Workbook::new();
        let sheet = workbook.add_worksheet();
        for (i, h) in [
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
            sheet.write_string(0, i as u16, *h).unwrap();
        }
        for (i, (desc, extra, offering)) in [
            (
                "insurance claims software",
                "policy administration",
                "software",
            ),
            ("claim management", "insurance platform", "services"),
            ("claims consulting", "insurance software", "consulting"),
            ("policy administration", "cloud platform", "platform"),
        ]
        .iter()
        .enumerate()
        {
            let n = (i + 1) as u32;
            for (col, value) in [
                format!("C{n}"),
                format!("E{n}"),
                format!("Company {n}"),
                desc.to_string(),
                extra.to_string(),
                offering.to_string(),
            ]
            .iter()
            .enumerate()
            {
                sheet.write_string(n, col as u16, value).unwrap();
            }
        }
        workbook.save(self.dir.path().join("mid.xlsx")).unwrap();
        let build = index_build::execute(
            &self.store,
            "start_index_build",
            &json!({"file":"mid.xlsx","name":"Fixture","activate_on_success":true}),
        )
        .unwrap();
        let started = Instant::now();
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
            assert!(started.elapsed() < Duration::from_secs(60));
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn query(&self, extra: Value) -> Result<Value, mna_tools::error::Error> {
        let mut args = json!({"run_id":"R","rationale":"Find claims businesses.","keywords":[{"id":"a","text":"claims"},{"id":"b","text":"software"}],"add_to_run":false});
        for (key, value) in extra.as_object().unwrap() {
            args[key] = value.clone();
        }
        mna_tools::mid_search::search(&self.store, &args)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for (key, value) in &self.previous {
            if let Some(value) = value {
                std::env::set_var(key, value);
            } else {
                std::env::remove_var(key);
            }
        }
    }
}
fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn boolean_queries_match_math_limit_and_persistence() {
    let _guard = ENV.lock().unwrap();
    let f = Fixture::new(true);
    let union = f.query(json!({})).unwrap();
    assert_eq!(union["total_matched"], 3);
    assert_eq!(union["returned"], 3);
    assert_eq!(union["expression"], "a OR b");
    assert_eq!(union["results"][0]["match_pct"], 100.0);
    let intersection = f.query(json!({"expression":"a AND b"})).unwrap();
    assert_eq!(intersection["returned"], 2);
    let weighted=f.query(json!({"keywords":[{"id":"a","text":"claims","weight":3},{"id":"b","text":"software","weight":1}],"limit":1,"add_to_run":true})).unwrap();
    assert_eq!(weighted["total_matched"], 3);
    assert_eq!(weighted["returned"], 1);
    assert_eq!(weighted["results"][0]["hit_count"], 2);
    assert_eq!(weighted["added_to_run"], true);
    let all=f.query(json!({"keywords":[{"id":"a","text":"claims","weight":3},{"id":"b","text":"software","weight":1}]})).unwrap();
    let single = all["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["company_id"] == "E2-C2")
        .unwrap();
    assert_eq!(single["match_pct"], 75.0);
    f.store.with_connection(|c| {
        let query=weighted["query_id"].as_str().unwrap();
        let hit: i64=c.query_row("SELECT COUNT(*) FROM mid_keyword_hits WHERE query_id=?",[query],|r|r.get(0))?; assert_eq!(hit,1);
        let joined: i64=c.query_row("SELECT COUNT(*) FROM candidate_discovery d JOIN search_queries s USING(query_id) JOIN mid_keyword_queries m USING(query_id) WHERE d.query_id=?",[query],|r|r.get(0))?; assert_eq!(joined,1); Ok(())
    }).unwrap();
}
#[test]
fn approved_not_and_expression_validation() {
    let _guard = ENV.lock().unwrap();
    let f = Fixture::new(true);
    let keywords = json!([{"id":"a","text":"claims"},{"id":"x","text":"consulting"}]);
    let found = f
        .query(json!({"keywords":keywords,"expression":"a AND NOT (x)"}))
        .unwrap();
    assert_eq!(found["returned"], 2);
    assert!(found["results"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["match_pct"] == 100.0 && r["matched"].as_array().unwrap().len() == 1));
    assert!(f.query(json!({"keywords":[{"id":"a","text":"claims"},{"id":"x","text":"software"}],"expression":"a AND NOT x"})).unwrap_err().to_string().contains("approved core-business exclusions: software"));
    for expr in [
        "NOT a",
        "a OR NOT b",
        "a AND ()",
        "a OR missing",
        "(a OR b",
        "a b",
    ] {
        assert!(f.query(json!({"expression":expr})).is_err(), "{expr}");
    }
    assert!(f
        .query(json!({"expression":std::iter::repeat_n("a",52).collect::<Vec<_>>().join(" OR ")}))
        .is_err());
    let safe = f
        .query(json!({"keywords":[{"id":"a","text":"claims\" OR"}]}))
        .unwrap();
    assert_eq!(safe["returned"], 0);
    // A trailing wildcard on an injection-looking multiword phrase is neutralized by validation.
    assert!(f
        .query(json!({"keywords":[{"id":"a","text":"claims\" OR *"}]}))
        .unwrap_err()
        .to_string()
        .contains("Use * only on single words"));
    assert!(f
        .query(json!({"keywords":[{"id":"a","text":"\"()"}]}))
        .is_err());
}
#[test]
fn stemming_exact_prefix_and_column_filter_use_built_config() {
    let _guard = ENV.lock().unwrap();
    let f = Fixture::new(true);
    let stem = f
        .query(json!({"keywords":[{"id":"a","text":"claims"}]}))
        .unwrap();
    assert_eq!(stem["returned"], 3);
    let exact = f
        .query(json!({"keywords":[{"id":"a","text":"claims","match":"exact"}]}))
        .unwrap();
    assert_eq!(exact["returned"], 2);
    let prefix = f
        .query(json!({"keywords":[{"id":"a","text":"claim*","match":"exact"}]}))
        .unwrap();
    assert_eq!(prefix["returned"], 3);
    let config = mna_tools::mid_config::MidIndexConfig::load().unwrap();
    let column = &config.fts5_column_names["Company Description"];
    let filtered = f
        .query(json!({"keywords":[{"id":"a","text":"insurance"}],"columns":[column]}))
        .unwrap();
    assert_eq!(filtered["returned"], 1);
    let phrase = f
        .query(json!({"keywords":[{"id":"a","text":"policy administration","match":"exact"}]}))
        .unwrap();
    assert_eq!(phrase["returned"], 2);
    // Searching uses the bundle snapshot even when the current config file is unusable.
    std::fs::write(f.dir.path().join("bad.json"), "{}").unwrap();
    std::env::set_var("MNA_MID_INDEX_CONFIG", f.dir.path().join("bad.json"));
    assert_eq!(f.query(json!({"columns":[column]})).unwrap()["returned"], 3);
    assert!(f.query(json!({"columns":["unknown"]})).is_err());
}
#[test]
fn limits_and_arguments_are_strict() {
    let _guard = ENV.lock().unwrap();
    let f = Fixture::new(true);
    for extra in [
        json!({"rationale":""}),
        json!({"limit":0}),
        json!({"limit":20001}),
        json!({"unexpected":true}),
        json!({"keywords":[]}),
        json!({"keywords":[{"id":"A","text":"claims"}]}),
        json!({"keywords":[{"id":"a","text":"claims"},{"id":"a","text":"software"}]}),
        json!({"keywords":[{"id":"a","text":"claims","weight":0.0}]}),
        json!({"keywords":[{"id":"a","text":"claims","match":"wild"}]}),
    ] {
        assert!(f.query(extra.clone()).is_err(), "{extra}");
    }
}
#[test]
fn no_bundle_has_clear_error_and_semantics_skip_without_model() {
    let _guard = ENV.lock().unwrap();
    let f = Fixture::new(false);
    assert!(f
        .query(json!({}))
        .unwrap_err()
        .to_string()
        .contains("Build and activate the MID index before keyword search."));
    let runtime = rt();
    let engine = SearchEngine::new(f.store.clone()).unwrap();
    let skipped = runtime
        .block_on(engine.execute("score_mid_semantic", &json!({"run_id":"R"})))
        .unwrap();
    assert_eq!(skipped["status"], "skipped");
    f.build();
    let skipped = runtime
        .block_on(engine.execute("score_mid_semantic", &json!({"run_id":"R"})))
        .unwrap();
    assert_eq!(skipped["status"], "skipped");
    assert!(skipped["reason"].as_str().unwrap().contains("not ready"));
    f.store
        .with_connection(|c| {
            c.execute("UPDATE mid_bundles SET semantic_status='ready'", [])?;
            Ok(())
        })
        .unwrap();
    let skipped = runtime
        .block_on(engine.execute("score_mid_semantic", &json!({"run_id":"R"})))
        .unwrap();
    assert!(skipped["reason"]
        .as_str()
        .unwrap()
        .contains("MNA_EMBED_ENDPOINT"));
    let skipped = runtime
        .block_on(engine.execute(
            "search_mid_semantic",
            &json!({"run_id":"R","rationale":"Broader matches.","min_score":5}),
        ))
        .unwrap();
    assert_eq!(skipped["status"], "skipped");
}
#[test]
fn semantic_scores_use_mid_hashes_and_add_only_new_companies() {
    let _guard = ENV.lock().unwrap();
    let f = Fixture::new(true);
    let runtime = rt();
    let (server,endpoint)=runtime.block_on(async {
        use axum::{routing::post,Json,Router};
        async fn embed(Json(payload): Json<Value>) -> Json<Value> {
            assert_eq!(payload["texts"],json!(["query: Insurance claims software"]));
            Json(json!({"model":payload["model"],"version":payload["version"],"dimensions":2,"vectors":[[1.0,0.0]]}))
        }
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let address=listener.local_addr().unwrap();
        let server=tokio::spawn(async move {axum::serve(listener,Router::new().route("/embed",post(embed))).await.unwrap()});
        (server,format!("http://{address}/embed"))
    });
    std::env::set_var("MNA_EMBED_ENDPOINT", endpoint);
    std::env::set_var("MNA_EMBED_MODEL", "fixture");
    std::env::set_var("MNA_EMBED_VERSION", "1");
    std::env::set_var("MNA_EMBED_DIMENSIONS", "2");
    f.store.with_connection(|c| {
        c.execute("UPDATE mid_bundles SET semantic_status='ready'",[])?;
        for (id,vector,dimensions,valid_hash) in [("E1-C1",vec![1.0f32,0.0],2,true),("E2-C2",vec![1.0,1.0],2,true),("E3-C3",vec![1.0],1,true),("E4-C4",vec![1.0,0.0],2,false)] {
            let hash: String=c.query_row("SELECT desc_hash FROM mid_rows WHERE company_id=?",[id],|r|r.get(0))?;
            let blob=vector.iter().flat_map(|v|v.to_le_bytes()).collect::<Vec<_>>();
            c.execute("INSERT INTO embedding_vectors(company_id,model,model_version,dimensions,text_hash,vector_blob,created_at) VALUES(?,'fixture','1',?,?,?,datetime('now'))",params![id,dimensions,if valid_hash {hash}else {"stale".into()},blob])?;
        } Ok(())
    }).unwrap();
    f.store
        .execute(
            "add_candidates",
            &json!({"run_id":"R","companies":["E1-C1","E3-C3","E4-C4"],"discovery_source":"MID"}),
        )
        .unwrap();
    let engine = SearchEngine::new(f.store.clone()).unwrap();
    let result = runtime
        .block_on(engine.execute("score_mid_semantic", &json!({"run_id":"R"})))
        .unwrap();
    assert_eq!(result["status"], "scored");
    assert_eq!(result["scored"], 1);
    assert_eq!(result["missing_vector"], 2);
    assert_eq!(result["criteria_revision"], 1);
    let semantic=runtime.block_on(engine.execute("search_mid_semantic",&json!({"run_id":"R","rationale":"Additional insurance matches.","min_score":7,"limit":1}))).unwrap();
    assert_eq!(semantic["returned"], 1);
    assert_eq!(semantic["considered"], 1);
    assert_eq!(semantic["results"][0]["company_id"], "E2-C2");
    assert_eq!(semantic["results"][0]["score"], 7.1);
    f.store.with_connection(|c| {
        let score: f64=c.query_row("SELECT score FROM mid_semantic_scores WHERE company_id='E1-C1' AND criteria_revision=1",[],|r|r.get(0))?; assert_eq!(score,10.0);
        let query: String=c.query_row("SELECT query_id FROM candidate_discovery WHERE company_id='E2-C2'",[],|r|r.get(0))?; assert_eq!(query,semantic["query_id"].as_str().unwrap()); Ok(())
    }).unwrap();
    let repeated = runtime
        .block_on(engine.execute(
            "search_mid_semantic",
            &json!({"run_id":"R","rationale":"Additional matches.","min_score":0}),
        ))
        .unwrap();
    assert_eq!(repeated["returned"], 0);
    server.abort();
}
#[test]
fn runtime_authorizes_both_semantic_tools_and_keyword_search() {
    let _guard = ENV.lock().unwrap();
    let f = Fixture::new(true);
    f.store.execute("save_criteria_revision",&json!({"run_id":"R","criteria_text":"Changed business","business_definition":"Changed business"})).unwrap();
    let runtime = Runtime::new(f.store.clone()).unwrap();
    let tokio = rt();
    for (tool, args) in [
        ("score_mid_semantic", json!({"run_id":"R"})),
        (
            "search_mid_semantic",
            json!({"run_id":"R","rationale":"Find more.","min_score":5}),
        ),
        (
            "search_mid",
            json!({"run_id":"R","rationale":"Find claims.","keywords":[{"id":"a","text":"claims"}]}),
        ),
    ] {
        let result = tokio.block_on(runtime.execute(ToolCall {
            tool: tool.into(),
            arguments: args,
        }));
        assert!(result.is_err());
    }
}
