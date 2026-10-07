use mna_tools::{error::Error, prompts};
use serde_json::{json, Value};
use std::{fs, path::Path};

fn prompt_error_code(error: &Error) -> Option<String> {
    let message = error.to_string();
    let code = message.strip_prefix("[prompt code: ")?;
    code.split_once(']').map(|(code, _)| code.to_owned())
}

fn fixture_vars(case: &Value) -> Value {
    case.get("vars").cloned().unwrap_or_else(|| json!({}))
}

#[test]
fn rust_prompt_engine_matches_shared_conformance_fixtures() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let engine_path = root.join("../mna-ui/tests/fixtures/prompt-engine-conformance.json");
    let prompt_path = root.join("../mna-ui/tests/fixtures/prompt-conformance.json");
    let engine: Vec<Value> = serde_json::from_slice(&fs::read(engine_path).unwrap()).unwrap();
    let prompt_cases: Vec<Value> = serde_json::from_slice(&fs::read(prompt_path).unwrap()).unwrap();
    let overrides = tempfile::tempdir().unwrap();
    std::env::set_var("MNA_PROMPTS_DIR", overrides.path());

    for (index, case) in engine.iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        let id = format!("fixture-{index}");
        let source = case["source"].as_str().unwrap();
        let source = if source.contains("**ID:** Bad_Id") {
            source.to_owned()
        } else {
            source.replacen("**ID:** t", &format!("**ID:** {id}"), 1)
        };
        fs::write(overrides.path().join(format!("{id}.md")), source).unwrap();

        let result = prompts::render_with_values(&id, &fixture_vars(case));
        if let Some(expected_error) = case.get("error").and_then(Value::as_str) {
            let error = result.unwrap_err();
            assert_eq!(
                prompt_error_code(&error),
                Some(expected_error.to_owned()),
                "{name}: {error}"
            );
        } else {
            assert_eq!(
                result.unwrap_or_else(|error| panic!("{name}: {error}")),
                case["expected"].as_str().unwrap(),
                "{name}"
            );
        }
    }

    for case in prompt_cases {
        let name = case["name"].as_str().unwrap();
        let id = case["id"].as_str().unwrap();
        let result = prompts::render_with_values(id, &fixture_vars(&case));
        if let Some(expected_error) = case.get("error").and_then(Value::as_str) {
            let error = result.unwrap_err();
            assert_eq!(
                prompt_error_code(&error),
                Some(expected_error.to_owned()),
                "{name}: {error}"
            );
        } else {
            assert_eq!(
                result.unwrap_or_else(|error| panic!("{name}: {error}")),
                case["expected"].as_str().unwrap(),
                "{name}"
            );
        }
    }
}
