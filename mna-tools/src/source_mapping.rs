use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

const DEFAULT: &str = include_str!("../config/source-mapping.json");

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Prefixes {
    pub iscc: String,
    pub mid: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SourceMapping {
    pub version: u32,
    pub iscc_to_mid: BTreeMap<String, String>,
    pub dropped_iscc: Vec<String>,
    pub prefix: Prefixes,
}

impl SourceMapping {
    pub fn load() -> Result<Self> {
        let path = std::env::var_os("MNA_SOURCE_MAPPING")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                concat!(env!("CARGO_MANIFEST_DIR"), "/config/source-mapping.json").into()
            });
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => DEFAULT.to_owned(),
            Err(e) => return Err(e.into()),
        };
        let mapping: Self = serde_json::from_str(&raw)?;
        mapping.validate()?;
        Ok(mapping)
    }

    pub fn validate(&self) -> Result<()> {
        if self.version != 1 {
            return Err(Error::Validation("Source mapping version must be 1".into()));
        }
        if self.prefix.iscc.is_empty()
            || self.prefix.mid.is_empty()
            || self.prefix.iscc == self.prefix.mid
        {
            return Err(Error::Validation(
                "Source prefixes must be non-empty and distinct".into(),
            ));
        }
        let mut targets = BTreeSet::new();
        for (iscc, mid) in &self.iscc_to_mid {
            if iscc.trim().is_empty() || mid.trim().is_empty() {
                return Err(Error::Validation(
                    "Mapped column names must be non-empty".into(),
                ));
            }
            if !targets.insert(mid.to_lowercase()) {
                return Err(Error::Validation(format!(
                    "Duplicate MID mapping target: {mid}"
                )));
            }
        }
        let mut dropped = BTreeSet::new();
        for name in &self.dropped_iscc {
            if name.trim().is_empty() || !dropped.insert(name.to_lowercase()) {
                return Err(Error::Validation(format!(
                    "Invalid or duplicate dropped ISCC column: {name}"
                )));
            }
            if self.iscc_to_mid.contains_key(name) {
                return Err(Error::Validation(format!(
                    "Mapped ISCC column cannot be dropped: {name}"
                )));
            }
        }
        Ok(())
    }

    pub fn mid_name_for_iscc(&self, column: &str) -> Option<&str> {
        self.iscc_to_mid.get(column).map(String::as_str)
    }

    pub fn merged_column_name(&self, source: &str, column: &str) -> Option<String> {
        match source {
            "ISCC" => {
                if self.dropped_iscc.iter().any(|name| name == column) {
                    None
                } else {
                    Some(
                        self.mid_name_for_iscc(column)
                            .map_or_else(|| format!("{}{column}", self.prefix.iscc), str::to_owned),
                    )
                }
            }
            "MID" => Some(if self.iscc_to_mid.values().any(|name| name == column) {
                column.to_owned()
            } else {
                format!("{}{column}", self.prefix.mid)
            }),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analyst_mapping_covers_every_iscc_column() {
        let mapping: SourceMapping = serde_json::from_str(DEFAULT).unwrap();
        mapping.validate().unwrap();
        let mapped = [
            ("CID", "Crescendo ID"),
            ("ECI", "ECID"),
            ("Company Name", "Company"),
            ("Company Website", "Website"),
            ("City", "HQ City"),
            ("State", "HQ State"),
            ("LOB", "BU Level 05"),
            ("Sub LOB", "BU Level 06"),
            ("Sub Sub LOB", "BU Level 07"),
            ("Sub Sub Sub LOB", "BU Level 08"),
            ("Sub Sub Sub Sub LOB", "BU Level 09"),
            ("Sub Sub Sub Sub Sub LOB", "BU Level 11"),
        ];
        assert_eq!(mapping.iscc_to_mid.len(), mapped.len());
        for (iscc, mid) in mapped {
            assert_eq!(mapping.mid_name_for_iscc(iscc), Some(mid));
            assert_eq!(
                mapping.merged_column_name("ISCC", iscc).as_deref(),
                Some(mid)
            );
            assert_eq!(mapping.merged_column_name("MID", mid).as_deref(), Some(mid));
        }
        let other = [
            "Relevancy Score",
            "Company Status",
            "iSpreso Indicator",
            "Parent",
            "Sales Range",
            "Annual Revenue ($ mm)",
            "Ownership",
            "Employees",
            "Address",
            "Country",
            "ZIP",
            "Segment",
            "Region",
            "Market",
            "HQ Location",
            "Quality of Connection",
            "IB Sector",
            "IB Sub Sector",
            "IB Sub Sector Level 2",
            "IB Microsector",
            "CB Banker",
            "CB Banker SID",
            "GCB Banker",
            "GCB Banker SID",
            "IB Client Executive",
            "IB Client Executive SID",
            "CB R12 Call Count",
            "IB R12 Call Count",
            "Total R12 Call Count",
            "Last Call Date",
            "Sponsors",
            "Sponsor Type",
            "Protocol Tier",
            "Company Description",
            "Company Description Source",
            "Pitchbook ID",
            "Pitchbook Description",
            "Factset Description",
            "Demandbase Description",
            "Dealogic Description",
            "NAICS",
            "NAICS Description",
            "Offerings",
            "Pitchbook Keywords",
        ];
        for column in other {
            assert_eq!(mapping.mid_name_for_iscc(column), None);
            assert_eq!(
                mapping.merged_column_name("ISCC", column),
                Some(format!("ISCC_{column}"))
            );
        }
        assert_eq!(mapping.merged_column_name("ISCC", "iQ Link"), None);
        assert_eq!(
            mapping.merged_column_name("MID", "Unmapped"),
            Some("MID_Unmapped".into())
        );
    }

    #[test]
    fn rejects_invalid_mapping() {
        let mut mapping: SourceMapping = serde_json::from_str(DEFAULT).unwrap();
        mapping.iscc_to_mid.insert("Extra".into(), "ECID".into());
        assert!(mapping
            .validate()
            .unwrap_err()
            .to_string()
            .contains("Duplicate MID"));
        let mut mapping: SourceMapping = serde_json::from_str(DEFAULT).unwrap();
        mapping.dropped_iscc.push("CID".into());
        assert!(mapping.validate().is_err());
        let mut mapping: SourceMapping = serde_json::from_str(DEFAULT).unwrap();
        mapping.prefix.mid = mapping.prefix.iscc.clone();
        assert!(mapping.validate().is_err());
    }
}
