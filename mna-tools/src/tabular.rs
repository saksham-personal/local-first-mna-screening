use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use calamine::{open_workbook_auto, Reader};
use regex::Regex;
use serde_json::{Map, Value};

use crate::{
    error::{Error, Result},
    identity::normalize_header,
};

pub const MAX_FILES: usize = 32;
pub const MAX_ROWS_PER_FILE: usize = 250_000;
pub const MAX_COLUMNS: usize = 512;
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct SheetRows {
    pub file_name: String,
    pub sheet_name: String,
    pub header_row: usize,
    pub headers: Vec<String>,
    pub rows: Vec<Value>,
}

/// Only files below the explicitly configured import root can be consumed.
pub fn resolve_import_path(provided: &str) -> Result<PathBuf> {
    resolve_contained("MNA_IMPORT_DIR", "data/import", provided, true)
}

pub fn resolve_export_path(provided: &str) -> Result<PathBuf> {
    resolve_contained("MNA_EXPORT_DIR", "data/export", provided, false)
}

fn resolve_contained(
    env_name: &str,
    default_dir: &str,
    provided: &str,
    must_exist: bool,
) -> Result<PathBuf> {
    if provided.trim().is_empty() || provided.contains('\0') {
        return Err(Error::Validation("file path is blank or invalid".into()));
    }
    let root = std::env::var(env_name).unwrap_or_else(|_| default_dir.to_owned());
    fs::create_dir_all(&root)?;
    let root = fs::canonicalize(root)?;
    let requested = Path::new(provided);
    if requested
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(Error::Validation("path traversal is not allowed".into()));
    }
    let joined = if requested.is_absolute() {
        requested.to_owned()
    } else {
        root.join(requested)
    };
    if !joined.starts_with(&root) {
        return Err(Error::Validation(format!("path must be below {env_name}")));
    }
    let resolved = if must_exist {
        fs::canonicalize(joined)?
    } else {
        let parent = joined
            .parent()
            .ok_or_else(|| Error::Validation("invalid export path".into()))?;
        let mut ancestor = parent;
        while !ancestor.exists() {
            ancestor = ancestor
                .parent()
                .ok_or_else(|| Error::Validation("invalid export directory".into()))?;
        }
        if !fs::canonicalize(ancestor)?.starts_with(&root) {
            return Err(Error::Validation(format!("path must be below {env_name}")));
        }
        fs::create_dir_all(parent)?;
        let parent = fs::canonicalize(parent)?;
        if !parent.starts_with(&root) {
            return Err(Error::Validation(format!("path must be below {env_name}")));
        }
        let target = parent.join(
            joined
                .file_name()
                .ok_or_else(|| Error::Validation("invalid export filename".into()))?,
        );
        if fs::symlink_metadata(&target).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(Error::Validation(
                "export target cannot be a symlink".into(),
            ));
        }
        target
    };
    if !resolved.starts_with(&root) {
        return Err(Error::Validation(format!("path must be below {env_name}")));
    }
    if must_exist && !resolved.is_file() {
        return Err(Error::Validation("import path must be a file".into()));
    }
    Ok(resolved)
}

pub fn read_file(path: &Path) -> Result<Vec<SheetRows>> {
    let length = fs::metadata(path)?.len();
    if length > MAX_FILE_BYTES {
        return Err(Error::Validation(format!(
            "file exceeds {MAX_FILE_BYTES} bytes"
        )));
    }
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "csv" => read_csv(path),
        "xlsx" | "xls" | "xlsm" | "xlsb" | "ods" => read_workbook(path),
        _ => Err(Error::Validation(
            "supported import formats: CSV, XLSX, XLS, XLSM, XLSB, ODS".into(),
        )),
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_owned()
}

fn read_csv(path: &Path) -> Result<Vec<SheetRows>> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_path(path)
        .map_err(|e| Error::Validation(format!("cannot parse CSV: {e}")))?;
    let mut matrix = Vec::new();
    for record in reader.records() {
        if matrix.len() >= MAX_ROWS_PER_FILE + 50 {
            return Err(Error::Validation(format!(
                "CSV exceeds {MAX_ROWS_PER_FILE} data rows"
            )));
        }
        let record = record.map_err(|e| Error::Validation(format!("invalid CSV row: {e}")))?;
        if record.len() > MAX_COLUMNS {
            return Err(Error::Validation(format!(
                "CSV exceeds {MAX_COLUMNS} columns"
            )));
        }
        matrix.push(record.iter().map(clean_cell).collect::<Vec<_>>());
    }
    Ok(vec![matrix_to_sheet(
        file_name(path),
        "CSV".into(),
        matrix,
    )?])
}

fn read_workbook(path: &Path) -> Result<Vec<SheetRows>> {
    let mut workbook = open_workbook_auto(path)
        .map_err(|e| Error::Validation(format!("cannot parse workbook: {e}")))?;
    let names = workbook.sheet_names().to_vec();
    if names.len() > 100 {
        return Err(Error::Validation(
            "workbook has more than 100 sheets".into(),
        ));
    }
    let mut sheets = Vec::new();
    let mut total_rows = 0usize;
    for name in names {
        let range = workbook
            .worksheet_range(&name)
            .map_err(|e| Error::Validation(format!("cannot read sheet {name}: {e}")))?;
        let mut matrix = Vec::new();
        for cells in range.rows() {
            if matrix.len() >= MAX_ROWS_PER_FILE + 50 {
                return Err(Error::Validation(format!(
                    "sheet {name} exceeds {MAX_ROWS_PER_FILE} data rows"
                )));
            }
            if cells.len() > MAX_COLUMNS {
                return Err(Error::Validation(format!(
                    "sheet {name} exceeds {MAX_COLUMNS} columns"
                )));
            }
            matrix.push(
                cells
                    .iter()
                    .map(|cell| clean_cell(&cell.to_string()))
                    .collect::<Vec<_>>(),
            );
        }
        drop(range);
        if matrix
            .iter()
            .any(|row| row.iter().any(|v| !v.trim().is_empty()))
        {
            let sheet = matrix_to_sheet(file_name(path), name, matrix)?;
            total_rows += sheet.rows.len();
            if total_rows > MAX_ROWS_PER_FILE {
                return Err(Error::Validation(format!(
                    "workbook exceeds {MAX_ROWS_PER_FILE} total data rows"
                )));
            }
            sheets.push(sheet);
        }
    }
    Ok(sheets)
}

fn matrix_to_sheet(
    file_name: String,
    sheet_name: String,
    matrix: Vec<Vec<String>>,
) -> Result<SheetRows> {
    let header_index = detect_header(&matrix).ok_or_else(|| {
        Error::Validation(format!("cannot detect header in {file_name}/{sheet_name}"))
    })?;
    let headers = matrix[header_index]
        .iter()
        .enumerate()
        .map(|(i, value)| {
            if value.trim().is_empty() {
                format!("Column_{}", i + 1)
            } else {
                value.trim().to_owned()
            }
        })
        .collect::<Vec<_>>();
    let mut unique = std::collections::HashSet::new();
    let headers = headers
        .into_iter()
        .enumerate()
        .map(|(i, header)| {
            if unique.insert(normalize_header(&header)) {
                header
            } else {
                format!("{header}__{}", i + 1)
            }
        })
        .collect::<Vec<_>>();
    let mut rows = Vec::new();
    for source_row in matrix.into_iter().skip(header_index + 1) {
        if source_row.iter().all(|cell| cell.trim().is_empty()) {
            continue;
        }
        let mut object = Map::new();
        let mut cells = source_row.into_iter();
        for header in &headers {
            object.insert(
                header.clone(),
                Value::String(cells.next().unwrap_or_default()),
            );
        }
        rows.push(Value::Object(object));
        if rows.len() > MAX_ROWS_PER_FILE {
            return Err(Error::Validation(format!(
                "sheet exceeds {MAX_ROWS_PER_FILE} data rows"
            )));
        }
    }
    Ok(SheetRows {
        file_name,
        sheet_name,
        header_row: header_index + 1,
        headers,
        rows,
    })
}

fn clean_cell(cell: &str) -> String {
    static COPYRIGHT: OnceLock<Regex> = OnceLock::new();
    let expression = COPYRIGHT.get_or_init(|| {
        Regex::new(r"(?i)©\s*PitchBook\s*Data,?\s*Inc\.?\s*\d{4}").expect("valid copyright regex")
    });
    expression.replace_all(cell, "").trim().to_owned()
}

/// Inspect a bounded prefix. Strong MID/PitchBook headers take priority;
/// otherwise ROGO's first Website row is its header.
fn detect_header(rows: &[Vec<String>]) -> Option<usize> {
    let scan = rows.len().min(1000);
    let mut website_header = None;
    for (index, row) in rows.iter().take(scan).enumerate() {
        let labels = row.iter().map(|s| normalize_header(s)).collect::<Vec<_>>();
        let has = |key: &str| labels.iter().any(|label| label == key);
        if (has("ecid") || has("cid")) && (has("companyname") || has("name") || has("companies"))
            || has("pk") && has("pbid") && has("companyprofile")
            || has("companyid") && has("companies")
        {
            return Some(index);
        }
        if website_header.is_none() && (has("website") || has("websites")) {
            website_header = Some(index);
        }
    }
    website_header
}

pub fn sheet_kind(sheet: &SheetRows) -> Option<&'static str> {
    let labels = sheet
        .headers
        .iter()
        .map(|s| normalize_header(s))
        .collect::<Vec<_>>();
    let has = |key: &str| labels.iter().any(|value| value == key);
    if has("pk") && has("pbid") {
        let required = [
            "pk",
            "pbid",
            "firmnamefrompitchbook",
            "websitefrompitchbook",
            "companyprofile",
            "investorprofile",
            "limitedpartnerprofile",
            "serviceproviderprofile",
        ];
        if sheet.header_row == 1 && required.iter().all(|key| has(key)) {
            Some("PB_MAPPING")
        } else {
            None
        }
    } else if has("companyid") && has("companies") && (has("description") || has("hqlocation")) {
        Some("PB_DATA")
    } else if has("ecid") || has("cid") {
        Some("COMPANY")
    } else if (has("website") || has("websites")) && !has("pbid") {
        Some("ROGO")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn header_detection_handles_preamble_and_website() {
        let matrix = vec![
            vec!["© PitchBook Data, Inc. 2026".into()],
            vec![
                "Company ID".into(),
                "Companies".into(),
                "Description".into(),
            ],
        ];
        assert_eq!(detect_header(&matrix), Some(1));
        let matrix = vec![
            vec!["notes".into()],
            vec!["Website".into(), "Signal".into()],
            vec!["foo.com".into(), "Yes".into()],
        ];
        assert_eq!(detect_header(&matrix), Some(1));
    }

    #[test]
    fn strong_header_beats_website_in_preamble() {
        let matrix = vec![
            vec!["Website".into(), "Memo".into()],
            vec![
                "Company ID".into(),
                "Companies".into(),
                "Website".into(),
                "Description".into(),
            ],
        ];
        assert_eq!(detect_header(&matrix), Some(1));
    }

    #[test]
    fn mapping_requires_full_first_row_header() {
        let required = [
            "pk",
            "PBId",
            "Firm Name from PitchBook",
            "Website from PitchBook",
            "Company Profile",
            "Investor Profile",
            "Limited Partner Profile",
            "Service Provider Profile",
        ];
        let sheet = SheetRows {
            file_name: "mapping.csv".into(),
            sheet_name: "CSV".into(),
            header_row: 1,
            headers: required.iter().map(|s| s.to_string()).collect(),
            rows: vec![],
        };
        assert_eq!(sheet_kind(&sheet), Some("PB_MAPPING"));
        let mut wrong_row = sheet.clone();
        wrong_row.header_row = 2;
        assert_eq!(sheet_kind(&wrong_row), None);
        let mut missing = sheet;
        missing.headers.pop();
        assert_eq!(sheet_kind(&missing), None);
    }

    #[test]
    fn copyright_is_removed_anywhere_in_cell() {
        assert_eq!(
            clean_cell("Acme © PitchBook Data, Inc. 2027 report"),
            "Acme  report"
        );
        assert_eq!(clean_cell("© PitchBook Data Inc 2025"), "");
    }
}
