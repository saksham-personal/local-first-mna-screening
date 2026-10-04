use mna_tools::{search::SearchEngine, Store};
use serde_json::json;

#[tokio::test]
async fn mid_alias_keeps_broad_business_matches_and_reports_ignored_criteria() {
    let store = Store::open(":memory:").unwrap();
    store.execute("ingest_companies", &json!({"companies":[
        {"company_id":"X-C1","name":"Claims Automation","description":"Claims workflow software for insurance carriers","country":"India","industry":"Software","revenue":100.0,"employees":50},
        {"company_id":"X-C2","name":"Retail Company","description":"Retail clothing outlets","country":"USA","industry":"Retail","revenue":1000.0,"employees":5000},
        {"company_id":"X-C3","name":"ISCC Only","description":"Claims insurance software","metadata":{"preferred_source":"ISCC"}}
    ]})).unwrap();
    let engine = SearchEngine::new(store).unwrap();
    let result = engine.execute("search_mid", &json!({
        "query":"claims insurance software",
        "mode":"lexical",
        "prefer_meilisearch":false,
        "filters":{"country":["USA"],"industry":"Retail","revenue_min":9999.0,"employees_max":1}
    })).await.unwrap();
    assert_eq!(result["total"], 1);
    assert_eq!(result["results"][0]["company"]["company_id"], "X-C1");
    assert_eq!(result["search_scope"], "qualitative_core_business");
    assert_eq!(
        result["ignored_search_filters"],
        json!(["country", "industry", "revenue_min", "employees_max"])
    );
}

#[tokio::test]
async fn streaming_search_counts_all_matches_and_returns_only_requested_page_without_vectors() {
    let store = Store::open(":memory:").unwrap();
    let companies: Vec<_> = (0..400)
        .map(|index| {
            json!({
                "company_id":format!("X-{index:04}"),
                "name":format!("Target {index}"),
                "description":"Claims software for insurance carriers",
                "embedding":[1.0,0.0],
            })
        })
        .collect();
    store
        .execute("ingest_companies", &json!({"companies":companies}))
        .unwrap();
    let engine = SearchEngine::new(store).unwrap();
    let page = engine
        .execute(
            "search_mid",
            &json!({
                "query":"claims software",
                "mode":"lexical",
                "offset":390,
                "limit":10,
                "prefer_meilisearch":false,
            }),
        )
        .await
        .unwrap();
    assert_eq!(page["total"], 400);
    assert_eq!(page["results"].as_array().unwrap().len(), 10);
    assert_eq!(page["results"][0]["rank"], 391);
    assert_eq!(page["results"][0]["company"]["company_id"], "X-0390");
    assert!(page["results"][0]["company"].get("embedding").is_none());

    let neighbors = engine
        .execute(
            "find_similar_companies",
            &json!({
                "company_id":"X-0000",
                "limit":3,
            }),
        )
        .await
        .unwrap();
    assert_eq!(neighbors["results"].as_array().unwrap().len(), 3);
    assert!(neighbors["results"][0]["company"]
        .get("embedding")
        .is_none());
}
