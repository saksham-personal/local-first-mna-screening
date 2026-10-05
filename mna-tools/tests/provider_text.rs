use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
use mna_tools::{
    gateway::{self, ProviderTextRequest, TextAttachment},
    Store,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

#[test]
fn text_contracts_accept_only_finite_drafts() {
    let valid = "BEGIN_QUERIES\nQUERY: {company} insurance products\nQUERY: site:{website} core business\nEND_QUERIES";
    assert_eq!(
        gateway::parse_text_output("query_templates", valid).unwrap()["templates"],
        json!([
            "{company} insurance products",
            "site:{website} core business"
        ])
    );
    for invalid in [
        "QUERY: {company} insurance products",
        "prefix\nBEGIN_QUERIES\nQUERY: {company}\nEND_QUERIES",
        "BEGIN_QUERIES\nQUERY: {company}\nEND_QUERIES\nsuffix",
        "BEGIN_QUERIES\n{company}\nEND_QUERIES",
        "BEGIN_QUERIES\nQUERY: no placeholder\nEND_QUERIES",
        "BEGIN_QUERIES\nQUERY: {unknown}\nEND_QUERIES",
        "BEGIN_QUERIES\nQUERY: {company}\nQUERY: {COMPANY}\nEND_QUERIES",
        "BEGIN_QUERIES\nQUERY: {company}\nBEGIN_QUERIES\nEND_QUERIES",
        "BEGIN_QUERIES\nQUERY: {company} 1\nQUERY: {company} 2\nQUERY: {company} 3\nQUERY: {company} 4\nQUERY: {company} 5\nQUERY: {company} 6\nEND_QUERIES",
    ] {
        assert!(gateway::parse_text_output("query_templates", invalid).is_err(), "accepted: {invalid}");
    }
    assert_eq!(
        gateway::parse_text_output("text", "  analyst answer  ").unwrap()["text"],
        "analyst answer"
    );
    assert_eq!(
        gateway::parse_text_output("criteria", "BEGIN_CRITERIA\nFit to claims\nEND_CRITERIA")
            .unwrap()["text"],
        "Fit to claims"
    );
    assert_eq!(
        gateway::parse_text_output("screening_prompt", "BEGIN_PROMPT\nScore fit\nEND_PROMPT")
            .unwrap()["text"],
        "Score fit"
    );
    for (format, body) in [
        ("criteria", "prefix BEGIN_CRITERIA\nFit\nEND_CRITERIA"),
        ("criteria", "BEGIN_CRITERIA\n\nEND_CRITERIA"),
        (
            "screening_prompt",
            "BEGIN_PROMPT\nScore fit\nEND_PROMPT\nextra",
        ),
        ("unknown", "anything"),
    ] {
        assert!(gateway::parse_text_output(format, body).is_err());
    }
}

#[derive(Clone)]
struct MockState {
    replies: Arc<Mutex<VecDeque<String>>>,
    requests: Arc<Mutex<Vec<(String, Value, String)>>>,
}

fn request(id: &str, provider: &str, purpose: &str, format: &str) -> ProviderTextRequest {
    ProviderTextRequest {
        run_id: None,
        provider: provider.into(),
        deployment: Some("fixture".into()),
        prompt: "Draft for an analyst".into(),
        request_id: Some(id.into()),
        expected_format: Some(format.into()),
        purpose: Some(purpose.into()),
        attachments: vec![TextAttachment {
            name: "notes.txt".into(),
            media_type: Some("text/plain".into()),
            content: "Known facts".into(),
        }],
    }
}

#[tokio::test]
async fn local_adapter_receipts_repairs_cache_identity_and_shared_gate() {
    let store = Store::open(":memory:").unwrap();
    let state = MockState {
        replies: Arc::new(Mutex::new(VecDeque::new())),
        requests: Arc::new(Mutex::new(Vec::new())),
    };
    let app =
        Router::new()
            .route(
                "/one",
                post(
                    |State(state): State<MockState>,
                     headers: HeaderMap,
                     Json(body): Json<Value>| async move {
                        let key = headers
                            .get("idempotency-key")
                            .unwrap()
                            .to_str()
                            .unwrap()
                            .to_owned();
                        state
                            .requests
                            .lock()
                            .unwrap()
                            .push(("one".into(), body, key));
                        let reply = state
                            .replies
                            .lock()
                            .unwrap()
                            .pop_front()
                            .expect("fixture response");
                        ([("content-type", "application/json")], reply)
                    },
                ),
            )
            .route(
                "/two",
                post(
                    |State(state): State<MockState>,
                     headers: HeaderMap,
                     Json(body): Json<Value>| async move {
                        let key = headers
                            .get("idempotency-key")
                            .unwrap()
                            .to_str()
                            .unwrap()
                            .to_owned();
                        state
                            .requests
                            .lock()
                            .unwrap()
                            .push(("two".into(), body, key));
                        let reply = state
                            .replies
                            .lock()
                            .unwrap()
                            .pop_front()
                            .expect("fixture response");
                        ([("content-type", "application/json")], reply)
                    },
                ),
            )
            .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    std::env::set_var("MNA_ENABLE_EXTERNAL", "true");
    std::env::set_var("MNA_LLMSUITE_ENDPOINT", format!("http://{address}/one"));
    std::env::set_var("MNA_LLMSUITE_TOKEN", "fixture-only");
    std::env::set_var("MNA_M365_ENDPOINT", format!("http://{address}/two"));
    std::env::set_var("MNA_M365_TOKEN", "fixture-only");

    state
        .replies
        .lock()
        .unwrap()
        .push_back(json!({"response_text":"First answer"}).to_string());
    let first = gateway::provider_text(
        store.clone(),
        request("cached", "llm_suite", "question", "text"),
    )
    .await
    .unwrap();
    assert_eq!(first["text"], "First answer");
    assert_eq!(state.requests.lock().unwrap().len(), 1);
    assert_eq!(
        state.requests.lock().unwrap()[0].1["attachments"][0]["content"],
        "Known facts"
    );
    assert_eq!(
        gateway::provider_text(
            store.clone(),
            request("cached", "llm_suite", "question", "text")
        )
        .await
        .unwrap(),
        first
    );
    assert_eq!(state.requests.lock().unwrap().len(), 1);
    std::env::set_var("MNA_LLMSUITE_ENDPOINT", format!("http://{address}/two"));
    assert!(gateway::provider_text(
        store.clone(),
        request("cached", "llm_suite", "question", "text")
    )
    .await
    .is_err());
    std::env::set_var("MNA_LLMSUITE_ENDPOINT", format!("http://{address}/one"));
    assert!(gateway::provider_text(
        store.clone(),
        request("cached", "llm_suite", "subagent", "text")
    )
    .await
    .is_err());
    assert!(gateway::provider_text(
        store.clone(),
        request("cached", "copilot", "question", "text")
    )
    .await
    .is_err());
    assert_eq!(state.requests.lock().unwrap().len(), 1);

    state.replies.lock().unwrap().push_back("{".into());
    assert!(gateway::provider_text(
        store.clone(),
        request("malformed", "llm_suite", "question", "text")
    )
    .await
    .is_err());
    let receipt: Value = store
        .with_connection(|conn| {
            let payload: String = conn.query_row(
                "SELECT payload_json FROM agent_events WHERE event_id='text:malformed:receipt:0'",
                [],
                |row| row.get(0),
            )?;
            Ok(serde_json::from_str(&payload)?)
        })
        .unwrap();
    assert_eq!(receipt["response_bytes_hex"], "7b");
    assert_eq!(receipt["attempt"], 0);
    assert!(receipt.get("accepted").is_none());
    assert!(gateway::provider_text(
        store.clone(),
        request("malformed", "llm_suite", "question", "text")
    )
    .await
    .is_err());
    assert_eq!(state.requests.lock().unwrap().len(), 2);

    state.replies.lock().unwrap().extend([
        json!({"response_text":"bad"}).to_string(),
        json!({"response_text":"BEGIN_QUERIES\nQUERY: {unknown}\nEND_QUERIES"}).to_string(),
        json!({"response_text":"BEGIN_QUERIES\nQUERY: {company} claims software\nEND_QUERIES"})
            .to_string(),
    ]);
    let repaired = gateway::provider_text(
        store.clone(),
        request("repair", "llm_suite", "orchestrator", "query_templates"),
    )
    .await
    .unwrap();
    assert_eq!(repaired["templates"], json!(["{company} claims software"]));
    {
        let requests = state.requests.lock().unwrap();
        assert_eq!(requests.len(), 5);
        assert!(requests[3].1["prompt"]
            .as_str()
            .unwrap()
            .contains("Correct the output format"));
        assert_eq!(requests[4].2, "text:repair:2");
    }
    let slots: i64 = store
        .with_connection(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM llmsuite_slots", [], |row| row.get(0))?)
        })
        .unwrap();
    assert_eq!(slots, 5);

    // Copilot follows the same finite repair contract, without consuming the
    // LLM Suite gate. A third invalid response must terminate the request.
    state.replies.lock().unwrap().extend([
        json!({"response_text":"bad"}).to_string(),
        json!({"response_text":"still bad"}).to_string(),
        json!({"response_text":"also bad"}).to_string(),
    ]);
    assert!(gateway::provider_text(
        store.clone(),
        request("repair-exhausted", "copilot", "question", "query_templates")
    )
    .await
    .is_err());
    assert_eq!(state.requests.lock().unwrap().len(), 8);
    let receipt_count: i64 = store.with_connection(|conn| {
        Ok(conn.query_row("SELECT COUNT(*) FROM agent_events WHERE event_id LIKE 'text:repair-exhausted:receipt:%'", [], |row| row.get(0))?)
    }).unwrap();
    assert_eq!(receipt_count, 3);

    for id in ["six", "seven"] {
        state
            .replies
            .lock()
            .unwrap()
            .push_back(json!({"response_text":"ready"}).to_string());
        assert!(gateway::provider_text(
            store.clone(),
            request(id, "llm_suite", "subagent", "text")
        )
        .await
        .is_ok());
    }
    assert!(gateway::provider_text(
        store.clone(),
        request("eight", "llm_suite", "question", "text")
    )
    .await
    .is_err());
    assert_eq!(state.requests.lock().unwrap().len(), 10);
    for key in [
        "MNA_ENABLE_EXTERNAL",
        "MNA_LLMSUITE_ENDPOINT",
        "MNA_LLMSUITE_TOKEN",
        "MNA_M365_ENDPOINT",
        "MNA_M365_TOKEN",
    ] {
        std::env::remove_var(key);
    }
    server.abort();
}
