//! Background exports own a read snapshot and never hold the runtime's Store mutex.
use crate::{
    data::{
        export_has_simulated, export_row_total, publish_export, simulated_export_error,
        write_export_stream,
    },
    error::{Error, Result},
    store::Store,
    tabular,
};
use chrono::Utc;
use rusqlite::Connection;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct StartArgs {
    run_id: String,
    kind: String,
    #[serde(default)]
    allow_simulated: bool,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct GetArgs {
    export_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    run_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExportStatus {
    pub export_id: String,
    pub run_id: String,
    pub kind: String,
    pub state: String,
    pub rows_done: usize,
    pub rows_total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

pub fn input_schema(tool: &str) -> Option<Value> {
    let schema = match tool {
        "start_export" => schemars::schema_for!(StartArgs),
        "get_export" => schemars::schema_for!(GetArgs),
        "list_exports" => schemars::schema_for!(ListArgs),
        _ => return None,
    };
    serde_json::to_value(schema).ok()
}

#[derive(Clone)]
pub struct ExportJobs {
    root: PathBuf,
    db: PathBuf,
    statuses: Arc<Mutex<BTreeMap<String, ExportStatus>>>,
}
impl ExportJobs {
    pub fn new(store: &Store) -> Result<Self> {
        let root = tabular::resolve_export_path("exports-root")?
            .parent()
            .unwrap()
            .to_path_buf();
        let jobs = Self {
            root,
            db: store.db_path().to_path_buf(),
            statuses: Arc::new(Mutex::new(BTreeMap::new())),
        };
        // A damaged or foreign status file is skipped so it cannot block startup.
        for entry in fs::read_dir(&jobs.root)?.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(".tmp.xlsx") {
                let _ = fs::remove_file(entry.path());
                continue;
            }
            let Some(id) = name
                .strip_prefix("export-")
                .and_then(|s| s.strip_suffix(".json"))
            else {
                continue;
            };
            let Some(mut status) = validate_id(id)
                .ok()
                .and_then(|_| fs::canonicalize(entry.path()).ok())
                .filter(|path| path.starts_with(&jobs.root))
                .and_then(|path| fs::read(path).ok())
                .and_then(|raw| serde_json::from_slice::<ExportStatus>(&raw).ok())
                .filter(|status| status.export_id == id)
            else {
                continue;
            };
            if status.state == "running" {
                status.state = "failed".into();
                status.error = Some("interrupted".into());
                status.finished_at = Some(Utc::now().to_rfc3339());
            }
            jobs.save(status)?;
        }
        Ok(jobs)
    }
    fn save(&self, status: ExportStatus) -> Result<()> {
        // Same-directory rename makes each status read see a complete JSON record.
        let mut statuses = self
            .statuses
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let target = self.root.join(format!("export-{}.json", status.export_id));
        let temporary = target.with_extension("json.tmp");
        fs::write(&temporary, serde_json::to_vec(&status)?)?;
        fs::rename(temporary, target)?;
        statuses.insert(status.export_id.clone(), status);
        Ok(())
    }
    pub fn execute(&self, store: &Store, tool: &str, args: &Value) -> Result<Value> {
        match tool {
            "start_export" => self.start(store, serde_json::from_value(args.clone())?),
            "get_export" => {
                let args: GetArgs = serde_json::from_value(args.clone())?;
                validate_id(&args.export_id)?;
                let statuses = self
                    .statuses
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                serde_json::to_value(
                    statuses
                        .get(&args.export_id)
                        .ok_or_else(|| Error::NotFound("Export not found".into()))?,
                )
                .map_err(Into::into)
            }
            "list_exports" => {
                let args: ListArgs = serde_json::from_value(args.clone())?;
                let statuses = self
                    .statuses
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let mut exports: Vec<_> = statuses
                    .values()
                    .filter(|s| s.run_id == args.run_id)
                    .cloned()
                    .collect();
                exports.sort_by(|a, b| b.started_at.cmp(&a.started_at));
                Ok(json!({"exports":exports}))
            }
            _ => Err(Error::Validation("Unknown export operation".into())),
        }
    }
    fn start(&self, store: &Store, args: StartArgs) -> Result<Value> {
        if !matches!(args.kind.as_str(), "pitchbook" | "llm" | "full") {
            return Err(Error::Validation(
                "kind must be pitchbook, llm or full".into(),
            ));
        }
        if self.db.to_string_lossy() == ":memory:" {
            return Err(Error::Validation(
                "Background exports require a file database".into(),
            ));
        }
        let kind = args.kind.to_ascii_uppercase();
        let total = store.with_connection(|c| {
            if export_has_simulated(c, &args.run_id)? && !args.allow_simulated {
                return Err(simulated_export_error());
            }
            export_row_total(c, &args.run_id, &kind)
        })?;
        let status = ExportStatus {
            export_id: Uuid::new_v4().to_string(),
            run_id: args.run_id.clone(),
            kind: args.kind,
            state: "running".into(),
            rows_done: 0,
            rows_total: total,
            file: None,
            error: None,
            started_at: Utc::now().to_rfc3339(),
            finished_at: None,
        };
        self.save(status.clone())?;
        let export_id = status.export_id.clone();
        let jobs = self.clone();
        let mut failed = status.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("export-{export_id}"))
            .spawn(move || jobs.work(status, kind, args.allow_simulated));
        if let Err(error) = spawned {
            failed.state = "failed".into();
            failed.error = Some(error.to_string());
            failed.finished_at = Some(Utc::now().to_rfc3339());
            self.save(failed)?;
            return Err(Error::Io(error));
        }
        Ok(json!({"export_id":export_id}))
    }
    fn work(&self, mut status: ExportStatus, kind: String, allow_simulated: bool) {
        let temporary = self.root.join(format!(".{}.tmp.xlsx", status.export_id));
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<String> {
                let connection = Connection::open(&self.db)?;
                connection.busy_timeout(std::time::Duration::from_secs(5))?;
                connection.execute_batch(
                    "PRAGMA query_only=ON; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048;",
                )?;
                let snapshot = connection.unchecked_transaction()?;
                let simulated = export_has_simulated(&snapshot, &status.run_id)?;
                if simulated && !allow_simulated {
                    return Err(simulated_export_error());
                }
                let file = format!(
                    "{}-{}{}.xlsx",
                    status.export_id,
                    status.kind,
                    if simulated { "-SIMULATED" } else { "" }
                );
                let run_id = status.run_id.clone();
                write_export_stream(
                    &snapshot,
                    &run_id,
                    &kind,
                    &temporary,
                    simulated,
                    |done, total| {
                        status.rows_done = done;
                        status.rows_total = total;
                        self.save(status.clone())
                    },
                )?;
                publish_export(&temporary, &self.root.join(&file))?;
                Ok(file)
            }))
            .unwrap_or_else(|_| Err(Error::Internal("Export worker panicked".into())));
        match result {
            Ok(file) => {
                status.state = "done".into();
                status.file = Some(file);
            }
            Err(error) => {
                status.state = "failed".into();
                status.error = Some(error.to_string());
                let _ = fs::remove_file(temporary);
            }
        }
        status.finished_at = Some(Utc::now().to_rfc3339());
        if let Err(error) = self.save(status.clone()) {
            // Still expose the persistence failure to current clients.
            status.state = "failed".into();
            status.file = None;
            status.error = Some(error.to_string());
            self.statuses
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(status.export_id.clone(), status);
            tracing::error!(%error, "Could not persist export completion");
        }
    }
}
fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(Error::Validation("Invalid export id".into()));
    }
    Ok(())
}
