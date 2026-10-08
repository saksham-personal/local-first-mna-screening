use std::{fs, thread, time::{Duration, Instant}};
use calamine::{open_workbook_auto, Reader};
use mna_tools::{data::DataService, export_jobs::ExportJobs, Store};
use serde_json::{json, Value};

fn wait(jobs: &ExportJobs, store: &Store, id: &str) -> Value {
    let until = Instant::now() + Duration::from_secs(60);
    let mut previous = 0;
    loop {
        let status = jobs.execute(store, "get_export", &json!({"export_id":id})).unwrap();
        let done = status["rows_done"].as_u64().unwrap();
        assert!(done >= previous); previous = done;
        if status["state"] != "running" { assert_eq!(status["state"], "done", "{status}"); return status; }
        assert!(Instant::now() < until, "export did not finish: {status}");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn streams_all_formats_preserves_simulation_and_recovers_status() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("exports");
    std::env::set_var("MNA_EXPORT_DIR", &root);
    let store = Store::open(dir.path().join("data.db")).unwrap();
    store.execute("create_run", &json!({"run_id":"large", "objective":"Export test", "original_criteria":{}})).unwrap();
    store.with_connection(|c| {
        let tx = c.transaction()?;
        for i in 0..6001 {
            let id = format!("C{i:05}");
            tx.execute("INSERT INTO companies(company_id,name,website,city,description,metadata_json,created_at,updated_at) VALUES(?1,?2,'https://example.test','City','=untrusted description','{"hq_state":"State"}','now','now')", rusqlite::params![id,format!("Company {i}")])?;
            tx.execute("INSERT INTO candidates(run_id,company_id,status,discovered_at,updated_at,considered) VALUES('large',?1,'NEW','now','now',?2)", rusqlite::params![id,i<6000])?;
            let row = json!({"Company Name":format!("Company {i}"),"Description":"=raw text", "Number":i});
            tx.execute("INSERT INTO source_rows(source_row_id,source,company_id,row_hash,row_json,imported_at) VALUES(?1,'MID',?1,?1,?2,'now')",rusqlite::params![id,row.to_string()])?;
        }
        // Another run's ISCC rows and hidden candidates must never leak into exports.
        tx.execute("INSERT INTO source_rows(source_row_id,source,run_scope,company_id,row_hash,row_json,imported_at) VALUES('foreign','ISCC','other','C00000','foreign','{"Secret":"other run"}','now')",[])?;
        tx.commit()?; Ok(())
    }).unwrap();
    let jobs = ExportJobs::new(&store).unwrap();
    for kind in ["pitchbook","llm","full"] {
        let started = jobs.execute(&store,"start_export",&json!({"run_id":"large","kind":kind})).unwrap();
        let id = started["export_id"].as_str().unwrap();
        // Hold the shared connection mutex throughout writing: the export must use its own connection.
        let status = store.with_connection(|_| Ok(wait(&jobs,&store,id))).unwrap();
        assert_eq!(status["rows_done"],6000); assert_eq!(status["rows_total"],6000);
        assert!(status["finished_at"].is_string());
        let disk: Value = serde_json::from_slice(&fs::read(root.join(format!("export-{id}.json"))).unwrap()).unwrap();
        assert_eq!(status,disk);
        let path = root.join(status["file"].as_str().unwrap());
        let mut book = open_workbook_auto(&path).unwrap();
        let sheet = if kind=="full" {"MID"} else if kind=="llm" {"LLM"} else {"PITCHBOOK"};
        let range = book.worksheet_range(sheet).unwrap();
        assert_eq!(range.height(),6001);
        if kind=="llm" { assert_eq!(range.get_value((1,0)).unwrap().to_string(),"1"); }
        if kind=="full" { assert_eq!(book.worksheet_range("ISCC").unwrap().height(),1); }
        let sync = DataService::new(store.clone()).execute("export_candidate_set",&json!({"run_id":"large","export_type":kind})).unwrap();
        let mut sync_book = open_workbook_auto(sync["path"].as_str().unwrap()).unwrap();
        assert_eq!(range,sync_book.worksheet_range(sheet).unwrap());
    }
    assert_eq!(jobs.execute(&store,"list_exports",&json!({"run_id":"large"})).unwrap()["exports"].as_array().unwrap().len(),3);
    store.with_connection(|c| { c.execute("UPDATE source_rows SET simulated=1 WHERE source_row_id='C00000'",[])?; Ok(()) }).unwrap();
    for kind in ["pitchbook","llm","full"] {
        let refused = jobs.execute(&store,"start_export",&json!({"run_id":"large","kind":kind}));
        assert!(refused.unwrap_err().to_string().contains("simulated"));
        let started = jobs.execute(&store,"start_export",&json!({"run_id":"large","kind":kind,"allow_simulated":true})).unwrap();
        let status = wait(&jobs,&store,started["export_id"].as_str().unwrap());
        assert!(status["file"].as_str().unwrap().contains("SIMULATED"));
        let mut book = open_workbook_auto(root.join(status["file"].as_str().unwrap())).unwrap();
        let sheet = if kind=="full" { assert!(book.sheet_names().iter().any(|s| s=="SIMULATED")); "MID" } else if kind=="llm" {"LLM"} else {"PITCHBOOK"};
        let rows = book.worksheet_range(sheet).unwrap();
        assert_eq!(rows.get_value((0,0)).unwrap().to_string(),"Data origin");
        assert_eq!(rows.get_value((1,0)).unwrap().to_string(),"SIMULATED");
    }
    assert!(jobs.execute(&store,"get_export",&json!({"export_id":"../escape"})).is_err());
    assert!(jobs.execute(&store,"start_export",&json!({"run_id":"large","kind":"csv"})).is_err());
    assert!(jobs.execute(&store,"start_export",&json!({"run_id":"missing","kind":"full"})).is_err());
    let interrupted = json!({"export_id":"interrupted","run_id":"large","kind":"full","state":"running","rows_done":500,"rows_total":6000,"started_at":"2026-10-08T00:00:00Z"});
    fs::write(root.join("export-interrupted.json"),serde_json::to_vec(&interrupted).unwrap()).unwrap();
    drop(jobs);
    let recovered = ExportJobs::new(&store).unwrap();
    let status = recovered.execute(&store,"get_export",&json!({"export_id":"interrupted"})).unwrap();
    assert_eq!(status["state"],"failed"); assert_eq!(status["error"],"interrupted"); assert!(status["finished_at"].is_string());
    let saved: Value = serde_json::from_slice(&fs::read(root.join("export-interrupted.json")).unwrap()).unwrap();
    assert_eq!(saved,status);
    assert_eq!(recovered.execute(&store,"list_exports",&json!({"run_id":"large"})).unwrap()["exports"].as_array().unwrap().len(),7);
}
