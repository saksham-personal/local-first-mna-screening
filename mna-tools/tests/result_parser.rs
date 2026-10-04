use mna_tools::result_parser::parse_markdown_results;
use serde_json::json;

fn columns() -> Vec<String> {
    vec![
        "Fit Score".into(),
        "Rationale".into(),
        "Product | Ownership".into(),
    ]
}

#[test]
fn shuffled_rows_are_returned_in_frozen_order() {
    let text = "\u{feff}| index | Fit Score | Rationale | Product \\| Ownership |\r\n| --- | :---: | --- | ---: |\r\n| 7 | CHECK | unclear \\| verify | private |\r\n| 2 | 8.5 | 日本の会社 | founder \\\\ family |\r\n";
    let rows = parse_markdown_results(text, &columns(), &[2, 7], &["Fit Score".into()]).unwrap();
    assert_eq!(
        rows,
        vec![
            json!({"index":2,"Fit Score":8.5,"Rationale":"日本の会社","Product | Ownership":"founder \\ family"}),
            json!({"index":7,"Fit Score":"CHECK","Rationale":"unclear | verify","Product | Ownership":"private"}),
        ]
    );
}

#[test]
fn no_score_column_keeps_text_as_text() {
    let rows = parse_markdown_results(
        "| index | Verdict |\n| --- | --- |\n| 0 | 10 |",
        &["Verdict".into()],
        &[0],
        &[],
    )
    .unwrap();
    assert_eq!(rows, vec![json!({"index":0,"Verdict":"10"})]);
}

#[test]
fn rejects_duplicate_missing_and_out_of_scope_indexes() {
    let header = "| index | Fit Score |\n| --- | --- |\n";
    for body in [
        "| 1 | 5 |\n| 1 | 6 |",
        "| 1 | 5 |",
        "| 1 | 5 |\n| 3 | 6 |",
        "| 01 | 5 |\n| 2 | 6 |",
        "| -1 | 5 |\n| 2 | 6 |",
    ] {
        let text = format!("{header}{body}");
        assert!(
            parse_markdown_results(&text, &["Fit Score".into()], &[1, 2], &["Fit Score".into()])
                .is_err(),
            "accepted {body}"
        );
    }
}

#[test]
fn rejects_invalid_scores_headers_and_wrapping() {
    let columns = vec!["Fit Score".to_owned()];
    for score in [
        "NaN", "Infinity", "-1", "10.1", "check", "11", "5 points", "1e9999",
    ] {
        let text = format!("| index | Fit Score |\n| --- | --- |\n| 1 | {score} |");
        assert!(
            parse_markdown_results(&text, &columns, &[1], &columns).is_err(),
            "accepted {score}"
        );
    }
    for text in [
        "Here are results:\n| index | Fit Score |\n| --- | --- |\n| 1 | 5 |",
        "| index | Fit Score |\n| --- | --- |\n| 1 | 5 |\nDone.",
        "```markdown\n| index | Fit Score |\n| --- | --- |\n| 1 | 5 |\n```",
        "| Index | Fit Score |\n| --- | --- |\n| 1 | 5 |",
        "| index | Fit Score | Extra |\n| --- | --- | --- |\n| 1 | 5 | x |",
        "| index | Fit Score |\n| --- | --- |\n| 1 | 5 | extra |",
    ] {
        assert!(
            parse_markdown_results(text, &columns, &[1], &columns).is_err(),
            "accepted {text}"
        );
    }
}

#[test]
fn rejects_ambiguous_escaping_and_contract_inputs() {
    let cols = vec!["Reason".to_owned()];
    for reason in ["bad \\x escape", "dangling \\", "unescaped | pipe"] {
        let text = format!("| index | Reason |\n| --- | --- |\n| 1 | {reason} |");
        assert!(
            parse_markdown_results(&text, &cols, &[1], &[]).is_err(),
            "accepted {reason}"
        );
    }
    assert!(parse_markdown_results(
        "| index | Reason |\n| --- | --- |\n| 1 | x |",
        &["Reason".into(), "Reason".into()],
        &[1],
        &[]
    )
    .is_err());
    assert!(parse_markdown_results(
        "| index | Reason |\n| --- | --- |\n| 1 | x |",
        &cols,
        &[1, 1],
        &[]
    )
    .is_err());
    assert!(parse_markdown_results(
        "| index | Reason |\n| --- | --- |\n| 1 | x |",
        &cols,
        &[1],
        &["Unknown".into()]
    )
    .is_err());
}
