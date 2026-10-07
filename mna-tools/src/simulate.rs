//! Explicit, deterministic development providers. No network or random inputs.
use crate::{error::Result, Store};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn enabled() -> bool {
    std::env::var("MNA_SIMULATE").ok().as_deref() == Some("1")
}

pub const ISCC_HEADERS: &[&str] = &[
    "CID",
    "ECI",
    "Company Name",
    "iQ Link",
    "Company Website",
    "Relevancy Score",
    "Company Status",
    "iSpreso Indicator",
    "Parent",
    "Sales Range",
    "Annual Revenue ($ mm)",
    "Ownership",
    "Employees",
    "Address",
    "City",
    "State",
    "Country",
    "ZIP",
    "Segment",
    "Region",
    "Market",
    "HQ Location",
    "Quality of Connection",
    "LOB",
    "Sub LOB",
    "IB Sector",
    "IB Sub Sector",
    "IB Sub Sector Level 2",
    "IB Microsector",
    "CB Banker",
    "IB Client Executive",
    "CB R12 Call Count",
    "IB R12 Call Count",
    "Total R12 Call Count",
    "Last Call Date",
    "Sponsors",
    "Sponsor Type",
    "Protocol Tier",
    "Company Description",
    "Company Description Source",
    "Pitchbook ID",
    "Pitchbook Description",
    "Factset Description",
    "Demandbase Description",
    "Dealogic Description",
    "NAICS",
    "NAICS Description",
    "Offerings",
    "Pitchbook Keywords",
];

fn seed(parts: &[&str]) -> u64 {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    u64::from_be_bytes(hash.finalize()[..8].try_into().expect("eight hash bytes"))
}

/// A 60/40 mix when MID identities are available, capped at 1,000 rows.
pub fn iscc_rows(store: &Store, run_id: &str, query: &str) -> Result<Vec<Value>> {
    let mut companies = store.with_connection(|conn| {
        let mut stmt = conn.prepare("SELECT c.company_id,(SELECT identifier FROM company_identifiers WHERE company_id=c.company_id AND kind='ECID' LIMIT 1),(SELECT identifier FROM company_identifiers WHERE company_id=c.company_id AND kind='CID' LIMIT 1),c.name FROM companies c WHERE EXISTS(SELECT 1 FROM source_rows s WHERE s.company_id=c.company_id AND s.source='MID') ORDER BY c.company_id")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    companies.sort_by_key(|c| (seed(&[query, &c.0]), c.0.clone()));
    companies.truncate(600);
    let synthetic = if companies.is_empty() {
        400
    } else {
        (companies.len() * 2).div_ceil(3)
    };
    let words = query
        .split_whitespace()
        .take(4)
        .collect::<Vec<_>>()
        .join(" ");
    let vocab = [
        "Systems",
        "Solutions",
        "Partners",
        "Technologies",
        "Services",
    ];
    let base = seed(&[run_id, query]) / 1000 * 1000;
    let mut rows = Vec::new();
    for i in 0..companies.len() + synthetic {
        let n = base + i as u64;
        let (ecid, cid, name) = if let Some(c) = companies.get(i) {
            (
                c.1.clone().unwrap_or_else(|| "-".into()),
                c.2.clone().unwrap_or_default(),
                c.3.clone(),
            )
        } else {
            (
                if seed(&[query, &n.to_string(), "ecid"]) % 100 < 15 {
                    "-".into()
                } else {
                    format!("SIM-E{n}")
                },
                format!("SIM-C{n}"),
                format!("{words} {} {i}", vocab[i % vocab.len()]),
            )
        };
        let mut row = json!({});
        for header in ISCC_HEADERS {
            row[*header] = json!("");
        }
        row["CID"] = json!(cid);
        row["ECI"] = json!(ecid);
        row["Company Name"] = json!(name);
        row["iQ Link"] = json!(format!("https://iq.example.invalid/company/{cid}"));
        row["Company Website"] = json!(format!("https://example.invalid/company/{n}"));
        row["Relevancy Score"] = json!(format!(
            "{:.2}",
            (seed(&[query, &ecid, &cid, "relevance"]) % 101) as f64 / 100.0
        ));
        row["Company Status"] = json!("Simulated: Active");
        row["Company Description"] = json!(format!(
            "Simulated: {name} provides {query} products and workflow services."
        ));
        row["Company Description Source"] = json!("Simulated");
        row["Offerings"] = json!(format!("Simulated: {words} solutions"));
        rows.push(row);
    }
    Ok(rows)
}

fn escape(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace(['\r', '\n'], "<br>")
}

pub fn screening_response(payload: &Value) -> Result<String> {
    let outputs: Vec<String> = serde_json::from_value(payload["output_columns"].clone())?;
    let scores: Vec<String> = serde_json::from_value(payload["score_columns"].clone())?;
    if outputs.is_empty() {
        return Ok("Simulated: Development question response; no research was performed.".into());
    }
    let mut columns = vec!["index".to_owned()];
    columns.extend(outputs.iter().map(|c| escape(c)));
    let mut table = format!(
        "| {} |\n| {} |",
        columns.join(" | "),
        vec!["---"; columns.len()].join(" | ")
    );
    let rows: Vec<Value> = serde_json::from_value(payload["rows"].clone())?;
    for row in rows {
        let mut cells = vec![row["index"].to_string()];
        for column in &outputs {
            let h = seed(&[
                row["pk"].as_str().unwrap_or(""),
                payload["plan_id"].as_str().unwrap_or(""),
                column,
            ]);
            cells.push(if scores.contains(column) {
                if h % 10 == 0 {
                    "CHECK".into()
                } else {
                    (h / 10 % 11).to_string()
                }
            } else {
                escape(&format!("Simulated: {column} development assessment"))
            });
        }
        table.push_str(&format!("\n| {} |", cells.join(" | ")));
    }
    Ok(table)
}

pub fn bing_results(query: &str) -> Value {
    let h = seed(&[query]);
    let leads: Vec<_> = (0..3 + h % 3).map(|i| json!({
        "title":format!("Simulated: {query} lead {}", i+1),
        "url":format!("https://example.invalid/research/{h}/{i}"),
        "snippet":format!("Simulated: Development research excerpt for {query}; requires analyst verification.")
    })).collect();
    json!({"results":leads,"answer":"Simulated: Development research leads only."})
}

/// Matches the approved immutable adapter hash, even for late responses after
/// the environment has changed. Never infer assessment origin from current env.
pub fn adapter_hash(provider: &str) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(
            &json!({"provider":provider,"endpoint":"simulated","enabled":true,"simulated":true})
        )?)
    ))
}
