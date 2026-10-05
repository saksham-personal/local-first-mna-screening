use std::{
    fs,
    path::Path,
    sync::{Mutex, OnceLock},
};

use mna_tools::{data::DataService, store::Store};
use serde_json::json;

#[test]
fn inspection_classifies_staged_headers_without_a_run_or_mutation() {
    let _guard = file_env_lock();
    let dir = tempfile::tempdir().unwrap();
    let import_dir = dir.path().join("import");
    fs::create_dir_all(&import_dir).unwrap();
    std::env::set_var("MNA_IMPORT_DIR", &import_dir);
    let data = DataService::new(Store::open(dir.path().join("data.db")).unwrap());
    fs::write(import_dir.join("arbitrary-a.csv"), "pk,PBId,Firm Name from PitchBook,Website from PitchBook,Company Profile,Investor Profile,Limited Partner Profile,Service Provider Profile\nE1-C1,PB1,Firm,firm.example,Yes,No,No,No\n").unwrap();
    create_pb_data(&import_dir.join("arbitrary-b.xlsx"));
    fs::write(
        import_dir.join("arbitrary-c.csv"),
        "Note,Analyst\nWebsite,Signal\nfirm.example,Yes\n",
    )
    .unwrap();
    fs::write(import_dir.join("unknown.csv"), "Item,Value\na,b\n").unwrap();
    fs::write(
        import_dir.join("company.csv"),
        "ECID,CID,Company Name\nE1,C1,Firm\n",
    )
    .unwrap();
    create_mixed_workbook(&import_dir.join("mixed.xlsx"));
    let result = data.execute("inspect_enrichment_files", &json!({"files":["arbitrary-b.xlsx","unknown.csv","arbitrary-a.csv","arbitrary-c.csv","company.csv"]})).unwrap();
    assert_eq!(
        result["import_files"],
        json!(["arbitrary-b.xlsx", "arbitrary-a.csv", "arbitrary-c.csv"])
    );
    assert_eq!(
        result["pending_files"],
        json!(["unknown.csv", "company.csv"])
    );
    assert_eq!(result["files"][0]["sheets"][0]["kind"], "PB_DATA");
    assert_eq!(result["files"][0]["sheets"][0]["header_row"], 3);
    assert_eq!(result["files"][2]["sheets"][0]["kind"], "PB_MAPPING");
    assert_eq!(result["files"][3]["sheets"][0]["kind"], "ROGO");
    assert_eq!(result["files"][3]["sheets"][0]["header_row"], 2);
    assert_eq!(
        result["counts"],
        json!({"mapping":1,"pitchbook":1,"rogo":1,"company":1,"unrecognized":1})
    );
    assert_eq!(result["files"][0]["roles"], json!(["PB_DATA"]));
    let mixed = data
        .execute("inspect_enrichment_files", &json!({"files":["mixed.xlsx"]}))
        .unwrap();
    assert_eq!(mixed["import_files"], json!([]));
    assert_eq!(mixed["pending_files"], json!(["mixed.xlsx"]));
    assert_eq!(mixed["files"][0]["eligible"], false);
    assert_eq!(mixed["files"][0]["sheets"][0]["kind"], "ROGO");
    assert_eq!(
        mixed["files"][0]["sheets"][1]["kind"],
        serde_json::Value::Null
    );
}

#[test]
fn identity_promotion_source_priority_and_enrichment_export() {
    let _guard = file_env_lock();
    let dir = tempfile::tempdir().unwrap();
    let import_dir = dir.path().join("import");
    let export_dir = dir.path().join("export");
    fs::create_dir_all(&import_dir).unwrap();
    fs::create_dir_all(&export_dir).unwrap();
    std::env::set_var("MNA_IMPORT_DIR", &import_dir);
    std::env::set_var("MNA_EXPORT_DIR", &export_dir);
    let store = Store::open(dir.path().join("data.db")).unwrap();
    let run=store.execute("create_run",&json!({"run_id":"R1","objective":"Qualitative fit","original_criteria":{"business":"services"}})).unwrap();
    assert_eq!(run["run_id"], "R1");
    let data = DataService::new(store.clone());
    let iscc=data.ingest_iscc_rows(Some("R1"),None,&[json!({"ECID":"#N/A","CID":"C1","Company Name":"ISCC Name","Description":"Thin ISCC description","Website":"iscc.example","HQ City":"Austin","HQ State":"TX","Relevance Score":0.62})]).unwrap();
    assert_eq!(iscc["companies"][0]["company_id"], "X-C1");
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R1","companies":["X-C1"],"discovery_source":"ISCC"}),
        )
        .unwrap();
    store.execute("save_evidence",&json!({"run_id":"R1","company_id":"X-C1","claim":"business_model","value":"services","source_type":"analyst_note","source_reference":"note-1","confidence":"medium"})).unwrap();
    fs::write(import_dir.join("mid.csv"),"ECID,CID,Company Name,Description,Website,HQ City,HQ State\nE1,C1,MID Name,More complete MID description,mid.example,Boston,MA\nE2,C2,Second Firm,Second description,second.example,Denver,CO\n").unwrap();
    let imported = data
        .execute("import_company_files", &json!({"files":["mid.csv"]}))
        .unwrap();
    assert_eq!(imported["promoted"], 1);
    assert_eq!(store.resolve_company_id("X-C1").unwrap(), "E1-C1");
    assert_eq!(store.resolve_company_id("CID:C1").unwrap(), "E1-C1");
    let company = store
        .execute("get_company", &json!({"company_id":"E1-C1"}))
        .unwrap();
    assert_eq!(company["description"], "More complete MID description");
    let set = store
        .execute("get_candidate_set", &json!({"run_id":"R1"}))
        .unwrap();
    assert_eq!(set["candidates"][0]["company_id"], "E1-C1");
    let evidence = store
        .execute("get_evidence", &json!({"run_id":"R1","company_id":"E1-C1"}))
        .unwrap();
    assert_eq!(evidence.as_array().unwrap().len(), 1);
    let summary = data
        .execute("get_discovery_summary", &json!({"run_id":"R1"}))
        .unwrap();
    assert_eq!(summary["both"], 1);
    assert_eq!(summary["total_unique"], 1);
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R1","companies":["E2-C2"],"discovery_source":"MID"}),
        )
        .unwrap();

    fs::write(import_dir.join("mapping.csv"),"pk,PBId,Firm Name from PitchBook,Website from PitchBook,Company Profile,Investor Profile,Limited Partner Profile,Service Provider Profile\nE1-C1,PB1,MID Name,pb.example,Yes,No,No,No\nE2-C2,PB2,Second Firm,second.example,No,No,No,No\n").unwrap();
    create_pb_data(&import_dir.join("pb.xlsx"));
    fs::write(import_dir.join("rogo.csv"),"Note,For analyst\nWebsite,Signal\npb.example,Service provider\nmid.example,Old website should not match\n").unwrap();
    let enriched = data
        .execute(
            "import_enrichment_files",
            &json!({"run_id":"R1","files":["pb.xlsx","rogo.csv","mapping.csv"]}),
        )
        .unwrap();
    assert_eq!(enriched["pbid_populated"], 1);
    assert_eq!(enriched["pb_hydrated"], 1);
    assert_eq!(enriched["rogo_hydrated"], 1);
    assert_eq!(enriched["rogo_unmatched"], 1);
    assert_eq!(enriched["mapping_unique_companies"], 1);
    assert_eq!(enriched["pb_unique_companies"], 1);
    assert_eq!(enriched["rogo_unique_companies"], 1);
    let repeated = data
        .execute(
            "import_enrichment_files",
            &json!({"run_id":"R1","files":["mapping.csv","rogo.csv","rogo.csv"]}),
        )
        .unwrap();
    assert_eq!(repeated["pbid_populated"], 0);
    assert_eq!(repeated["rogo_hydrated"], 2);
    assert_eq!(repeated["rogo_unique_companies"], 1);
    assert!(store.resolve_company_id("PBID:PB2").is_err());
    let ids = data
        .execute("get_company_identifiers", &json!({"company_id":"E1-C1"}))
        .unwrap();
    assert_eq!(ids["enrichment"]["pb_website"], "pb.example");
    assert_eq!(ids["enrichment"]["rogo"]["Signal"], "Service provider");
    assert!(Path::new(enriched["parquet_files"][0].as_str().unwrap()).exists());
    let parquet = parquet::file::reader::SerializedFileReader::new(
        fs::File::open(enriched["parquet_files"][0].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    use parquet::file::reader::FileReader;
    assert_eq!(
        parquet
            .metadata()
            .file_metadata()
            .schema_descr()
            .num_columns(),
        8
    );
    assert!(parquet
        .metadata()
        .file_metadata()
        .key_value_metadata()
        .unwrap()
        .iter()
        .any(|item| item.key == "original_columns"
            && item.value.as_deref().unwrap().contains("Active Investors")));

    for kind in ["PITCHBOOK", "LLM", "FULL"] {
        let result = data
            .execute(
                "export_candidate_set",
                &json!({"run_id":"R1","export_type":kind,"file_name":format!("{kind}.xlsx")}),
            )
            .unwrap();
        assert!(Path::new(result["path"].as_str().unwrap()).exists());
    }
    let mut workbook = calamine::open_workbook_auto(export_dir.join("FULL.xlsx")).unwrap();
    use calamine::Reader;
    assert_eq!(
        workbook.sheet_names(),
        &["MID".to_string(), "ISCC".to_string()]
    );
    let mid = workbook.worksheet_range("MID").unwrap();
    assert_eq!(mid.get((0, 0)).unwrap().to_string(), "pk");
    assert_eq!(mid.get((1, 0)).unwrap().to_string(), "E1-C1");
    let repeat = data.execute(
        "export_candidate_set",
        &json!({"run_id":"R1","export_type":"FULL","file_name":"FULL.xlsx"}),
    );
    assert!(matches!(repeat, Err(mna_tools::error::Error::Conflict(_))));
}

#[test]
fn enrichment_only_hydrates_candidates_in_selected_run() {
    let _guard = file_env_lock();
    let dir = tempfile::tempdir().unwrap();
    let import_dir = dir.path().join("import");
    let export_dir = dir.path().join("export");
    fs::create_dir_all(&import_dir).unwrap();
    fs::create_dir_all(&export_dir).unwrap();
    std::env::set_var("MNA_IMPORT_DIR", &import_dir);
    std::env::set_var("MNA_EXPORT_DIR", &export_dir);
    let store = Store::open(dir.path().join("data.db")).unwrap();
    for run_id in ["R1", "R2"] {
        store.execute("create_run",&json!({"run_id":run_id,"objective":"Scope","original_criteria":{"business":"services"}})).unwrap();
    }
    let data = DataService::new(store.clone());
    data.ingest_iscc_rows(
        Some("R1"),
        None,
        &[json!({"ECID":"E1","CID":"C1","Company Name":"R1 Firm","Website":"r1.example"})],
    )
    .unwrap();
    data.ingest_iscc_rows(
        Some("R2"),
        None,
        &[json!({"ECID":"E2","CID":"C2","Company Name":"R2 Firm","Website":"r2.example"})],
    )
    .unwrap();
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R1","companies":["E1-C1"],"discovery_source":"ISCC"}),
        )
        .unwrap();
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R2","companies":["E2-C2"],"discovery_source":"ISCC"}),
        )
        .unwrap();
    fs::write(import_dir.join("mapping.csv"),"pk,PBId,Firm Name from PitchBook,Website from PitchBook,Company Profile,Investor Profile,Limited Partner Profile,Service Provider Profile\nE1-C1,PB1,R1 Firm,r1.example,Yes,No,No,No\n").unwrap();
    fs::write(
        import_dir.join("rogo.csv"),
        "Website,Signal\nr1.example,R1 only\n",
    )
    .unwrap();
    let outcome = data
        .execute(
            "import_enrichment_files",
            &json!({"run_id":"R2","files":["mapping.csv","rogo.csv"]}),
        )
        .unwrap();
    assert_eq!(outcome["pbid_populated"], 0);
    assert_eq!(outcome["rogo_hydrated"], 0);
    assert!(store.resolve_company_id("PBID:PB1").is_err());
    let ids = data
        .execute("get_company_identifiers", &json!({"company_id":"E1-C1"}))
        .unwrap();
    assert!(ids["enrichment"].is_null());
}

#[test]
fn missing_identifiers_and_conflicts_quarantine() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("data.db")).unwrap();
    let data = DataService::new(store.clone());
    let result = data
        .ingest_iscc_rows(
            None,
            None,
            &[
                json!({"ECID":"-","CID":"NA","Company Name":"Drop"}),
                json!({"ECID":"E1","CID":"","Company Name":"Provisional"}),
                json!({"ECID":"E1","CID":"C1","Company Name":"Full"}),
                json!({"ECID":"E2","CID":"C1","Company Name":"Conflict"}),
                json!({"ECID":"A-B","CID":"C","Company Name":"Hyphen One"}),
                json!({"ECID":"A","CID":"B-C","Company Name":"Hyphen Collision"}),
                json!({"ECID":"X","CID":"C3","Company Name":"Reserved X"}),
            ],
        )
        .unwrap();
    assert_eq!(result["quarantined"], 4);
    assert_eq!(result["promoted"], 1);
    assert_eq!(store.resolve_company_id("E1-X").unwrap(), "E1-C1");
    assert!(store.resolve_company_id("E2-C1").is_err());
    assert!(store.resolve_company_id("ECID:A").is_err());
}

#[test]
fn iscc_rows_do_not_leak_across_runs() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("data.db")).unwrap();
    for run_id in ["R1", "R2"] {
        store.execute("create_run",&json!({"run_id":run_id,"objective":"Scope","original_criteria":{"business":"services"}})).unwrap();
    }
    let data = DataService::new(store.clone());
    data.ingest_iscc_rows(
        Some("R1"),
        None,
        &[json!({"ECID":"E1","CID":"C1","Company Name":"Firm","Description":"Services"})],
    )
    .unwrap();
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R2","companies":["E1-C1"],"discovery_source":"MANUAL"}),
        )
        .unwrap();
    let summary = data
        .execute("get_discovery_summary", &json!({"run_id":"R2"}))
        .unwrap();
    assert_eq!(summary["iscc_only"], 0);
    assert_eq!(summary["other"], 1);
}

#[test]
fn repeated_iscc_queries_keep_separate_source_lineage() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("data.db")).unwrap();
    store.execute("create_run",&json!({"run_id":"R1","objective":"Find services","original_criteria":{"business":"services"}})).unwrap();
    let data = DataService::new(store.clone());
    let row = json!({"ECID":"E1","CID":"C1","Company Name":"Firm","Description":"Services","Relevance Score":0.5});
    let mut ids = Vec::new();
    for query in ["software services", "managed services"] {
        let history = store
            .record_search(
                Some("R1"),
                "ISCC",
                query,
                &json!({"limit":100}),
                &json!({"count":1}),
            )
            .unwrap();
        let query_id = history["query_id"].as_str().unwrap().to_owned();
        data.ingest_iscc_rows(Some("R1"), Some(&query_id), std::slice::from_ref(&row))
            .unwrap();
        ids.push(query_id);
    }
    let rows = data
        .execute(
            "get_source_rows",
            &json!({"company_id":"E1-C1","source":"ISCC"}),
        )
        .unwrap();
    let values = rows["rows"].as_array().unwrap();
    assert_eq!(values.len(), 2);
    assert!(values.iter().any(|record| record["query_id"] == ids[0]));
    assert!(values.iter().any(|record| record["query_id"] == ids[1]));
}

fn create_pb_data(path: &Path) {
    use rust_xlsxwriter::Workbook;
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet
        .write_string(0, 0, "© PitchBook Data, Inc. 2026")
        .unwrap();
    let headers = [
        "Company ID",
        "Companies",
        "Website",
        "LinkedIn URL",
        "Description",
        "HQ Location",
        "Active Investors",
        "Universe",
    ];
    for (col, value) in headers.iter().enumerate() {
        sheet.write_string(2, col as u16, *value).unwrap();
    }
    let row = [
        "PB1",
        "PB Firm",
        "pb.example",
        "https://linkedin.example/pb",
        "PB description",
        "Boston, MA",
        "Fund A",
        "Market A",
    ];
    for (col, value) in row.iter().enumerate() {
        sheet.write_string(3, col as u16, *value).unwrap();
    }
    workbook.save(path).unwrap();
}

fn create_mixed_workbook(path: &Path) {
    use rust_xlsxwriter::Workbook;
    let mut workbook = Workbook::new();
    let rogo = workbook.add_worksheet();
    rogo.set_name("ROGO").unwrap();
    rogo.write_string(0, 0, "Website").unwrap();
    rogo.write_string(0, 1, "Signal").unwrap();
    rogo.write_string(1, 0, "firm.example").unwrap();
    let unknown = workbook.add_worksheet();
    unknown.set_name("Notes").unwrap();
    unknown.write_string(0, 0, "Item").unwrap();
    unknown.write_string(0, 1, "Value").unwrap();
    unknown.write_string(1, 0, "a").unwrap();
    workbook.save(path).unwrap();
}

fn file_env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}
