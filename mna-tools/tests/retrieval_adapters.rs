use mna_tools::retrieval::{
    self, AdapterFuture, Embedder, LocalHttpAdapter, ModelIdentity, RerankCandidate, Reranker,
    RetrievalConfig,
};
use mna_tools::{search::SearchEngine, Store};
use serde_json::json;

struct ReverseReranker;
impl Reranker for ReverseReranker {
    fn rerank<'a>(
        &'a self,
        _query: &'a str,
        candidates: &'a [RerankCandidate],
    ) -> AdapterFuture<'a, Vec<(String, f64)>> {
        Box::pin(async move {
            Ok(candidates
                .iter()
                .rev()
                .enumerate()
                .map(|(rank, c)| (c.company_id.clone(), 1.0 - rank as f64 / 1000.0))
                .collect())
        })
    }
}

#[tokio::test]
async fn reranking_reorders_only_first_500_and_keeps_all_1000_with_provenance() {
    let candidates: Vec<_> = (0..1000)
        .map(|n| RerankCandidate {
            company_id: format!("C{n:04}"),
            description: "Claims software".into(),
            source: "MID".into(),
            retrieval_score: Some(0.9 - n as f64 / 2000.0),
            query_id: Some("Q1".into()),
        })
        .collect();
    let result = retrieval::rerank_preserving_tail(
        &ReverseReranker,
        "claims software",
        &candidates,
        "fixture",
        "1",
    )
    .await
    .unwrap();
    let rows = result["results"].as_array().unwrap();
    assert_eq!(rows.len(), 1000);
    assert_eq!(rows[0]["company_id"], "C0499");
    assert_eq!(rows[499]["company_id"], "C0000");
    assert_eq!(rows[500]["company_id"], "C0500");
    assert_eq!(rows[999]["company_id"], "C0999");
    assert_eq!(rows[500]["rerank_score"], serde_json::Value::Null);
    assert_eq!(rows[500]["source"], "MID");
    assert_eq!(rows[500]["query_id"], "Q1");
    assert_eq!(result["candidate_membership_preserved"], true);
    let mut mixed = candidates.clone();
    mixed[1].source = "ISCC".into();
    assert!(retrieval::rerank_preserving_tail(
        &ReverseReranker,
        "claims software",
        &mixed,
        "fixture",
        "1"
    )
    .await
    .unwrap_err()
    .to_string()
    .contains("one source/query"));
}

#[test]
fn selected_embedding_identity_and_geometry_are_strict() {
    let selected = ModelIdentity {
        model: "A".into(),
        version: "2".into(),
        dimensions: 768,
    };
    assert!(retrieval::validate_vector(&vec![1.0; 768], &selected).is_ok());
    assert!(retrieval::validate_vector(&vec![0.0; 768], &selected).is_err());
    assert!(retrieval::validate_vector(&vec![1.0; 767], &selected).is_err());
    let changed = ModelIdentity {
        model: "A".into(),
        version: "3".into(),
        dimensions: 768,
    };
    assert!(retrieval::validate_identity(&changed, &selected).is_err());
}

#[tokio::test]
async fn unconfigured_adapter_fails_clearly_without_inference() {
    let adapter = LocalHttpAdapter::new(RetrievalConfig {
        embedder: ModelIdentity {
            model: "A".into(),
            version: "2".into(),
            dimensions: 768,
        },
        embed_endpoint: None,
        rerank_model: None,
        rerank_version: None,
        rerank_endpoint: None,
    })
    .unwrap();
    assert!(adapter
        .embed(&["insurance software".into()])
        .await
        .unwrap_err()
        .to_string()
        .contains("not configured"));
    let candidate = RerankCandidate {
        company_id: "C1".into(),
        description: "insurance software".into(),
        source: "MID".into(),
        retrieval_score: None,
        query_id: None,
    };
    assert!(adapter
        .rerank("insurance", &[candidate])
        .await
        .unwrap_err()
        .to_string()
        .contains("not configured"));
    assert_eq!(adapter.config().status()["embedder"]["executed"], false);
}

#[tokio::test]
async fn localhost_worker_response_is_accepted_only_for_selected_model() {
    use axum::{routing::post, Json, Router};
    let app=Router::new().route("/embed",post(|Json(payload):Json<serde_json::Value>|async move {
        Json(json!({"model":payload["model"],"version":"wrong-version","dimensions":2,"vectors":[[1.0,0.0]]}))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let adapter = LocalHttpAdapter::new(RetrievalConfig {
        embedder: ModelIdentity {
            model: "fixture".into(),
            version: "v1".into(),
            dimensions: 2,
        },
        embed_endpoint: Some(format!("http://{address}/embed")),
        rerank_model: None,
        rerank_version: None,
        rerank_endpoint: None,
    })
    .unwrap();
    let error = adapter
        .embed(&["Insurance software".into()])
        .await
        .unwrap_err();
    assert!(error.to_string().contains("quarantined"));
    server.abort();
}

#[tokio::test]
async fn mid_defaults_to_1000_and_only_approved_business_exclusions_narrow() {
    let store = Store::open(":memory:").unwrap();
    let companies:Vec<_>=(0..1001).map(|n|json!({"company_id":format!("X-{n:04}"),"name":"Target","description":if n==0 {"Claims software consulting"} else {"Claims software"},"country":"India","revenue":1})).collect();
    store
        .execute("ingest_companies", &json!({"companies":&companies[..1000]}))
        .unwrap();
    store
        .execute("ingest_companies", &json!({"companies":&companies[1000..]}))
        .unwrap();
    store.execute("create_run",&json!({"run_id":"R1","objective":"Targets","original_criteria":{},"initial_profile":{"core_business_exclusions":["consulting"]}})).unwrap();
    let engine = SearchEngine::new(store.clone()).unwrap();
    let request = json!({"run_id":"R1","query":"claims software","mode":"lexical","prefer_meilisearch":false,"filters":{"country":"USA","exclude_keywords":["claims","consulting"]}});
    let before = engine.execute("search_mid", &request).await.unwrap();
    assert_eq!(before["total"], 1001);
    assert_eq!(before["results"].as_array().unwrap().len(), 1000);
    assert_eq!(
        before["ignored_search_filters"],
        json!(["country", "exclude_keywords_unapproved"])
    );
    store
        .execute(
            "approve_screening_profile",
            &json!({"run_id":"R1","version":1,"approved_by":"analyst"}),
        )
        .unwrap();
    let after = engine.execute("search_mid", &request).await.unwrap();
    assert_eq!(after["total"], 1000);
    assert_eq!(after["results"].as_array().unwrap().len(), 1000);
    assert_eq!(
        after["applied_core_business_exclusions"],
        json!(["consulting"])
    );
    for query in [
        "claims EXCLUDE consulting",
        "claims AND (NOT consulting)",
        "claims AND (-consulting)",
    ] {
        for mode in ["lexical", "semantic"] {
            assert!(engine.execute("search_mid",&json!({"run_id":"R1","query":query,"mode":mode,"prefer_meilisearch":false,"query_vector":[1.0,0.0]})).await.unwrap_err().to_string().contains("exclusions require"));
        }
    }
}
