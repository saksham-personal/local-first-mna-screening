//! Strict, versioned text commands emitted by an agent for the internal tool runtime.
use std::collections::BTreeMap;

use serde_json::{Map, Number, Value};

use crate::error::{Error, Result};

const MAX_BYTES: usize = 256 * 1024;
const MAX_FIELDS: usize = 4096;
const MAX_DEPTH: usize = 24;
const MAX_ARRAY_INDEX: usize = 4095;

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedToolCommand {
    pub tool: String,
    pub arguments: Value,
}

#[derive(Debug)]
enum Segment {
    Key(String),
    Index(usize),
}

#[derive(Debug)]
enum Node {
    Object(BTreeMap<String, Node>),
    Array(BTreeMap<usize, Node>),
    Unassigned,
    Assigned(Value),
}

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(format!("invalid tool command: {}", message.into()))
}

/// Parse exactly one `BEGIN TOOL v1` command. The allowlist comes from the controller.
pub fn parse_tool_response(text: &str, allowed: &[&str]) -> Result<ParsedToolCommand> {
    if text.len() > MAX_BYTES {
        return Err(invalid("response exceeds 256 KiB"));
    }
    let normalized = text.strip_prefix('\u{feff}').unwrap_or(text);
    if normalized.contains('\r') && !normalized.contains("\r\n") {
        return Err(invalid("bare carriage return"));
    }
    let normalized = normalized.replace("\r\n", "\n");
    if normalized.contains('\r') {
        return Err(invalid("bare carriage return"));
    }
    let lines: Vec<&str> = normalized.split('\n').collect();
    let Some(first) = lines.iter().position(|line| !line.is_empty()) else {
        return Err(invalid("empty response"));
    };
    let header = lines[first];
    let tool = header
        .strip_prefix("BEGIN TOOL v1 ")
        .filter(|name| {
            !name.is_empty() && *name == name.trim() && !name.contains(char::is_whitespace)
        })
        .ok_or_else(|| invalid("expected BEGIN TOOL v1 <allowlisted-name>"))?;
    if !allowed.contains(&tool) {
        return Err(invalid("tool is not on this request's allowlist"));
    }
    let mut root = Node::Object(BTreeMap::new());
    let mut i = first + 1;
    let mut fields = 0usize;
    let mut ended = false;
    while i < lines.len() {
        let line = lines[i];
        if line == "END TOOL" {
            ended = true;
            i += 1;
            break;
        }
        if line.is_empty() {
            return Err(invalid(format!(
                "blank line inside command at line {}",
                i + 1
            )));
        }
        fields += 1;
        if fields > MAX_FIELDS {
            return Err(invalid("too many fields"));
        }
        let (left, raw) = split_assignment(line)
            .ok_or_else(|| invalid(format!("expected path:type = value at line {}", i + 1)))?;
        let (path, kind) = left
            .rsplit_once(':')
            .ok_or_else(|| invalid(format!("missing type at line {}", i + 1)))?;
        let path = parse_path(path)?;
        let value = match kind {
            "text" if raw.starts_with("<<") => {
                let marker = &raw[2..];
                if marker.is_empty()
                    || marker.len() > 32
                    || !marker
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                {
                    return Err(invalid("invalid multiline terminator"));
                }
                let start = i + 1;
                i = start;
                while i < lines.len() && lines[i] != marker {
                    i += 1;
                }
                if i == lines.len() {
                    return Err(invalid("unterminated multiline text"));
                }
                let value = lines[start..i].join("\n");
                Value::String(value)
            }
            "text" => Value::String(parse_quoted(raw)?),
            "number" => Value::Number(parse_number(raw)?),
            "boolean" => match raw {
                "true" => Value::Bool(true),
                "false" => Value::Bool(false),
                _ => return Err(invalid("boolean must be true or false")),
            },
            "null" if raw == "-" => Value::Null,
            "empty-list" if raw == "-" => Value::Array(Vec::new()),
            "empty-map" if raw == "-" => Value::Object(Map::new()),
            _ => return Err(invalid(format!("invalid type or value at line {}", i + 1))),
        };
        insert(&mut root, &path, value)?;
        i += 1;
    }
    if !ended {
        return Err(invalid("missing END TOOL"));
    }
    if lines[i..].iter().any(|line| !line.is_empty()) {
        return Err(invalid("extra content after END TOOL"));
    }
    Ok(ParsedToolCommand {
        tool: tool.to_owned(),
        arguments: into_value(root)?,
    })
}

/// A bounded retry instruction; the controller decides whether another attempt is allowed.
pub fn repair_prompt(_raw: &str, error: &Error, allowed: &[&str]) -> crate::error::Result<String> {
    let names = allowed
        .iter()
        .take(32)
        .filter(|name| !name.is_empty() && name.len() <= 80)
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    let reason = error.to_string();
    let reason: String = reason
        .chars()
        .take(240)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    crate::prompts::render(
        "tool-command-repair",
        &[
            ("reason", reason.as_str()),
            ("allowed_names", names.as_str()),
        ],
    )
}

fn split_assignment(line: &str) -> Option<(&str, &str)> {
    let bytes = line.as_bytes();
    let mut quoted = false;
    let mut escaped = false;
    let mut pos = 0;
    while pos + 2 < bytes.len() {
        let b = bytes[pos];
        if quoted {
            if b == b'\\' && !escaped {
                escaped = true;
            } else {
                if b == b'"' && !escaped {
                    quoted = false;
                }
                escaped = false;
            }
        } else if b == b'"' {
            quoted = true;
        } else if &bytes[pos..pos + 3] == b" = " {
            return Some((&line[..pos], &line[pos + 3..]));
        }
        pos += 1;
    }
    None
}

fn parse_path(path: &str) -> Result<Vec<Segment>> {
    let bytes = path.as_bytes();
    let mut pos = 0usize;
    let mut segments = Vec::new();
    while pos < bytes.len() {
        if bytes[pos] == b'[' {
            pos += 1;
            if pos < bytes.len() && bytes[pos] == b'"' {
                let start = pos;
                pos += 1;
                let mut escaped = false;
                while pos < bytes.len() {
                    if !escaped && bytes[pos] == b'"' {
                        break;
                    }
                    escaped = bytes[pos] == b'\\' && !escaped;
                    pos += 1;
                }
                if pos >= bytes.len() {
                    return Err(invalid("unterminated quoted path key"));
                }
                let key = parse_quoted(&path[start..=pos])?;
                pos += 1;
                if bytes.get(pos) != Some(&b']') {
                    return Err(invalid("expected ] after quoted path key"));
                }
                pos += 1;
                segments.push(Segment::Key(key));
            } else {
                let start = pos;
                while pos < bytes.len() && bytes[pos].is_ascii_digit() {
                    pos += 1;
                }
                if start == pos || bytes.get(pos) != Some(&b']') {
                    return Err(invalid("array index must be a nonnegative decimal integer"));
                }
                let digits = &path[start..pos];
                if digits.len() > 1 && digits.starts_with('0') {
                    return Err(invalid("array index has a leading zero"));
                }
                let index = digits
                    .parse::<usize>()
                    .map_err(|_| invalid("array index overflow"))?;
                if index > MAX_ARRAY_INDEX {
                    return Err(invalid("array index exceeds 4095"));
                }
                pos += 1;
                segments.push(Segment::Index(index));
            }
        } else {
            let start = pos;
            if !bytes[pos].is_ascii_alphabetic() && bytes[pos] != b'_' {
                return Err(invalid("path key must start with a letter or underscore"));
            }
            pos += 1;
            while pos < bytes.len() && (bytes[pos].is_ascii_alphanumeric() || bytes[pos] == b'_') {
                pos += 1;
            }
            segments.push(Segment::Key(path[start..pos].to_owned()));
        }
        if pos < bytes.len() {
            match bytes[pos] {
                b'.' => {
                    pos += 1;
                    if pos == bytes.len() || bytes[pos] == b'[' {
                        return Err(invalid("invalid dot in path"));
                    }
                }
                b'[' => {}
                _ => return Err(invalid("invalid path separator")),
            }
        }
    }
    if segments.is_empty() || segments.len() > MAX_DEPTH || !matches!(segments[0], Segment::Key(_))
    {
        return Err(invalid("path depth or root key is invalid"));
    }
    Ok(segments)
}

fn parse_quoted(raw: &str) -> Result<String> {
    if !raw.starts_with('"') || !raw.ends_with('"') || raw.len() < 2 {
        return Err(invalid("text must be double quoted"));
    }
    let mut chars = raw[1..raw.len() - 1].chars();
    let mut out = String::new();
    while let Some(c) = chars.next() {
        if c == '"' || c.is_control() {
            return Err(invalid("unescaped quote or control character in text"));
        }
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('\\') => out.push('\\'),
            Some('"') => out.push('"'),
            Some('u') => {
                if chars.next() != Some('{') {
                    return Err(invalid("Unicode escape must use \\u{HEX}"));
                }
                let mut hex = String::new();
                loop {
                    match chars.next() {
                        Some('}') => break,
                        Some(c) if c.is_ascii_hexdigit() && hex.len() < 6 => hex.push(c),
                        _ => return Err(invalid("invalid Unicode escape")),
                    }
                }
                if hex.is_empty() {
                    return Err(invalid("empty Unicode escape"));
                }
                let scalar =
                    u32::from_str_radix(&hex, 16).map_err(|_| invalid("invalid Unicode escape"))?;
                out.push(char::from_u32(scalar).ok_or_else(|| invalid("invalid Unicode scalar"))?);
            }
            _ => return Err(invalid("unsupported text escape")),
        }
    }
    Ok(out)
}

fn parse_number(raw: &str) -> Result<Number> {
    let bytes = raw.as_bytes();
    let mut i = 0;
    if bytes.first() == Some(&b'-') {
        i += 1;
    }
    if i == bytes.len() {
        return Err(invalid("invalid number"));
    }
    if bytes[i] == b'0' {
        i += 1;
    } else if bytes[i].is_ascii_digit() && bytes[i] != b'0' {
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
    } else {
        return Err(invalid("invalid number"));
    }
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return Err(invalid("invalid number fraction"));
        }
    }
    if matches!(bytes.get(i), Some(&b'e') | Some(&b'E')) {
        i += 1;
        if matches!(bytes.get(i), Some(&b'+') | Some(&b'-')) {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return Err(invalid("invalid number exponent"));
        }
    }
    if i != bytes.len() {
        return Err(invalid("invalid number suffix"));
    }
    let value: Value =
        serde_json::from_str(raw).map_err(|_| invalid("number cannot be represented"))?;
    match value {
        Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => Ok(number),
        _ => Err(invalid("nonfinite or unrepresentable number")),
    }
}

fn insert(node: &mut Node, path: &[Segment], value: Value) -> Result<()> {
    let (first, rest) = path.split_first().ok_or_else(|| invalid("empty path"))?;
    let child = match (node, first) {
        (Node::Object(map), Segment::Key(key)) => map.entry(key.clone()).or_insert_with(|| {
            if matches!(rest.first(), Some(Segment::Index(_))) {
                Node::Array(BTreeMap::new())
            } else if rest.is_empty() {
                Node::Unassigned
            } else {
                Node::Object(BTreeMap::new())
            }
        }),
        (Node::Array(map), Segment::Index(index)) => map.entry(*index).or_insert_with(|| {
            if matches!(rest.first(), Some(Segment::Index(_))) {
                Node::Array(BTreeMap::new())
            } else if rest.is_empty() {
                Node::Unassigned
            } else {
                Node::Object(BTreeMap::new())
            }
        }),
        _ => return Err(invalid("path type conflict")),
    };
    if rest.is_empty() {
        match child {
            Node::Unassigned => {
                *child = Node::Assigned(value);
                Ok(())
            }
            _ => Err(invalid("duplicate field or path conflict")),
        }
    } else {
        insert(child, rest, value)
    }
}

fn into_value(node: Node) -> Result<Value> {
    match node {
        Node::Unassigned => Err(invalid("incomplete field")),
        Node::Assigned(value) => Ok(value),
        Node::Object(fields) => {
            let mut object = Map::new();
            for (key, child) in fields {
                object.insert(key, into_value(child)?);
            }
            Ok(Value::Object(object))
        }
        Node::Array(elements) => {
            let mut array = Vec::with_capacity(elements.len());
            for (expected, (actual, child)) in elements.into_iter().enumerate() {
                if expected != actual {
                    return Err(invalid("sparse array"));
                }
                array.push(into_value(child)?);
            }
            Ok(Value::Array(array))
        }
    }
}
