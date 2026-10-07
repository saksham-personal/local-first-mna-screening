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
    read_file_with_mode(path, true)
}

/// Inspection preserves sheets whose headers are not recognized, so callers can
/// retain the original upload for an explicit analyst choice.
pub fn inspect_file(path: &Path) -> Result<Vec<SheetRows>> {
    read_file_with_mode(path, false)
}

fn read_file_with_mode(path: &Path, strict_header: bool) -> Result<Vec<SheetRows>> {
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
        "csv" => read_csv(path, strict_header),
        "xlsx" | "xls" | "xlsm" | "xlsb" | "ods" => read_workbook(path, strict_header),
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

fn read_csv(path: &Path, strict_header: bool) -> Result<Vec<SheetRows>> {
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
        strict_header,
    )?])
}

fn read_workbook(path: &Path, strict_header: bool) -> Result<Vec<SheetRows>> {
    read_workbook_sheets(path, strict_header)?
        .into_iter()
        .map(|sheet| sheet.result)
        .collect()
}

/// One populated sheet of a file, read independently so a caller can keep the good sheets of a
/// workbook when another sheet is oversized or has no recognizable header.
pub struct SheetRead {
    pub sheet_name: String,
    pub result: Result<SheetRows>,
}

/// Like [`inspect_file`], but a failure on one sheet is reported next to that sheet instead of
/// failing the whole file. Only an unreadable file (missing, too large, not a spreadsheet, a
/// corrupt CSV) is an `Err`.
pub fn inspect_file_lenient(path: &Path) -> Result<Vec<SheetRead>> {
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
        "csv" => Ok(read_csv(path, false)?
            .into_iter()
            .map(|sheet| SheetRead {
                sheet_name: sheet.sheet_name.clone(),
                result: Ok(sheet),
            })
            .collect()),
        "xlsx" | "xls" | "xlsm" | "xlsb" | "ods" => read_workbook_sheets(path, false),
        _ => Err(Error::Validation(
            "supported import formats: CSV, XLSX, XLS, XLSM, XLSB, ODS".into(),
        )),
    }
}

fn read_workbook_sheets(path: &Path, strict_header: bool) -> Result<Vec<SheetRead>> {
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
        let result = read_one_sheet(&mut workbook, path, &name, strict_header);
        match result {
            Ok(None) => {}
            Ok(Some(sheet)) => {
                total_rows += sheet.rows.len();
                let result = if total_rows > MAX_ROWS_PER_FILE {
                    Err(Error::Validation(format!(
                        "workbook exceeds {MAX_ROWS_PER_FILE} total data rows"
                    )))
                } else {
                    Ok(sheet)
                };
                sheets.push(SheetRead {
                    sheet_name: name,
                    result,
                });
            }
            Err(error) => sheets.push(SheetRead {
                sheet_name: name,
                result: Err(error),
            }),
        }
    }
    Ok(sheets)
}

fn read_one_sheet(
    workbook: &mut calamine::Sheets<std::io::BufReader<std::fs::File>>,
    path: &Path,
    name: &str,
    strict_header: bool,
) -> Result<Option<SheetRows>> {
    let range = workbook
        .worksheet_range(name)
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
        Ok(Some(matrix_to_sheet(
            file_name(path),
            name.to_owned(),
            matrix,
            strict_header,
        )?))
    } else {
        Ok(None)
    }
}

fn matrix_to_sheet(
    file_name: String,
    sheet_name: String,
    matrix: Vec<Vec<String>>,
    strict_header: bool,
) -> Result<SheetRows> {
    let header_index = detect_header(&matrix)
        .or_else(|| {
            if strict_header {
                None
            } else {
                matrix
                    .iter()
                    .position(|row| row.iter().any(|cell| !cell.trim().is_empty()))
            }
        })
        .ok_or_else(|| {
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

/// The PitchBook mapping header must appear in the first rows of a sheet.
pub const MAPPING_HEADER_SCAN_ROWS: usize = 20;
/// ROGO identifies a company only by its website. Header names accepted for that column, in
/// priority order (the first non-blank value in a row is used).
pub const ROGO_WEBSITE_HEADERS: [&str; 5] =
    ["Website", "Websites", "Company Website", "URL", "Domain"];
/// Accepted header names for the PitchBook mapping identifier and company-profile columns.
pub const PB_ID_HEADERS: [&str; 3] = ["PBId", "PB Id", "PitchBook ID"];
pub const PB_PROFILE_HEADERS: [&str; 2] = ["Company Profile", "Profile"];
const PB_NAME_HEADERS: [&str; 2] = ["Companies", "Company Name"];
const PB_DATA_COLUMNS: [&str; 6] = [
    "description",
    "hqlocation",
    "website",
    "linkedinurl",
    "activeinvestors",
    "universe",
];

/// Which upload zone a file was dropped in. Used only to break ties and to reject mismatches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    Pitchbook,
    Rogo,
}

impl Purpose {
    pub fn parse(hint: Option<&str>) -> Result<Option<Self>> {
        match hint.map(|value| value.trim().to_ascii_lowercase()) {
            None => Ok(None),
            Some(value) if value.is_empty() => Ok(None),
            Some(value) if value == "pitchbook" => Ok(Some(Self::Pitchbook)),
            Some(value) if value == "rogo" => Ok(Some(Self::Rogo)),
            Some(_) => Err(Error::Validation(
                "purpose_hint must be \"pitchbook\" or \"rogo\"".into(),
            )),
        }
    }
}

fn normalized_labels(labels: &[String]) -> Vec<String> {
    labels.iter().map(|label| normalize_header(label)).collect()
}

fn has_any(labels: &[String], keys: &[&str]) -> bool {
    keys.iter().any(|key| {
        let wanted = normalize_header(key);
        labels.contains(&wanted)
    })
}

/// Inspect a bounded prefix. Strong MID/PitchBook headers take priority;
/// otherwise ROGO's first website row is its header. A PitchBook mapping header must be
/// within the first [`MAPPING_HEADER_SCAN_ROWS`] rows and needs pk, a PBId and a company
/// profile column (the other profile columns are optional).
fn detect_header(rows: &[Vec<String>]) -> Option<usize> {
    let scan = rows.len().min(1000);
    let mut website_header = None;
    for (index, row) in rows.iter().take(scan).enumerate() {
        let labels = normalized_labels(row);
        let has = |key: &str| labels.iter().any(|label| label == key);
        let company =
            (has("ecid") || has("cid")) && (has("companyname") || has("name") || has("companies"));
        let mapping = index < MAPPING_HEADER_SCAN_ROWS
            && has("pk")
            && has_any(&labels, &PB_ID_HEADERS)
            && has_any(&labels, &PB_PROFILE_HEADERS);
        let pb_data = has("companyid") && has_any(&labels, &PB_NAME_HEADERS);
        if company || mapping || pb_data {
            return Some(index);
        }
        if website_header.is_none() && has_any(&labels, &ROGO_WEBSITE_HEADERS) {
            website_header = Some(index);
        }
    }
    website_header
}

/// Classification used by the MID company import (ECID/CID sheets take precedence over ROGO).
pub fn sheet_kind(sheet: &SheetRows) -> Option<&'static str> {
    classify(sheet, None, true)
}

/// Classification for the PitchBook/ROGO enrichment path. PitchBook mapping and data are
/// recognized before ROGO, and a sheet with a single stray ECID/CID column but a website
/// column is ROGO. `hint` only breaks ties between ROGO and MID/PitchBook-like shapes.
pub fn enrichment_kind(sheet: &SheetRows, hint: Option<Purpose>) -> Option<&'static str> {
    classify(sheet, hint, false)
}

fn classify(sheet: &SheetRows, hint: Option<Purpose>, company_first: bool) -> Option<&'static str> {
    let labels = normalized_labels(&sheet.headers);
    let has = |key: &str| labels.iter().any(|value| value == key);
    let website = has_any(&labels, &ROGO_WEBSITE_HEADERS);
    if has("pk") && has_any(&labels, &PB_ID_HEADERS) {
        return if has_any(&labels, &PB_PROFILE_HEADERS)
            && sheet.header_row <= MAPPING_HEADER_SCAN_ROWS
        {
            Some("PB_MAPPING")
        } else {
            None
        };
    }
    let pb_named = has("companyid") && has_any(&labels, &PB_NAME_HEADERS);
    let pb_strong =
        has("companyid") && has("companies") && (has("description") || has("hqlocation"));
    let pb_weak = pb_named && has_any(&labels, &PB_DATA_COLUMNS);
    let rogo_like = website && !has_any(&labels, &PB_ID_HEADERS);
    if pb_strong || (pb_weak && !(hint == Some(Purpose::Rogo) && rogo_like)) {
        return Some("PB_DATA");
    }
    let ids = has("ecid") || has("cid");
    let named = has("companyname") || has("name") || has("companies");
    if company_first && ids {
        return Some("COMPANY");
    }
    if hint == Some(Purpose::Rogo) && rogo_like {
        return Some("ROGO");
    }
    let company_like = (has("ecid") && has("cid")) || (ids && named);
    if company_like {
        return Some("COMPANY");
    }
    if rogo_like {
        return Some("ROGO");
    }
    if ids {
        return Some("COMPANY");
    }
    None
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

    fn sheet(headers: &[&str], header_row: usize) -> SheetRows {
        SheetRows {
            file_name: "file.csv".into(),
            sheet_name: "CSV".into(),
            header_row,
            headers: headers.iter().map(|s| s.to_string()).collect(),
            rows: vec![],
        }
    }

    #[test]
    fn mapping_needs_pk_pbid_and_profile_within_the_first_rows() {
        let full = sheet(
            &[
                "pk",
                "PBId",
                "Firm Name from PitchBook",
                "Website from PitchBook",
                "Company Profile",
                "Investor Profile",
                "Limited Partner Profile",
                "Service Provider Profile",
            ],
            1,
        );
        assert_eq!(sheet_kind(&full), Some("PB_MAPPING"));
        assert_eq!(enrichment_kind(&full, None), Some("PB_MAPPING"));
        // A banner above the header, or only the three required columns, is still a mapping.
        assert_eq!(
            enrichment_kind(&sheet(&["pk", "PBId", "Company Profile"], 7), None),
            Some("PB_MAPPING")
        );
        // Aliases are accepted.
        assert_eq!(
            enrichment_kind(&sheet(&["PK", "PitchBook ID", "Profile"], 1), None),
            Some("PB_MAPPING")
        );
        assert_eq!(
            enrichment_kind(&sheet(&["pk", "PB Id", "Company Profile"], 1), None),
            Some("PB_MAPPING")
        );
        // Beyond the scan window, or without a profile column, it is not a mapping.
        assert_eq!(
            enrichment_kind(&sheet(&["pk", "PBId", "Company Profile"], 21), None),
            None
        );
        assert_eq!(
            enrichment_kind(&sheet(&["pk", "PBId", "Notes"], 1), None),
            None
        );
    }

    #[test]
    fn mapping_header_is_found_in_the_first_twenty_rows_only() {
        let header = vec!["pk".to_string(), "PBId".into(), "Company Profile".into()];
        let mut matrix: Vec<Vec<String>> = (0..12).map(|i| vec![format!("note {i}")]).collect();
        matrix.push(header.clone());
        assert_eq!(detect_header(&matrix), Some(12));
        let mut late: Vec<Vec<String>> = (0..25).map(|i| vec![format!("note {i}")]).collect();
        late.push(header);
        assert_eq!(detect_header(&late), None);
    }

    #[test]
    fn pitchbook_data_is_classified_before_rogo() {
        let export = sheet(&["Company ID", "Company Name", "Website", "Description"], 3);
        assert_eq!(enrichment_kind(&export, None), Some("PB_DATA"));
        assert_eq!(
            enrichment_kind(&export, Some(Purpose::Pitchbook)),
            Some("PB_DATA")
        );
        let classic = sheet(&["Company ID", "Companies", "Website", "HQ Location"], 3);
        assert_eq!(
            enrichment_kind(&classic, Some(Purpose::Rogo)),
            Some("PB_DATA")
        );
        // A weak PitchBook shape (no description/HQ) yields to ROGO only for the ROGO zone.
        let weak = sheet(&["Company ID", "Company Name", "Website"], 1);
        assert_eq!(enrichment_kind(&weak, None), Some("PB_DATA"));
        assert_eq!(enrichment_kind(&weak, Some(Purpose::Rogo)), Some("ROGO"));
    }

    #[test]
    fn rogo_accepts_website_aliases_and_ignores_a_stray_company_id_column() {
        for alias in ["Website", "Websites", "Company Website", "URL", "Domain"] {
            let rogo = sheet(&[alias, "Signal"], 1);
            assert_eq!(enrichment_kind(&rogo, None), Some("ROGO"), "{alias}");
        }
        let stray = sheet(&["Website", "Signal", "CID"], 2);
        assert_eq!(enrichment_kind(&stray, None), Some("ROGO"));
        assert_eq!(enrichment_kind(&stray, Some(Purpose::Rogo)), Some("ROGO"));
        // The MID company import keeps its ECID/CID precedence.
        assert_eq!(sheet_kind(&stray), Some("COMPANY"));
        let mid = sheet(&["ECID", "CID", "Company Name", "Website"], 1);
        assert_eq!(enrichment_kind(&mid, None), Some("COMPANY"));
        assert_eq!(sheet_kind(&mid), Some("COMPANY"));
        let tied = sheet(&["CID", "Company Name", "Website"], 1);
        assert_eq!(enrichment_kind(&tied, None), Some("COMPANY"));
        assert_eq!(enrichment_kind(&tied, Some(Purpose::Rogo)), Some("ROGO"));
    }

    #[test]
    fn purpose_hint_parses_strictly() {
        assert_eq!(Purpose::parse(None).unwrap(), None);
        assert_eq!(
            Purpose::parse(Some("PitchBook")).unwrap(),
            Some(Purpose::Pitchbook)
        );
        assert_eq!(Purpose::parse(Some(" rogo ")).unwrap(), Some(Purpose::Rogo));
        assert!(Purpose::parse(Some("mid")).is_err());
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
