use mna_tools::protocol::{parse_tool_response, repair_prompt};
use serde_json::json;

const SEARCH: &[&str] = &["search_companies"];

#[test]
fn simple_search_and_unicode_escaped_text() {
    let command = "BEGIN TOOL v1 search_companies\nquery:text = \"Acme \\u{1F680} | services\"\nlimit:number = 10\nfilters.country[0]:text = \"India\"\nfilters.country[1]:text = \"日本\"\nprefer_meilisearch:boolean = false\nEND TOOL\n";
    let parsed = parse_tool_response(command, SEARCH).unwrap();
    assert_eq!(parsed.tool, "search_companies");
    assert_eq!(
        parsed.arguments,
        json!({"query":"Acme 🚀 | services","limit":10,"filters":{"country":["India","日本"]},"prefer_meilisearch":false})
    );
}

#[test]
fn nested_plan_and_multiline_text() {
    let command = r#"BEGIN TOOL v1 propose_action_plan
run_id:text = "run-1"
rationale:text = <<WHY
First line
END TOOL is harmless inside a multiline field.
Why this "quoted" strategy?
WHY
steps[0].step_id:text = "s1"
steps[0].kind:text = "search_mid"
steps[0].depends_on:empty-list = -
steps[0].query_templates[0]:text = "industrial pumps"
steps[0].parameters["source.name"]:text = "MID"
steps[0].parameters["owner = source"]:text = "analyst"
steps[1].step_id:text = "s2"
steps[1].kind:text = "llm_screening"
steps[1].depends_on[0]:text = "s1"
steps[1].company_ids[0]:text = "c-1"
steps[1].parameters.batch_size:number = 100
END TOOL"#;
    let parsed = parse_tool_response(command, &["propose_action_plan"]).unwrap();
    assert_eq!(
        parsed.arguments["steps"][0]["parameters"]["source.name"],
        "MID"
    );
    assert_eq!(
        parsed.arguments["steps"][0]["parameters"]["owner = source"],
        "analyst"
    );
    assert_eq!(parsed.arguments["steps"][1]["depends_on"], json!(["s1"]));
    assert!(parsed.arguments["rationale"]
        .as_str()
        .unwrap()
        .contains("END TOOL is harmless"));
}

#[test]
fn rejects_untrusted_wrapping_and_wrong_tool() {
    for command in [
        "I will search.\nBEGIN TOOL v1 search_companies\nEND TOOL",
        "BEGIN TOOL v1 search_companies\nEND TOOL\nDone.",
        "BEGIN TOOL v1 search_companies\nEND TOOL\nBEGIN TOOL v1 search_companies\nEND TOOL",
        "```\nBEGIN TOOL v1 search_companies\nEND TOOL\n```",
    ] {
        assert!(
            parse_tool_response(command, SEARCH).is_err(),
            "accepted {command}"
        );
    }
    assert!(parse_tool_response("BEGIN TOOL v1 label_company\nEND TOOL", SEARCH).is_err());
}

#[test]
fn rejects_duplicates_conflicts_sparse_arrays_and_unknown_types() {
    let cases = [
        "query:text = \"one\"\nquery:text = \"two\"",
        "query:null = -\nquery.name:text = \"x\"",
        "filters.country[1]:text = \"India\"",
        "query:json = \"x\"",
        "filters[0]:text = \"x\"\nfilters.name:text = \"y\"",
        "filters.country[00]:text = \"x\"",
        "filters.country[4096]:text = \"x\"",
        "query:text = \"unterminated",
        "query:number = NaN",
        "query:number = 1e9999",
        "query:boolean = yes",
    ];
    for body in cases {
        let command = format!("BEGIN TOOL v1 search_companies\n{body}\nEND TOOL");
        assert!(
            parse_tool_response(&command, SEARCH).is_err(),
            "accepted {body}"
        );
    }
}

#[test]
fn accepts_explicit_empty_values_and_rejects_oversize() {
    let command = "BEGIN TOOL v1 search_companies\nquery:text = \"\"\nfilters:empty-map = -\nquery_vector:empty-list = -\nrun_id:null = -\nEND TOOL";
    assert_eq!(
        parse_tool_response(command, SEARCH).unwrap().arguments,
        json!({"query":"","filters":{},"query_vector":[],"run_id":null})
    );
    let huge = format!(
        "BEGIN TOOL v1 search_companies\nquery:text = \"{}\"\nEND TOOL",
        "x".repeat(256 * 1024)
    );
    assert!(parse_tool_response(&huge, SEARCH).is_err());
}

#[test]
fn repair_prompt_is_bounded_and_does_not_echo_raw_output() {
    let err = parse_tool_response("secret prose", SEARCH).unwrap_err();
    let prompt = repair_prompt("private model text", &err, SEARCH);
    assert!(prompt.contains("search_companies"));
    assert!(!prompt.contains("private model text"));
    assert!(prompt.len() < 1000);
}
