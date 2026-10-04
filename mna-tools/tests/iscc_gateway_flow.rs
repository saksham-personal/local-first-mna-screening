use axum::{routing::post, Json, Router};
use mna_tools::{data::DataService, runtime::ToolCall, Runtime, Store};
use serde_json::{json, Value};

#[tokio::test]
async fn gateway_pull_preserves_raw_rows_and_returns_one_mid_preferred_company_per_identity() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("mid.csv"), "ECID,CID,Company Name,Website,Description,HQ City,HQ State\n10,11,MID Policy Vendor,mid.example,Insurance policy administration software,City,State\n").unwrap();
    std::env::set_var("MNA_IMPORT_DIR", directory.path());
    let app = Router::new().route("/iscc", post(|Json(payload): Json<Value>| async move {
        assert_eq!(payload, json!({"query":"policy administration software insurance carriers","limit":4}));
        Json(json!({"rows":[
            {"ECID":"10","CID":"11","Company Name":"ISCC Alternative Name","Website":"other.example","Description":"Policy workflow platform","Relevance Score":0.91},
            {"ECID":"10","CID":"11","Company Name":"Duplicate ISCC Company","Description":"Another incomplete description","Relevance Score":0.71},
            {"ECID":"81","CID":"#N/A","Company Name":"ECID Only Vendor","Description":"Insurance carrier software","Relevance Score":0.43},
            {"ECID":"0","CID":"NA","Company Name":"Missing Both","Description":"Policy tools","Relevance Score":0.35}
        ]}))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    std::env::set_var("MNA_ENABLE_EXTERNAL", "true");
    std::env::set_var("MNA_ISCC_ENDPOINT", format!("http://{address}/iscc"));
    let store = Store::open(":memory:").unwrap();
    let data = DataService::new(store.clone());
    data.execute("import_company_files", &json!({"files":["mid.csv"]}))
        .unwrap();
    store.execute("create_run", &json!({"run_id":"R","objective":"Find insurance workflow vendors","original_criteria":{"business":"insurance software"}})).unwrap();
    store
        .execute(
            "approve_screening_profile",
            &json!({"run_id":"R","version":1,"approved_by":"test analyst"}),
        )
        .unwrap();
    let runtime = Runtime::new(store.clone()).unwrap();
    let call = || ToolCall {
        tool: "search_iscc".into(),
        arguments: json!({"run_id":"R","query":"policy administration software insurance carriers","limit":4}),
    };
    let result = runtime.execute(call()).await.unwrap();
    assert_eq!(result["retrieved_count"], 4);
    assert_eq!(result["result_count"], 2);
    assert_eq!(result["ingestion"]["quarantined"], 1);
    assert_eq!(result["results"][0]["company_id"], "10-11");
    assert_eq!(result["results"][0]["name"], "MID Policy Vendor");
    assert_eq!(
        result["results"][0]["description"],
        "Insurance policy administration software"
    );
    assert_eq!(result["results"][0]["source"], "both");
    assert_eq!(result["results"][0]["relevance_score"], 0.91);
    assert_eq!(result["results"][1]["company_id"], "81-X");
    assert!(result["results"][0].get("embedding").is_none());
    let ids: Vec<_> = result["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|company| company["company_id"].clone())
        .collect();
    store.execute("add_candidates", &json!({"run_id":"R","companies":ids,"discovery_source":"ISCC","query_id":result["query_id"]})).unwrap();
    let summary = data
        .execute("get_discovery_summary", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(summary["both"], 1);
    assert_eq!(summary["iscc_only"], 1);
    let samples = runtime
        .execute(ToolCall {
            tool: "get_iscc_score_samples".into(),
            arguments: json!({"run_id":"R","query_id":result["query_id"]}),
        })
        .await
        .unwrap();
    assert_eq!(samples["cutoff_applied"], false);
    let repeated = runtime.execute(call()).await.unwrap();
    assert_eq!(repeated["cached"], true);
    assert_ne!(repeated["query_id"], result["query_id"]);
    let source = data
        .execute(
            "get_source_rows",
            &json!({"company_id":"10-11","source":"ISCC"}),
        )
        .unwrap();
    assert_eq!(source["rows"].as_array().unwrap().len(), 4);
    server.abort();
    for name in ["MNA_ENABLE_EXTERNAL", "MNA_ISCC_ENDPOINT", "MNA_IMPORT_DIR"] {
        std::env::remove_var(name);
    }
}
