use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    sync::{Mutex, OnceLock},
};

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use mna_tools::{
    data::DataService,
    error::Error,
    projection,
    runtime::administrator_definitions,
    {router, Runtime, Store},
};
use serde_json::{json, Value};
use tower::ServiceExt;

const MAPPING_HEADER: &str = "pk,PBId,Firm Name from PitchBook,Website from PitchBook,Company Profile,Investor Profile,Limited Partner Profile,Service Provider Profile\n";
const PB_COLUMNS: [&str; 8] = [
    "Company ID",
    "Companies",
    "Website",
    "LinkedIn URL",
    "Description",
    "HQ Location",
    "Active Investors",
    "Universe",
];

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Fixture {
    _dir: tempfile::TempDir,
    import: std::path::PathBuf,
    store: Store,
    data: DataService,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let import = dir.path().join("import");
    let export = dir.path().join("export");
    fs::create_dir_all(&import).unwrap();
    fs::create_dir_all(&export).unwrap();
    std::env::set_var("MNA_IMPORT_DIR", &import);
    std::env::set_var("MNA_EXPORT_DIR", &export);
    let store = Store::open(dir.path().join("data.db")).unwrap();
    let data = DataService::new(store.clone());
    Fixture {
        _dir: dir,
        import,
        store,
        data,
    }
}

impl Fixture {
    fn run(&self, run_id: &str, companies: &[(&str, &str, &str)]) {
        self.store
            .execute(
                "create_run",
                &json!({"run_id":run_id,"objective":"Screen","original_criteria":{}}),
            )
            .unwrap();
        let rows: Vec<Value> = companies
            .iter()
            .map(|(id, name, website)| json!({"company_id":id,"name":name,"website":website}))
            .collect();
        self.store
            .execute("ingest_companies", &json!({"companies":rows}))
            .unwrap();
        let ids: Vec<&str> = companies.iter().map(|(id, _, _)| *id).collect();
        self.store
            .execute(
                "add_candidates",
                &json!({"run_id":run_id,"companies":ids,"discovery_source":"MID"}),
            )
            .unwrap();
    }

    fn write(&self, name: &str, text: &str) {
        fs::write(self.import.join(name), text).unwrap();
    }

    fn import(&self, args: Value) -> Result<Value, Error> {
        self.data.execute("import_enrichment_files", &args)
    }

    fn context(&self, run_id: &str) -> Value {
        self.store
            .execute(
                "get_shortlist_context",
                &json!({"run_id":run_id,"include_hidden":true}),
            )
            .unwrap()
    }

    fn count(&self, sql: &str) -> i64 {
        self.store
            .with_connection(|conn| Ok(conn.query_row(sql, [], |r| r.get::<_, i64>(0))?))
            .unwrap()
    }
}

fn write_pb_workbook(path: &Path, rows: &[[&str; 8]]) {
    let mut workbook = rust_xlsxwriter::Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet
        .write_string(0, 0, "© PitchBook Data, Inc. 2026")
        .unwrap();
    for (column, heading) in PB_COLUMNS.iter().enumerate() {
        sheet.write_string(2, column as u16, *heading).unwrap();
    }
    for (index, row) in rows.iter().enumerate() {
        for (column, value) in row.iter().enumerate() {
            if !value.is_empty() {
                sheet
                    .write_string((3 + index) as u32, column as u16, *value)
                    .unwrap();
            }
        }
    }
    workbook.save(path).unwrap();
}

fn ids(list: &Value) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["company_id"].as_str().unwrap().to_owned())
        .collect()
}

fn reasons(report: &Value) -> BTreeMap<String, String> {
    report["not_matched"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["company_id"].as_str().unwrap().to_owned(),
                entry["reason"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn seed_report_scenario(fx: &Fixture) -> Value {
    fx.run("R2", &[("H", "Eta Holdings", "holdings.example")]);
    fx.write(
        "other.csv",
        &format!("{MAPPING_HEADER}H,PB9,Eta Holdings,holdings.example,Yes,No,No,No\n"),
    );
    fx.import(json!({"run_id":"R2","files":["other.csv"]}))
        .unwrap();
    fx.run(
        "R",
        &[
            ("A", "Alpha", "alpha.example"),
            ("B", "Beta", "beta.example"),
            ("C", "Gamma", "gamma.example"),
            ("D", "Delta", "delta.example"),
            ("E", "Epsilon", "eps.example"),
            ("F", "Zeta", "zeta.example"),
            ("G", "Eta", "eta.example"),
        ],
    );
    // G is hidden by the analyst before the import.
    fx.store
        .execute(
            "review_shortlist",
            &json!({"run_id":"R","keep_company_ids":["A","B","C","D","E","F"]}),
        )
        .unwrap();
    fx.write(
        "mapping.csv",
        &format!(
            "{MAPPING_HEADER}A,PB1,Alpha,alpha.example,Yes,No,No,No\nB,PB2,Beta,beta.example,No,No,No,No\nC,,Gamma,gamma.example,Yes,No,No,No\nE,PB5,Eps,eps.example,Yes,No,No,No\nF,PB9,Zeta,zeta.example,Yes,No,No,No\nG,PB7,Eta,eta.example,Yes,No,No,No\nZZZ,PB8,Nobody,nobody.example,Yes,No,No,No\n"
        ),
    );
    write_pb_workbook(
        &fx.import.join("pb.xlsx"),
        &[
            [
                "PB1",
                "Alpha PB",
                "alpha.example",
                "",
                "Alpha description",
                "Boston",
                "Fund A",
                "Market A",
            ],
            [
                "PB7",
                "Eta PB",
                "eta.example",
                "",
                "Eta description",
                "Denver",
                "",
                "",
            ],
        ],
    );
    fx.import(json!({
        "run_id":"R",
        "files":["mapping.csv","pb.xlsx"],
        "purpose_hint":"pitchbook",
        "display_names":{"mapping.csv":"Original Mapping.csv","pb.xlsx":"PB Export.xlsx"}
    }))
    .unwrap()
}

#[test]
fn import_saves_a_match_report_with_reasons_and_never_changes_flags() {
    let _guard = env_lock();
    let fx = fixture();
    let imported = seed_report_scenario(&fx);

    // Flags are exactly what the analyst left: only G is hidden, as "manual".
    assert_eq!(imported["considered_count"], 6);
    assert_eq!(imported["hidden_count"], 1);
    assert_eq!(imported["selection_revision"], 1);
    let context = fx.context("R");
    let candidates = context["candidates"].as_array().unwrap();
    assert_eq!(candidates.len(), 7);
    for candidate in candidates {
        if candidate["company_id"] == "G" {
            assert_eq!(candidate["considered"], false);
            assert_eq!(candidate["consideration_reason"], "manual");
        } else {
            assert_eq!(candidate["considered"], true);
        }
    }
    assert_eq!(context["selection_revision"], 1);

    // Counts describe this import: A, E and G got a PBID; B is a non-company row; C has no
    // PBId; F collides with H's PB9; ZZZ resolves to nothing.
    assert_eq!(imported["pbid_populated"], 3);
    assert_eq!(imported["mapping_skipped_non_company"], 1);
    assert_eq!(imported["pb_hydrated"], 2);
    assert_eq!(imported["pb_unmatched"], 0);
    assert_eq!(imported["quarantined"], 3);
    assert_eq!(imported["purpose"], "pitchbook");

    let report = &imported["reports"][0];
    assert_eq!(imported["report_id"], report["report_id"]);
    assert_eq!(report["purpose"], "pitchbook");
    assert_eq!(ids(&report["matched"]), ["A", "G"]);
    let alpha = &report["matched"][0];
    assert_eq!(alpha["pbid"], "PB1");
    assert_eq!(alpha["pb_name"], "Alpha PB");
    assert_eq!(alpha["name"], "Alpha");
    let fields = alpha["fields_hydrated"].as_array().unwrap();
    for field in ["PB_Name", "PB_Website", "PB_Description", "PB_HQ Location"] {
        assert!(fields.contains(&json!(field)), "{field}");
    }
    assert!(!fields.contains(&json!("PB_LinkedIn URL")));
    // Hidden companies are reported too, with their state.
    assert_eq!(report["matched"][1]["considered"], false);
    assert_eq!(
        reasons(report),
        BTreeMap::from([
            ("B".to_owned(), "profile_not_company".to_owned()),
            ("C".to_owned(), "blank_pbid".to_owned()),
            ("D".to_owned(), "not_in_mapping".to_owned()),
            ("E".to_owned(), "no_data_row".to_owned()),
            ("F".to_owned(), "conflict".to_owned()),
        ])
    );
    let summary = &report["summary"];
    assert_eq!(summary["candidates_total"], 7);
    assert_eq!(summary["matched_count"], 2);
    assert_eq!(summary["not_matched_count"], 5);
    assert_eq!(summary["matched_considered"], 1);
    assert_eq!(summary["not_matched_considered"], 5);
    for reason in [
        "not_in_mapping",
        "profile_not_company",
        "blank_pbid",
        "no_data_row",
        "conflict",
    ] {
        assert_eq!(summary["not_matched_reasons"][reason], 1, "{reason}");
    }
    assert_eq!(report["files"][0]["display_name"], "Original Mapping.csv");

    // The saved report can be read back, by id or as the latest of the run.
    let latest = fx
        .data
        .execute("get_enrichment_report", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(&latest, report);
    let by_id = fx
        .data
        .execute(
            "get_enrichment_report",
            &json!({"run_id":"R","report_id":report["report_id"]}),
        )
        .unwrap();
    assert_eq!(&by_id, report);
    assert!(matches!(
        fx.data.execute(
            "get_enrichment_report",
            &json!({"run_id":"R","purpose":"rogo"})
        ),
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        fx.data.execute(
            "get_enrichment_report",
            &json!({"run_id":"R2","report_id":report["report_id"]})
        ),
        Err(Error::NotFound(_))
    ));

    // Re-importing the same files saves a fresh, equally accurate (not cumulative) report,
    // adds no quarantine rows and no review row.
    assert_eq!(
        fx.count("SELECT COUNT(*) FROM identity_quarantine WHERE source='PB_MAPPING'"),
        3
    );
    let again = fx
        .import(json!({"run_id":"R","files":["mapping.csv","pb.xlsx"]}))
        .unwrap();
    assert_eq!(again["pbid_populated"], 0);
    assert_eq!(again["selection_revision"], 1);
    assert_ne!(again["report_id"], imported["report_id"]);
    assert_eq!(ids(&again["reports"][0]["matched"]), ["A", "G"]);
    assert_eq!(reasons(&again["reports"][0]), reasons(report));
    assert_eq!(
        fx.count("SELECT COUNT(*) FROM identity_quarantine WHERE source='PB_MAPPING'"),
        3
    );
    assert_eq!(fx.count("SELECT COUNT(*) FROM shortlist_reviews"), 1);
}

#[test]
fn a_new_pbid_replaces_the_old_one_and_never_steals_another_companys() {
    let _guard = env_lock();
    let fx = fixture();
    fx.run(
        "R",
        &[
            ("A", "Alpha", "alpha.example"),
            ("B", "Beta", "beta.example"),
        ],
    );
    fx.write(
        "map1.csv",
        &format!("{MAPPING_HEADER}A,PB1,Alpha,alpha.example,Yes,No,No,No\n"),
    );
    write_pb_workbook(
        &fx.import.join("pb1.xlsx"),
        &[[
            "PB1",
            "Old Name",
            "old.example",
            "",
            "Old description",
            "Boston",
            "",
            "",
        ]],
    );
    fx.import(json!({"run_id":"R","files":["map1.csv","pb1.xlsx"]}))
        .unwrap();
    let identifiers = |company: &str| {
        let value = fx
            .data
            .execute("get_company_identifiers", &json!({"company_id":company}))
            .unwrap();
        let pbids: Vec<String> = value["identifiers"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["kind"] == "PBID")
            .map(|entry| entry["identifier"].as_str().unwrap().to_owned())
            .collect();
        (pbids, value["enrichment"].clone())
    };
    let (pbids, enrichment) = identifiers("A");
    assert_eq!(pbids, ["PB1"]);
    assert_eq!(enrichment["pb_name"], "Old Name");

    // A corrected mapping replaces the PBID; data of the old PBID stops describing A.
    fx.write(
        "map2.csv",
        &format!("{MAPPING_HEADER}A,PB2,Alpha,alpha.example,Yes,No,No,No\n"),
    );
    let replaced = fx
        .import(json!({"run_id":"R","files":["map2.csv"]}))
        .unwrap();
    assert_eq!(replaced["pbid_populated"], 1);
    let (pbids, enrichment) = identifiers("A");
    assert_eq!(pbids, ["PB2"]);
    assert!(enrichment["pb_name"].is_null());
    assert!(store_resolve_fails(&fx, "PBID:PB1"));
    let current = fx
        .data
        .execute("get_candidate_source_data", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(current["rows"][0]["PBId"], "PB2");
    assert_eq!(current["rows"][0]["provenance"]["PB"], json!([]));

    // The old PBID's data no longer hydrates A; the new PBID's data does.
    let stale = fx
        .import(json!({"run_id":"R","files":["pb1.xlsx"]}))
        .unwrap();
    assert_eq!(stale["pb_hydrated"], 0);
    assert_eq!(stale["pb_unmatched"], 1);
    write_pb_workbook(
        &fx.import.join("pb2.xlsx"),
        &[[
            "PB2",
            "New Name",
            "new.example",
            "",
            "New description",
            "Austin",
            "",
            "",
        ]],
    );
    fx.import(json!({"run_id":"R","files":["pb2.xlsx"]}))
        .unwrap();
    let (_, enrichment) = identifiers("A");
    assert_eq!(enrichment["pb_name"], "New Name");
    assert_eq!(enrichment["pb_website"], "new.example");

    // Newest wins as a whole record: a later PB2 export without a website clears it instead
    // of keeping the older value.
    write_pb_workbook(
        &fx.import.join("pb2b.xlsx"),
        &[[
            "PB2",
            "Newest Name",
            "",
            "",
            "Newest description",
            "",
            "",
            "",
        ]],
    );
    fx.import(json!({"run_id":"R","files":["pb2b.xlsx"]}))
        .unwrap();
    let (_, enrichment) = identifiers("A");
    assert_eq!(enrichment["pb_name"], "Newest Name");
    assert!(enrichment["pb_website"].is_null());
    assert!(enrichment["pb_hq_location"].is_null());

    // B asks for PB2, which belongs to A: a conflict, nothing is reassigned.
    fx.write(
        "map3.csv",
        &format!("{MAPPING_HEADER}B,PB2,Beta,beta.example,Yes,No,No,No\n"),
    );
    let conflict = fx
        .import(json!({"run_id":"R","files":["map3.csv"]}))
        .unwrap();
    assert_eq!(conflict["pbid_populated"], 0);
    assert_eq!(conflict["quarantined"], 1);
    assert_eq!(identifiers("A").0, ["PB2"]);
    assert!(identifiers("B").0.is_empty());
    assert_eq!(reasons(&conflict["reports"][0])["B"], "conflict");

    // Repeating the same mapping changes nothing.
    let repeated = fx
        .import(json!({"run_id":"R","files":["map2.csv"]}))
        .unwrap();
    assert_eq!(repeated["pbid_populated"], 0);
}

fn store_resolve_fails(fx: &Fixture, identifier: &str) -> bool {
    fx.store.resolve_company_id(identifier).is_err()
}

#[test]
fn identical_reimports_leave_plan_hashes_and_review_history_untouched() {
    let _guard = env_lock();
    let fx = fixture();
    fx.write(
        "mid.csv",
        "ECID,CID,Company Name,Description,Website,HQ City,HQ State\nE1,C1,Alpha,Claims software,alpha.example,Boston,MA\nE2,C2,Beta,Benefits software,beta.example,Denver,CO\n",
    );
    fx.data
        .execute("import_company_files", &json!({"files":["mid.csv"]}))
        .unwrap();
    fx.store
        .execute(
            "create_run",
            &json!({"run_id":"R","objective":"Screen","original_criteria":{}}),
        )
        .unwrap();
    fx.store
        .execute(
            "add_candidates",
            &json!({"run_id":"R","companies":["E1-C1","E2-C2"],"discovery_source":"MID"}),
        )
        .unwrap();
    let hashes = |fx: &Fixture| {
        let projected = projection::execute(
            &fx.store,
            "get_run_source_projection",
            &json!({"run_id":"R"}),
        )
        .unwrap();
        let context = fx
            .store
            .execute("get_shortlist_context", &json!({"run_id":"R"}))
            .unwrap();
        (
            projected["data_hash"].clone(),
            projected["candidate_hash"].clone(),
            context["source_hash"].clone(),
            context["selection_revision"].clone(),
        )
    };
    let before = hashes(&fx);
    // Re-importing the same MID file changes no canonical value, so nothing is touched.
    fx.data
        .execute("import_company_files", &json!({"files":["mid.csv"]}))
        .unwrap();
    assert_eq!(before, hashes(&fx));

    fx.write(
        "mapping.csv",
        &format!("{MAPPING_HEADER}E1-C1,PB1,Alpha,alpha.example,Yes,No,No,No\n"),
    );
    write_pb_workbook(
        &fx.import.join("pb.xlsx"),
        &[[
            "PB1",
            "Alpha PB",
            "alpha.example",
            "",
            "Alpha description",
            "Boston",
            "Fund",
            "Market",
        ]],
    );
    fx.write("rogo.csv", "Website,Signal\nalpha.example,Strong\n");
    let files = json!({"run_id":"R","files":["mapping.csv","pb.xlsx","rogo.csv"]});
    fx.import(files.clone()).unwrap();
    let enriched = hashes(&fx);
    // Enrichment is source data, so a real import legitimately changes the data hash, but it
    // never moves the candidate hash or adds a review row.
    assert_ne!(before.0, enriched.0);
    assert_eq!(before.1, enriched.1);
    assert_eq!(before.3, enriched.3);
    fx.import(files).unwrap();
    assert_eq!(enriched, hashes(&fx));
    assert_eq!(fx.count("SELECT COUNT(*) FROM shortlist_reviews"), 0);
}

#[test]
fn rogo_ambiguity_needs_two_distinct_considered_companies() {
    let _guard = env_lock();
    let fx = fixture();
    fx.run(
        "R",
        &[
            ("P", "Primary", "shared.example"),
            ("Q", "Hidden twin", "www.shared.example/home"),
            ("S", "Seven", "dup.example"),
            ("T", "Tango", "dup.example"),
            ("V", "Victor", "alias.example"),
            ("W", "Whiskey", "hiddenonly.example"),
        ],
    );
    fx.store
        .execute(
            "review_shortlist",
            &json!({"run_id":"R","keep_company_ids":["P","S","T","V"]}),
        )
        .unwrap();
    fx.write(
        "rogo.csv",
        "Website,Signal\nshared.example,Strong\ndup.example,Weak\nnowhere.example,None\nhiddenonly.example,Quiet\n",
    );
    let imported = fx
        .import(json!({"run_id":"R","files":["rogo.csv"],"purpose_hint":"rogo"}))
        .unwrap();
    assert_eq!(imported["purpose"], "rogo");
    assert_eq!(imported["rogo_hydrated"], 2);
    assert_eq!(imported["rogo_unmatched"], 1);
    assert_eq!(imported["quarantined"], 1);
    assert_eq!(imported["considered_count"], 4);
    let report = &imported["reports"][0];
    assert_eq!(report["purpose"], "rogo");
    // The hidden twin does not make "shared.example" ambiguous; a hidden-only match is still
    // hydrated because enrichment is company-global.
    assert_eq!(ids(&report["matched"]), ["P", "W"]);
    assert_eq!(report["unmatched_rows"]["count"], 1);
    assert_eq!(
        report["unmatched_rows"]["sample"][0]["website"],
        "nowhere.example"
    );
    assert_eq!(report["ambiguous"].as_array().unwrap().len(), 1);
    assert_eq!(report["ambiguous"][0]["host"], "dup.example");
    assert_eq!(report["ambiguous"][0]["company_ids"], json!(["S", "T"]));
    let rogo = |company: &str| {
        fx.data
            .execute("get_company_identifiers", &json!({"company_id":company}))
            .unwrap()["enrichment"]
            .clone()
    };
    assert_eq!(rogo("P")["rogo"]["Signal"], "Strong");
    assert!(rogo("Q").is_null());
    assert_eq!(rogo("W")["rogo"]["Signal"], "Quiet");

    // Website aliases are accepted and the key column is not stored as data.
    fx.write("domains.csv", "Domain,Signal\nalias.example,Via domain\n");
    let aliased = fx
        .import(json!({"run_id":"R","files":["domains.csv"]}))
        .unwrap();
    assert_eq!(aliased["rogo_hydrated"], 1);
    let victor = rogo("V");
    assert_eq!(victor["rogo"]["Signal"], "Via domain");
    assert!(victor["rogo"].get("Domain").is_none());

    // A ROGO sheet with a stray CID column is still ROGO, not a MID company file.
    fx.write("stray.csv", "Website,Signal,CID\nalias.example,Extra,99\n");
    let stray = fx
        .import(json!({"run_id":"R","files":["stray.csv"]}))
        .unwrap();
    assert_eq!(stray["purpose"], "rogo");
    assert_eq!(stray["rogo_hydrated"], 1);
}

#[test]
fn tolerant_headers_per_sheet_errors_and_zone_hints() {
    let _guard = env_lock();
    let fx = fixture();
    fx.run("R", &[("A", "Alpha", "alpha.example")]);

    // Mapping header below a banner, aliases, and only the three required columns.
    fx.write(
        "banner.csv",
        "Exported from PitchBook,,\nNotes,,\npk,PitchBook ID,Profile\nA,PB1,Yes\n",
    );
    let mapped = fx
        .import(json!({"run_id":"R","files":["banner.csv"],"purpose_hint":"pitchbook"}))
        .unwrap();
    assert_eq!(mapped["pbid_populated"], 1);
    assert_eq!(mapped["files"][0]["sheets"][0]["kind"], "PB_MAPPING");
    assert_eq!(mapped["files"][0]["sheets"][0]["status"], "imported");

    // One good sheet and one junk sheet in the same workbook: the good one is imported.
    let mut workbook = rust_xlsxwriter::Workbook::new();
    let data = workbook.add_worksheet();
    data.set_name("Data").unwrap();
    for (column, heading) in PB_COLUMNS.iter().enumerate() {
        data.write_string(0, column as u16, *heading).unwrap();
    }
    for (column, value) in [
        "PB1",
        "PB Firm",
        "pb.example",
        "",
        "PB text",
        "Boston",
        "",
        "",
    ]
    .iter()
    .enumerate()
    {
        if !value.is_empty() {
            data.write_string(1, column as u16, *value).unwrap();
        }
    }
    let junk = workbook.add_worksheet();
    junk.set_name("Junk").unwrap();
    junk.write_string(0, 0, "Item").unwrap();
    junk.write_string(0, 1, "Value").unwrap();
    junk.write_string(1, 0, "a").unwrap();
    workbook.save(fx.import.join("mixed.xlsx")).unwrap();
    fx.write("unknown.csv", "Item,Value\na,b\n");
    let partial = fx
        .import(json!({
            "run_id":"R",
            "files":["unknown.csv","mixed.xlsx"],
            "display_names":{"unknown.csv":"Notes from Sam.csv"}
        }))
        .unwrap();
    assert_eq!(partial["pb_hydrated"], 1);
    assert_eq!(partial["files"][0]["sheets"][0]["status"], "skipped");
    assert!(partial["files"][0]["sheets"][0]["error"]
        .as_str()
        .unwrap()
        .contains("Notes from Sam.csv"));
    assert_eq!(partial["files"][1]["status"], "partial");
    assert_eq!(partial["files"][1]["sheets"][0]["sheet"], "Data");
    assert_eq!(partial["files"][1]["sheets"][0]["status"], "imported");
    assert_eq!(partial["files"][1]["sheets"][1]["status"], "skipped");

    // A ROGO file in the PitchBook zone is rejected with an actionable message that names
    // the analyst's file.
    fx.write("rogo.csv", "Website,Signal\nalpha.example,Strong\n");
    let rejected = fx
        .import(json!({
            "run_id":"R",
            "files":["rogo.csv"],
            "purpose_hint":"pitchbook",
            "display_names":{"rogo.csv":"Their File.csv"}
        }))
        .unwrap_err();
    let message = rejected.to_string();
    assert!(message.contains("Their File.csv"), "{message}");
    assert!(message.contains("looks like a ROGO file"), "{message}");
    assert!(message.contains("Drop it in ROGO data"), "{message}");
    // ... and the reverse.
    let rejected = fx
        .import(json!({"run_id":"R","files":["banner.csv"],"purpose_hint":"rogo"}))
        .unwrap_err();
    assert!(rejected.to_string().contains("Drop it in PitchBook data"));
    assert!(matches!(
        fx.import(json!({"run_id":"R","files":["rogo.csv"],"purpose_hint":"mid"})),
        Err(Error::Validation(_))
    ));
    // Nothing importable at all is an error listing why.
    assert!(matches!(
        fx.import(json!({"run_id":"R","files":["unknown.csv"]})),
        Err(Error::Validation(_))
    ));

    // Inspection applies the same hint without importing.
    let inspected = fx
        .data
        .execute(
            "inspect_enrichment_files",
            &json!({
                "files":["rogo.csv","banner.csv","missing.csv"],
                "purpose_hint":"pitchbook",
                "display_names":{"rogo.csv":"Their File.csv"}
            }),
        )
        .unwrap();
    assert_eq!(inspected["import_files"], json!(["banner.csv"]));
    assert_eq!(inspected["files"][0]["eligible"], false);
    assert!(inspected["files"][0]["reason"]
        .as_str()
        .unwrap()
        .contains("Drop it in ROGO data"));
    assert_eq!(inspected["files"][2]["eligible"], false);
    assert!(inspected["files"][2]["error"].is_string());
}

#[test]
fn apply_enrichment_review_hides_restores_and_audits_only_real_changes() {
    let _guard = env_lock();
    let fx = fixture();
    let imported = seed_report_scenario(&fx);
    let report_id = imported["report_id"].as_str().unwrap().to_owned();
    let review = |args: Value| fx.store.execute("apply_enrichment_review", &args);
    let reviews = || fx.count("SELECT COUNT(*) FROM shortlist_reviews WHERE run_id='R'");
    assert_eq!(reviews(), 1);

    // Hide two unmatched companies; keeping the manually hidden G restores nothing.
    let first = review(json!({
        "run_id":"R","report_id":report_id,
        "hide_company_ids":["B","D"],"keep_company_ids":["G"]
    }))
    .unwrap();
    assert_eq!(first["changed"], true);
    assert_eq!(first["hidden"], 2);
    assert_eq!(first["restored"], 0);
    assert_eq!(first["left_hidden_count"], 1);
    assert_eq!(first["left_hidden"], json!(["G"]));
    assert_eq!(first["selection_revision"], 2);
    assert_eq!(first["considered_count"], 4);
    assert_eq!(reviews(), 2);
    let reason = |company: &str| {
        let context = fx.context("R");
        context["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["company_id"] == company)
            .unwrap()["consideration_reason"]
            .clone()
    };
    assert_eq!(reason("B"), "pitchbook_unmatched");
    assert_eq!(reason("D"), "pitchbook_unmatched");
    assert_eq!(reason("G"), "manual");

    // The same decision again changes nothing and writes no audit row.
    let repeat = review(json!({
        "run_id":"R","report_id":report_id,"hide_company_ids":["B","D"]
    }))
    .unwrap();
    assert_eq!(repeat["changed"], false);
    assert_eq!(repeat["already_hidden"], 2);
    assert_eq!(repeat["selection_revision"], 2);
    assert_eq!(reviews(), 2);

    // A manual hide is never relabelled; a pitchbook hide can be restored.
    let restore = review(json!({
        "run_id":"R","report_id":report_id,
        "hide_company_ids":["G"],"keep_company_ids":["B"],
        "expected_selection_revision":2
    }))
    .unwrap();
    assert_eq!(restore["hidden"], 0);
    assert_eq!(restore["already_hidden"], 1);
    assert_eq!(restore["restored"], 1);
    assert_eq!(restore["selection_revision"], 3);
    assert_eq!(reason("G"), "manual");
    assert!(reason("B").is_null());
    assert_eq!(reviews(), 3);

    // Optimistic concurrency, scoping and validation.
    assert!(matches!(
        review(
            json!({"run_id":"R","report_id":report_id,"hide_company_ids":["A"],"expected_selection_revision":1})
        ),
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        review(json!({"run_id":"R2","report_id":report_id})),
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        review(json!({"run_id":"R","report_id":"ER-missing"})),
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        review(
            json!({"run_id":"R","report_id":report_id,"hide_company_ids":["A"],"keep_company_ids":["A"]})
        ),
        Err(Error::Validation(_))
    ));
    assert!(matches!(
        review(json!({"run_id":"R","report_id":report_id,"hide_company_ids":["H"]})),
        Err(Error::Validation(_))
    ));
    assert!(matches!(
        review(json!({"run_id":"R","report_id":report_id,"hide_company_ids":["A","A"]})),
        Err(Error::Validation(_))
    ));
    assert!(review(json!({"run_id":"R","report_id":report_id,"surprise":true})).is_err());
    // Only a PitchBook report can drive a PitchBook decision.
    fx.write("rogo.csv", "Website,Signal\nalpha.example,Strong\n");
    let rogo = fx
        .import(json!({"run_id":"R","files":["rogo.csv"],"purpose_hint":"rogo"}))
        .unwrap();
    assert!(matches!(
        review(json!({"run_id":"R","report_id":rogo["report_id"],"hide_company_ids":["A"]})),
        Err(Error::Validation(_))
    ));
    assert_eq!(reviews(), 3);
}

#[tokio::test]
async fn apply_enrichment_review_is_a_controller_operation() {
    const API_KEY: &str = "test-service-key-with-at-least-24-characters";
    const ANALYST_KEY: &str = "test-analyst-key-with-at-least-24-characters";
    const CONTROLLER_KEY: &str = "test-controller-key-with-at-least-24-characters";
    // Process-wide environment is only touched while the guard is held; it is released before
    // the first await.
    let guard = env_lock();
    let fx = fixture();
    let imported = seed_report_scenario(&fx);
    let report_id = imported["report_id"].clone();
    std::env::set_var("MNA_CONTROLLER_KEY", CONTROLLER_KEY);
    let runtime = Runtime::new(fx.store.clone()).unwrap();
    let app = router(runtime, API_KEY.into(), Some(ANALYST_KEY.into())).unwrap();
    std::env::remove_var("MNA_CONTROLLER_KEY");
    drop(guard);
    let call = |controller: bool, analyst: bool, payload: Value| {
        let app = app.clone();
        async move {
            let mut builder = Request::builder()
                .method("POST")
                .uri("/admin/enrichment-review")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {API_KEY}"));
            if controller {
                builder = builder.header("x-mna-controller-key", CONTROLLER_KEY);
            }
            if analyst {
                builder = builder.header("x-mna-analyst-key", ANALYST_KEY);
            }
            let response = app
                .oneshot(builder.body(Body::from(payload.to_string())).unwrap())
                .await
                .unwrap();
            let status = response.status();
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            (status, serde_json::from_slice::<Value>(&bytes).unwrap())
        }
    };
    let payload = json!({"run_id":"R","report_id":report_id,"hide_company_ids":["D"]});
    // The analyst key alone is not enough; the review decision belongs to the controller.
    assert_eq!(
        call(false, true, payload.clone()).await.0,
        StatusCode::FORBIDDEN
    );
    let (status, body) = call(true, false, payload).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["hidden"], 1);
    assert_eq!(
        call(
            true,
            false,
            json!({"run_id":"R","report_id":report_id,"unknown":1})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    // The privileged catalog lists it, controller-only, with a real schema.
    let catalog = administrator_definitions();
    assert_eq!(catalog.len(), 29);
    let entry = catalog
        .iter()
        .find(|tool| tool["name"] == "apply_enrichment_review")
        .unwrap();
    assert_eq!(entry["endpoint"], "/admin/enrichment-review");
    assert_eq!(entry["controller_only"], true);
    assert_eq!(entry["input_schema"]["additionalProperties"], false);
}
