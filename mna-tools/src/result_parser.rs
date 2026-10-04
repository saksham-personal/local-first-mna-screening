//! All-or-nothing parser for index-bound model screening results.
use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::error::{Error, Result};

const MAX_BYTES: usize = 256 * 1024;
const MAX_ROWS: usize = 4096;

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(format!("invalid result table: {}", message.into()))
}

/// Parse one Markdown table whose header is `index` followed by the requested columns.
/// Rows may be shuffled; the returned order follows `expected_indices`.
pub fn parse_markdown_results(
    text: &str,
    columns: &[String],
    expected_indices: &[usize],
    score_columns: &[String],
) -> Result<Vec<Value>> {
    if text.len() > MAX_BYTES {
        return Err(invalid("response exceeds 256 KiB"));
    }
    if expected_indices.len() > MAX_ROWS {
        return Err(invalid("too many expected rows"));
    }
    let mut names = HashSet::new();
    for name in columns {
        if name.is_empty() || name.trim() != name || name == "index" || !names.insert(name.as_str())
        {
            return Err(invalid(
                "requested columns must be unique, nonempty, and exclude index",
            ));
        }
    }
    let mut scores = HashSet::new();
    for name in score_columns {
        if !names.contains(name.as_str()) || !scores.insert(name.as_str()) {
            return Err(invalid("score columns must be unique requested columns"));
        }
    }
    let expected: HashSet<usize> = expected_indices.iter().copied().collect();
    if expected.len() != expected_indices.len() {
        return Err(invalid("duplicate expected index"));
    }
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if text.contains('\r') && !text.contains("\r\n") {
        return Err(invalid("bare carriage return"));
    }
    let text = text.replace("\r\n", "\n");
    if text.contains('\r') {
        return Err(invalid("bare carriage return"));
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let start = lines
        .iter()
        .position(|line| !line.is_empty())
        .ok_or_else(|| invalid("empty response"))?;
    let end = lines.iter().rposition(|line| !line.is_empty()).unwrap();
    let lines = &lines[start..=end];
    if lines.len() != expected_indices.len() + 2 {
        return Err(invalid(
            "table must contain one header, one separator, and exactly one row per index",
        ));
    }
    let header = split_row(lines[0])?;
    if header.len() != columns.len() + 1 || header[0] != "index" {
        return Err(invalid(
            "header must begin with index and contain exactly the requested columns",
        ));
    }
    for (actual, expected) in header[1..].iter().zip(columns) {
        if actual != expected {
            return Err(invalid(
                "header columns differ from the requested order or spelling",
            ));
        }
    }
    let separator = split_row(lines[1])?;
    if separator.len() != header.len() || !separator.iter().all(|cell| valid_separator(cell)) {
        return Err(invalid("invalid Markdown separator"));
    }
    let mut found = std::collections::HashMap::new();
    for (line_number, line) in lines[2..].iter().enumerate() {
        let cells = split_row(line)?;
        if cells.len() != header.len() {
            return Err(invalid(format!(
                "row {} has the wrong number of cells",
                line_number + 1
            )));
        }
        let index = parse_index(&cells[0])?;
        if !expected.contains(&index) {
            return Err(invalid(format!(
                "index {index} is outside this frozen batch"
            )));
        }
        if found.contains_key(&index) {
            return Err(invalid(format!("duplicate index {index}")));
        }
        let mut object = Map::new();
        object.insert("index".into(), Value::from(index));
        for (column, cell) in columns.iter().zip(&cells[1..]) {
            let value = if scores.contains(column.as_str()) {
                parse_score(cell)?
            } else {
                Value::String(cell.clone())
            };
            object.insert(column.clone(), value);
        }
        found.insert(index, Value::Object(object));
    }
    expected_indices
        .iter()
        .map(|index| {
            found
                .remove(index)
                .ok_or_else(|| invalid(format!("missing index {index}")))
        })
        .collect()
}

fn split_row(line: &str) -> Result<Vec<String>> {
    if !line.starts_with('|') {
        return Err(invalid("each table line must start with |"));
    }
    let mut cells = Vec::new();
    let mut cell = String::new();
    let mut chars = line[1..].chars().peekable();
    let mut closed = false;
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => match chars.next() {
                Some('|') => cell.push('|'),
                Some('\\') => cell.push('\\'),
                _ => return Err(invalid("only \\| and \\\\ escapes are supported")),
            },
            '|' => {
                cells.push(cell.trim().to_owned());
                cell.clear();
                closed = chars.peek().is_none();
            }
            '\r' | '\n' => return Err(invalid("newline inside table cell")),
            c if c.is_control() => return Err(invalid("control character inside table cell")),
            _ => cell.push(ch),
        }
    }
    if !closed {
        return Err(invalid("each table line must end with an unescaped |"));
    }
    Ok(cells)
}

fn valid_separator(cell: &str) -> bool {
    let inner = cell.strip_prefix(':').unwrap_or(cell);
    let inner = inner.strip_suffix(':').unwrap_or(inner);
    inner.len() >= 3 && inner.bytes().all(|b| b == b'-')
}

fn parse_index(raw: &str) -> Result<usize> {
    if raw.is_empty()
        || !raw.bytes().all(|b| b.is_ascii_digit())
        || (raw.len() > 1 && raw.starts_with('0'))
    {
        return Err(invalid("index must be a canonical nonnegative integer"));
    }
    raw.parse::<usize>().map_err(|_| invalid("index overflow"))
}

fn parse_score(raw: &str) -> Result<Value> {
    if raw == "CHECK" {
        return Ok(Value::String("CHECK".into()));
    }
    // serde_json accepts the finite decimal grammar and rejects NaN, infinity and leading +.
    let parsed: Value =
        serde_json::from_str(raw).map_err(|_| invalid("score must be 0..10 or CHECK"))?;
    let Value::Number(number) = parsed else {
        return Err(invalid("score must be 0..10 or CHECK"));
    };
    let score = number
        .as_f64()
        .ok_or_else(|| invalid("score is not representable"))?;
    if !score.is_finite() || !(0.0..=10.0).contains(&score) {
        return Err(invalid("score must be 0..10 or CHECK"));
    }
    Ok(Value::Number(number))
}
