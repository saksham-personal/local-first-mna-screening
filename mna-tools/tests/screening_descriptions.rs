use mna_tools::{execution::ExecutionService, projection, Store};
use serde_json::{json, Value};

fn description(mid: Value, iscc: Value) -> String {
    let (lines, _) = projection::description_lines(&json!({}), &mid, &iscc, &Default::default());
    projection::join_descriptions(&lines)
}

#[test]
fn descriptions_join_both_sources_in_order_and_skip_blanks() {
    assert_eq!(
        description(json!({"Description":" Claims software ","Business Description":"Policy tools","Company Description":"-"}),
            json!({"Company Description":"Carrier workflows","Pitchbook Description":" ","Factset Description":"Recurring products","Offerings":"-","NAICS Description":"Software"})),
        "MID Description: Claims software; Policy tools\nISCC Description: Carrier workflows; Recurring products; Software"
    );
}

#[test]
fn identical_trimmed_case_insensitive_descriptions_are_sent_once() {
    assert_eq!(
        description(
            json!({"Description":" Claims Software "}),
            json!({"Company Description":" claims software "})
        ),
        "MID Description: Claims Software"
    );
}

#[test]
fn single_source_descriptions_keep_their_labels() {
    assert_eq!(
        description(json!({"Description":"MID only"}), json!({})),
        "MID Description: MID only"
    );
    assert_eq!(
        description(
            json!({}),
            json!({"Company Description":"ISCC only","Offerings":"APIs"})
        ),
        "ISCC Description: ISCC only; APIs"
    );
}

#[test]
fn active_bundle_description_columns_are_frozen_before_stable_digest() {
    let store = Store::open(":memory:").unwrap();
    store
        .execute(
            "ingest_companies",
            &json!({"companies":[{"company_id":"X-1","name":"Fixture","description":"Canonical"}]}),
        )
        .unwrap();
    store.execute("create_run", &json!({"run_id":"R","objective":"Claims software","original_criteria":{},"initial_profile":{"core_business_query":"claims software"}})).unwrap();
    store
        .execute(
            "approve_screening_profile",
            &json!({"run_id":"R","version":1,"approved_by":"Analyst"}),
        )
        .unwrap();
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R","companies":["X-1"],"discovery_source":"MID"}),
        )
        .unwrap();
    store.with_connection(|conn| {
        let mut config: Value = serde_json::from_str(include_str!("../config/mid-index.json")).unwrap();
        config["description_columns"] = json!(["Custom A", "Custom B", "Custom Empty"]);
        conn.execute("INSERT INTO mid_bundles(bundle_id,fts_id,name,status,source_file,config_json,config_hash,created_at) VALUES('B',1,'Fixture','active','fixture.xlsx',?,'hash','now')", [config.to_string()])?;
        for (source, row) in [("MID", json!({"Custom A":"MID A","Custom B":"MID B","Custom Empty":"-","Description":"Ignored"})), ("ISCC", json!({"Company Description":"ISCC A","Offerings":"ISCC B"}))] {
            conn.execute("INSERT INTO source_rows(source_row_id,source,run_scope,query_scope,company_id,row_hash,row_json,imported_at) VALUES(?,?,'R','','X-1',?,?,'now')", rusqlite::params![source, source, source, row.to_string()])?;
        }
        Ok(())
    }).unwrap();
    let service = ExecutionService::new(store);
    let args = json!({"run_id":"R","provider":"llm_suite","mode":"screening","deployment":"fixture","prompt":"Screen","input_columns":["index","Description"],"output_columns":["Fit"],"batch_size":25});
    let first = service.execute("propose_prepared_plan", &args).unwrap();
    let second = service.execute("propose_prepared_plan", &args).unwrap();
    assert_eq!(
        first["snapshot"]["rows"][0]["Description"],
        "MID Description: MID A; MID B\nISCC Description: ISCC A; ISCC B"
    );
    assert_eq!(first["digest"], second["digest"]);
    assert_eq!(
        first["snapshot"]["input_hash"],
        second["snapshot"]["input_hash"]
    );
    assert_eq!(first["executed"], false);
}
