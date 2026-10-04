use std::{
    fs,
    sync::{Mutex, OnceLock},
};

use mna_tools::{data::DataService, error::Error, store::Store};
use serde_json::json;

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

fn create_run(store: &Store, id: &str) {
    store
        .execute(
            "create_run",
            &json!({"run_id":id,"objective":"Scope","original_criteria":{"business":"services"}}),
        )
        .unwrap();
}

#[test]
fn pages_keep_sources_scoped_and_fall_back_to_older_nonblank_values() {
    let _guard = env_lock();
    let temp = tempfile::tempdir().unwrap();
    let import = temp.path().join("import");
    let export = temp.path().join("export");
    fs::create_dir_all(&import).unwrap();
    fs::create_dir_all(&export).unwrap();
    std::env::set_var("MNA_IMPORT_DIR", &import);
    std::env::set_var("MNA_EXPORT_DIR", &export);
    let store = Store::open(temp.path().join("data.db")).unwrap();
    create_run(&store, "R1");
    create_run(&store, "R2");
    let data = DataService::new(store.clone());
    fs::write(import.join("mid.csv"), "ECID,CID,Company Name,Description,Legacy MID Field\nE1,C1,MID Firm,Mid description,MID only\nE2,C2,Second Firm,Second description,Second MID\n").unwrap();
    data.execute("import_company_files", &json!({"files":["mid.csv"]}))
        .unwrap();
    data.ingest_iscc_rows(Some("R1"), None, &[json!({"ECID":"E1","CID":"C1","Company Name":"ISCC Firm","Description":"Older detail","Signal":"Strong"})]).unwrap();
    data.ingest_iscc_rows(Some("R1"), None, &[json!({"ECID":"E1","CID":"C1","Company Name":"ISCC Firm","Description":"#N/A","Signal":"Recent","Reported Count":"0","Blank Field":"#N/A"})]).unwrap();
    data.ingest_iscc_rows(Some("R2"), None, &[json!({"ECID":"E1","CID":"C1","Company Name":"ISCC Firm","Description":"Other run secret"})]).unwrap();
    for run in ["R1", "R2"] {
        store
            .execute(
                "add_candidates",
                &json!({"run_id":run,"companies":["E1-C1","E2-C2"],"discovery_source":"MANUAL"}),
            )
            .unwrap();
    }
    let first = data
        .execute(
            "get_candidate_source_data",
            &json!({"run_id":"R1","limit":1}),
        )
        .unwrap();
    assert_eq!(first["total"], 2);
    assert_eq!(first["rows"][0]["pk"], "E1-C1");
    assert_eq!(
        first["rows"][0]["sources"]["MID"]["Legacy MID Field"],
        "MID only"
    );
    assert_eq!(
        first["rows"][0]["sources"]["ISCC"]["Description"],
        "Older detail"
    );
    assert_eq!(first["rows"][0]["sources"]["ISCC"]["Signal"], "Recent");
    assert_eq!(first["rows"][0]["sources"]["ISCC"]["Reported Count"], "0");
    assert!(first["rows"][0]["sources"]["ISCC"]
        .as_object()
        .unwrap()
        .contains_key("Blank Field"));
    assert!(first["rows"][0]["sources"]["ISCC"]["Blank Field"].is_null());
    assert_eq!(first["next_cursor"], "E1-C1");
    assert_eq!(first["rows"][0]["sources"]["PB"], json!({}));
    assert_eq!(first["rows"][0]["sources"]["ROGO"], json!({}));
    let second = data
        .execute(
            "get_candidate_source_data",
            &json!({"run_id":"R1","after_company_id":"E1-C1","limit":1}),
        )
        .unwrap();
    assert_eq!(second["rows"][0]["pk"], "E2-C2");
    assert_eq!(second["rows"][0]["sources"]["ISCC"], json!({}));
    assert!(second["next_cursor"].is_null());
    let other = data
        .execute(
            "get_candidate_source_data",
            &json!({"run_id":"R2","limit":1}),
        )
        .unwrap();
    assert_eq!(
        other["rows"][0]["sources"]["ISCC"]["Description"],
        "Other run secret"
    );
    assert!(matches!(
        data.execute(
            "get_candidate_source_data",
            &json!({"run_id":"R1","limit":101})
        ),
        Err(Error::Validation(_))
    ));
    assert!(matches!(
        data.execute(
            "get_candidate_source_data",
            &json!({"run_id":"R1","after_company_id":"missing"})
        ),
        Err(Error::Validation(_))
    ));
    data.ingest_iscc_rows(Some("R1"), None, &[json!({"ECID":"E1","CID":"C1","Company Name":"ISCC Firm","Very Wide Field":"x".repeat(2_100_000)})]).unwrap();
    assert!(
        matches!(data.execute("get_candidate_source_data", &json!({"run_id":"R1","limit":1})), Err(Error::Validation(message)) if message.contains("2 MB"))
    );
}

#[test]
fn pitchbook_wide_columns_and_rogo_are_returned_from_source_storage() {
    let _guard = env_lock();
    let temp = tempfile::tempdir().unwrap();
    let import = temp.path().join("import");
    let export = temp.path().join("export");
    fs::create_dir_all(&import).unwrap();
    fs::create_dir_all(&export).unwrap();
    std::env::set_var("MNA_IMPORT_DIR", &import);
    std::env::set_var("MNA_EXPORT_DIR", &export);
    let store = Store::open(temp.path().join("data.db")).unwrap();
    create_run(&store, "R1");
    let data = DataService::new(store.clone());
    fs::write(
        import.join("mid.csv"),
        "ECID,CID,Company Name,Website\nE1,C1,Firm,firm.example\n",
    )
    .unwrap();
    data.execute("import_company_files", &json!({"files":["mid.csv"]}))
        .unwrap();
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R1","companies":["E1-C1"],"discovery_source":"MID"}),
        )
        .unwrap();
    fs::write(import.join("mapping.csv"), "pk,PBId,Firm Name from PitchBook,Website from PitchBook,Company Profile,Investor Profile,Limited Partner Profile,Service Provider Profile\nE1-C1,PB1,Firm,pb.example,Yes,No,No,No\n").unwrap();
    let mut workbook = rust_xlsxwriter::Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet
        .write_string(0, 0, "© PitchBook Data, Inc. 2026")
        .unwrap();
    for (index, heading) in [
        "Company ID",
        "Companies",
        "Website",
        "Description",
        "LinkedIn URL",
        "HQ Location",
        "Active Investors",
        "Universe",
        "Wide Analyst Field",
        "Blank Wide Field",
    ]
    .iter()
    .enumerate()
    {
        sheet.write_string(2, index as u16, *heading).unwrap();
    }
    for (index, value) in [
        "PB1",
        "PB Firm",
        "pb.example",
        "PB description",
        "linkedin.example",
        "Boston",
        "Investor",
        "Universe",
        "Wide value",
    ]
    .iter()
    .enumerate()
    {
        sheet.write_string(3, index as u16, *value).unwrap();
    }
    workbook.save(import.join("pb.xlsx")).unwrap();
    fs::write(
        import.join("rogo.csv"),
        "Website,Signal\npb.example,Service provider\n",
    )
    .unwrap();
    data.execute(
        "import_enrichment_files",
        &json!({"run_id":"R1","files":["mapping.csv","pb.xlsx","rogo.csv"]}),
    )
    .unwrap();
    let result = data
        .execute("get_candidate_source_data", &json!({"run_id":"R1"}))
        .unwrap();
    let row = &result["rows"][0];
    assert_eq!(row["PBId"], "PB1");
    assert_eq!(row["sources"]["PB"]["PB_Name"], "PB Firm");
    assert_eq!(row["sources"]["PB"]["Wide Analyst Field"], "Wide value");
    assert_eq!(row["sources"]["PB"]["Blank Wide Field"], "");
    assert_eq!(row["sources"]["ROGO"]["Signal"], "Service provider");
    assert_eq!(row["provenance"]["PB"].as_array().unwrap().len(), 1);
    assert_eq!(row["provenance"]["MID"].as_array().unwrap().len(), 1);
    let parquet = row["provenance"]["PB"][0]["parquet_path"].as_str().unwrap();
    fs::remove_file(parquet).unwrap();
    assert!(data
        .execute("get_candidate_source_data", &json!({"run_id":"R1"}))
        .is_err());
}
