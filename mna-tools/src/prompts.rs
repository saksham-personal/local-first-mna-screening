use crate::error::{Error, Result};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

const START_MARKER: &str = "===@@=== STARTING ===@@===";
const END_MARKER: &str = "===@@=== END ===@@===";
const FIELDS: [&str; 7] = [
    "ID",
    "Description",
    "What it does",
    "Context",
    "Inputs",
    "Output",
    "Version",
];

#[derive(Clone, Debug)]
struct PromptFailure {
    code: &'static str,
    file: Option<String>,
    line: Option<usize>,
    message: String,
}

impl PromptFailure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            file: None,
            line: None,
            message: message.into(),
        }
    }

    fn at(code: &'static str, message: impl Into<String>, file: &str, line: Option<usize>) -> Self {
        Self {
            code,
            file: Some(file.to_owned()),
            line,
            message: message.into(),
        }
    }

    fn into_error(self) -> Error {
        let mut message = format!("[prompt code: {}] ", self.code);
        if let Some(file) = self.file {
            message.push_str(&file);
            if let Some(line) = self.line {
                message.push_str(&format!(":{line}"));
            }
            message.push_str(": ");
        }
        message.push_str(&self.message);
        if self.code == "not_found" {
            Error::NotFound(message)
        } else {
            Error::Validation(message)
        }
    }
}

#[derive(Clone, Debug)]
struct Prompt {
    id: String,
    file: String,
    summary: String,
    description: String,
    context: String,
    output: String,
    version: u32,
    inputs: Vec<Input>,
    tree: Vec<Node>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptMetadata {
    pub id: String,
    pub summary: String,
    pub description: String,
    pub context: String,
    pub output: String,
    pub version: u32,
}

/// Read the descriptive header for a prompt using the same override and cache as rendering.
pub fn metadata(id: &str) -> Result<PromptMetadata> {
    let prompt = load_prompt(id)?;
    Ok(PromptMetadata {
        id: prompt.id.clone(),
        summary: prompt.summary.clone(),
        description: prompt.description.clone(),
        context: prompt.context.clone(),
        output: prompt.output.clone(),
        version: prompt.version,
    })
}

#[derive(Clone, Debug)]
struct Input {
    name: String,
    required: bool,
}

#[derive(Clone, Debug)]
enum Node {
    Text(String),
    Variable(String),
    Section { name: String, children: Vec<Node> },
}

#[derive(Clone, Debug)]
enum Token {
    Text(String),
    Variable(String),
    Open(String),
    Close(String),
}

#[derive(Clone, Debug)]
enum InputValue {
    String(String),
    Number(String),
    Null,
    Invalid,
}

type CachedPrompt = std::result::Result<Prompt, PromptFailure>;
static PROMPT_CACHE: OnceLock<Mutex<HashMap<String, CachedPrompt>>> = OnceLock::new();

/// Render a prompt from `prompts/`. Rust callers pass string values; optional values may be
/// omitted or passed as an empty string.
pub fn render(id: &str, vars: &[(&str, &str)]) -> Result<String> {
    let values = vars
        .iter()
        .map(|(name, value)| ((*name).to_owned(), InputValue::String((*value).to_owned())))
        .collect::<Vec<_>>();
    render_values(id, values)
}

/// Render using JSON values, preserving the JavaScript prompt engine's input type checks.
/// This is also used by the shared Rust/JavaScript conformance fixtures.
#[doc(hidden)]
pub fn render_with_values(id: &str, vars: &Value) -> Result<String> {
    let prompt = load_prompt(id)?;
    let values = vars.as_object().ok_or_else(|| {
        PromptFailure::at(
            "bad_value",
            "Prompt inputs must be an object of strings.",
            &prompt.file,
            None,
        )
        .into_error()
    })?;
    let values = values
        .iter()
        .map(|(name, value)| {
            let value = match value {
                Value::String(value) => InputValue::String(value.clone()),
                Value::Number(value) => InputValue::Number(number_to_string(value)),
                Value::Null => InputValue::Null,
                _ => InputValue::Invalid,
            };
            (name.clone(), value)
        })
        .collect();
    render_loaded(&prompt, values)
}

fn render_values(id: &str, values: Vec<(String, InputValue)>) -> Result<String> {
    let prompt = load_prompt(id)?;
    render_loaded(&prompt, values)
}

fn render_loaded(prompt: &Prompt, values: Vec<(String, InputValue)>) -> Result<String> {
    let fail =
        |code, message: String| PromptFailure::at(code, message, &prompt.file, None).into_error();
    let declared = prompt
        .inputs
        .iter()
        .map(|input| input.name.as_str())
        .collect::<HashSet<_>>();
    for (name, _) in &values {
        if !declared.contains(name.as_str()) {
            let input_names = if prompt.inputs.is_empty() {
                "none".to_owned()
            } else {
                prompt
                    .inputs
                    .iter()
                    .map(|input| input.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            return Err(fail(
                "unknown_input",
                format!(
                    "Unknown input \"{name}\" for prompt \"{}\". Declared inputs: {input_names}.",
                    prompt.id
                ),
            ));
        }
    }

    let supplied = values.into_iter().collect::<HashMap<_, _>>();
    let mut rendered_values = HashMap::new();
    for input in &prompt.inputs {
        let value = match supplied.get(&input.name) {
            None | Some(InputValue::Null) => String::new(),
            Some(InputValue::String(value)) | Some(InputValue::Number(value)) => value.clone(),
            Some(InputValue::Invalid) => {
                return Err(fail(
                    "bad_value",
                    format!(
                        "Input \"{}\" for prompt \"{}\" must be a string.",
                        input.name, prompt.id
                    ),
                ));
            }
        };
        if trim_js(&value).is_empty() {
            if input.required {
                return Err(fail(
                    "missing_input",
                    format!(
                        "Required input \"{}\" for prompt \"{}\" is missing or blank.",
                        input.name, prompt.id
                    ),
                ));
            }
            rendered_values.insert(input.name.clone(), String::new());
        } else {
            rendered_values.insert(input.name.clone(), value);
        }
    }

    let mut output = String::new();
    render_nodes(&prompt.tree, &rendered_values, &mut output);
    Ok(output)
}

fn render_nodes(nodes: &[Node], values: &HashMap<String, String>, output: &mut String) {
    for node in nodes {
        match node {
            Node::Text(text) => output.push_str(text),
            Node::Variable(name) => {
                if let Some(value) = values.get(name) {
                    output.push_str(value);
                }
            }
            Node::Section { name, children } => {
                if values.get(name).is_some_and(|value| !value.is_empty()) {
                    render_nodes(children, values, output);
                }
            }
        }
    }
}

fn number_to_string(value: &serde_json::Number) -> String {
    if let Some(value) = value.as_i64() {
        return value.to_string();
    }
    if let Some(value) = value.as_u64() {
        return value.to_string();
    }
    if let Some(value) = value.as_f64() {
        if value == 0.0 {
            return "0".to_owned();
        }
        if value.fract() == 0.0 && value.abs() < 1.0e21 {
            return format!("{value:.0}");
        }
    }
    value.to_string()
}

fn load_prompt(id: &str) -> Result<Prompt> {
    if !valid_prompt_id(id) {
        return Err(
            PromptFailure::new("bad_id", format!("\"{id}\" is not a valid prompt id."))
                .into_error(),
        );
    }

    let cache = PROMPT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = cache
        .lock()
        .map_err(|_| Error::Internal("prompt cache lock was poisoned".into()))?;
    if let Some(prompt) = cache.get(id) {
        return prompt.clone().map_err(PromptFailure::into_error);
    }

    let parsed = read_and_parse_prompt(id)?;
    cache.insert(id.to_owned(), parsed.clone());
    parsed.map_err(PromptFailure::into_error)
}

fn read_and_parse_prompt(id: &str) -> Result<CachedPrompt> {
    let file = format!("{id}.md");
    let override_dir = std::env::var("MNA_PROMPTS_DIR")
        .ok()
        .map(|value| trim_js(&value).to_owned())
        .filter(|value| !value.is_empty());
    let override_path = override_dir.map(|directory| PathBuf::from(directory).join(&file));
    let source = if let Some(path) = &override_path {
        match fs::read_to_string(path) {
            Ok(source) => Some(source),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(Error::Io(error)),
        }
    } else {
        None
    };
    let source = match source {
        Some(source) => source,
        None => match embedded_prompt(id) {
            Some(source) => source.to_owned(),
            None => {
                let path = match override_path {
                    Some(path) => path,
                    None => std::env::current_dir()
                        .map_err(Error::Io)?
                        .join("prompts")
                        .join(&file),
                };
                return Ok(Err(PromptFailure::at(
                    "not_found",
                    format!("Prompt file not found: {}", path.display()),
                    &file,
                    None,
                )));
            }
        },
    };

    let prompt = match parse_prompt_file(&source, &file) {
        Ok(prompt) => prompt,
        Err(error) => return Ok(Err(error)),
    };
    if format!("{}.md", prompt.id) != file {
        return Ok(Err(PromptFailure::at(
            "bad_header",
            format!("The ID \"{}\" must match the file name.", prompt.id),
            &file,
            None,
        )));
    }
    Ok(Ok(prompt))
}

fn embedded_prompt(id: &str) -> Option<&'static str> {
    Some(match id {
        "batch-repair" => include_str!("../../prompts/batch-repair.md"),
        "bing-query-writer" => include_str!("../../prompts/bing-query-writer.md"),
        "controller-tools" => include_str!("../../prompts/controller-tools.md"),
        "controller-instruction-set" => include_str!("../../prompts/controller-instruction-set.md"),
        "instruction-feedback" => include_str!("../../prompts/instruction-feedback.md"),
        "conversation-handoff" => include_str!("../../prompts/conversation-handoff.md"),
        "controller-loop" => include_str!("../../prompts/controller-loop.md"),
        "controller-loop-turn" => include_str!("../../prompts/controller-loop-turn.md"),
        "controller-loop-budget" => include_str!("../../prompts/controller-loop-budget.md"),
        "criteria-from-examples" => include_str!("../../prompts/criteria-from-examples.md"),
        "criteria-from-research" => include_str!("../../prompts/criteria-from-research.md"),
        "direct-question" => include_str!("../../prompts/direct-question.md"),
        "format-repair" => include_str!("../../prompts/format-repair.md"),
        "intake-form-extraction" => include_str!("../../prompts/intake-form-extraction.md"),
        "mid-search-planner" => include_str!("../../prompts/mid-search-planner.md"),
        "output-contract" => include_str!("../../prompts/output-contract.md"),
        "screening-prompt-writer" => include_str!("../../prompts/screening-prompt-writer.md"),
        "screening-question" => include_str!("../../prompts/screening-question.md"),
        "screening-scored" => include_str!("../../prompts/screening-scored.md"),
        "tool-command-repair" => include_str!("../../prompts/tool-command-repair.md"),
        _ => return None,
    })
}

fn valid_prompt_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[derive(Clone)]
struct HeaderField {
    value: String,
    line: usize,
}

fn parse_prompt_file(text: &str, file: &str) -> std::result::Result<Prompt, PromptFailure> {
    let text = text
        .strip_prefix('\u{feff}')
        .unwrap_or(text)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let lines = text.split('\n').collect::<Vec<_>>();
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = trim_end_js(line);
        if trimmed == START_MARKER {
            starts.push(index);
        } else if trimmed == END_MARKER {
            ends.push(index);
        } else if line.contains("===@@===") {
            return Err(PromptFailure::at(
                "bad_marker",
                format!("Malformed marker. Use exactly \"{START_MARKER}\" and \"{END_MARKER}\"."),
                file,
                Some(index + 1),
            ));
        }
    }
    if starts.is_empty() {
        return Err(PromptFailure::at(
            "missing_marker",
            format!("Missing the start marker \"{START_MARKER}\"."),
            file,
            None,
        ));
    }
    if ends.is_empty() {
        return Err(PromptFailure::at(
            "missing_marker",
            format!("Missing the end marker \"{END_MARKER}\"."),
            file,
            None,
        ));
    }
    if starts.len() > 1 {
        return Err(PromptFailure::at(
            "duplicate_marker",
            "More than one start marker; a file holds exactly one prompt.",
            file,
            Some(starts[1] + 1),
        ));
    }
    if ends.len() > 1 {
        return Err(PromptFailure::at(
            "duplicate_marker",
            "More than one end marker; a file holds exactly one prompt.",
            file,
            Some(ends[1] + 1),
        ));
    }
    if ends[0] < starts[0] {
        return Err(PromptFailure::at(
            "missing_marker",
            "The end marker comes before the start marker.",
            file,
            Some(ends[0] + 1),
        ));
    }
    if let Some(index) = lines
        .iter()
        .enumerate()
        .find_map(|(index, line)| (index > ends[0] && !trim_js(line).is_empty()).then_some(index))
    {
        return Err(PromptFailure::at(
            "bad_header",
            "Text after the end marker. Only the text between the markers is the prompt.",
            file,
            Some(index + 1),
        ));
    }

    let header = &lines[..starts[0]];
    let title_index = header.iter().position(|line| !trim_js(line).is_empty());
    let Some(title_index) = title_index else {
        return Err(PromptFailure::at(
            "bad_header",
            "The file must begin with a \"# Title\" line.",
            file,
            Some(1),
        ));
    };
    let title_line = header[title_index];
    if !valid_title_line(title_line) {
        return Err(PromptFailure::at(
            "bad_header",
            "The file must begin with a \"# Title\" line.",
            file,
            Some(title_index + 1),
        ));
    }
    let _title = trim_js(&title_line[2..]);

    let mut fields: HashMap<String, HeaderField> = HashMap::new();
    let mut current: Option<String> = None;
    let mut field_index = 0;
    for (index, line) in header.iter().enumerate().skip(title_index + 1) {
        if trim_js(line).is_empty() {
            current = None;
            continue;
        }
        if let Some((name, value)) = parse_header_field(line) {
            let name = trim_js(name).to_owned();
            if !FIELDS.contains(&name.as_str()) {
                return Err(PromptFailure::at(
                    "bad_header",
                    format!(
                        "Unknown description field \"{name}\". Use: {}.",
                        FIELDS.join(", ")
                    ),
                    file,
                    Some(index + 1),
                ));
            }
            if fields.contains_key(&name) {
                return Err(PromptFailure::at(
                    "bad_header",
                    format!("The description field \"{name}\" appears twice."),
                    file,
                    Some(index + 1),
                ));
            }
            if name != FIELDS[field_index] {
                return Err(PromptFailure::at(
                    "bad_header",
                    format!(
                        "Expected description field \"{}\" before \"{name}\".",
                        FIELDS[field_index]
                    ),
                    file,
                    Some(index + 1),
                ));
            }
            field_index += 1;
            fields.insert(
                name.clone(),
                HeaderField {
                    value: trim_js(value).to_owned(),
                    line: index + 1,
                },
            );
            current = Some(name);
        } else if let Some(name) = &current {
            if let Some(field) = fields.get_mut(name) {
                field.value.push(' ');
                field.value.push_str(trim_js(line));
            }
        } else {
            return Err(PromptFailure::at(
                "bad_header",
                "Unexpected text in the description block. Use **Field:** lines only.",
                file,
                Some(index + 1),
            ));
        }
    }
    for name in FIELDS {
        if fields
            .get(name)
            .is_none_or(|field| trim_js(&field.value).is_empty())
        {
            return Err(PromptFailure::at(
                "bad_header",
                format!("Missing or empty description field \"{name}\"."),
                file,
                fields.get(name).map(|field| field.line),
            ));
        }
    }

    let id = fields["ID"].value.clone();
    if !valid_prompt_id(&id) {
        return Err(PromptFailure::at(
            "bad_header",
            format!("The ID \"{id}\" must use lowercase letters, digits and hyphens."),
            file,
            Some(fields["ID"].line),
        ));
    }
    let version = fields["Version"].value.as_str();
    if version.is_empty()
        || version.len() > 6
        || version.starts_with('0')
        || !version.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(PromptFailure::at(
            "bad_header",
            "The Version must be a whole number of 1 or more.",
            file,
            Some(fields["Version"].line),
        ));
    }

    let inputs = parse_inputs(&fields["Inputs"].value, file, fields["Inputs"].line)?;
    let body = lines[starts[0] + 1..ends[0]].join("\n");
    let body_line = starts[0] + 2;
    let written = tokenize(&body, file, body_line)?;
    let _written_tree = build_tree(written.clone(), file, body_line, &body)?;
    let mut declared = HashSet::new();
    for input in &inputs {
        declared.insert(input.name.as_str());
    }
    let mut used = HashSet::new();
    let mut offset = 0;
    for token in &written {
        let name = match token {
            Token::Text(text) => {
                offset += text.len();
                continue;
            }
            Token::Variable(name) | Token::Open(name) | Token::Close(name) => name,
        };
        if !declared.contains(name.as_str()) {
            return Err(fail_body(
                "undeclared_placeholder",
                format!("The placeholder \"{name}\" is not declared in Inputs."),
                file,
                body_line,
                &body,
                offset,
            ));
        }
        used.insert(name.as_str());
        offset += match token {
            Token::Variable(name) => name.len() + 4,
            Token::Open(name) | Token::Close(name) => name.len() + 5,
            Token::Text(_) => unreachable!(),
        };
    }
    for input in &inputs {
        if !used.contains(input.name.as_str()) {
            return Err(PromptFailure::at(
                "unused_input",
                format!(
                    "Input \"{}\" is declared in Inputs but never used in the prompt.",
                    input.name
                ),
                file,
                Some(fields["Inputs"].line),
            ));
        }
    }

    let render_body = remove_standalone_section_lines(&body);
    let tokens = tokenize(&render_body, file, body_line)?;
    let tree = build_tree(tokens, file, body_line, &render_body)?;
    Ok(Prompt {
        id,
        file: file.to_owned(),
        summary: fields["Description"].value.clone(),
        description: fields["What it does"].value.clone(),
        context: fields["Context"].value.clone(),
        output: fields["Output"].value.clone(),
        version: version.parse().expect("validated prompt version"),
        inputs,
        tree,
    })
}

fn valid_title_line(line: &str) -> bool {
    line.strip_prefix("# ")
        .and_then(|title| title.chars().next())
        .is_some_and(|first| !is_js_whitespace(first))
}

fn parse_header_field(line: &str) -> Option<(&str, &str)> {
    let body = line.strip_prefix("**")?;
    let colon = body.find(':')?;
    let name = &body[..colon];
    if name.is_empty() || name.contains('*') {
        return None;
    }
    let value = body.get(colon + 3..)?;
    if !body[colon..].starts_with(":**") {
        return None;
    }
    Some((name, value))
}

fn parse_inputs(
    raw: &str,
    file: &str,
    line: usize,
) -> std::result::Result<Vec<Input>, PromptFailure> {
    if raw.eq_ignore_ascii_case("none") || raw.eq_ignore_ascii_case("none.") {
        return Ok(Vec::new());
    }
    let matches = input_matches(raw);
    if matches.is_empty() {
        return Err(PromptFailure::at(
            "bad_inputs",
            "Inputs must be \"none\" or a list such as `{{name}}` (required) – what it holds.",
            file,
            Some(line),
        ));
    }
    if !trim_js(&raw[..matches[0].start]).is_empty() {
        return Err(PromptFailure::at(
            "bad_inputs",
            "Unexpected text before the first input.",
            file,
            Some(line),
        ));
    }

    let mut inputs = Vec::new();
    for (index, matched) in matches.iter().enumerate() {
        if inputs
            .iter()
            .any(|input: &Input| input.name == matched.name)
        {
            return Err(PromptFailure::at(
                "bad_inputs",
                format!("Input \"{}\" is listed twice.", matched.name),
                file,
                Some(line),
            ));
        }
        let end = matches
            .get(index + 1)
            .map(|next| next.start)
            .unwrap_or(raw.len());
        let description = trim_js(trim_description_prefix(&raw[matched.end..end]));
        if description.is_empty() {
            return Err(PromptFailure::at(
                "bad_inputs",
                format!(
                    "Describe input \"{}\" after its (required) or (optional) mark.",
                    matched.name
                ),
                file,
                Some(line),
            ));
        }
        inputs.push(Input {
            name: matched.name.clone(),
            required: matched.required,
        });
    }
    Ok(inputs)
}

struct InputMatch {
    start: usize,
    end: usize,
    name: String,
    required: bool,
}

fn input_matches(raw: &str) -> Vec<InputMatch> {
    let mut matches = Vec::new();
    let mut search_from = 0;
    while let Some(relative) = raw[search_from..].find('`') {
        let start = search_from + relative;
        let mut at = start + 1;
        if !raw[at..].starts_with("{{") {
            search_from = at;
            continue;
        }
        at += 2;
        let name_start = at;
        let Some(first) = raw[at..].chars().next() else {
            break;
        };
        if !first.is_ascii_lowercase() {
            search_from = start + 1;
            continue;
        }
        at += first.len_utf8();
        while let Some(character) = raw[at..].chars().next() {
            if character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_' {
                at += character.len_utf8();
            } else {
                break;
            }
        }
        let name = raw[name_start..at].to_owned();
        if !raw[at..].starts_with("}}`") {
            search_from = start + 1;
            continue;
        }
        at += 3;
        while let Some(character) = raw[at..].chars().next() {
            if is_js_whitespace(character) {
                at += character.len_utf8();
            } else {
                break;
            }
        }
        let (required, suffix) = if raw[at..].starts_with("(required)") {
            (true, "(required)".len())
        } else if raw[at..].starts_with("(optional)") {
            (false, "(optional)".len())
        } else {
            search_from = start + 1;
            continue;
        };
        at += suffix;
        matches.push(InputMatch {
            start,
            end: at,
            name,
            required,
        });
        search_from = at;
    }
    matches
}

fn trim_description_prefix(value: &str) -> &str {
    let mut at = 0;
    for character in value.chars() {
        if is_js_whitespace(character) {
            at += character.len_utf8();
        } else {
            break;
        }
    }
    let dashes_start = at;
    while let Some(character) = value[at..].chars().next() {
        if matches!(character, '–' | '—' | '-') {
            at += character.len_utf8();
        } else {
            break;
        }
    }
    if at == dashes_start {
        trim_end_matches_js_or_semicolon(value)
    } else {
        while let Some(character) = value[at..].chars().next() {
            if is_js_whitespace(character) {
                at += character.len_utf8();
            } else {
                break;
            }
        }
        trim_end_matches_js_or_semicolon(&value[at..])
    }
}

fn trim_end_matches_js_or_semicolon(value: &str) -> &str {
    value.trim_end_matches(|character| is_js_whitespace(character) || character == ';')
}

fn tokenize(
    source: &str,
    file: &str,
    body_line: usize,
) -> std::result::Result<Vec<Token>, PromptFailure> {
    let mut tokens = Vec::new();
    let mut last = 0;
    while let Some(relative) = source[last..].find("{{") {
        let at = last + relative;
        let Some((token, end)) = parse_token(source, at) else {
            return Err(fail_body(
                "bad_placeholder",
                "Malformed placeholder. Use {{name}}, {{#name}} or {{/name}} with lowercase letters, digits and underscores.",
                file,
                body_line,
                source,
                at,
            ));
        };
        if at > last {
            tokens.push(Token::Text(source[last..at].to_owned()));
        }
        tokens.push(token);
        last = end;
    }
    if last < source.len() {
        tokens.push(Token::Text(source[last..].to_owned()));
    }
    Ok(tokens)
}

fn parse_token(source: &str, at: usize) -> Option<(Token, usize)> {
    let mut cursor = at + 2;
    let kind = match source[cursor..].chars().next()? {
        '#' => {
            cursor += 1;
            1
        }
        '/' => {
            cursor += 1;
            2
        }
        _ => 0,
    };
    let name_start = cursor;
    let first = source[cursor..].chars().next()?;
    if !first.is_ascii_lowercase() {
        return None;
    }
    cursor += first.len_utf8();
    while let Some(character) = source[cursor..].chars().next() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_' {
            cursor += character.len_utf8();
        } else {
            break;
        }
    }
    if !source[cursor..].starts_with("}}") {
        return None;
    }
    let name = source[name_start..cursor].to_owned();
    cursor += 2;
    let token = match kind {
        1 => Token::Open(name),
        2 => Token::Close(name),
        _ => Token::Variable(name),
    };
    Some((token, cursor))
}

fn build_tree(
    tokens: Vec<Token>,
    file: &str,
    body_line: usize,
    body: &str,
) -> std::result::Result<Vec<Node>, PromptFailure> {
    struct Frame {
        name: Option<String>,
        at: usize,
        children: Vec<Node>,
    }
    let mut stack = vec![Frame {
        name: None,
        at: 0,
        children: Vec::new(),
    }];
    let mut offset = 0;
    for token in tokens {
        let token_len = match &token {
            Token::Text(text) => {
                stack
                    .last_mut()
                    .expect("root frame")
                    .children
                    .push(Node::Text(text.clone()));
                text.len()
            }
            Token::Variable(name) => {
                stack
                    .last_mut()
                    .expect("root frame")
                    .children
                    .push(Node::Variable(name.clone()));
                name.len() + 4
            }
            Token::Open(name) => {
                if stack
                    .iter()
                    .any(|frame| frame.name.as_deref() == Some(name.as_str()))
                {
                    return Err(fail_body(
                        "unbalanced_section",
                        format!("Section {{{{#{name}}}}} is nested inside itself."),
                        file,
                        body_line,
                        body,
                        offset,
                    ));
                }
                if stack.len() > 2 {
                    return Err(fail_body(
                        "section_depth",
                        "Sections can be nested one level deep at most.",
                        file,
                        body_line,
                        body,
                        offset,
                    ));
                }
                stack.push(Frame {
                    name: Some(name.clone()),
                    at: offset,
                    children: Vec::new(),
                });
                name.len() + 5
            }
            Token::Close(name) => {
                if stack.last().and_then(|frame| frame.name.as_deref()) != Some(name.as_str()) {
                    let top = stack.last().and_then(|frame| frame.name.as_deref());
                    let message = if let Some(open) = top {
                        format!("Closing tag {{{{/{name}}}}} does not match the open section {{{{#{open}}}}}.")
                    } else {
                        format!("Closing tag {{{{/{name}}}}} has no matching {{{{#{name}}}}}.")
                    };
                    return Err(fail_body(
                        "unbalanced_section",
                        message,
                        file,
                        body_line,
                        body,
                        offset,
                    ));
                }
                let frame = stack.pop().expect("matching section frame");
                stack
                    .last_mut()
                    .expect("root frame")
                    .children
                    .push(Node::Section {
                        name: frame.name.expect("section frame name"),
                        children: frame.children,
                    });
                name.len() + 5
            }
        };
        offset += token_len;
    }
    if stack.len() > 1 {
        let frame = stack.last().expect("open section frame");
        let name = frame.name.as_deref().unwrap_or_default();
        return Err(fail_body(
            "unbalanced_section",
            format!("Section {{{{#{name}}}}} is never closed."),
            file,
            body_line,
            body,
            frame.at,
        ));
    }
    Ok(stack.pop().expect("root frame").children)
}

fn remove_standalone_section_lines(body: &str) -> String {
    let mut output = String::with_capacity(body.len());
    for line in body.split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line);
        if let Some(tag) = standalone_section_tag(content) {
            output.push_str(tag);
        } else {
            output.push_str(line);
        }
    }
    output
}

fn standalone_section_tag(line: &str) -> Option<&str> {
    let start = line
        .bytes()
        .take_while(|byte| matches!(byte, b' ' | b'\t'))
        .count();
    let end = line
        .bytes()
        .rev()
        .take_while(|byte| matches!(byte, b' ' | b'\t'))
        .count();
    let tag_end = line.len().checked_sub(end)?;
    let tag = line.get(start..tag_end)?;
    if tag.starts_with("{{#") || tag.starts_with("{{/") {
        parse_token(tag, 0).and_then(|(token, consumed)| {
            (consumed == tag.len() && !matches!(token, Token::Variable(_))).then_some(tag)
        })
    } else {
        None
    }
}

fn fail_body(
    code: &'static str,
    message: impl Into<String>,
    file: &str,
    body_line: usize,
    body: &str,
    offset: usize,
) -> PromptFailure {
    let line = body[..offset.min(body.len())]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
        + body_line;
    PromptFailure::at(code, message, file, Some(line))
}

fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000a}'
            | '\u{000b}'
            | '\u{000c}'
            | '\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn trim_js(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

fn trim_end_js(value: &str) -> &str {
    value.trim_end_matches(is_js_whitespace)
}

#[cfg(test)]
mod tests {
    use super::{embedded_prompt, parse_prompt_file};

    #[test]
    fn every_embedded_prompt_parses() {
        let ids = [
            "batch-repair",
            "bing-query-writer",
            "controller-tools",
            "controller-instruction-set",
            "instruction-feedback",
            "conversation-handoff",
            "controller-loop",
            "controller-loop-turn",
            "controller-loop-budget",
            "criteria-from-examples",
            "criteria-from-research",
            "direct-question",
            "format-repair",
            "intake-form-extraction",
            "mid-search-planner",
            "output-contract",
            "screening-prompt-writer",
            "screening-question",
            "screening-scored",
            "tool-command-repair",
        ];
        for id in ids {
            let source = embedded_prompt(id).expect("embedded prompt");
            parse_prompt_file(source, &format!("{id}.md"))
                .unwrap_or_else(|error| panic!("{id}: {}", error.message));
        }
    }
}
