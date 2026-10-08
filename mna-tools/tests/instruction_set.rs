use mna_tools::instruction_set::{
    parse_reply, to_tool_calls, ConversionReport, InstructionContext,
};
use mna_tools::runtime::{tool_definitions, ToolDefinition};
use serde_json::{json, Map, Value};

const CANONICAL: &str = "## Context\nI will search MID for claims and policy software vendors.\n\n## Reasoning\nBroad keyword groups first, then semantic scoring.\n\n## Instruction set\n1. **search_mid** — Claims and policy software\n   - rationale: Broad claims/policy software group\n   - keywords: claims software; policy administration; insurer*\n   - expression: (k1 OR k2) AND k3\n   - limit: 5000\n2. **score_mid_semantic**\n\n## Notes for the analyst\nExclusions come from the approved criteria.";

fn ctx() -> InstructionContext {
    InstructionContext {
        run_id: "run-current".into(),
        extra: Map::new(),
    }
}

fn report(text: &str, allowed: &[&str]) -> ConversionReport {
    to_tool_calls(&parse_reply(text), allowed, &tool_definitions(), &ctx())
}

fn custom(schema: Value) -> ToolDefinition {
    ToolDefinition {
        name: "example",
        description: "Test schema",
        category: "test",
        mutates_state: false,
        input_schema: schema,
    }
}

fn typed(fields: &str, schema: Value) -> ConversionReport {
    to_tool_calls(
        &parse_reply(&format!("Instructions:\n1. example\n{fields}")),
        &["example"],
        &[custom(schema)],
        &ctx(),
    )
}

fn args(fields: &str, name: &str, schema: Value) -> Value {
    let result = typed(
        fields,
        json!({"type":"object","properties":{name:schema},"required":[name],"additionalProperties":false}),
    );
    assert!(result.rejected.is_empty(), "{:?}", result.rejected);
    result.calls[0].arguments[name].clone()
}

#[test]
fn canonical_sections_and_order() {
    let reply = parse_reply(CANONICAL);
    assert!(reply.context.unwrap().contains("claims and policy"));
    assert!(reply.reasoning.unwrap().contains("semantic scoring"));
    assert!(reply.notes.unwrap().contains("approved criteria"));
    assert_eq!(reply.instructions.len(), 2);
    assert_eq!(reply.instructions[0].index, 1);
    assert_eq!(reply.instructions[1].index, 2);
    assert_eq!(
        reply.instructions[0].title.as_deref(),
        Some("Claims and policy software")
    );
    assert!(reply.unparsed.is_empty());
}

#[test]
fn canonical_conversion_uses_real_catalog() {
    let result = report(CANONICAL, &["search_mid", "score_mid_semantic"]);
    assert!(result.rejected.is_empty(), "{:?}", result.rejected);
    assert_eq!(result.calls.len(), 2);
    assert_eq!(result.calls[0].arguments["limit"], 5000);
    assert_eq!(result.calls[0].arguments["keywords"][2]["text"], "insurer*");
    assert_eq!(result.calls[1].arguments, json!({"run_id":"run-current"}));
    assert!(result.feedback.is_empty());
}

#[test]
fn heading_hash_levels() {
    for n in 1..=4 {
        let reply = parse_reply(&format!("{} Instructions\n1. search_mid", "#".repeat(n)));
        assert_eq!(reply.instructions.len(), 1);
    }
}

#[test]
fn bold_heading() {
    assert_eq!(
        parse_reply("**Instruction set**\n1. search_mid")
            .instructions
            .len(),
        1
    );
}

#[test]
fn colon_heading() {
    assert_eq!(
        parse_reply("INSTRUCTIONS:\n1. search_mid")
            .instructions
            .len(),
        1
    );
}

#[test]
fn all_instruction_synonyms() {
    for name in [
        "instruction set",
        "instructions",
        "steps",
        "actions",
        "plan",
        "next steps",
        "commands",
    ] {
        assert_eq!(
            parse_reply(&format!("## {name}\n1. unknown_tool"))
                .instructions
                .len(),
            1,
            "{name}"
        );
    }
}

#[test]
fn all_context_synonyms() {
    for name in ["context", "summary", "understanding"] {
        assert_eq!(
            parse_reply(&format!("## {name}\nUnderstood"))
                .context
                .as_deref(),
            Some("Understood")
        );
    }
}

#[test]
fn all_reasoning_synonyms() {
    for name in ["reasoning", "thinking", "thoughts", "analysis", "rationale"] {
        assert_eq!(
            parse_reply(&format!("## {name}\nBecause"))
                .reasoning
                .as_deref(),
            Some("Because")
        );
    }
}

#[test]
fn all_notes_synonyms() {
    for name in ["notes", "notes for the analyst", "comments"] {
        assert_eq!(
            parse_reply(&format!("## {name}\nReview")).notes.as_deref(),
            Some("Review")
        );
    }
}

#[test]
fn missing_headings_capture_context_and_actions() {
    let reply = parse_reply(
        "I understand the business.\n1. search_mid\n  - rationale: broad\n2. semantic score",
    );
    assert_eq!(reply.instructions.len(), 2);
    assert_eq!(reply.context.as_deref(), Some("I understand the business."));
}

#[test]
fn missing_headings_ignore_ordinary_prose_list() {
    let reply = parse_reply("Summary\n- Apples are fruit\n- Bananas are yellow");
    assert!(reply.instructions.is_empty());
    assert!(reply.context.unwrap().contains("Apples"));
}

#[test]
fn every_item_marker() {
    for marker in ["1.", "1)", "-", "*", "•", "Step 1:"] {
        let reply = parse_reply(&format!("Instructions:\n{marker} search_mid"));
        assert_eq!(reply.instructions.len(), 1, "{marker}");
        assert_eq!(reply.instructions[0].name_text, "search_mid");
    }
}

#[test]
fn every_name_markup() {
    for name in [
        "**search_mid**",
        "`search_mid`",
        "__search_mid__",
        "search_mid",
        "search_mid:",
        "Action: search_mid",
    ] {
        let reply = parse_reply(&format!("Instructions:\n1. {name}"));
        assert_eq!(reply.instructions[0].name_text, "search_mid", "{name}");
    }
}

#[test]
fn every_title_separator() {
    for sep in ["—", "–", "-", ":"] {
        for name in ["search_mid", "**search_mid**"] {
            let reply = parse_reply(&format!(
                "Instructions:\n1. {name} {sep} Find claims vendors"
            ));
            assert_eq!(
                reply.instructions[0].title.as_deref(),
                Some("Find claims vendors")
            );
        }
    }
}

#[test]
fn equal_fields() {
    let result = report(
        "Instructions:\n1. search_iscc\n  query = software\n  limit = 25",
        &["search_iscc"],
    );
    assert_eq!(result.calls[0].arguments["query"], "software");
    assert_eq!(result.calls[0].arguments["limit"], 25);
}

#[test]
fn bold_and_dash_fields() {
    let result = report(
        "Instructions:\n1. search_iscc\n  - **query**: software\n  - limit — 25",
        &["search_iscc"],
    );
    assert_eq!(result.calls[0].arguments["query"], "software");
    assert_eq!(result.calls[0].arguments["limit"], 25);
}

#[test]
fn multiline_values() {
    let result = report(
        "Instructions:\n1. search_iscc\n  query: claims\n    policy software\n  limit: 10",
        &["search_iscc"],
    );
    assert_eq!(
        result.calls[0].arguments["query"],
        "claims\n    policy software"
    );
}

#[test]
fn sub_bullet_array() {
    assert_eq!(
        args(
            "  values:\n    - claims\n    - policy",
            "values",
            json!({"type":"array","items":{"type":"string"}})
        ),
        json!(["claims", "policy"])
    );
}

#[test]
fn table_fields() {
    let result = report("Instructions:\n1. search_iscc\n| Key | Value |\n| --- | --- |\n| query | claims |\n| limit | 20 |", &["search_iscc"]);
    assert_eq!(result.calls[0].arguments["query"], "claims");
    assert_eq!(result.calls[0].arguments["limit"], 20);
}

#[test]
fn fenced_json_fallback() {
    let result = report(
        "Instructions:\n1. search_iscc\n```json\n{\"query\":\"claims\",\"limit\":20}\n```",
        &["search_iscc"],
    );
    assert_eq!(result.calls[0].arguments["limit"], 20);
}

#[test]
fn bare_multiline_json_fallback() {
    let result = report(
        "Instructions:\n1. search_iscc\n{\n  \"query\": \"claims\",\n  \"limit\": 20\n}",
        &["search_iscc"],
    );
    assert_eq!(result.calls[0].arguments["query"], "claims");
}

#[test]
fn inline_call() {
    let result = report(
        "Instructions:\n1. search_iscc(query=\"claims, software\", limit=20)",
        &["search_iscc"],
    );
    assert_eq!(result.calls[0].arguments["query"], "claims, software");
    assert_eq!(result.calls[0].arguments["limit"], 20);
}

#[test]
fn duplicate_keys_last_wins() {
    let reply = parse_reply("Instructions:\n1. search_iscc\n  query: first\n  QUERY: second");
    assert_eq!(reply.instructions[0].fields.len(), 1);
    assert_eq!(reply.instructions[0].fields[0].1, "second");
    assert!(reply.warnings[0].contains("last value wins"));
}

#[test]
fn alias_duplicate_last_wins() {
    let result = report(
        "Instructions:\n1. search_iscc\n  query: first\n  text: second",
        &["search_iscc"],
    );
    assert_eq!(result.calls[0].arguments["query"], "second");
    assert!(result.calls[0]
        .warnings
        .iter()
        .any(|s| s.contains("Duplicate field")));
}

#[test]
fn unknown_key_dropped_with_feedback() {
    let result = report(
        "Instructions:\n1. search_iscc\n  query: claims\n  ignored: junk",
        &["search_iscc"],
    );
    assert_eq!(result.calls.len(), 1);
    assert!(result.calls[0].arguments.get("ignored").is_none());
    assert!(result.feedback.contains("Dropped field 'ignored'"));
}

#[test]
fn junk_lines_reported() {
    let reply =
        parse_reply("Instructions:\nThis is junk\n1. score_mid_semantic\nMore unexplained junk");
    assert_eq!(reply.unparsed.len(), 2);
    assert!(
        to_tool_calls(&reply, &["score_mid_semantic"], &tool_definitions(), &ctx())
            .feedback
            .contains("Unused fragment")
    );
}

#[test]
fn unknown_action_does_not_abort_other_instructions() {
    let result = report(
        "Instructions:\n1. dance wildly\n2. score_mid_semantic",
        &["score_mid_semantic"],
    );
    assert_eq!(result.calls.len(), 1);
    assert_eq!(result.rejected.len(), 1);
    assert!(result.rejected[0].reason.contains("unknown action"));
    assert!(result.feedback.contains("Instruction 1 was not run"));
}

#[test]
fn fuzzy_one_typo() {
    let result = report(
        "Instructions:\n1. serch_iscc\n  query: claims",
        &["search_iscc"],
    );
    assert_eq!(result.calls[0].tool, "search_iscc");
}

#[test]
fn fuzzy_two_typos() {
    let result = report(
        "Instructions:\n1. serch_iscs\n  query: claims",
        &["search_iscc"],
    );
    assert_eq!(result.calls[0].tool, "search_iscc");
}

#[test]
fn ambiguous_fuzzy_rejected() {
    let mut mid = custom(json!({"type":"object","properties":{}}));
    mid.name = "search_mid";
    let mut mix = mid.clone();
    mix.name = "search_mix";
    let result = to_tool_calls(
        &parse_reply("Instructions:\n1. search_mic"),
        &["search_mid", "search_mix"],
        &[mid, mix],
        &ctx(),
    );
    assert_eq!(result.rejected.len(), 1);
}

#[test]
fn exact_disallowed_action_rejected() {
    let result = report("Instructions:\n1. search_mid", &["search_iscc"]);
    assert_eq!(result.rejected.len(), 1);
    assert!(result.calls.is_empty());
}

#[test]
fn synonym_disallowed_action_rejected() {
    let result = report("Instructions:\n1. keyword search", &["search_iscc"]);
    assert_eq!(result.rejected.len(), 1);
}

#[test]
fn normalization_and_synonyms() {
    for name in ["SEARCH ISCC", "search-iscc", "search_isccs", "iscc search"] {
        let result = report(
            &format!("Instructions:\n1. {name}\n  query: claims"),
            &["search_iscc"],
        );
        assert_eq!(result.calls[0].tool, "search_iscc");
    }
    for name in ["semantic score", "score semantic"] {
        assert_eq!(
            report(
                &format!("Instructions:\n1. {name}"),
                &["score_mid_semantic"]
            )
            .calls[0]
                .tool,
            "score_mid_semantic"
        );
    }
    for name in ["bing", "web search"] {
        assert_eq!(
            report(
                &format!("Instructions:\n1. {name}\n  query: claims"),
                &["bing_search"]
            )
            .calls[0]
                .tool,
            "bing_search"
        );
    }
}

#[test]
fn missing_required_field_rejected() {
    let result = report("Instructions:\n1. search_iscc", &["search_iscc"]);
    assert_eq!(result.rejected[0].reason, "missing query");
}

#[test]
fn number_with_commas() {
    assert_eq!(
        args("  count: 5,000", "count", json!({"type":"integer"})),
        5000
    );
}

#[test]
fn number_k_suffix() {
    assert_eq!(
        args("  count: 5k", "count", json!({"type":"integer"})),
        5000
    );
}

#[test]
fn percentage_number() {
    assert_eq!(
        args("  ratio: 45%", "ratio", json!({"type":"number"})),
        0.45
    );
}

#[test]
fn all_boolean_spellings() {
    for (raw, value) in [
        ("yes", true),
        ("true", true),
        ("ON", true),
        ("no", false),
        ("false", false),
        ("off", false),
    ] {
        assert_eq!(
            args(&format!("  flag: {raw}"), "flag", json!({"type":"boolean"})),
            value
        );
    }
}

#[test]
fn enum_case_insensitive_with_reference() {
    let result = typed(
        "  mode: EXACT",
        json!({"type":"object","properties":{"mode":{"$ref":"#/$defs/Mode"}},"required":["mode"],"$defs":{"Mode":{"type":"string","enum":["stem","exact"]}}}),
    );
    assert_eq!(result.calls[0].arguments["mode"], "exact");
}

#[test]
fn keywords_annotations() {
    let result = report("Instructions:\n1. search_mid\n  rationale: broad\n  keywords: insurer* (exact, weight 2); \"policy admin\" [exact]; claims", &["search_mid"]);
    let values = &result.calls[0].arguments["keywords"];
    assert_eq!(
        values[0],
        json!({"id":"k1","text":"insurer*","weight":2.0,"match":"exact"})
    );
    assert_eq!(values[1]["text"], "policy admin");
    assert_eq!(values[1]["match"], "exact");
    assert_eq!(values[2]["match"], "stem");
}

#[test]
fn expression_text_to_ids_adds_terms() {
    let result = report("Instructions:\n1. search_mid\n  rationale: broad\n  keywords: claims software; policy\n  expression: (\"claims software\" OR policy) AND NOT broker", &["search_mid"]);
    let arguments = &result.calls[0].arguments;
    assert_eq!(arguments["expression"], "(k1 OR k2) AND NOT k3");
    assert_eq!(arguments["keywords"][2]["text"], "broker");
}

#[test]
fn negative_only_expression_passes_through() {
    let result = report("Instructions:\n1. search_mid\n  rationale: broad\n  keywords: broker\n  expression: NOT k1", &["search_mid"]);
    assert_eq!(result.calls[0].arguments["expression"], "NOT k1");
}

#[test]
fn run_id_always_overridden() {
    let result = report(
        "Instructions:\n1. score_mid_semantic\n  run-id: malicious",
        &["score_mid_semantic"],
    );
    assert_eq!(result.calls[0].arguments["run_id"], "run-current");
    assert!(result.calls[0]
        .warnings
        .iter()
        .any(|s| s.contains("overridden")));
}

#[test]
fn extra_fills_required_only() {
    let mut context = ctx();
    context.extra = json!({"query":"trusted","limit":12})
        .as_object()
        .unwrap()
        .clone();
    let result = to_tool_calls(
        &parse_reply("Instructions:\n1. search_iscc"),
        &["search_iscc"],
        &tool_definitions(),
        &context,
    );
    assert_eq!(result.calls[0].arguments["query"], "trusted");
    assert!(result.calls[0].arguments.get("limit").is_none());
}

#[test]
fn empty_reply() {
    let reply = parse_reply("");
    assert!(reply.instructions.is_empty());
    assert!(reply.context.is_none());
    assert!(report("", &[]).feedback.is_empty());
}

#[test]
fn prose_only_reply() {
    let reply = parse_reply("I need more information.");
    assert_eq!(reply.context.as_deref(), Some("I need more information."));
    assert!(reply.instructions.is_empty());
}

#[test]
fn huge_input_utf8_safe_prefix() {
    let reply = parse_reply(&format!(
        "{}{}",
        "a".repeat(512 * 1024 - 1),
        "😀".repeat(10)
    ));
    assert!(reply.warnings[0].contains("512 KiB"));
    assert_eq!(reply.context.unwrap().len(), 512 * 1024 - 1);
}

#[test]
fn generated_garbage_never_panics() {
    let alphabet = [
        '\0', '\u{1}', '\u{feff}', '😀', 'é', '{', '}', '#', '*', '`', '\n', '\r', '1', '(', ')',
        '-', ' ', 'a',
    ];
    let mut state = 17u64;
    for size in 0..600 {
        let mut input = String::new();
        for _ in 0..size {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            input.push(alphabet[(state as usize) % alphabet.len()]);
        }
        let reply = parse_reply(&input);
        serde_json::to_string(&reply).unwrap();
    }
}

#[test]
fn crlf_reply() {
    assert_eq!(
        report(
            &CANONICAL.replace('\n', "\r\n"),
            &["search_mid", "score_mid_semantic"]
        )
        .calls
        .len(),
        2
    );
}

#[test]
fn bom_reply() {
    assert_eq!(
        parse_reply(&format!("\u{feff}{CANONICAL}"))
            .instructions
            .len(),
        2
    );
}

#[test]
fn emojis_and_unicode_preserved() {
    let result = report(
        "Instructions:\n• search_iscc — Find 🏢\n  query: 保険 café 😀",
        &["search_iscc"],
    );
    assert_eq!(result.calls[0].arguments["query"], "保険 café 😀");
}

#[test]
fn nested_code_fences_ignored() {
    let result = report(
        "````markdown\n## Instructions\n1. search_iscc\n```json\n{\"query\":\"claims\"}\n```\n````",
        &["search_iscc"],
    );
    assert_eq!(result.calls[0].arguments["query"], "claims");
}

#[test]
fn two_sections_merge_in_order_with_warning() {
    let reply = parse_reply("## Instructions\n1. score_mid_semantic\n## Notes\nReview\n## Actions\n1. search_iscc\n  query: claims");
    assert_eq!(reply.instructions.len(), 2);
    assert_eq!(reply.instructions[1].index, 2);
    assert!(reply.warnings.iter().any(|s| s.contains("merged")));
}

#[test]
fn nested_objects_from_sub_bullets() {
    let schema = json!({"type":"object","properties":{"filters":{"type":"object","properties":{"include":{"type":"boolean"},"nested":{"type":"object","properties":{"count":{"type":"integer"}},"required":["count"]}},"required":["include","nested"]}},"required":["filters"]});
    let result = typed(
        "  filters:\n    - include: yes\n    - nested:\n      - count: 5k",
        schema,
    );
    assert!(result.rejected.is_empty(), "{:?}", result.rejected);
    assert_eq!(
        result.calls[0].arguments["filters"],
        json!({"include":true,"nested":{"count":5000}})
    );
}

#[test]
fn array_respects_quotes_and_parentheses() {
    assert_eq!(
        args(
            "  values: \"a,b\"; vendor (claims, policy); other",
            "values",
            json!({"type":"array","items":{"type":"string"}})
        ),
        json!(["a,b", "vendor (claims, policy)", "other"])
    );
}

#[test]
fn invalid_types_rejected() {
    let result = typed(
        "  limit: many",
        json!({"type":"object","properties":{"limit":{"type":"integer"}},"required":["limit"]}),
    );
    assert_eq!(result.rejected.len(), 1);
    assert!(result.rejected[0].reason.contains("expected number"));
}

#[test]
fn invalid_enum_rejected() {
    let result = typed(
        "  mode: unknown",
        json!({"type":"object","properties":{"mode":{"type":"string","enum":["stem","exact"]}}}),
    );
    assert_eq!(result.rejected.len(), 1);
}

#[test]
fn nullable_none() {
    assert_eq!(
        args("  value: none", "value", json!({"type":["string","null"]})),
        Value::Null
    );
}

#[test]
fn numeric_ranges_validated() {
    let result = typed(
        "  limit: -2",
        json!({"type":"object","properties":{"limit":{"type":"integer","minimum":0}}}),
    );
    assert_eq!(result.rejected.len(), 1);
}

#[test]
fn keyword_json_objects_coerced_and_validated() {
    let result = report("Instructions:\n1. search_mid\n```json\n{\"rationale\":\"broad\",\"keywords\":[{\"id\":\"k1\",\"text\":\"claims\",\"weight\":\"2\",\"match\":\"EXACT\"}]}\n```", &["search_mid"]);
    assert!(result.rejected.is_empty(), "{:?}", result.rejected);
    assert_eq!(result.calls[0].arguments["keywords"][0]["match"], "exact");
    assert_eq!(result.calls[0].arguments["keywords"][0]["weight"], 2.0);
}

#[test]
fn missing_keyword_rationale_cannot_fall_back_to_legacy() {
    let result = report(
        "Instructions:\n1. search_mid\n  keywords: claims",
        &["search_mid"],
    );
    assert_eq!(result.rejected[0].reason, "missing rationale");
}

#[test]
fn legacy_mid_query_still_valid() {
    let result = report(
        "Instructions:\n1. search_mid\n  query: claims\n  limit: 20",
        &["search_mid"],
    );
    assert!(result.rejected.is_empty(), "{:?}", result.rejected);
    assert_eq!(result.calls[0].arguments["query"], "claims");
}

#[test]
fn feedback_bounded_and_utf8_safe() {
    let reply = parse_reply(&format!(
        "Instructions:\n{}",
        (0..100)
            .map(|i| format!("{i}. unknown😀{i}\n"))
            .collect::<String>()
    ));
    let result = to_tool_calls(&reply, &["score_mid_semantic"], &tool_definitions(), &ctx());
    assert_eq!(result.rejected.len(), 100);
    assert!(result.feedback.chars().count() <= 1200);
    assert!(result.feedback.len() <= 1200);
}

#[test]
fn unindented_field_bullets() {
    let result = report(
        "Instructions:\n1. search_iscc\n- query: claims\n- limit: 20",
        &["search_iscc"],
    );
    assert_eq!(result.calls.len(), 1);
    assert_eq!(result.calls[0].arguments["query"], "claims");
    assert_eq!(result.calls[0].arguments["limit"], 20);
}

#[test]
fn malformed_json_retains_following_fields() {
    let reply = parse_reply("Instructions:\n1. search_iscc\n{bad json}\n  query: claims");
    assert_eq!(reply.unparsed, vec!["{bad json}"]);
    assert_eq!(
        report(
            "Instructions:\n1. search_iscc\n{bad json}\n  query: claims",
            &["search_iscc"]
        )
        .calls
        .len(),
        1
    );
}

#[test]
fn deeply_nested_json_does_not_panic() {
    let text = format!(
        "Instructions:\n1. search_iscc\n{}{}\n  query: claims",
        "{\"x\":".repeat(500),
        "}".repeat(500)
    );
    let reply = parse_reply(&text);
    assert_eq!(reply.unparsed.len(), 1);
    assert_eq!(reply.instructions[0].fields[0].0, "query");
}

#[test]
fn duplicate_json_fields_last_wins_with_warning() {
    let reply =
        parse_reply("Instructions:\n1. search_iscc\n{\"query\":\"first\",\"query\":\"second\"}");
    assert!(reply.warnings[0].contains("duplicate field"));
    assert_eq!(reply.instructions[0].fields[0].1, "second");
}

#[test]
fn rejected_instruction_also_reports_dropped_fields() {
    let result = report(
        "Instructions:\n1. search_iscc\n  junk: ignored",
        &["search_iscc"],
    );
    assert_eq!(result.rejected.len(), 1);
    assert!(result.feedback.contains("missing query"));
    assert!(result.feedback.contains("Dropped field 'junk'"));
}

#[test]
fn json_serializable_for_logging() {
    let reply = parse_reply(CANONICAL);
    let value = serde_json::to_value(reply).unwrap();
    assert_eq!(value["instructions"][0]["name_text"], "search_mid");
    serde_json::to_string(&report(CANONICAL, &["search_mid", "score_mid_semantic"])).unwrap();
}
