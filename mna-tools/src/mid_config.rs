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

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MidIndexConfig {
    pub version: u32,
    pub header_row: usize,
    pub identifier_columns: IdentifierColumns,
    pub name_columns: Vec<String>,
    pub website_columns: Vec<String>,
    pub search_columns: Vec<String>,
    pub llm_description_columns: Vec<String>,
    pub fts5_column_names: BTreeMap<String, String>,
    pub source_weights: BTreeMap<String, f64>,
    pub metadata_columns: Vec<String>,
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
        let config: Self = serde_json::from_str(&raw)?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        if self.header_row != 1 {
            return Err(Error::Validation("MID header_row must be 1".into()));
        }
        for (label, columns) in [
            ("ECID", &self.identifier_columns.ecid),
            ("CID", &self.identifier_columns.cid),
            ("PBID", &self.identifier_columns.pbid),
            ("name", &self.name_columns),
            ("search", &self.search_columns),
            ("LLM description", &self.llm_description_columns),
        ] {
            if columns.is_empty() || columns.iter().any(|s| s.trim().is_empty()) {
                return Err(Error::Validation(format!(
                    "{label} columns must be non-empty"
                )));
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
            if !self
                .source_weights
                .get(name)
                .is_some_and(|w| w.is_finite() && *w > 0.0)
            {
                return Err(Error::Validation(format!(
                    "Positive FTS weight required for {name}"
                )));
            }
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
        assert_eq!(c.config_hash().unwrap().len(), 64);
        let reparsed: MidIndexConfig =
            serde_json::from_value(serde_json::to_value(&c).unwrap()).unwrap();
        assert_eq!(c.config_hash().unwrap(), reparsed.config_hash().unwrap());
    }
    #[test]
    fn rejects_missing_invalid_duplicate_names_and_weights() {
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
        assert!(c.validate().unwrap_err().to_string().contains("Duplicate"));
        let mut c = config();
        c.source_weights.clear();
        assert!(c.validate().is_err());
        let mut c = config();
        c.source_weights.insert("company_desc".into(), 0.0);
        assert!(c.validate().is_err());
    }
    #[test]
    fn rejects_empty_columns_and_header() {
        let mut c = config();
        c.llm_description_columns.clear();
        assert!(c.validate().is_err());
        let mut c = config();
        c.identifier_columns.cid.clear();
        assert!(c.validate().is_err());
        let mut c = config();
        c.identifier_columns.ecid.clear();
        assert!(c.validate().is_err());
        let mut c = config();
        c.identifier_columns.pbid.clear();
        assert!(c.validate().is_err());
        let mut c = config();
        c.header_row = 2;
        assert!(c.validate().is_err());
    }
}
