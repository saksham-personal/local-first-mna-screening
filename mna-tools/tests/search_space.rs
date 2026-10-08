use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use calamine::{open_workbook, Reader, Xlsx};
use mna_tools::{index_build, search_space::SearchSpace, Store};
use rusqlite::params;
use rust_xlsxwriter::Workbook;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
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
    fn new(rows: usize) -> Self {
        let root = std::env::var_os("CARGO_TARGET_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap());
        let dir = TempDir::new_in(root).unwrap();
        let keys = [
            "MNA_IMPORT_DIR",
            "MNA_EXPORT_DIR",
            "MNA_MID_INDEX_CONFIG",
            "MNA_MEILI_URL",
            "MNA_MEILI_API_KEY",
            "MNA_EMBED_ENDPOINT",
            "MNA_EMBED_MODEL",
            "MNA_EMBED_VERSION",
            "MNA_EMBED_DIMENSIONS",
            "MNA_SIMULATE",
            "MNA_ENABLE_EXTERNAL",
        ];
        let previous = keys
            .into_iter()
            .map(|k| {
                let v = std::env::var_os(k);
                std::env::remove_var(k);
                (k, v)
            })
            .collect();
        std::env::set_var("MNA_IMPORT_DIR", dir.path());
        std::env::set_var("MNA_EXPORT_DIR", dir.path().join("export"));
        let store = Store::open(dir.path().join("space.db")).unwrap();
        let f = Self {
            store,
            dir,
            previous,
        };
        if rows > 0 {
            f.build(rows);
        }
        f
    }
    fn build(&self, rows: usize) {
        self.build_with_ecid(rows, true);
    }
    fn build_with_ecid(&self, rows: usize, with_ecid: bool) {
        let mut workbook = Workbook::new();
        let sheet = workbook.add_worksheet();
        for (col, h) in [
            "ECID",
            "Crescendo ID",
            "Company",
            "Website",
            "Company Description",
            "Offerings",
            "Country",
            "Arbitrary Flag",
            "Annual Revenue",
        ]
        .iter()
        .enumerate()
        {
            sheet.write_string(0, col as u16, *h).unwrap();
        }
        for i in 1..=rows {
            let desc = match i {
                1 => "claims software",
                2 => "claims platform",
                3 => "claims consulting software",
                4 => "policy administration",
                _ => "claims software",
            };
            for (col, v) in [
                if with_ecid {
                    format!("E{i}")
                } else {
                    String::new()
                },
                format!("C{i}"),
                format!("Company {i:03}"),
                format!("https://company{i}.example"),
                desc.into(),
                if i == 4 {
                    "insurance policy"
                } else {
                    "claims workflows"
                }
                .into(),
                if i % 2 == 0 { "India" } else { "USA" }.into(),
                format!("flag {i}"),
                format!("{}", i * 10),
            ]
            .iter()
            .enumerate()
            {
                sheet.write_string(i as u32, col as u16, v).unwrap();
            }
        }
        workbook.save(self.dir.path().join("mid.xlsx")).unwrap();
        let result = index_build::execute(
            &self.store,
            "start_index_build",
            &json!({"file":"mid.xlsx","name":"Search Space fixture","activate_on_success":true}),
        )
        .unwrap();
        let start = Instant::now();
        loop {
            let status = index_build::execute(
                &self.store,
                "get_index_build",
                &json!({"build_id":result["build_id"]}),
            )
            .unwrap();
            if !["running", "queued"].contains(&status["status"].as_str().unwrap()) {
                assert_eq!(status["status"], "succeeded", "{status}");
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(60));
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn run(&self) {
        self.store.execute("create_run",&json!({"run_id":"R","objective":"Analyst selected companies","original_criteria":{}})).unwrap();
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

#[derive(Default)]
struct Fake {
    docs: BTreeMap<String, Vec<Value>>,
    settings: BTreeMap<String, Value>,
    queries: Vec<Value>,
    failed: bool,
}
type Shared = Arc<Mutex<Fake>>;
async fn health() -> Json<Value> {
    Json(json!({"status":"available"}))
}
async fn create(State(s): State<Shared>, Json(v): Json<Value>) -> Json<Value> {
    s.lock()
        .unwrap()
        .docs
        .insert(v["uid"].as_str().unwrap().into(), Vec::new());
    Json(json!({"taskUid":1}))
}
async fn index(State(s): State<Shared>, Path(id): Path<String>) -> (StatusCode, Json<Value>) {
    let found = s.lock().unwrap().docs.contains_key(&id);
    (
        if found {
            StatusCode::OK
        } else {
            StatusCode::NOT_FOUND
        },
        Json(json!({"uid":id})),
    )
}
async fn delete(State(s): State<Shared>, Path(id): Path<String>) -> Json<Value> {
    s.lock().unwrap().docs.remove(&id);
    Json(json!({"taskUid":1}))
}
async fn settings(
    State(s): State<Shared>,
    Path(id): Path<String>,
    Json(v): Json<Value>,
) -> Json<Value> {
    s.lock().unwrap().settings.insert(id, v);
    Json(json!({"taskUid":1}))
}
async fn documents(
    State(s): State<Shared>,
    Path(id): Path<String>,
    Json(v): Json<Value>,
) -> Json<Value> {
    assert!(v.as_array().unwrap().len() <= 5000);
    s.lock()
        .unwrap()
        .docs
        .get_mut(&id)
        .unwrap()
        .extend(v.as_array().unwrap().iter().cloned());
    Json(json!({"taskUid":1}))
}
async fn stats(State(s): State<Shared>, Path(id): Path<String>) -> Json<Value> {
    Json(json!({"numberOfDocuments":s.lock().unwrap().docs.get(&id).map_or(0,Vec::len)}))
}
async fn task(State(s): State<Shared>) -> Json<Value> {
    Json(if s.lock().unwrap().failed {
        json!({"status":"failed","error":"fixture"})
    } else {
        json!({"status":"succeeded"})
    })
}
async fn search(
    State(s): State<Shared>,
    Path(id): Path<String>,
    Json(v): Json<Value>,
) -> Json<Value> {
    assert_eq!(v["limit"], 200000);
    assert_eq!(v["matchingStrategy"], "all");
    assert_eq!(v["attributesToRetrieve"], json!(["company_id"]));
    let q = v["q"].as_str().unwrap().trim_matches('"').to_lowercase();
    let mut s = s.lock().unwrap();
    s.queries.push(v.clone());
    let hits = s.docs[&id]
        .iter()
        .filter(|doc| {
            v["attributesToSearchOn"]
                .as_array()
                .unwrap()
                .iter()
                .any(|col| {
                    doc[col.as_str().unwrap()]
                        .as_str()
                        .is_some_and(|text| text.to_lowercase().contains(&q))
                })
        })
        .map(|doc| json!({"company_id":doc["company_id"]}))
        .collect::<Vec<_>>();
    Json(json!({"hits":hits,"estimatedTotalHits":hits.len()}))
}
async fn fake() -> (tokio::task::JoinHandle<()>, Shared) {
    let state = Arc::new(Mutex::new(Fake::default()));
    let app = Router::new()
        .route("/health", get(health))
        .route("/indexes", post(create))
        .route("/indexes/{id}", get(index).delete(delete))
        .route("/indexes/{id}/settings", axum::routing::patch(settings))
        .route("/indexes/{id}/documents", post(documents))
        .route("/indexes/{id}/stats", get(stats))
        .route("/indexes/{id}/search", post(search))
        .route("/tasks/{id}", get(task))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    std::env::set_var(
        "MNA_MEILI_URL",
        format!("http://{}", listener.local_addr().unwrap()),
    );
    (
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }),
        state,
    )
}
fn ids(result: &Value) -> Vec<String> {
    result["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["company_id"].as_str().unwrap().into())
        .collect()
}

#[test]
fn no_active_bundle_every_tool_reports_plain_message() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new(0);
    let rt = rt();
    let space = SearchSpace::new(f.store.clone()).unwrap();
    for tool in [
        "space_sync_status",
        "space_sync",
        "space_browse",
        "space_search_lexical",
        "space_search_semantic",
        "space_search_iscc",
        "space_recent",
        "space_add_to_run",
        "space_export",
    ] {
        assert!(
            rt.block_on(space.execute(tool, &json!({})))
                .unwrap_err()
                .to_string()
                .contains("Build and activate a MID bundle"),
            "{tool}"
        );
    }
}
#[test]
fn sync_all_columns_settings_resync_and_failed_tasks() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new(4);
    let rt = rt();
    let down = rt
        .block_on(
            SearchSpace::new(f.store.clone())
                .unwrap()
                .execute("space_sync_status", &json!({})),
        )
        .unwrap();
    assert_eq!(down["meili"], "down");
    let (server, state) = rt.block_on(fake());
    let space = SearchSpace::new(f.store.clone()).unwrap();
    let sync = rt
        .block_on(space.execute("space_sync", &json!({})))
        .unwrap();
    assert_eq!(sync["documents"], 4);
    assert_eq!(sync["task_status"], "succeeded");
    assert!(sync["last_synced_at"].is_string());
    let idx = sync["index"].as_str().unwrap();
    {
        let s = state.lock().unwrap();
        let doc = &s.docs[idx][0];
        assert_eq!(doc["id"], "E1-C1");
        assert_eq!(doc["Arbitrary Flag"], "flag 1");
        assert_eq!(doc["Website"], "https://company1.example");
        assert_eq!(doc["company_id"], "E1-C1");
        assert_eq!(s.settings[idx]["pagination"]["maxTotalHits"], 200000);
        assert!(s.settings[idx]["searchableAttributes"]
            .as_array()
            .unwrap()
            .contains(&json!("Company Description")));
        assert!(!s.settings[idx]
            .as_object()
            .unwrap()
            .contains_key("typoTolerance"));
    }
    assert_eq!(
        rt.block_on(space.execute("space_sync_status", &json!({})))
            .unwrap()["documents"],
        4
    );
    rt.block_on(space.execute("space_sync", &json!({})))
        .unwrap();
    assert_eq!(state.lock().unwrap().docs[idx].len(), 4);
    state.lock().unwrap().failed = true;
    assert!(rt
        .block_on(space.execute("space_sync", &json!({})))
        .is_err());
    assert_eq!(
        rt.block_on(space.execute("space_sync_status", &json!({})))
            .unwrap()["task_status"],
        "failed"
    );
    server.abort();
}
#[test]
fn keyword_union_matched_count_strength_and_phrase_quoting() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new(4);
    let rt = rt();
    let (server, state) = rt.block_on(fake());
    let space = SearchSpace::new(f.store.clone()).unwrap();
    rt.block_on(space.execute("space_sync", &json!({})))
        .unwrap();
    let found = rt
        .block_on(space.execute(
            "space_search_lexical",
            &json!({"keywords":[{"text":"claims"},{"text":"software"}],"limit":1}),
        ))
        .unwrap();
    assert_eq!(found["total"], 3);
    assert_eq!(ids(&found), vec!["E1-C1"]);
    assert_eq!(found["results"][0]["raw_score"], 2);
    assert_eq!(found["results"][0]["hit_count"], 2);
    assert_eq!(found["results"][0]["match_strength"], 100.0);
    assert_eq!(
        found["results"][0]["matched_keywords"],
        json!([{"id":"k1","text":"claims"},{"id":"k2","text":"software"}])
    );
    let next = rt
        .block_on(space.execute(
            "space_search_lexical",
            &json!({"keywords":[{"text":"claims"},{"text":"software"}],"offset":2}),
        ))
        .unwrap();
    assert_eq!(ids(&next), vec!["E2-C2"]);
    assert_eq!(next["results"][0]["match_strength"], 50.0);
    let phrase = rt
        .block_on(space.execute(
            "space_search_lexical",
            &json!({"keywords":[{"text":"policy administration","match":"exact"}]}),
        ))
        .unwrap();
    assert_eq!(ids(&phrase), vec!["E4-C4"]);
    assert_eq!(
        state.lock().unwrap().queries.last().unwrap()["q"],
        "\"policy administration\""
    );
    let recent = rt
        .block_on(space.execute("space_recent", &json!({"limit":2})))
        .unwrap();
    assert_eq!(recent["queries"].as_array().unwrap().len(), 2);
    assert_eq!(recent["queries"][0]["query_id"], phrase["query_id"]);
    let auto_phrase = rt
        .block_on(space.execute(
            "space_search_lexical",
            &json!({"expression":"\"policy administration\" OR consulting"}),
        ))
        .unwrap();
    assert_eq!(auto_phrase["total"], 2);
    let collision = rt.block_on(space.execute("space_search_lexical", &json!({"keywords":[{"id":"a","text":"software"},{"id":"b","text":"a"}],"expression":"a"}))).unwrap();
    assert_eq!(collision["total"], 2);
    let too_many = (0..51)
        .map(|i| json!({"id":format!("k{i}"),"text":"claims"}))
        .collect::<Vec<_>>();
    assert!(rt
        .block_on(space.execute("space_search_lexical", &json!({"keywords":too_many})))
        .unwrap_err()
        .to_string()
        .contains("50 keywords"));
    server.abort();
}
#[test]
fn expressions_override_chips_use_shared_boolean_semantics_without_approval() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new(4);
    let rt = rt();
    let (server, state) = rt.block_on(fake());
    let space = SearchSpace::new(f.store.clone()).unwrap();
    rt.block_on(space.execute("space_sync", &json!({})))
        .unwrap();
    let keywords = json!([{"id":"a","text":"claims"},{"id":"b","text":"software"},{"id":"x","text":"consulting"},{"id":"unused","text":"missing"}]);
    for (expr, want) in [
        ("a AND b", vec!["E1-C1", "E3-C3"]),
        ("(a OR b) AND NOT x", vec!["E1-C1", "E2-C2"]),
        ("claims AND software", vec!["E1-C1", "E3-C3"]),
        ("a OR (b AND x)", vec!["E3-C3", "E1-C1", "E2-C2"]),
    ] {
        let found = rt
            .block_on(space.execute(
                "space_search_lexical",
                &json!({"keywords":keywords,"expression":expr}),
            ))
            .unwrap();
        assert_eq!(ids(&found), want, "{expr}");
    }
    assert!(!state
        .lock()
        .unwrap()
        .queries
        .iter()
        .any(|q| q["q"] == "missing"));
    let one = rt
        .block_on(space.execute(
            "space_search_lexical",
            &json!({"keywords":keywords,"expression":"a"}),
        ))
        .unwrap();
    assert!(one["results"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["match_strength"] == 100.0));
    let contradiction = rt
        .block_on(space.execute(
            "space_search_lexical",
            &json!({"keywords":keywords,"expression":"a AND NOT a"}),
        ))
        .unwrap();
    assert_eq!(contradiction["total"], 0);
    let both = rt
        .block_on(space.execute(
            "space_search_lexical",
            &json!({"keywords":keywords,"expression":"(a AND NOT x) OR x"}),
        ))
        .unwrap();
    assert_eq!(both["results"][0]["company_id"], "E3-C3");
    assert_eq!(both["results"][0]["match_strength"], 100.0);
    for expr in [
        "NOT a",
        "a OR NOT b",
        "a and b",
        "a AND ()",
        "a OR absent",
        "(a OR b",
        "a b",
    ] {
        assert!(
            rt.block_on(space.execute(
                "space_search_lexical",
                &json!({"keywords":keywords,"expression":expr})
            ))
            .is_err(),
            "{expr}"
        );
    }
    let phrase=rt.block_on(space.execute("space_search_lexical",&json!({"keywords":[{"text":"policy administration"}],"expression":"\"policy administration\""}))).unwrap();
    assert_eq!(ids(&phrase), vec!["E4-C4"]);
    assert_eq!(
        rt.block_on(space.execute(
            "space_search_lexical",
            &json!({"expression":"claims AND NOT consulting"})
        ))
        .unwrap()["total"],
        2
    );
    server.abort();
}
#[test]
fn browse_paging_sort_and_limits_work_without_meili() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new(125);
    let rt = rt();
    let space = SearchSpace::new(f.store.clone()).unwrap();
    let page = rt
        .block_on(space.execute("space_browse", &json!({})))
        .unwrap();
    assert_eq!(page["results"].as_array().unwrap().len(), 100);
    assert_eq!(page["total"], 125);
    assert_eq!(page["results"][0]["values"]["Arbitrary Flag"], "flag 1");
    let page = rt
        .block_on(space.execute("space_browse", &json!({"offset":100})))
        .unwrap();
    assert_eq!(page["results"].as_array().unwrap().len(), 25);
    let sorted = rt
        .block_on(space.execute(
            "space_browse",
            &json!({"sort":{"column":"Company","direction":"desc"},"limit":2}),
        ))
        .unwrap();
    assert_eq!(ids(&sorted), vec!["E125-C125", "E124-C124"]);
    let numeric = rt
        .block_on(space.execute(
            "space_browse",
            &json!({"sort":{"column":"Annual Revenue","direction":"asc"},"limit":2}),
        ))
        .unwrap();
    assert_eq!(ids(&numeric), vec!["E1-C1", "E2-C2"]);
    for args in [
        json!({"limit":201}),
        json!({"limit":0}),
        json!({"sort":{"column":"SQL injection","direction":"asc"}}),
        json!({"unknown":true}),
    ] {
        assert!(rt.block_on(space.execute("space_browse", &args)).is_err());
    }
    assert!(rt
        .block_on(space.execute(
            "space_search_lexical",
            &json!({"keywords":[{"text":"claims"}]})
        ))
        .unwrap_err()
        .to_string()
        .contains("Meilisearch is not running"));
}
#[test]
fn semantic_streams_compatible_vectors_and_skips_unavailable() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new(4);
    let rt = rt();
    let space = SearchSpace::new(f.store.clone()).unwrap();
    let skipped = rt
        .block_on(space.execute("space_search_semantic", &json!({"text":"claims"})))
        .unwrap();
    assert_eq!(skipped["status"], "skipped");
    let (server,)=rt.block_on(async {
        async fn embed(Json(v):Json<Value>)->Json<Value> {assert_eq!(v["texts"],json!(["query: claims"]));Json(json!({"model":v["model"],"version":v["version"],"dimensions":2,"vectors":[[1.0,0.0]]}))}
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();std::env::set_var("MNA_EMBED_ENDPOINT",format!("http://{}/embed",listener.local_addr().unwrap()));
        (tokio::spawn(async move {axum::serve(listener,Router::new().route("/embed",post(embed))).await.unwrap()}),)
    });
    std::env::set_var("MNA_EMBED_MODEL", "fixture");
    std::env::set_var("MNA_EMBED_VERSION", "1");
    std::env::set_var("MNA_EMBED_DIMENSIONS", "2");
    f.store.with_connection(|c| {
        c.execute("UPDATE mid_bundles SET semantic_status='ready'",[])?;
        for (id,vector,dimensions,hash_ok) in [("E1-C1",vec![1.0f32,0.0],2,true),("E2-C2",vec![1.0,1.0],2,true),("E3-C3",vec![1.0],1,true),("E4-C4",vec![1.0,0.0],2,false)] {
            let hash:String=c.query_row("SELECT desc_hash FROM mid_rows WHERE company_id=?",[id],|r|r.get(0))?;
            let blob=vector.iter().flat_map(|v|v.to_le_bytes()).collect::<Vec<_>>();
            c.execute("INSERT INTO embedding_vectors(company_id,model,model_version,dimensions,text_hash,vector_blob,created_at) VALUES(?,'fixture','1',?,?,?,datetime('now'))",params![id,dimensions,if hash_ok {hash} else {"stale".into()},blob])?;
        }Ok(())
    }).unwrap();
    let found = rt
        .block_on(space.execute(
            "space_search_semantic",
            &json!({"text":"claims","offset":1,"limit":1}),
        ))
        .unwrap();
    assert_eq!(found["total"], 2);
    assert_eq!(ids(&found), vec!["E2-C2"]);
    assert_eq!(found["results"][0]["score"], 7.1);
    assert_eq!(found["missing_vectors"], 2);
    let filtered = rt
        .block_on(space.execute(
            "space_search_semantic",
            &json!({"text":"claims","min_score":8}),
        ))
        .unwrap();
    assert_eq!(ids(&filtered), vec!["E1-C1"]);
    assert!(rt
        .block_on(space.execute(
            "space_search_semantic",
            &json!({"text":"claims","offset":4901,"limit":100})
        ))
        .is_err());
    let export = rt
        .block_on(space.execute(
            "space_export",
            &json!({"search":{"text":"claims","offset":1,"limit":1},"format":"xlsx"}),
        ))
        .unwrap();
    assert_eq!(export["rows"], 2);
    server.abort();
}
#[test]
fn simulated_iscc_hydrates_without_run_drops_iq_link_and_adds_origin() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new(4);
    let rt = rt();
    let space = SearchSpace::new(f.store.clone()).unwrap();
    assert!(rt
        .block_on(space.execute("space_search_iscc", &json!({"query":"claims","count":5})))
        .unwrap_err()
        .to_string()
        .contains("disconnected"));
    std::env::set_var("MNA_SIMULATE", "1");
    let found = rt
        .block_on(space.execute(
            "space_search_iscc",
            &json!({"query":"claims software","count":5}),
        ))
        .unwrap();
    assert_eq!(found["total"], 5);
    assert_eq!(found["simulated"], true);
    assert!(found["results"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["values"].get("iQ Link").is_none() && r["values"]["CID"].is_string()));
    f.store.with_connection(|c| {let (run,source):(Option<String>,String)=c.query_row("SELECT run_id,source FROM search_queries WHERE query_id=?",[found["query_id"].as_str().unwrap()],|r|Ok((r.get(0)?,r.get(1)?)))?;assert!(run.is_none());assert_eq!(source,"SPACE_ISCC");let rows:i64=c.query_row("SELECT COUNT(*) FROM source_rows WHERE source='ISCC' AND run_scope='' AND query_scope=?",[found["query_id"].as_str().unwrap()],|r|r.get(0))?;assert_eq!(rows,5);Ok(())}).unwrap();
    f.run();
    let selected = ids(&found)[..2].to_vec();
    let added = rt
        .block_on(space.execute(
            "space_add_to_run",
            &json!({"run_id":"R","company_ids":selected,"query_id":found["query_id"]}),
        ))
        .unwrap();
    assert_eq!(added["added"], 2);
    f.store.with_connection(|c| {let n:i64=c.query_row("SELECT COUNT(*) FROM candidate_discovery WHERE run_id='R' AND discovery_source='ISCC' AND query_id=?",[found["query_id"].as_str().unwrap()],|r|r.get(0))?;assert_eq!(n,2);let n:i64=c.query_row("SELECT COUNT(*) FROM source_rows WHERE source='ISCC' AND run_scope='R'",[],|r|r.get(0))?;assert_eq!(n,2);Ok(())}).unwrap();
    assert!(rt
        .block_on(space.execute(
            "space_export",
            &json!({"search":{"query":"claims","count":5},"format":"xlsx"})
        ))
        .unwrap_err()
        .to_string()
        .contains("simulated"));
    let exported = rt
        .block_on(space.execute(
            "space_export",
            &json!({"search":{"query":"claims","count":5},"format":"xlsx","allow_simulated":true}),
        ))
        .unwrap();
    assert_eq!(exported["rows"], 5);
}
#[test]
fn mid_add_to_run_and_export_all_rows_beyond_page() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new(125);
    let rt = rt();
    let (server, _) = rt.block_on(fake());
    let space = SearchSpace::new(f.store.clone()).unwrap();
    rt.block_on(space.execute("space_sync", &json!({})))
        .unwrap();
    f.run();
    let found = rt
        .block_on(space.execute(
            "space_search_lexical",
            &json!({"keywords":[{"text":"claims"}],"limit":1}),
        ))
        .unwrap();
    assert_eq!(found["total"], 124);
    let add = rt
        .block_on(space.execute(
            "space_add_to_run",
            &json!({"run_id":"R","company_ids":["E1-C1","E2-C2"],"query_id":found["query_id"]}),
        ))
        .unwrap();
    assert_eq!(add["added"], 2);
    f.store.with_connection(|c| {let n:i64=c.query_row("SELECT COUNT(*) FROM candidate_discovery WHERE discovery_source='MID' AND query_id=?",[found["query_id"].as_str().unwrap()],|r|r.get(0))?;assert_eq!(n,2);Ok(())}).unwrap();
    for (search, expected) in [
        (
            json!({"keywords":[{"text":"claims"}],"offset":100,"limit":1}),
            124,
        ),
        (
            json!({"offset":100,"limit":1,"sort":{"column":"Company","direction":"desc"}}),
            125,
        ),
    ] {
        let result = rt
            .block_on(space.execute("space_export", &json!({"search":search,"format":"xlsx"})))
            .unwrap();
        assert_eq!(result["rows"], expected);
        let mut workbook: Xlsx<_> = open_workbook(
            f.dir
                .path()
                .join("export")
                .join(result["file"].as_str().unwrap()),
        )
        .unwrap();
        let range = workbook.worksheet_range_at(0).unwrap().unwrap();
        assert_eq!(range.height(), expected as usize + 1);
        assert!(range
            .rows()
            .next()
            .unwrap()
            .iter()
            .any(|v| matches!(v, calamine::Data::String(s) if s == "Arbitrary Flag")));
    }
    server.abort();
}
#[test]
fn lexical_hits_follow_exact_identifier_promotion_after_sync() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new(0);
    f.build_with_ecid(4, false);
    let rt = rt();
    let (server, _) = rt.block_on(fake());
    let space = SearchSpace::new(f.store.clone()).unwrap();
    rt.block_on(space.execute("space_sync", &json!({})))
        .unwrap();
    let before = rt
        .block_on(space.execute(
            "space_search_lexical",
            &json!({"keywords":[{"text":"claims"}]}),
        ))
        .unwrap();
    assert!(ids(&before).contains(&"X-C1".to_owned()));
    mna_tools::data::DataService::new(f.store.clone())
        .ingest_iscc_rows(
            None,
            None,
            &[json!({"CID":"C1","ECI":"E1","Company Name":"Company 001","Relevancy Score":"0.8"})],
        )
        .unwrap();
    let after = rt
        .block_on(space.execute(
            "space_search_lexical",
            &json!({"keywords":[{"text":"claims"}]}),
        ))
        .unwrap();
    assert_eq!(after["total"], 3);
    assert!(ids(&after).contains(&"E1-C1".to_owned()));
    assert!(!ids(&after).contains(&"X-C1".to_owned()));
    server.abort();
}

#[test]
fn excel_dump_adapter_keeps_all_other_iscc_fields() {
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    for (col, h) in ["CID", "ECI", "Company Name", "iQ Link", "Other Column"]
        .iter()
        .enumerate()
    {
        sheet.write_string(0, col as u16, *h).unwrap();
        sheet
            .write_string(1, col as u16, format!("value {col}"))
            .unwrap();
    }
    let rows =
        mna_tools::search_space::iscc_dump_rows(&workbook.save_to_buffer().unwrap()).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["Other Column"], "value 4");
    assert!(rows[0].get("iQ Link").is_none());
    assert!(mna_tools::search_space::iscc_dump_rows(b"not an excel file").is_err());
}

#[test]
fn stale_sync_metadata_refuses_missing_or_empty_meili_index() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new(4);
    let rt = rt();
    let (server, state) = rt.block_on(fake());
    let space = SearchSpace::new(f.store.clone()).unwrap();
    let synced = rt
        .block_on(space.execute("space_sync", &json!({})))
        .unwrap();
    let index = synced["index"].as_str().unwrap();
    for absent in [false, true] {
        if absent {
            state.lock().unwrap().docs.remove(index);
        } else {
            state.lock().unwrap().docs.get_mut(index).unwrap().clear();
        }
        let error = rt
            .block_on(space.execute(
                "space_search_lexical",
                &json!({"keywords":[{"text":"claims"}]}),
            ))
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Search Space index is not synced yet"),
            "{error}"
        );
        assert!(state.lock().unwrap().queries.is_empty());
    }
    server.abort();
}

#[test]
fn sorted_export_over_multiple_pages_preserves_numeric_order_and_count() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new(425);
    let rt = rt();
    let space = SearchSpace::new(f.store.clone()).unwrap();
    for direction in ["asc", "desc"] {
        let result = rt.block_on(space.execute("space_export", &json!({"search":{"sort":{"column":"Annual Revenue","direction":direction},"offset":200,"limit":100},"format":"xlsx"}))).unwrap();
        assert_eq!(result["rows"], 425);
        let mut workbook: Xlsx<_> = open_workbook(
            f.dir
                .path()
                .join("export")
                .join(result["file"].as_str().unwrap()),
        )
        .unwrap();
        let range = workbook.worksheet_range_at(0).unwrap().unwrap();
        assert_eq!(range.height(), 426);
        let actual = range
            .rows()
            .skip(1)
            .map(|r| r[0].to_string())
            .collect::<Vec<_>>();
        let mut expected = (1..=425).map(|i| format!("E{i}-C{i}")).collect::<Vec<_>>();
        if direction == "desc" {
            expected.reverse();
        }
        assert_eq!(actual, expected);
    }
}

#[test]
fn export_truncates_long_cells_and_cleans_failed_and_expired_files() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new(4);
    let long = "😀".repeat(17000);
    f.store.with_connection(|c| {
        c.execute("UPDATE mid_rows SET row_json=json_set(row_json,'$.\"Arbitrary Flag\"',?) WHERE company_id='E1-C1'", [&long])?;
        Ok(())
    }).unwrap();
    let export_dir = f.dir.path().join("export");
    std::fs::create_dir_all(&export_dir).unwrap();
    let expired = export_dir.join("space-expired.xlsx");
    let other = export_dir.join("other-export.xlsx");
    for path in [&expired, &other] {
        let file = std::fs::File::create(path).unwrap();
        file.set_modified(std::time::SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60))
            .unwrap();
    }
    let rt = rt();
    let space = SearchSpace::new(f.store.clone()).unwrap();
    let result = rt
        .block_on(space.execute("space_export", &json!({"search":{},"format":"xlsx"})))
        .unwrap();
    assert!(!expired.exists());
    assert!(other.exists());
    let mut workbook: Xlsx<_> =
        open_workbook(export_dir.join(result["file"].as_str().unwrap())).unwrap();
    let range = workbook.worksheet_range_at(0).unwrap().unwrap();
    let col = range
        .rows()
        .next()
        .unwrap()
        .iter()
        .position(|v| matches!(v, calamine::Data::String(value) if value == "Arbitrary Flag"))
        .unwrap();
    let cell = range.rows().nth(1).unwrap()[col].to_string();
    assert!(cell.ends_with('…'));
    assert_eq!(cell.encode_utf16().count(), 32767);
    let before = std::fs::read_dir(&export_dir).unwrap().count();
    assert!(rt
        .block_on(space.execute(
            "space_export",
            &json!({"search":{"sort":{"column":"absent","direction":"asc"}},"format":"xlsx"})
        ))
        .is_err());
    assert_eq!(std::fs::read_dir(&export_dir).unwrap().count(), before);
}
#[test]
fn runtime_read_tools_need_no_run_and_admin_routes_need_analyst() {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new(4);
    f.run();
    let rt = rt();
    let runtime = mna_tools::Runtime::new(f.store.clone()).unwrap();
    let browse = rt
        .block_on(runtime.execute(mna_tools::runtime::ToolCall {
            tool: "space_browse".into(),
            arguments: json!({}),
        }))
        .unwrap();
    assert_eq!(browse["total"], 4);
    let api = "test-api-key-with-at-least-24-characters";
    let analyst = "test-analyst-key-at-least-24-characters";
    let app = mna_tools::router(runtime, api.into(), Some(analyst.into())).unwrap();
    for approved in [false, true] {
        let mut req = Request::builder()
            .method("POST")
            .uri("/admin/space-add-to-run")
            .header("authorization", format!("Bearer {api}"))
            .header("content-type", "application/json");
        if approved {
            req = req.header("x-mna-analyst-key", analyst);
        }
        let response = rt
            .block_on(
                app.clone().oneshot(
                    req.body(Body::from(
                        json!({"run_id":"R","company_ids":["E1-C1"]}).to_string(),
                    ))
                    .unwrap(),
                ),
            )
            .unwrap();
        assert_eq!(
            response.status(),
            if approved {
                StatusCode::OK
            } else {
                StatusCode::FORBIDDEN
            }
        );
        let body = rt
            .block_on(response.into_body().collect())
            .unwrap()
            .to_bytes();
        if approved {
            assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["added"], 1);
        }
    }
    let admin = mna_tools::runtime::administrator_definitions();
    for name in ["space_sync", "space_add_to_run", "space_export"] {
        let def = admin.iter().find(|d| d["name"] == name).unwrap();
        assert_eq!(def["controller_only"], false);
        assert!(def["input_schema"].is_object());
    }
}

#[test]
#[ignore = "Optional real local Meilisearch smoke; set SEARCH_SPACE_REAL_MEILI_BIN"]
fn real_meili_smoke() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new(4);
    let binary = std::env::var("SEARCH_SPACE_REAL_MEILI_BIN").expect("local binary path");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    struct Process(std::process::Child);
    impl Drop for Process {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut child = Process(
        std::process::Command::new(binary)
            .args([
                "--http-addr",
                &address.to_string(),
                "--env",
                "development",
                "--no-analytics",
            ])
            .arg("--db-path")
            .arg(f.dir.path().join("meili"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let url = format!("http://{address}");
    std::env::set_var("MNA_MEILI_URL", &url);
    let rt = rt();
    rt.block_on(async {
        let start = Instant::now();
        loop {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "Meilisearch exited during startup"
            );
            if reqwest::Client::new()
                .get(format!("{url}/health"))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(30),
                "Meilisearch readiness timed out"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let space = SearchSpace::new(f.store.clone()).unwrap();
        let start = Instant::now();
        let sync = space.execute("space_sync", &json!({})).await.unwrap();
        let sync_time = start.elapsed();
        assert_eq!(sync["documents"], 4);
        let start = Instant::now();
        let found = space
            .execute(
                "space_search_lexical",
                &json!({"keywords":[{"text":"claims"},{"text":"software"}]}),
            )
            .await
            .unwrap();
        assert_eq!(found["total"], 3, "{found}");
        let lexical_time = start.elapsed();
        let prefix = space
            .execute(
                "space_search_lexical",
                &json!({"keywords":[{"text":"claim","match":"stem"}]}),
            )
            .await
            .unwrap();
        assert_eq!(prefix["total"], 3);
        let exact = space
            .execute(
                "space_search_lexical",
                &json!({"keywords":[{"text":"claim","match":"exact"}]}),
            )
            .await
            .unwrap();
        assert_eq!(exact["total"], 0);
        println!(
            "Real Meilisearch smoke: documents=4, matches=3, sync_ms={}, lexical_ms={}",
            sync_time.as_millis(),
            lexical_time.as_millis()
        );
    });
}

#[test]
fn older_bundles_without_workbook_columns_list_headers_from_rows() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new(5);
    f.store
        .with_connection(|c| {
            c.execute(
                "UPDATE mid_bundles SET config_json=json_remove(config_json,'$.workbook_columns') WHERE status='active'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let rt = rt();
    let space = SearchSpace::new(f.store.clone()).unwrap();
    let page = rt
        .block_on(space.execute("space_browse", &json!({})))
        .unwrap();
    let columns: Vec<&str> = page["columns"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(columns.contains(&"Company"), "{columns:?}");
    assert!(columns.contains(&"Arbitrary Flag"), "{columns:?}");
}
