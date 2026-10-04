use mna_tools::{router, Runtime, Store};
use std::{net::SocketAddr, path::PathBuf};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    match std::env::args().nth(1).as_deref() {
        Some("--print-tool-schemas") => {
            println!(
                "{}",
                serde_json::to_string_pretty(&mna_tools::runtime::tool_definitions())?
            );
            return Ok(());
        }
        Some("--print-admin-schemas") => {
            println!(
                "{}",
                serde_json::to_string_pretty(&mna_tools::runtime::administrator_definitions())?
            );
            return Ok(());
        }
        Some("--help") | Some("-h") => {
            println!("mna-tools\n\nOptions: --print-tool-schemas, --print-admin-schemas, --help\nSet MNA_API_KEY (24+ characters) before serving.\nOptional: MNA_ANALYST_KEY, MNA_CONTROLLER_KEY, MNA_DB_PATH, MNA_BIND (127.0.0.1:7318).\nSee README.md for provider and local inference configuration.");
            return Ok(());
        }
        Some(argument) => return Err(format!("Unknown argument: {argument}").into()),
        None => {}
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "mna_tools=info".into()),
        )
        .init();
    let address: SocketAddr = std::env::var("MNA_BIND")
        .unwrap_or_else(|_| "127.0.0.1:7318".into())
        .parse()?;
    if !address.ip().is_loopback() {
        return Err("MNA_BIND must use a loopback IP address".into());
    }
    let database =
        PathBuf::from(std::env::var("MNA_DB_PATH").unwrap_or_else(|_| "data/agent.db".into()));
    if let Some(parent) = database.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let api_key = std::env::var("MNA_API_KEY")
        .map_err(|_| "Set MNA_API_KEY to a random secret of at least 24 characters")?;
    let analyst_key = std::env::var("MNA_ANALYST_KEY").ok();
    let runtime = Runtime::new(Store::open(database)?)?;
    let app = router(runtime, api_key, analyst_key)?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "M&A tool service listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
