//! Replaceable LLM Suite controller transport; policy and parsing live elsewhere.
use crate::{
    error::{Error, Result},
    gateway, Store,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

pub struct Reply {
    pub text: String,
    pub usage: Option<Value>,
}

/// To connect the real LLM Suite API, configure MNA_LLMSUITE_ENDPOINT and
/// MNA_LLMSUITE_TOKEN, then change the auth header in gateway::send_text_envelope
/// (currently Bearer), the body fields below (prompt, conversation_id, model),
/// and the response field below (response_text). Preserve the conversation id
/// on every send and the shared gateway rate gate, receipts and 2 MB limit.
pub async fn send(
    store: &Store,
    run_id: &str,
    turn_id: &str,
    conversation_id: &str,
    prompt: &str,
    model: &str,
    feedback: bool,
) -> Result<Reply> {
    let (endpoint, token) = gateway::configured("llm_suite")?;
    if crate::simulate::enabled() && !is_stub(&endpoint, &token) {
        return Err(Error::ProviderUnavailable(
            "Controller simulation requires the local LLM Suite stub".into(),
        ));
    }
    let body = json!({"prompt":prompt,"conversation_id":conversation_id,"model":model});
    let hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(
            &json!({"endpoint":endpoint.as_str(),"payload":body})
        )?)
    );
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(90))
        .build()?;
    let envelope = gateway::send_text_envelope(
        store,
        &client,
        gateway::TextSend {
            provider: "llm_suite",
            run_id: Some(run_id),
            request_id: turn_id,
            attempt: 0,
            purpose: if feedback { "repair" } else { "orchestrator" },
            payload_hash: &hash,
            endpoint,
            token: &token,
            body,
        },
    )
    .await?;
    let text = envelope["response_text"]
        .as_str()
        .ok_or_else(|| {
            Error::Validation("Provider response does not match the text adapter contract".into())
        })?
        .to_owned();
    Ok(Reply {
        text,
        usage: envelope.get("usage").cloned(),
    })
}

fn is_stub(endpoint: &url::Url, token: &str) -> bool {
    token == "stub"
        && endpoint.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
}

pub fn simulated() -> bool {
    crate::simulate::enabled()
        || gateway::configured("llm_suite")
            .is_ok_and(|(endpoint, token)| is_stub(&endpoint, &token))
}
