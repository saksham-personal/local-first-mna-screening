use mna_tools::{data::DataService, runtime::ToolCall, workflow::WorkflowService, Runtime, Store};
use serde_json::{json, Value};

fn fixture(approved: bool) -> (Store, WorkflowService) {
    let store = Store::open(":memory:").unwrap();
    store.execute("ingest_companies",&json!({"companies":[
        {"company_id":"C1","name":"Same Name","website":"same.example","description":"Insurance policy software"},
        {"company_id":"C2","name":"Same Name","website":"same.example","description":"Insurance claims software"}
    ]})).unwrap();
    for run in ["R1", "R2"] {
        store.execute("create_run",&json!({"run_id":run,"objective":"Find insurance software","original_criteria":{"country":"India","revenue_min":1000000,"ownership":"private","business":"insurance software"},"initial_profile":{"core_business_query":"insurance policy and claims software for carriers","core_business_criteria":["insurance software"],"unused_criteria":[{"criterion":"country","reason":"Not used in discovery"}]}})).unwrap();
        if approved {
            store
                .execute(
                    "approve_screening_profile",
                    &json!({"run_id":run,"version":1,"approved_by":"test-analyst"}),
                )
                .unwrap();
        }
        store
            .execute(
                "add_candidates",
                &json!({"run_id":run,"companies":["C1","C2"],"discovery_source":"MID"}),
            )
            .unwrap();
    }
    let workflow = WorkflowService::new(store.clone());
    (store, workflow)
}

fn approved_plan(workflow: &WorkflowService, steps: Value) -> String {
    let plan = workflow
        .execute(
            "propose_action_plan",
            &json!({"run_id":"R1","rationale":"Explicit analyst instruction","steps":steps}),
        )
        .unwrap();
    let id = plan["plan_id"].as_str().unwrap().to_owned();
    workflow
        .execute(
            "approve_action_plan",
            &json!({"run_id":"R1","plan_id":id,"approved_by":"test-analyst","approve":true}),
        )
        .unwrap();
    id
}

#[tokio::test]
async fn new_runs_require_actual_criteria_approval_before_discovery() {
    let (store, workflow) = fixture(false);
    let runtime = Runtime::new(store.clone()).unwrap();
    let call = || ToolCall {
        tool: "search_mid".into(),
        arguments: json!({"run_id":"R1","query":"insurance software","mode":"lexical","prefer_meilisearch":false}),
    };
    assert!(runtime.execute(call()).await.is_err());
    let policy = workflow
        .execute("get_search_policy", &json!({"run_id":"R1"}))
        .unwrap();
    assert_eq!(policy["approved"], false);
    assert!(policy["unused_criteria"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["criterion"] == "ownership"));
    let packet=runtime.execute(ToolCall{tool:"build_context_packet".into(),arguments:json!({"run_id":"R1","task_type":"CRITERIA_ANALYSIS","subject_ids":[],"token_budget":10000})}).await.unwrap();
    assert!(packet["context"]["active_profile"].is_null());
    assert_eq!(packet["context"]["working_profile"]["status"], "PROPOSED");
    store
        .execute(
            "approve_screening_profile",
            &json!({"run_id":"R1","version":1,"approved_by":"analyst"}),
        )
        .unwrap();
    assert_eq!(runtime.execute(call()).await.unwrap()["total"], 2);
    assert!(runtime
        .execute(ToolCall {
            tool: "approve_action_plan".into(),
            arguments: json!({})
        })
        .await
        .is_err());
}

#[test]
fn plans_reject_cycles_and_stale_approval_and_allow_single_criteria_query() {
    let (store, workflow) = fixture(false);
    let bad = workflow.execute(
        "propose_action_plan",
        &json!({"run_id":"R1","rationale":"Cycle","steps":[
            {"step_id":"A","kind":"llm_screening","depends_on":["B"],"company_ids":["C1"]},
            {"step_id":"B","kind":"llm_screening","depends_on":["A"],"company_ids":["C1"]}
        ]}),
    );
    assert!(bad.is_err());
    let plan = approved_plan(
        &workflow,
        json!([{"step_id":"clarify","kind":"bing_research","query_templates":["ABC Inc core products and customer segments"]}]),
    );
    workflow.authorize_provider("bing_search",&json!({"run_id":"R1","plan_id":plan,"step_id":"clarify","query":"ABC Inc core products and customer segments"})).unwrap();
    store
        .execute(
            "approve_screening_profile",
            &json!({"run_id":"R1","version":1,"approved_by":"analyst"}),
        )
        .unwrap();
    assert!(workflow.authorize_provider("bing_search",&json!({"run_id":"R1","plan_id":plan,"step_id":"clarify","query":"ABC Inc core products and customer segments"})).is_err());
}

#[test]
fn screening_is_hydrated_scoped_and_linkedin_is_optional_for_copilot() {
    let (store, workflow) = fixture(true);
    let plan = approved_plan(
        &workflow,
        json!([
            {"step_id":"llm","kind":"llm_screening","company_ids":["C1"]},
            {"step_id":"copilot","kind":"m365_screening","company_ids":["C1"]}
        ]),
    );
    let args = json!({"run_id":"R1","plan_id":plan,"step_id":"copilot","engine":"copilot","company_ids":["C1"],"prompt":"Assess core-business fit"});
    let without_linkedin = workflow.execute("prepare_screening_batch", &args).unwrap();
    assert_eq!(without_linkedin["missing_optional_linkedin"], json!(["C1"]));
    assert!(without_linkedin["companies"][0]["company"]["linkedin_url"].is_null());
    store.with_connection(|conn|{
        conn.execute("INSERT INTO company_enrichment(company_id,pb_description,pb_linkedin_url,rogo_json,updated_at) VALUES('C1','Verified policy product','https://www.linkedin.com/company/policy','{\"Product\":\"Policy platform\"}','now')",[])?;
        Ok(())
    }).unwrap();
    store.with_connection(|conn|{
        conn.execute("UPDATE company_enrichment SET pb_linkedin_url='https://linkedin.com.example/company/policy' WHERE company_id='C1'",[])?;
        Ok(())
    }).unwrap();
    let invalid_linkedin = workflow.execute("prepare_screening_batch", &args).unwrap();
    assert_eq!(invalid_linkedin["missing_optional_linkedin"], json!(["C1"]));
    assert!(invalid_linkedin["companies"][0]["company"]["linkedin_url"].is_null());
    store.with_connection(|conn|{
        conn.execute("UPDATE company_enrichment SET pb_linkedin_url='https://www.linkedin.com/company/policy' WHERE company_id='C1'",[])?;
        Ok(())
    }).unwrap();
    let copilot = workflow.execute("prepare_screening_batch", &args).unwrap();
    assert_eq!(
        copilot["companies"][0]["company"]["linkedin_url"],
        "https://www.linkedin.com/company/policy"
    );
    assert_eq!(
        copilot["companies"][0]["company"]["ROGO"]["Product"],
        "Policy platform"
    );
    let batch=workflow.execute("prepare_screening_batch",&json!({"run_id":"R1","plan_id":plan,"step_id":"llm","engine":"llm_suite","company_ids":["C1"],"prompt":"Assess core-business fit","output_columns":["fit_score","rationale","product_fit"]})).unwrap();
    assert_eq!(batch["executed"], false);
    let batch_id = &batch["batch_id"];
    assert!(workflow.execute("save_screening_results",&json!({"run_id":"R1","plan_id":plan,"step_id":"llm","batch_id":batch_id,"results":[{"company_id":"C1","fit_score":11,"rationale":"bad"}]})).is_err());
    let result = json!({"run_id":"R1","plan_id":plan,"step_id":"llm","batch_id":batch_id,"results":[{"company_id":"C1","fit_score":"CHECK","rationale":"Need product evidence","additional_columns":{"product_fit":"unclear"}}]});
    workflow.execute("save_screening_results", &result).unwrap();
    workflow.execute("save_screening_results", &result).unwrap();
    assert_eq!(
        workflow
            .screening_results("R1", "C1", 100)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(workflow
        .screening_results("R2", "C1", 100)
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    assert!(store
        .execute("get_labelled_examples", &json!({"run_id":"R1"}))
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        store
            .execute("get_candidate_set", &json!({"run_id":"R1"}))
            .unwrap()["candidates"][0]["status"],
        "DISCOVERED"
    );
}

#[test]
fn profile_change_blocks_old_prepared_batch_results() {
    let (store, workflow) = fixture(true);
    let plan = approved_plan(
        &workflow,
        json!([{"step_id":"llm","kind":"llm_screening","company_ids":["C1"]}]),
    );
    let batch=workflow.execute("prepare_screening_batch",&json!({"run_id":"R1","plan_id":plan,"step_id":"llm","engine":"llm_suite","company_ids":["C1"],"prompt":"Assess fit"})).unwrap();
    let version = store
        .execute(
            "propose_screening_profile",
            &json!({"run_id":"R1","content":{"core_business_query":"insurance product software"}}),
        )
        .unwrap()["version"]
        .clone();
    store
        .execute(
            "approve_screening_profile",
            &json!({"run_id":"R1","version":version,"approved_by":"analyst"}),
        )
        .unwrap();
    assert!(workflow.execute("save_screening_results",&json!({"run_id":"R1","plan_id":plan,"step_id":"llm","batch_id":batch["batch_id"],"results":[{"company_id":"C1","fit_score":8,"rationale":"Fit"}]})).is_err());
}

#[test]
fn identity_promotion_after_preparation_resolves_historical_scopes() {
    let (store, workflow) = fixture(true);
    let data = DataService::new(store.clone());
    data.ingest_iscc_rows(
        Some("R1"),
        None,
        &[json!({"CID":"77","Company Name":"Provisional","Description":"Insurance software"})],
    )
    .unwrap();
    store
        .execute(
            "add_candidates",
            &json!({"run_id":"R1","companies":["X-77"],"discovery_source":"ISCC"}),
        )
        .unwrap();
    let plan = approved_plan(
        &workflow,
        json!([{"step_id":"llm","kind":"llm_screening","company_ids":["X-77"]}]),
    );
    let batch=workflow.execute("prepare_screening_batch",&json!({"run_id":"R1","plan_id":plan,"step_id":"llm","engine":"llm_suite","company_ids":["X-77"],"prompt":"Assess fit"})).unwrap();
    data.ingest_iscc_rows(
        Some("R1"),
        None,
        &[json!({"ECID":"88","CID":"77","Company Name":"Full","Description":"Insurance software"})],
    )
    .unwrap();
    workflow.execute("prepare_screening_batch",&json!({"run_id":"R1","plan_id":plan,"step_id":"llm","engine":"llm_suite","company_ids":["88-77"],"prompt":"Assess fit"})).unwrap();
    workflow.execute("save_screening_results",&json!({"run_id":"R1","plan_id":plan,"step_id":"llm","batch_id":batch["batch_id"],"results":[{"company_id":"X-77","fit_score":7,"rationale":"Plausible"}]})).unwrap();
    assert_eq!(
        workflow
            .screening_results("R1", "88-77", 100)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn graph_completion_requires_full_screening_scope() {
    let (_store, workflow) = fixture(true);
    let plan = approved_plan(
        &workflow,
        json!([
            {"step_id":"first","kind":"llm_screening","company_ids":["C1","C2"]},
            {"step_id":"next","kind":"llm_screening","company_ids":["C1"],"depends_on":["first"]}
        ]),
    );
    assert!(workflow.execute("prepare_screening_batch",&json!({"run_id":"R1","plan_id":plan,"step_id":"next","engine":"llm_suite","company_ids":["C1"],"prompt":"Assess fit"})).is_err());
    let mut receipts = Vec::new();
    for id in ["C1", "C2"] {
        let batch=workflow.execute("prepare_screening_batch",&json!({"run_id":"R1","plan_id":plan,"step_id":"first","engine":"llm_suite","company_ids":[id],"prompt":"Assess fit"})).unwrap();
        let args = json!({"run_id":"R1","plan_id":plan,"step_id":"first","batch_id":batch["batch_id"],"results":[{"company_id":id,"fit_score":8,"rationale":"Core fit"}]});
        let result = workflow.execute("save_screening_results", &args).unwrap();
        receipts.push(
            workflow
                .record_receipt("save_screening_results", &args, &result)
                .unwrap(),
        );
        if id == "C1" {
            assert!(workflow
                .execute(
                    "complete_action_step",
                    &json!({"run_id":"R1","plan_id":plan,"step_id":"first","receipt_ids":receipts})
                )
                .is_err());
        }
    }
    workflow
        .execute(
            "complete_action_step",
            &json!({"run_id":"R1","plan_id":plan,"step_id":"first","receipt_ids":receipts}),
        )
        .unwrap();
    workflow.execute("prepare_screening_batch",&json!({"run_id":"R1","plan_id":plan,"step_id":"next","engine":"llm_suite","company_ids":["C1"],"prompt":"Assess fit"})).unwrap();
}

#[test]
fn identical_bing_query_text_does_not_replace_another_companys_research() {
    let (_store, workflow) = fixture(true);
    let plan = approved_plan(
        &workflow,
        json!([{"step_id":"bing","kind":"bing_research","company_ids":["C1","C2"],"query_templates":["Does <company> make policy software?","Does <company> serve insurance carriers?","Does <company> sell recurring software?"]}]),
    );
    let mut receipts = Vec::new();
    for id in ["C1", "C2"] {
        let prepared = workflow
            .execute(
                "prepare_bing_queries",
                &json!({"run_id":"R1","plan_id":plan,"step_id":"bing","company_ids":[id]}),
            )
            .unwrap();
        for query in prepared["queries"].as_array().unwrap() {
            let args = json!({"run_id":"R1","plan_id":plan,"step_id":"bing","company_id":id,"query":query["query"]});
            workflow.authorize_provider("bing_search", &args).unwrap();
            receipts.push(
                workflow
                    .record_receipt("bing_search", &args, &json!({"query_id":"mock"}))
                    .unwrap(),
            );
        }
        if id == "C1" {
            assert!(workflow
                .execute(
                    "complete_action_step",
                    &json!({"run_id":"R1","plan_id":plan,"step_id":"bing","receipt_ids":receipts})
                )
                .is_err());
        }
    }
    workflow
        .execute(
            "complete_action_step",
            &json!({"run_id":"R1","plan_id":plan,"step_id":"bing","receipt_ids":receipts}),
        )
        .unwrap();
}

#[test]
fn migration_does_not_treat_system_initialization_as_human_approval() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("legacy.db");
    {
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch(include_str!("../migrations/001_init.sql"))
            .unwrap();
        connection.execute("INSERT INTO screening_runs(run_id,objective,status,original_criteria_json,created_at,updated_at) VALUES('old','old','ACTIVE','{}','now','now')",[]).unwrap();
        connection.execute("INSERT INTO screening_profiles(profile_id,run_id,version,content_json,status,proposed_at,approved_at,approved_by) VALUES('P','old',1,'{}','APPROVED','now','now','system_initialization')",[]).unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert!(WorkflowService::new(store)
        .require_approved_criteria("old")
        .is_err());
}

#[test]
fn candidate_reads_do_not_apply_financial_geographic_or_classification_filters() {
    let (store, _workflow) = fixture(true);
    let result=store.execute("get_candidate_set",&json!({"run_id":"R1","filters":{"country":["Neverland"],"industry":["Unknown"],"revenue_min":1000,"revenue_max":1}})).unwrap();
    assert_eq!(result["count"], 2);
    assert_eq!(
        result["ignored_search_filters"],
        json!(["country", "industry", "revenue_min", "revenue_max"])
    );
    assert_eq!(
        store
            .execute(
                "get_candidate_set",
                &json!({"run_id":"R1","filters":{"company_ids":["C1"]}})
            )
            .unwrap()["count"],
        1
    );
}

#[test]
fn large_bing_observations_save_bounded_unicode_excerpts_with_provenance() {
    let (store, workflow) = fixture(true);
    let mut response = json!({"query_id":"Q-large","answer":"界\n".repeat(50000),"results":(0..10).map(|_|json!({"title":"界".repeat(2000),"url":"https://company.example/products","snippet":"界\n".repeat(20000)})).collect::<Vec<_>>()});
    workflow.hydrate_bing_observation(&json!({"run_id":"R1","company_id":"C1","query":"Does Same Name sell policy software?"}),&mut response).unwrap();
    assert!(response["evidence_id"].is_string());
    let saved = store
        .execute("get_evidence", &json!({"run_id":"R1","company_id":"C1"}))
        .unwrap();
    assert!(serde_json::to_vec(&saved[0]["value"]).unwrap().len() <= 95000);
    assert_eq!(saved[0]["source_reference"], "Q-large");
    assert_eq!(saved[0]["confidence"], "low");
}

#[test]
fn recommendation_changes_at_exactly_two_thousand_unique_candidates() {
    let (store, _workflow) = fixture(true);
    let companies:Vec<_>=(0..1999).map(|index|json!({"company_id":format!("T{index}"),"name":format!("Test Company {index}")})).collect();
    for chunk in companies.chunks(1000) {
        store
            .execute("ingest_companies", &json!({"companies":chunk}))
            .unwrap();
    }
    let ids: Vec<_> = (0..1997).map(|index| format!("T{index}")).collect();
    for chunk in ids.chunks(1000) {
        store
            .execute(
                "add_candidates",
                &json!({"run_id":"R1","companies":chunk,"discovery_source":"MID"}),
            )
            .unwrap();
    }
    let data = DataService::new(store.clone());
    let before = data
        .execute("get_discovery_summary", &json!({"run_id":"R1"}))
        .unwrap();
    assert_eq!(before["total_unique"], 1999);
    assert_eq!(before["recommended_next_step"], "PITCHBOOK_ENRICHMENT");
    for (id, total) in [("T1997", 2000), ("T1998", 2001)] {
        store
            .execute(
                "add_candidates",
                &json!({"run_id":"R1","companies":[id],"discovery_source":"MID"}),
            )
            .unwrap();
        let summary = data
            .execute("get_discovery_summary", &json!({"run_id":"R1"}))
            .unwrap();
        assert_eq!(summary["total_unique"], total);
        assert_eq!(summary["recommended_next_step"], "LLM_SCREENING");
    }
}

#[test]
fn mid_graph_step_rejects_receipts_from_unrestricted_company_search() {
    let (_store, workflow) = fixture(true);
    let plan = approved_plan(
        &workflow,
        json!([{"step_id":"mid","kind":"search_mid","parameters":{"query":"insurance software"}}]),
    );
    let args = json!({"run_id":"R1","query":"insurance software"});
    let wrong = workflow
        .record_receipt("search_companies", &args, &json!({"query_id":"generic"}))
        .unwrap();
    assert!(workflow
        .execute(
            "complete_action_step",
            &json!({"run_id":"R1","plan_id":plan,"step_id":"mid","receipt_ids":[wrong]})
        )
        .is_err());
    let correct = workflow
        .record_receipt("search_mid", &args, &json!({"query_id":"mid"}))
        .unwrap();
    workflow
        .execute(
            "complete_action_step",
            &json!({"run_id":"R1","plan_id":plan,"step_id":"mid","receipt_ids":[correct]}),
        )
        .unwrap();
}

#[test]
fn m365_company_research_requires_scoped_inputs_and_all_company_question_receipts() {
    let (_store, workflow) = fixture(true);
    let plan = approved_plan(
        &workflow,
        json!([{"step_id":"m365","kind":"m365_research","company_ids":["C1","C2"],"query_templates":["Describe owned products","Describe customer workflows"]}]),
    );
    let base =
        json!({"run_id":"R1","plan_id":plan,"step_id":"m365","question":"Describe owned products"});
    assert!(workflow
        .normalize_m365_arguments(&mut base.clone())
        .is_err());
    let mut outside = base.clone();
    outside["company_ids"] = json!(["C404"]);
    assert!(workflow.normalize_m365_arguments(&mut outside).is_err());
    let mut unrelated = base.clone();
    unrelated["company_ids"] = json!(["C1"]);
    unrelated["companies"] = json!(["Other business"]);
    assert!(workflow.normalize_m365_arguments(&mut unrelated).is_err());
    let empty = workflow
        .record_receipt("m365_research", &base, &json!({"query_id":"empty"}))
        .unwrap();
    assert!(workflow
        .execute(
            "complete_action_step",
            &json!({"run_id":"R1","plan_id":plan,"step_id":"m365","receipt_ids":[empty]})
        )
        .is_err());
    let mut receipts = Vec::new();
    for question in ["Describe owned products", "Describe customer workflows"] {
        for company in ["C1", "C2"] {
            let mut args = base.clone();
            args["question"] = json!(question);
            args["company_ids"] = json!([company]);
            workflow.normalize_m365_arguments(&mut args).unwrap();
            assert!(args["companies"][0].as_str().unwrap().contains(company));
            workflow.authorize_provider("m365_research", &args).unwrap();
            receipts.push(
                workflow
                    .record_receipt("m365_research", &args, &json!({"query_id":"scoped"}))
                    .unwrap(),
            );
            if receipts.len() < 4 {
                assert!(workflow.execute("complete_action_step",&json!({"run_id":"R1","plan_id":plan,"step_id":"m365","receipt_ids":receipts})).is_err());
            }
        }
    }
    workflow
        .execute(
            "complete_action_step",
            &json!({"run_id":"R1","plan_id":plan,"step_id":"m365","receipt_ids":receipts}),
        )
        .unwrap();
    let criteria = approved_plan(
        &workflow,
        json!([{"step_id":"clarify","kind":"m365_research","query_templates":["Explain policy software"]}]),
    );
    let mut literal = json!({"run_id":"R1","plan_id":criteria,"step_id":"clarify","question":"Explain policy software"});
    workflow.normalize_m365_arguments(&mut literal).unwrap();
    workflow
        .authorize_provider("m365_research", &literal)
        .unwrap();
}
