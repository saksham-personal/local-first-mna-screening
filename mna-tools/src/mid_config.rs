use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

const DEFAULT: &str = include_str!("../config/mid-index.json");

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct IdentifierColumns {
    pub ecid: Vec<String>,
    pub cid: Vec<String>,
    pub pbid: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ColumnType {
    Text,
    Number,
    Date,
    Category,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MidIndexConfig {
    pub version: u32,
    pub header_row: usize,
    pub identifier_columns: IdentifierColumns,
    pub name_columns: Vec<String>,
    pub website_columns: Vec<String>,
    pub search_columns: Vec<String>,
    #[serde(alias = "llm_description_columns")]
    pub description_columns: Vec<String>,
    pub fts5_column_names: BTreeMap<String, String>,
    #[serde(default)]
    pub display_columns: Vec<String>,
    #[serde(default)]
    pub column_types: BTreeMap<String, ColumnType>,
    #[serde(default)]
    pub coverage_columns: Vec<String>,
}

impl MidIndexConfig {
    pub fn load() -> Result<Self> {
        let path = std::env::var_os("MNA_MID_INDEX_CONFIG")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                concat!(env!("CARGO_MANIFEST_DIR"), "/config/mid-index.json").into()
            });
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => DEFAULT.to_owned(),
            Err(e) => return Err(e.into()),
        };
        Self::parse(&raw)
    }

    fn parse(raw: &str) -> Result<Self> {
        let value: serde_json::Value = serde_json::from_str(raw)?;
        for key in ["source_weights", "metadata_columns"] {
            if value.get(key).is_some() {
                tracing::warn!("MID index config {key} is obsolete and ignored");
            }
        }
        if value.get("llm_description_columns").is_some() {
            tracing::warn!(
                "MID index config llm_description_columns is deprecated; use description_columns"
            );
        }
        let config: Self = serde_json::from_value(value)?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        if !matches!(self.version, 1 | 2) {
            return Err(Error::Validation(
                "MID index config version must be 1 or 2".into(),
            ));
        }
        if self.header_row != 1 {
            return Err(Error::Validation("MID header_row must be 1".into()));
        }
        for (label, columns) in [
            ("ECID", &self.identifier_columns.ecid),
            ("CID", &self.identifier_columns.cid),
            ("PBID", &self.identifier_columns.pbid),
            ("name", &self.name_columns),
            ("website", &self.website_columns),
            ("search", &self.search_columns),
            ("description", &self.description_columns),
            ("display", &self.display_columns),
            ("coverage", &self.coverage_columns),
        ] {
            if (columns.is_empty() && !matches!(label, "website" | "display" | "coverage"))
                || columns.iter().any(|s| s.trim().is_empty())
            {
                return Err(Error::Validation(format!(
                    "{label} columns must be non-empty"
                )));
            }
            let mut seen = BTreeSet::new();
            for column in columns {
                if !seen.insert(column.trim().to_lowercase()) {
                    return Err(Error::Validation(format!(
                        "Duplicate {label} column: {column}"
                    )));
                }
            }
        }
        for column in &self.search_columns {
            if !self.fts5_column_names.contains_key(column) {
                return Err(Error::Validation(format!("Missing FTS name for {column}")));
            }
        }
        let mut names = BTreeSet::new();
        for (column, name) in &self.fts5_column_names {
            if name.len() > 41
                || !name.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                || matches!(name.as_str(), "rank" | "rowid")
            {
                return Err(Error::Validation(format!(
                    "Invalid FTS name for {column}: {name}"
                )));
            }
            if !names.insert(name) {
                return Err(Error::Validation(format!("Duplicate FTS name: {name}")));
            }
        }
        if self.column_types.keys().any(|name| name.trim().is_empty()) {
            return Err(Error::Validation(
                "Column type names must be non-empty".into(),
            ));
        }
        Ok(())
    }

    pub fn config_hash(&self) -> Result<String> {
        // Value's sorted object keys give canonical, compact JSON independent of input key order.
        let canonical = serde_json::to_vec(&serde_json::to_value(self)?)?;
        Ok(format!("{:x}", Sha256::digest(canonical)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> MidIndexConfig {
        serde_json::from_str(DEFAULT).unwrap()
    }

    #[test]
    fn default_and_canonical_hash() {
        let c = config();
        c.validate().unwrap();
        assert_eq!(c.version, 2);
        assert_eq!(c.config_hash().unwrap().len(), 64);
        let reparsed: MidIndexConfig =
            serde_json::from_value(serde_json::to_value(&c).unwrap()).unwrap();
        assert_eq!(c.config_hash().unwrap(), reparsed.config_hash().unwrap());
        assert_eq!(c.column_types["Annual Revenue"], ColumnType::Number);
        assert_eq!(c.column_types["Last Call Date"], ColumnType::Date);
        assert_eq!(c.column_types["Company Status"], ColumnType::Category);
        assert!(!c.column_types.contains_key("Company")); // Text is the default.
    }
    #[test]
    fn old_config_loads_without_weights_or_metadata() {
        let mut old: serde_json::Value = serde_json::from_str(DEFAULT).unwrap();
        old["version"] = 1.into();
        let descriptions = old["description_columns"].take();
        old["llm_description_columns"] = descriptions;
        old.as_object_mut().unwrap().remove("description_columns");
        old.as_object_mut().unwrap().remove("display_columns");
        old.as_object_mut().unwrap().remove("column_types");
        old.as_object_mut().unwrap().remove("coverage_columns");
        old["source_weights"] = serde_json::json!({"company_desc": 0.0});
        old["metadata_columns"] = serde_json::json!(["Missing metadata"]);
        let loaded = MidIndexConfig::parse(&old.to_string()).unwrap();
        assert_eq!(loaded.version, 1);
        assert_eq!(loaded.description_columns[0], "Company Description");
        assert!(loaded.display_columns.is_empty());
        assert!(loaded.column_types.is_empty());
        assert!(loaded.coverage_columns.is_empty());
        assert!(serde_json::to_value(loaded)
            .unwrap()
            .get("source_weights")
            .is_none());
    }
    #[test]
    fn rejects_missing_invalid_and_duplicate_names() {
        let mut c = config();
        let column = c.search_columns[0].clone();
        c.fts5_column_names.remove(&column);
        assert!(c
            .validate()
            .unwrap_err()
            .to_string()
            .contains("Missing FTS"));
        c.fts5_column_names
            .insert(column.clone(), "bad-name".into());
        assert!(c.validate().is_err());
        c.fts5_column_names
            .insert(column, c.fts5_column_names[&c.search_columns[1]].clone());
        assert!(c
            .validate()
            .unwrap_err()
            .to_string()
            .contains("Duplicate FTS"));
        let mut c = config();
        c.search_columns.push(c.search_columns[0].to_lowercase());
        assert!(c
            .validate()
            .unwrap_err()
            .to_string()
            .contains("Duplicate search"));
        let mut c = config();
        c.display_columns.push(c.display_columns[0].clone());
        assert!(c
            .validate()
            .unwrap_err()
            .to_string()
            .contains("Duplicate display"));
    }
    #[test]
    fn rejects_empty_columns_header_version_and_invalid_type() {
        let mut c = config();
        c.description_columns.clear();
        assert!(c.validate().is_err());
        let mut c = config();
        c.identifier_columns.cid.clear();
        assert!(c.validate().is_err());
        let mut c = config();
        c.header_row = 2;
        assert!(c.validate().is_err());
        let mut c = config();
        c.version = 3;
        assert!(c.validate().is_err());
        let mut raw: serde_json::Value = serde_json::from_str(DEFAULT).unwrap();
        raw["column_types"]["Company"] = "currency".into();
        assert!(serde_json::from_value::<MidIndexConfig>(raw).is_err());
    }
}
