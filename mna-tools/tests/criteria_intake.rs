use mna_tools::{error::Error, search::SearchEngine, Store};
use serde_json::{json, Value};

fn store_with_run() -> Store {
    let store = Store::open(":memory:").unwrap();
    store
        .execute(
            "create_run",
            &json!({"run_id":"R","objective":"Screen","original_criteria":{}}),
        )
        .unwrap();
    store
}

fn save(store: &Store, extra: Value) -> Result<Value, Error> {
    let mut args = json!({
        "run_id":"R",
        "criteria_text":"Claims workflow software for carriers",
        "business_definition":"Builds claims workflow software"
    });
    for (key, value) in extra.as_object().unwrap() {
        args[key] = value.clone();
    }
    store.execute("save_criteria_revision", &args)
}

#[test]
fn intake_form_and_exclusions_are_stored_on_the_revision_and_listed_in_history() {
    let store = store_with_run();
    let first = save(
        &store,
        json!({
            "core_business_exclusions":["consulting","  Staffing  ",""],
            "intake_form":{"submitter":{"name":"Sam","request_type":"New Platform"},"thesis":"Claims","size":["$0-50MM"]}
        }),
    )
    .unwrap();
    assert_eq!(first["revision"], 1);
    // Exclusions are trimmed and blanks dropped; the intake form is stored verbatim.
    assert_eq!(
        first["last_criteria"]["core_business_exclusions"],
        json!(["consulting", "Staffing"])
    );
    assert_eq!(first["last_criteria"]["intake_form"]["submitter"]["name"], "Sam");

    // Saving identical content again is idempotent; changing only the exclusions is a new,
    // differently digested revision.
    let same = save(
        &store,
        json!({
            "core_business_exclusions":["consulting","Staffing"],
            "intake_form":{"submitter":{"name":"Sam","request_type":"New Platform"},"thesis":"Claims","size":["$0-50MM"]}
        }),
    )
    .unwrap();
    assert_eq!(same["revision"], 1);
    assert_eq!(same["digest"], first["digest"]);
    let second = save(
        &store,
        json!({"core_business_exclusions":["consulting"],"intake_form":{"thesis":"Claims only"}}),
    )
    .unwrap();
    assert_eq!(second["revision"], 2);
    assert_ne!(second["digest"], first["digest"]);
    // A revision without the optional fields keeps its original digest recipe.
    let plain = save(&store, json!({"business_definition":"Different definition"})).unwrap();
    assert_eq!(plain["revision"], 3);
    assert_eq!(plain["last_criteria"]["core_business_exclusions"], json!([]));
    assert!(plain["last_criteria"]["intake_form"].is_null());

    let history = store
        .execute("get_criteria_history", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(history["count"], 3);
    let revisions = history["revisions"].as_array().unwrap();
    assert_eq!(revisions[0]["intake_form"]["thesis"], "Claims");
    assert_eq!(
        revisions[0]["core_business_exclusions"],
        json!(["consulting", "Staffing"])
    );
    // A revision is valid from created_at until the next one is saved.
    assert_eq!(revisions[0]["superseded_at"], revisions[1]["created_at"]);
    assert_eq!(revisions[1]["superseded_at"], revisions[2]["created_at"]);
    assert!(revisions[2]["superseded_at"].is_null());
    assert_eq!(revisions[0]["approved"], false);
    assert!(revisions[0]["approved_at"].is_null());
    // last_criteria is the NEWEST revision, not the previous one.
    assert_eq!(history["last_criteria"]["revision"], 3);

    // The shortlist fingerprint keeps its original shape so new fields never stale plans.
    let context = store
        .execute("get_shortlist_context", &json!({"run_id":"R"}))
        .unwrap();
    let criteria = context["criteria_revision"].as_object().unwrap();
    assert_eq!(criteria["revision"], 3);
    assert!(!criteria.contains_key("intake_form"));
    assert!(!criteria.contains_key("core_business_exclusions"));
}

#[test]
fn intake_form_and_exclusions_are_validated() {
    let store = store_with_run();
    let many: Vec<String> = (0..101).map(|n| format!("term {n}")).collect();
    assert!(matches!(
        save(&store, json!({"core_business_exclusions":many})),
        Err(Error::Validation(_))
    ));
    assert!(matches!(
        save(&store, json!({"core_business_exclusions":["x".repeat(501)]})),
        Err(Error::Validation(_))
    ));
    assert!(save(&store, json!({"core_business_exclusions":["x".repeat(500)]})).is_ok());
    assert!(matches!(
        save(&store, json!({"intake_form":"not an object"})),
        Err(Error::Validation(_))
    ));
    assert!(matches!(
        save(&store, json!({"intake_form":{"": "blank key"}})),
        Err(Error::Validation(_))
    ));
    assert!(matches!(
        save(&store, json!({"intake_form":{"notes":"x".repeat(100 * 1024)}})),
        Err(Error::Validation(_))
    ));
    let mut deep = json!("leaf");
    for _ in 0..10 {
        deep = json!({"level": deep});
    }
    assert!(matches!(
        save(&store, json!({"intake_form":deep})),
        Err(Error::Validation(_))
    ));
    assert!(save(&store, json!({"surprise":true})).is_err());
    // An explicit null is no intake form.
    let none = save(&store, json!({"intake_form":null,"business_definition":"Another"})).unwrap();
    assert!(none["last_criteria"]["intake_form"].is_null());
    // 100 KB is accepted.
    assert!(save(&store, json!({"intake_form":{"notes":"y".repeat(100 * 1024 - 20)}})).is_ok());
}

#[tokio::test]
async fn approval_copies_exclusions_into_the_profile_so_exclude_keywords_keeps_working() {
    let store = store_with_run();
    store
        .execute(
            "ingest_companies",
            &json!({"companies":[
                {"company_id":"C1","name":"Claims One","description":"Claims software"},
                {"company_id":"C2","name":"Claims Two","description":"Claims software"},
                {"company_id":"C3","name":"Claims Advisors","description":"Claims software consulting"}
            ]}),
        )
        .unwrap();
    let saved = save(
        &store,
        json!({"core_business_exclusions":["Consulting"],"intake_form":{"thesis":"Claims"}}),
    )
    .unwrap();
    store
        .execute(
            "approve_criteria_revision",
            &json!({"run_id":"R","revision":saved["revision"],"digest":saved["digest"],"approved_by":"Analyst"}),
        )
        .unwrap();
    let profile = store
        .execute("get_active_screening_profile", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(profile["content"]["core_business_exclusions"], json!(["Consulting"]));
    assert_eq!(
        profile["content"]["core_business_query"],
        "Builds claims workflow software"
    );

    let engine = SearchEngine::new(store.clone()).unwrap();
    let request = json!({"run_id":"R","query":"claims software","mode":"lexical","prefer_meilisearch":false,"filters":{"exclude_keywords":["consulting"]}});
    let result = engine.execute("search_mid", &request).await.unwrap();
    assert_eq!(result["total"], 2);
    assert_eq!(result["applied_core_business_exclusions"], json!(["Consulting"]).as_array().map(|_| json!(["consulting"])).unwrap());
    assert!(!result["ignored_search_filters"]
        .as_array()
        .unwrap()
        .contains(&json!("exclude_keywords_unapproved")));

    let history = store
        .execute("get_criteria_history", &json!({"run_id":"R"}))
        .unwrap();
    assert_eq!(history["revisions"][0]["approved"], true);
    assert_eq!(history["revisions"][0]["approved_by"], "Analyst");
    assert!(history["revisions"][0]["approved_at"].is_string());
}
