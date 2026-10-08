//! Tolerant Markdown instruction parsing. This module never executes or approves a tool.
use crate::runtime::ToolDefinition;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Number, Value};

const MAX_BYTES: usize = 512 * 1024;
const MAX_DEPTH: usize = 32;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ParsedReply {
    pub context: Option<String>,
    pub reasoning: Option<String>,
    pub notes: Option<String>,
    pub instructions: Vec<RawInstruction>,
    pub unparsed: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawInstruction {
    pub index: usize,
    pub name_text: String,
    pub title: Option<String>,
    pub fields: Vec<(String, String)>,
    pub raw: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InstructionContext {
    pub run_id: String,
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConversionReport {
    pub calls: Vec<ConvertedCall>,
    pub rejected: Vec<Rejection>,
    pub feedback: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertedCall {
    pub index: usize,
    pub tool: String,
    pub arguments: Value,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rejection {
    pub index: usize,
    pub name_text: String,
    pub reason: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Section {
    Context,
    Reasoning,
    Instructions,
    Notes,
}

fn unquote(s: &str) -> &str {
    let s = s.trim();
    for mark in ["**", "__", "`", "\"", "'"] {
        if let Some(inner) = s.strip_prefix(mark).and_then(|v| v.strip_suffix(mark)) {
            return inner.trim();
        }
    }
    s
}

fn normalize(s: &str) -> String {
    unquote(s)
        .to_lowercase()
        .split(|c: char| c.is_whitespace() || c == '-' || c == '_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

fn section(line: &str) -> Option<Section> {
    let s = line.trim();
    let name = if s.starts_with('#') {
        let count = s.chars().take_while(|c| *c == '#').count();
        if count > 4 {
            return None;
        }
        s[count..].trim().trim_end_matches('#').trim()
    } else if s.starts_with("**") && s.ends_with("**") {
        unquote(s)
    } else {
        s.strip_suffix(':')?.trim()
    };
    match normalize(name).as_str() {
        "context" | "summary" | "understanding" => Some(Section::Context),
        "reasoning" | "thinking" | "thoughts" | "analysis" | "rationale" => {
            Some(Section::Reasoning)
        }
        "instruction_set" | "instructions" | "steps" | "actions" | "plan" | "next_steps"
        | "commands" => Some(Section::Instructions),
        "notes" | "notes_for_the_analyst" | "comments" => Some(Section::Notes),
        _ => None,
    }
}

fn indent(s: &str) -> usize {
    s.chars()
        .take_while(|c| c.is_whitespace())
        .map(|c| if c == '\t' { 4 } else { 1 })
        .sum()
}

fn list_item(s: &str) -> Option<&str> {
    let s = s.trim_start();
    for marker in ["- ", "* ", "• "] {
        if let Some(rest) = s.strip_prefix(marker) {
            return Some(rest.trim());
        }
    }
    let numbered = if s.get(..5).is_some_and(|v| v.eq_ignore_ascii_case("step ")) {
        &s[5..]
    } else {
        s
    };
    let end = numbered.bytes().take_while(u8::is_ascii_digit).count();
    if end > 0 {
        let rest = &numbered[end..];
        if let Some(rest) = rest
            .strip_prefix('.')
            .or_else(|| rest.strip_prefix(')'))
            .or_else(|| rest.strip_prefix(':'))
        {
            return Some(rest.trim());
        }
    }
    None
}

fn assignment(s: &str) -> Option<(String, String)> {
    let s = list_item(s).unwrap_or(s).trim();
    let mut split = None;
    for sep in [":", "=", "—", "–"] {
        if let Some(i) = s.find(sep) {
            if split.is_none_or(|(best, _)| i < best) {
                split = Some((i, sep.len()));
            }
        }
    }
    let (i, len) = split?;
    let key = unquote(&s[..i]);
    if key.is_empty()
        || key.len() > 128
        || !key
            .chars()
            .all(|c| c.is_alphanumeric() || " _-".contains(c))
    {
        return None;
    }
    Some((key.to_owned(), s[i + len..].trim().to_owned()))
}

fn action(s: &str) -> (String, Option<String>, Vec<(String, String)>) {
    let s = s.trim();
    let s = if s
        .get(..7)
        .is_some_and(|v| v.eq_ignore_ascii_case("action:"))
    {
        s[7..].trim()
    } else {
        s
    };
    // Inline calls keep the parenthesized argument list separate from the action name.
    if let Some(open) = s.find('(') {
        if let Some(close) = s.rfind(')') {
            if close > open && s[open + 1..close].contains('=') {
                let fields = split_values(&s[open + 1..close])
                    .iter()
                    .filter_map(|v| assignment(v))
                    .collect();
                return (
                    unquote(&s[..open]).to_owned(),
                    title(&s[close + 1..]),
                    fields,
                );
            }
        }
    }
    for mark in ["**", "__", "`"] {
        if let Some(rest) = s.strip_prefix(mark) {
            if let Some(end) = rest.find(mark) {
                return (
                    rest[..end].trim().to_owned(),
                    title(&rest[end + mark.len()..]),
                    vec![],
                );
            }
        }
    }
    let cut = [" — ", " – ", " - ", ":"]
        .iter()
        .filter_map(|sep| s.find(sep).map(|i| (i, sep.len())))
        .min_by_key(|(i, _)| *i);
    match cut {
        Some((i, len)) => (unquote(&s[..i]).to_owned(), title(&s[i + len..]), vec![]),
        None => (unquote(s).to_owned(), None, vec![]),
    }
}

fn title(s: &str) -> Option<String> {
    let s = s.trim().trim_start_matches(['—', '–', '-', ':']).trim();
    (!s.is_empty()).then(|| unquote(s).to_owned())
}

fn synonym(name: &str) -> Option<&'static str> {
    match name {
        "search_mid" | "mid_search" | "keyword_search" => Some("search_mid"),
        "semantic_score" | "score_semantic" => Some("score_mid_semantic"),
        "semantic_search" => Some("search_mid_semantic"),
        "iscc_search" => Some("search_iscc"),
        "bing" | "web_search" => Some("bing_search"),
        _ => None,
    }
}

fn recognizable(s: &str) -> bool {
    let (name, _, _) = action(s);
    let name = normalize(&name);
    synonym(&name).is_some()
        || [
            "search_",
            "score_",
            "get_",
            "find_",
            "add_",
            "list_",
            "propose_",
            "export_",
            "prepare_",
            "rerank_",
            "read_",
            "hide_",
            "restore_",
            "update_",
            "record_",
            "bing_",
            "m365_",
            "build_",
            "compare_",
            "label_",
            "fetch_",
            "extract_",
            "save_",
            "resolve_",
            "inspect_",
            "import_",
            "embed_",
            "complete_",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

fn append_text(target: &mut Option<String>, line: &str) {
    let value = target.get_or_insert_with(String::new);
    if !value.is_empty() {
        value.push('\n');
    }
    value.push_str(line);
}

fn add_field(
    reply: &mut ParsedReply,
    instruction: &mut RawInstruction,
    key: String,
    value: String,
) {
    let normalized = normalize(&key);
    if let Some(i) = instruction
        .fields
        .iter()
        .position(|(k, _)| normalize(k) == normalized)
    {
        instruction.fields.remove(i);
        reply.warnings.push(format!(
            "Instruction {}: duplicate field '{key}'; last value wins",
            instruction.index
        ));
    }
    instruction.fields.push((key, value));
}

// Collect once, and deserialize once, rather than reparsing an ever-growing
// prefix on every line of a large or malformed JSON fragment.
fn json_fragment(lines: &[String], start: usize) -> (String, usize) {
    let mut buffer = String::new();
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    let mut end = start;
    while end < lines.len() {
        let line = &lines[end];
        if !fence(line.trim()) {
            buffer.push_str(line);
            buffer.push('\n');
            for c in line.chars() {
                if escaped {
                    escaped = false;
                    continue;
                }
                if quoted && c == '\\' {
                    escaped = true;
                    continue;
                }
                if c == '"' {
                    quoted = !quoted;
                }
                if !quoted {
                    if c == '{' || c == '[' {
                        depth += 1;
                    }
                    if c == '}' || c == ']' {
                        depth = depth.saturating_sub(1);
                    }
                }
            }
            if depth == 0 {
                return (buffer, end + 1);
            }
        }
        end += 1;
    }
    (buffer, end)
}

// Preserve duplicate top-level JSON keys so fallback parsing can report them,
// just like repeated Markdown fields, instead of silently losing them in a Map.
struct JsonFields(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for JsonFields {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FieldsVisitor;
        impl<'de> serde::de::Visitor<'de> for FieldsVisitor {
            type Value = JsonFields;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("an instruction object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                let mut fields = vec![];
                while let Some(field) = map.next_entry()? {
                    fields.push(field);
                }
                Ok(JsonFields(fields))
            }
        }
        deserializer.deserialize_map(FieldsVisitor)
    }
}

fn finish_instruction(
    reply: &mut ParsedReply,
    current: &mut Option<RawInstruction>,
    body: &mut Vec<String>,
) {
    let Some(mut instruction) = current.take() else {
        return;
    };
    let mut i = 0;
    let mut field_indent = None;
    while i < body.len() {
        let line = &body[i];
        let trimmed = line.trim();
        if trimmed.is_empty() || fence(trimmed) {
            i += 1;
            continue;
        }
        if trimmed.starts_with('{') {
            let (buffer, end) = json_fragment(body, i);
            if let Ok(JsonFields(fields)) = serde_json::from_str(&buffer) {
                for (key, value) in fields {
                    let value = value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string());
                    add_field(reply, &mut instruction, key, value);
                }
            } else {
                reply.unparsed.push(buffer.trim().to_owned());
            }
            i = end;
            field_indent = None;
            continue;
        }
        if trimmed.starts_with('|') {
            let cells: Vec<_> = trimmed
                .trim_matches('|')
                .split('|')
                .map(str::trim)
                .collect();
            if cells.len() == 2 {
                let key = unquote(cells[0]);
                if ["key", "field", "parameter"].contains(&key.to_lowercase().as_str())
                    && ["value", "argument"].contains(&cells[1].to_lowercase().as_str())
                    || cells.iter().all(|s| s.chars().all(|c| "-: ".contains(c)))
                {
                    i += 1;
                    continue;
                }
                add_field(reply, &mut instruction, key.to_owned(), cells[1].to_owned());
                field_indent = Some(indent(line));
                i += 1;
                continue;
            }
        }
        let deeper = field_indent.is_some_and(|depth| indent(line) > depth);
        if deeper {
            if let Some((_, value)) = instruction.fields.last_mut() {
                value.push('\n');
                value.push_str(line);
            }
        } else if let Some((key, value)) = assignment(trimmed) {
            add_field(reply, &mut instruction, key, value);
            field_indent = Some(indent(line));
        } else if field_indent.is_some_and(|depth| indent(line) >= depth && depth > 0) {
            if let Some((_, value)) = instruction.fields.last_mut() {
                value.push('\n');
                value.push_str(line);
            }
        } else {
            reply.unparsed.push(line.to_owned());
        }
        i += 1;
    }
    body.clear();
    reply.instructions.push(instruction);
}

fn fence(s: &str) -> bool {
    s.starts_with("```") || s.starts_with("~~~")
}

/// Parse the bounded UTF-8 prefix; malformed fragments are retained for feedback.
pub fn parse_reply(text: &str) -> ParsedReply {
    let mut reply = ParsedReply::default();
    let mut end = text.len().min(MAX_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    if text.len() > MAX_BYTES {
        reply
            .warnings
            .push("Reply exceeds 512 KiB; only the first 512 KiB were parsed".into());
    }
    let text = text[..end]
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut active = Section::Context;
    let mut sections = 0;
    let mut current: Option<RawInstruction> = None;
    let mut body = vec![];
    let mut item_indent = 0;
    for line in text.lines() {
        if fence(line.trim()) {
            if let Some(instruction) = &mut current {
                instruction.raw.push('\n');
                instruction.raw.push_str(line);
                body.push(line.to_owned());
            }
            continue;
        }
        // Indented field values named "rationale:" are fields, not sections.
        if (current.is_none() || indent(line) <= item_indent) && section(line).is_some() {
            finish_instruction(&mut reply, &mut current, &mut body);
            active = section(line).unwrap_or(Section::Context);
            if active == Section::Instructions {
                sections += 1;
                if sections > 1 {
                    reply
                        .warnings
                        .push("Multiple instruction sections merged in reply order".into());
                }
            }
            continue;
        }
        let candidate = list_item(line);
        let new_item = candidate.is_some_and(|s| {
            let bullet_field = current.is_some()
                && ["- ", "* ", "• "]
                    .iter()
                    .any(|m| line.trim_start().starts_with(m))
                && assignment(s).is_some()
                && !recognizable(s)
                && !s.to_lowercase().starts_with("action:");
            (current.is_none() || indent(line) <= item_indent)
                && (active == Section::Instructions || recognizable(s))
                && !bullet_field
        });
        if new_item {
            finish_instruction(&mut reply, &mut current, &mut body);
            let (name_text, title, fields) = action(candidate.unwrap_or_default());
            active = Section::Instructions;
            item_indent = indent(line);
            let mut instruction = RawInstruction {
                index: reply.instructions.len() + 1,
                name_text,
                title,
                fields: vec![],
                raw: line.to_owned(),
            };
            for (key, value) in fields {
                add_field(&mut reply, &mut instruction, key, value);
            }
            current = Some(instruction);
        } else if let Some(instruction) = &mut current {
            instruction.raw.push('\n');
            instruction.raw.push_str(line);
            body.push(line.to_owned());
        } else {
            match active {
                Section::Context => append_text(&mut reply.context, line),
                Section::Reasoning => append_text(&mut reply.reasoning, line),
                Section::Notes => append_text(&mut reply.notes, line),
                Section::Instructions if !line.trim().is_empty() => {
                    reply.unparsed.push(line.to_owned())
                }
                Section::Instructions => {}
            }
        }
    }
    finish_instruction(&mut reply, &mut current, &mut body);
    for field in [&mut reply.context, &mut reply.reasoning, &mut reply.notes] {
        *field = field
            .take()
            .and_then(|v| (!v.trim().is_empty()).then(|| v.trim().to_owned()));
    }
    reply
}

fn distance(a: &str, b: &str) -> usize {
    let b: Vec<_> = b.chars().collect();
    let mut row: Vec<_> = (0..=b.len()).collect();
    for (i, x) in a.chars().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, y) in b.iter().enumerate() {
            let saved = row[j + 1];
            row[j + 1] = (row[j] + 1)
                .min(saved + 1)
                .min(previous + usize::from(x != *y));
            previous = saved;
        }
    }
    row[b.len()]
}

fn match_action<'a>(name: &str, allowed: &'a [&str]) -> Option<&'a str> {
    if let Some(found) = allowed.iter().find(|s| **s == name) {
        return Some(found);
    }
    let normal = normalize(name);
    let singular = |s: &str| normalize(s).trim_end_matches('s').to_owned();
    let matches: Vec<_> = allowed
        .iter()
        .filter(|s| singular(s) == singular(&normal))
        .collect();
    if matches.len() == 1 {
        return Some(matches[0]);
    }
    if let Some(target) = synonym(&normal).or_else(|| synonym(normal.trim_end_matches('s'))) {
        // A known synonym cannot be redirected to a different allowed action by fuzzy matching.
        return allowed.iter().find(|s| **s == target).copied();
    }
    if normal.len() > 256 {
        return None;
    }
    let matches: Vec<_> = allowed
        .iter()
        .filter(|s| distance(&normal, &normalize(s)) <= 2)
        .collect();
    (matches.len() == 1).then(|| *matches[0])
}

fn match_field<'a>(key: &str, properties: &'a Map<String, Value>) -> Option<&'a str> {
    if let Some((key, _)) = properties.get_key_value(key) {
        return Some(key);
    }
    let normal = normalize(key);
    if let Some((key, _)) = properties.iter().find(|(key, _)| normalize(key) == normal) {
        return Some(key);
    }
    let aliases: &[&str] = match normal.as_str() {
        "query" | "text" => &["query", "text"],
        "max" | "limit" | "max_results" => &["limit", "max_results", "max"],
        "terms" | "keywords" => &["keywords", "terms"],
        "why" | "rationale" => &["rationale", "why"],
        _ => &[],
    };
    aliases
        .iter()
        .find_map(|key| properties.get_key_value(*key).map(|(key, _)| key.as_str()))
}

fn resolve<'a>(schema: &'a Value, root: &'a Value, depth: usize) -> Result<&'a Value, String> {
    if depth > MAX_DEPTH {
        return Err("schema reference nesting exceeds 32".into());
    }
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let pointer = reference
            .strip_prefix('#')
            .ok_or_else(|| format!("non-local schema reference {reference}"))?;
        let target = root
            .pointer(pointer)
            .ok_or_else(|| format!("unresolved schema reference {reference}"))?;
        return resolve(target, root, depth + 1);
    }
    Ok(schema)
}

fn types(schema: &Value) -> Vec<&str> {
    match schema.get("type") {
        Some(Value::String(s)) => vec![s],
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
        _ => vec![],
    }
}

/// Split Markdown lists while preserving quoted text and parenthesized annotations.
fn split_values(s: &str) -> Vec<String> {
    let mut output = vec![];
    let mut start = 0;
    let mut quote = None;
    let mut depth = 0usize;
    let mut escaped = false;
    for (i, c) in s.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' && quote.is_some() {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\"' | '\'' | '`' => quote = Some(c),
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            ';' | ',' | '\n' if depth == 0 => {
                let value = s[start..i].trim();
                if !value.is_empty() {
                    output.push(list_item(value).unwrap_or(value).to_owned());
                }
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    let value = s[start..].trim();
    if !value.is_empty() {
        output.push(list_item(value).unwrap_or(value).to_owned());
    }
    output
}

fn numeric(raw: &str, integer: bool) -> Result<Value, String> {
    let raw = unquote(raw).replace(',', "");
    let raw = raw.trim();
    let (raw, multiplier) = if let Some(raw) = raw.strip_suffix('%') {
        (raw, 0.01)
    } else if let Some(raw) = raw.strip_suffix(['k', 'K']) {
        (raw, 1000.0)
    } else {
        (raw, 1.0)
    };
    if integer && multiplier == 1.0 {
        if let Ok(n) = raw.parse::<i64>() {
            return Ok(Value::Number(n.into()));
        }
        if let Ok(n) = raw.parse::<u64>() {
            return Ok(Value::Number(n.into()));
        }
    }
    let n = raw
        .trim()
        .parse::<f64>()
        .map_err(|_| "expected number".to_owned())?
        * multiplier;
    if integer {
        if !n.is_finite() || n.fract() != 0.0 || n < i64::MIN as f64 || n >= u64::MAX as f64 {
            return Err("expected integer".into());
        }
        return Ok(if n < 0.0 {
            json!(n as i64)
        } else {
            json!(n as u64)
        });
    }
    Number::from_f64(n)
        .map(Value::Number)
        .ok_or_else(|| "expected finite number".into())
}

fn object_fields(raw: &str) -> Result<Vec<(String, String)>, String> {
    let mut fields: Vec<(String, String)> = vec![];
    let mut level = None;
    for line in raw.lines().filter(|s| !s.trim().is_empty()) {
        let depth = indent(line);
        if level.is_some_and(|level| depth > level) {
            if let Some((_, value)) = fields.last_mut() {
                value.push('\n');
                value.push_str(line);
            }
        } else {
            let field = assignment(line).ok_or_else(|| "expected object key: value".to_owned())?;
            level = Some(depth);
            fields.push(field);
        }
    }
    if fields.is_empty() {
        return Err("expected object".into());
    }
    Ok(fields)
}

fn coerce(
    raw: &Value,
    schema: &Value,
    root: &Value,
    path: &str,
    warnings: &mut Vec<String>,
    depth: usize,
) -> Result<Value, String> {
    if depth > MAX_DEPTH {
        return Err(format!("{path}: value nesting exceeds 32"));
    }
    let schema = resolve(schema, root, 0)?;
    if schema == &Value::Bool(true) || schema.as_object().is_some_and(Map::is_empty) {
        return Ok(raw.clone());
    }
    if schema == &Value::Bool(false) {
        return Err(format!("{path}: forbidden value"));
    }
    if let Some(branches) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Value::as_array)
    {
        for branch in branches {
            let mut local = vec![];
            if let Ok(value) = coerce(raw, branch, root, path, &mut local, depth + 1) {
                if validate(&value, branch, root, path, depth + 1).is_ok() {
                    warnings.extend(local);
                    return Ok(value);
                }
            }
        }
        return Err(format!("{path}: no schema alternative matched"));
    }
    let choices = types(schema);
    let text = raw.as_str().map(unquote);
    if choices.contains(&"null")
        && (raw.is_null()
            || text.is_some_and(|s| ["null", "none"].contains(&s.to_lowercase().as_str())))
    {
        return Ok(Value::Null);
    }
    let mut last_error = "unsupported schema type".to_owned();
    for kind in choices.iter().filter(|s| **s != "null") {
        let result: Result<Value, String> = match *kind {
            "string" => Ok(Value::String(
                text.map(str::to_owned).unwrap_or_else(|| raw.to_string()),
            )),
            "integer" | "number" => numeric(
                text.map(str::to_owned)
                    .unwrap_or_else(|| raw.to_string())
                    .as_str(),
                *kind == "integer",
            ),
            "boolean" => match text
                .map(str::to_lowercase)
                .unwrap_or_else(|| raw.to_string())
                .as_str()
            {
                "yes" | "true" | "on" => Ok(Value::Bool(true)),
                "no" | "false" | "off" => Ok(Value::Bool(false)),
                _ => Err("expected boolean (yes/no, true/false, on/off)".into()),
            },
            "array" => {
                let values = raw
                    .as_array()
                    .cloned()
                    .or_else(|| text.and_then(|s| serde_json::from_str::<Vec<Value>>(s).ok()))
                    .unwrap_or_else(|| {
                        split_values(text.unwrap_or(""))
                            .into_iter()
                            .map(Value::String)
                            .collect()
                    });
                if !raw.is_array() && text.is_none() {
                    Err("expected array".into())
                } else {
                    let items = schema.get("items").unwrap_or(&Value::Bool(true));
                    values
                        .iter()
                        .enumerate()
                        .map(|(i, v)| {
                            coerce(v, items, root, &format!("{path}[{i}]"), warnings, depth + 1)
                        })
                        .collect::<Result<Vec<_>, _>>()
                        .map(Value::Array)
                }
            }
            "object" => {
                let object = raw.as_object().cloned().or_else(|| {
                    text.and_then(|s| serde_json::from_str::<Map<String, Value>>(s).ok())
                });
                let fields = match object {
                    Some(object) => Ok(object.into_iter().collect()),
                    // Preserve the first child's indentation; trimming only that
                    // line would make sibling keys look like its nested values.
                    None => object_fields(raw.as_str().unwrap_or("")).map(|fields| {
                        fields
                            .into_iter()
                            .map(|(k, v)| (k, Value::String(v)))
                            .collect::<Vec<_>>()
                    }),
                };
                fields
                    .and_then(|fields| {
                        coerce_fields(&fields, schema, root, path, warnings, depth + 1)
                    })
                    .map(Value::Object)
            }
            _ => Err(format!("unsupported schema type {kind}")),
        };
        match result {
            Ok(mut value) => {
                if let Some(enums) = schema.get("enum").and_then(Value::as_array) {
                    if let Some(text) = value.as_str() {
                        if let Some(found) = enums.iter().find(|v| {
                            v.as_str()
                                .is_some_and(|s| s.to_lowercase() == text.to_lowercase())
                        }) {
                            value = found.clone();
                        }
                    }
                    if !enums.contains(&value) {
                        return Err(format!(
                            "{path}: expected one of {}",
                            Value::Array(enums.clone())
                        ));
                    }
                }
                validate(&value, schema, root, path, depth + 1)?;
                return Ok(value);
            }
            Err(error) => last_error = error,
        }
    }
    if choices.is_empty() {
        validate(raw, schema, root, path, depth + 1)?;
        return Ok(raw.clone());
    }
    Err(format!("{path}: {last_error}"))
}

fn coerce_fields(
    fields: &[(String, Value)],
    schema: &Value,
    root: &Value,
    path: &str,
    warnings: &mut Vec<String>,
    depth: usize,
) -> Result<Map<String, Value>, String> {
    let empty = Map::new();
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let mut object = Map::new();
    for (key, raw) in fields {
        if let Some(key) = match_field(key, properties) {
            let value = coerce(
                raw,
                &properties[key],
                root,
                &format!("{path}.{key}"),
                warnings,
                depth + 1,
            )?;
            if object.insert(key.to_owned(), value).is_some() {
                warnings.push(format!("Duplicate field '{path}.{key}'; last value wins"));
            }
        } else if schema.get("additionalProperties") != Some(&Value::Bool(false)) {
            let value = if let Some(extra) = schema.get("additionalProperties") {
                coerce(
                    raw,
                    extra,
                    root,
                    &format!("{path}.{key}"),
                    warnings,
                    depth + 1,
                )?
            } else {
                raw.clone()
            };
            object.insert(key.clone(), value);
        } else {
            warnings.push(format!("Dropped field '{path}.{key}': unknown field"));
        }
    }
    Ok(object)
}

fn validate(
    value: &Value,
    schema: &Value,
    root: &Value,
    path: &str,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err(format!("{path}: schema nesting exceeds 32"));
    }
    let schema = resolve(schema, root, 0)?;
    if schema == &Value::Bool(false) {
        return Err(format!("{path}: forbidden value"));
    }
    if let Some(branches) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Value::as_array)
    {
        let successes = branches
            .iter()
            .filter(|s| validate(value, s, root, path, depth + 1).is_ok())
            .count();
        if successes == 0 || schema.get("oneOf").is_some() && successes != 1 {
            return Err(format!("{path}: no schema alternative matched"));
        }
    }
    if let Some(branches) = schema.get("allOf").and_then(Value::as_array) {
        for branch in branches {
            validate(value, branch, root, path, depth + 1)?;
        }
    }
    let choices = types(schema);
    if !choices.is_empty()
        && !choices.iter().any(|kind| match *kind {
            "string" => value.is_string(),
            "number" => value.is_number(),
            "integer" => {
                value.is_i64() || value.is_u64() || value.as_f64().is_some_and(|n| n.fract() == 0.0)
            }
            "boolean" => value.is_boolean(),
            "array" => value.is_array(),
            "object" => value.is_object(),
            "null" => value.is_null(),
            _ => false,
        })
    {
        return Err(format!("{path}: invalid type"));
    }
    if let Some(enums) = schema.get("enum").and_then(Value::as_array) {
        if !enums.contains(value) {
            return Err(format!("{path}: invalid enum value"));
        }
    }
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            if value.get(key).is_none() {
                return Err(format!("missing {key}"));
            }
        }
    }
    if let Some(object) = value.as_object() {
        for (key, value) in object {
            if let Some(property) = schema.get("properties").and_then(|s| s.get(key)) {
                validate(value, property, root, &format!("{path}.{key}"), depth + 1)?;
            } else if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                return Err(format!("{path}: unknown field {key}"));
            } else if let Some(extra) = schema.get("additionalProperties").filter(|s| s.is_object())
            {
                validate(value, extra, root, &format!("{path}.{key}"), depth + 1)?;
            }
        }
    }
    if let Some(array) = value.as_array() {
        if let Some(items) = schema.get("items") {
            for (i, v) in array.iter().enumerate() {
                validate(v, items, root, &format!("{path}[{i}]"), depth + 1)?;
            }
        }
    }
    if let Some(n) = value.as_f64() {
        if schema
            .get("minimum")
            .and_then(Value::as_f64)
            .is_some_and(|min| n < min)
            || schema
                .get("maximum")
                .and_then(Value::as_f64)
                .is_some_and(|max| n > max)
        {
            return Err(format!("{path}: number outside schema range"));
        }
    }
    Ok(())
}

fn keyword(raw: &str, index: usize) -> Value {
    let mut text = raw.trim().to_owned();
    let mut mode = "stem";
    let mut weight = 1.0;
    for (open, close) in [('(', ')'), ('[', ']')] {
        if text.ends_with(close) {
            if let Some(start) = text.rfind(open) {
                let annotations = text[start + 1..text.len() - 1].to_lowercase();
                let mut recognized = false;
                for annotation in split_values(&annotations) {
                    match annotation.trim() {
                        "exact" => {
                            mode = "exact";
                            recognized = true;
                        }
                        "stem" => {
                            mode = "stem";
                            recognized = true;
                        }
                        other => {
                            if let Some(value) = other
                                .strip_prefix("weight")
                                .map(|s| s.trim().trim_start_matches([':', '=']).trim())
                            {
                                if let Ok(n) = value.parse::<f64>() {
                                    if n.is_finite() {
                                        weight = n;
                                        recognized = true;
                                    }
                                }
                            }
                        }
                    }
                }
                if recognized {
                    text.truncate(start);
                    text = text.trim().to_owned();
                }
            }
        }
    }
    json!({"id":format!("k{index}"),"text":unquote(&text),"weight":weight,"match":mode})
}

fn keyword_values(raw: &Value) -> Vec<Value> {
    let values = raw
        .as_array()
        .cloned()
        .or_else(|| {
            raw.as_str()
                .and_then(|s| serde_json::from_str::<Vec<Value>>(s).ok())
        })
        .unwrap_or_else(|| {
            split_values(raw.as_str().unwrap_or(""))
                .into_iter()
                .map(Value::String)
                .collect()
        });
    values
        .into_iter()
        .enumerate()
        .map(|(i, v)| v.as_str().map(|s| keyword(s, i + 1)).unwrap_or(v))
        .collect()
}

fn rewrite_expression(expression: &str, keywords: &mut Vec<Value>) -> String {
    // Boolean operators and parentheses delimit terms; quotes may contain spaces/operators.
    let mut tokens = vec![];
    let mut term = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut word = String::new();
    let flush_word = |word: &mut String, term: &mut String, tokens: &mut Vec<String>| {
        if word.is_empty() {
            return;
        }
        if ["AND", "OR", "NOT"].contains(&word.to_uppercase().as_str()) {
            if !term.trim().is_empty() {
                tokens.push(term.trim().to_owned());
                term.clear();
            }
            tokens.push(word.to_uppercase());
        } else {
            if !term.is_empty() {
                term.push(' ');
            }
            term.push_str(word);
        }
        word.clear();
    };
    for c in expression.chars() {
        if escaped {
            word.push(c);
            escaped = false;
            continue;
        }
        if let Some(q) = quote {
            word.push(c);
            if c == '\\' {
                escaped = true;
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\"' | '\'' | '`' => {
                quote = Some(c);
                word.push(c);
            }
            '(' | ')' => {
                flush_word(&mut word, &mut term, &mut tokens);
                if !term.trim().is_empty() {
                    tokens.push(term.trim().to_owned());
                    term.clear();
                }
                tokens.push(c.to_string());
            }
            c if c.is_whitespace() => flush_word(&mut word, &mut term, &mut tokens),
            _ => word.push(c),
        }
    }
    flush_word(&mut word, &mut term, &mut tokens);
    if !term.trim().is_empty() {
        tokens.push(term.trim().to_owned());
    }
    for token in &mut tokens {
        if ["AND", "OR", "NOT", "(", ")"].contains(&token.as_str()) {
            continue;
        }
        let text = unquote(token);
        if keywords
            .iter()
            .any(|v| v.get("id").and_then(Value::as_str) == Some(text))
        {
            continue;
        }
        // Unknown id-shaped terms are left for the tool's expression validator.
        if text
            .strip_prefix('k')
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
        {
            continue;
        }
        if let Some(id) = keywords
            .iter()
            .find(|v| {
                v.get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.eq_ignore_ascii_case(text))
            })
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
        {
            *token = id.to_owned();
        } else {
            let mut index = keywords.len() + 1;
            while keywords
                .iter()
                .any(|v| v.get("id").and_then(Value::as_str) == Some(&format!("k{index}")))
            {
                index += 1;
            }
            let value = keyword(text, index);
            *token = format!("k{index}");
            keywords.push(value);
        }
    }
    tokens.join(" ").replace("( ", "(").replace(" )", ")")
}

fn convert(
    instruction: &RawInstruction,
    tool: &ToolDefinition,
    ctx: &InstructionContext,
    warnings: &mut Vec<String>,
) -> Result<Value, String> {
    let root = &tool.input_schema;
    let resolved = resolve(root, root, 0)?;
    // Prefer the union branch with the most recognized model fields. In particular,
    // keyword search must not silently fall back to an empty legacy query on failure.
    let schema = if let Some(branches) = resolved
        .get("anyOf")
        .or_else(|| resolved.get("oneOf"))
        .and_then(Value::as_array)
    {
        branches
            .iter()
            .max_by_key(|branch| {
                branch
                    .get("properties")
                    .and_then(Value::as_object)
                    .map(|properties| {
                        instruction
                            .fields
                            .iter()
                            .filter(|(k, _)| match_field(k, properties).is_some())
                            .count()
                    })
                    .unwrap_or(0)
            })
            .unwrap_or(resolved)
    } else {
        resolved
    };
    let schema = resolve(schema, root, 0)?;
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| "tool schema has no object properties".to_owned())?;
    let mut fields = Map::new();
    for (key, value) in &instruction.fields {
        if let Some(key) = match_field(key, properties) {
            if fields
                .insert(key.to_owned(), Value::String(value.clone()))
                .is_some()
            {
                warnings.push(format!("Duplicate field '{key}'; last value wins"));
            }
        } else {
            warnings.push(format!("Dropped field '{key}': unknown field"));
        }
    }
    if properties.contains_key("run_id") {
        if fields
            .get("run_id")
            .is_some_and(|v| v.as_str().map(unquote) != Some(ctx.run_id.as_str()))
        {
            warnings.push("Model run_id overridden with the current run_id".into());
        }
        fields.insert("run_id".into(), Value::String(ctx.run_id.clone()));
    }
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            if !fields.contains_key(key) {
                if let Some(value) = ctx.extra.get(key) {
                    fields.insert(key.to_owned(), value.clone());
                }
            }
        }
    }
    if tool.name == "search_mid" && fields.contains_key("keywords") {
        let mut keywords = keyword_values(&fields["keywords"]);
        if let Some(expression) = fields.get("expression").and_then(Value::as_str) {
            if !["none", "null"].contains(&unquote(expression).to_lowercase().as_str()) {
                let rewritten = rewrite_expression(unquote(expression), &mut keywords);
                fields.insert("expression".into(), Value::String(rewritten));
            }
        }
        fields.insert("keywords".into(), Value::Array(keywords));
    }
    let arguments = Value::Object(coerce_fields(
        &fields.into_iter().collect::<Vec<_>>(),
        schema,
        root,
        "arguments",
        warnings,
        0,
    )?);
    validate(&arguments, schema, root, "arguments", 0)?;
    validate(&arguments, root, root, "arguments", 0)?;
    Ok(arguments)
}

fn bounded_feedback(lines: &[String]) -> String {
    let text = lines.join("\n");
    if text.len() <= 1200 {
        return text;
    }
    let mut end = 1197;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut result = text[..end].to_owned();
    result.push_str("...");
    result
}

/// Convert only allowlisted actions, inject trusted context and validate locally.
pub fn to_tool_calls(
    reply: &ParsedReply,
    allowed: &[&str],
    catalog: &[ToolDefinition],
    ctx: &InstructionContext,
) -> ConversionReport {
    let mut report = ConversionReport::default();
    let mut feedback = vec![];
    for instruction in &reply.instructions {
        let mut warnings = vec![];
        let matched = match_action(&instruction.name_text, allowed);
        // Exact catalog names that are disallowed may not fuzzy-match a different tool.
        let disallowed = catalog.iter().any(|t| {
            normalize(t.name) == normalize(&instruction.name_text) && !allowed.contains(&t.name)
        });
        let result = if disallowed {
            Err(format!(
                "unknown action '{}'; allowed: {}",
                instruction.name_text,
                allowed.join(", ")
            ))
        } else if let Some(tool) = matched.and_then(|name| catalog.iter().find(|t| t.name == name))
        {
            convert(instruction, tool, ctx, &mut warnings).map(|arguments| ConvertedCall {
                index: instruction.index,
                tool: tool.name.to_owned(),
                arguments,
                warnings: warnings.clone(),
            })
        } else {
            Err(format!(
                "unknown action '{}'; allowed: {}",
                instruction.name_text,
                allowed.join(", ")
            ))
        };
        for warning in warnings.iter().filter(|s| s.starts_with("Dropped field")) {
            feedback.push(format!("Instruction {}: {warning}.", instruction.index));
        }
        match result {
            Ok(call) => report.calls.push(call),
            Err(reason) => {
                let feedback_reason = reason.replace("; allowed: ", ". Allowed actions: ");
                feedback.push(format!(
                    "Instruction {} was not run: {feedback_reason}.",
                    instruction.index
                ));
                report.rejected.push(Rejection {
                    index: instruction.index,
                    name_text: instruction.name_text.clone(),
                    reason,
                });
            }
        }
    }
    for fragment in &reply.unparsed {
        feedback.push(format!(
            "Unused fragment: {}",
            fragment.chars().take(160).collect::<String>()
        ));
    }
    report.feedback = bounded_feedback(&feedback);
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_split_keeps_quotes_and_parentheses() {
        assert_eq!(
            split_values("\"a,b\"; insurer* (exact, weight 2)\n- policy"),
            vec!["\"a,b\"", "insurer* (exact, weight 2)", "policy"]
        );
    }

    #[test]
    fn local_reference_supports_definitions_and_escaped_pointers() {
        let schema = json!({"definitions":{"a/b":{"type":"integer"}},"$ref":"#/definitions/a~1b"});
        assert_eq!(resolve(&schema, &schema, 0).unwrap()["type"], "integer");
    }

    #[test]
    fn cyclic_reference_is_bounded() {
        let schema = json!({"$ref":"#"});
        assert!(resolve(&schema, &schema, 0).is_err());
    }

    #[test]
    fn edit_distance_unicode() {
        assert_eq!(distance("search_mid", "serch_mid"), 1);
        assert_eq!(distance("é", "e"), 1);
    }

    #[test]
    fn fractional_integer_is_rejected() {
        assert!(numeric("1.2", true).is_err());
        assert!(numeric("NaN", false).is_err());
    }
}
