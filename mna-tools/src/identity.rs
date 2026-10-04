use serde_json::Value;

/// External identifiers are preserved as text. A spreadsheet's numeric cell is
/// converted to its displayed integer when possible, without guessing zeros.
pub fn normalized_identifier(value: Option<&Value>) -> Option<String> {
    let raw = match value? {
        Value::Null => return None,
        Value::String(s) => s.trim().to_owned(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    };
    let normalized = raw.trim().to_ascii_uppercase();
    let compact: String = normalized.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty()
        || matches!(
            compact.as_str(),
            "-" | "--"
                | "0"
                | "0.0"
                | "N/A"
                | "NA"
                | "#N/A"
                | "NULL"
                | "NONE"
                | "NAN"
                | "UNDEFINED"
        )
    {
        None
    } else {
        Some(normalized)
    }
}

pub fn company_key(ecid: Option<&str>, cid: Option<&str>) -> Option<String> {
    match (ecid, cid) {
        (Some(e), Some(c)) => Some(format!("{e}-{c}")),
        (Some(e), None) => Some(format!("{e}-X")),
        (None, Some(c)) => Some(format!("X-{c}")),
        (None, None) => None,
    }
}

pub fn normalize_header(header: &str) -> String {
    header
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

pub fn get_field<'a>(row: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    let object = row.as_object()?;
    for key in keys {
        let wanted = normalize_header(key);
        if let Some((_, value)) = object
            .iter()
            .find(|(actual, _)| normalize_header(actual) == wanted)
        {
            return Some(value);
        }
    }
    None
}

pub fn field_text(row: &Value, keys: &[&str]) -> Option<String> {
    match get_field(row, keys)? {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

pub fn safe_spreadsheet_text(text: &str) -> String {
    let trimmed = text.trim_start();
    if trimmed.starts_with(['=', '+', '-', '@', '\t', '\r', '\n']) {
        format!("'{text}")
    } else {
        text.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn placeholders_and_keys() {
        for marker in ["", " - ", "0", "NA", "#N/A", "null", "NaN", "undefined"] {
            assert_eq!(normalized_identifier(Some(&json!(marker))), None);
        }
        assert_eq!(
            company_key(Some("123"), Some("456")),
            Some("123-456".into())
        );
        assert_eq!(company_key(None, Some("456")), Some("X-456".into()));
        assert_eq!(company_key(Some("123"), None), Some("123-X".into()));
        assert_eq!(company_key(None, None), None);
    }

    #[test]
    fn headers_and_formula_values() {
        let row = json!({"HQ State":"New York","E C I D":" 42 "});
        assert_eq!(field_text(&row, &["HQ_State"]), Some("New York".into()));
        assert_eq!(
            normalized_identifier(get_field(&row, &["ECID"])),
            Some("42".into())
        );
        assert_eq!(safe_spreadsheet_text("=1+1"), "'=1+1");
    }
}
