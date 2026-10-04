//! Deterministic approval, search-policy, and external-screening handoffs.
//! Interpretation and execution belong to the caller; no LLM is invoked here.
use crate::{
    error::{Error, Result},
    store::Store,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use schemars::JsonSchema;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Clone)]
pub struct WorkflowService {
    store: Store,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RunArgs {
    run_id: String,
}

#[derive(Clone, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ActionKind {
    SearchMid,
    SearchIscc,
    ImportPitchbook,
    ImportRogo,
    BingResearch,
    LlmScreening,
    M365Screening,
    M365Research,
    Export,
}

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ActionStep {
    step_id: String,
    kind: ActionKind,
    #[serde(default)]
    depends_on: Vec<String>,
    #[serde(default)]
    company_ids: Vec<String>,
    #[serde(default)]
    query_templates: Vec<String>,
    #[serde(default)]
    parameters: Value,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct PlanArgs {
    run_id: String,
    rationale: String,
    steps: Vec<ActionStep>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct PlanRef {
    run_id: String,
    plan_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ApproveArgs {
    run_id: String,
    plan_id: String,
    approved_by: String,
    approve: bool,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct BatchArgs {
    run_id: String,
    plan_id: String,
    step_id: String,
    engine: ScreeningEngine,
    company_ids: Vec<String>,
    prompt: String,
    #[serde(default)]
    output_columns: Vec<String>,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum ScreeningEngine {
    LlmSuite,
    Copilot,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct BingArgs {
    run_id: String,
    plan_id: String,
    step_id: String,
    company_ids: Vec<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ScreeningResult {
    company_id: String,
    fit_score: Value,
    rationale: String,
    #[serde(default)]
    additional_columns: Value,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ResultsArgs {
    run_id: String,
    plan_id: String,
    step_id: String,
    batch_id: String,
    results: Vec<ScreeningResult>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ScreeningReadArgs {
    run_id: String,
    company_id: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CompleteArgs {
    run_id: String,
    plan_id: String,
    step_id: String,
    receipt_ids: Vec<String>,
}

pub fn input_schema(tool: &str) -> Option<Value> {
    let schema = match tool {
        "get_search_policy" => schemars::schema_for!(RunArgs),
        "propose_action_plan" => schemars::schema_for!(PlanArgs),
        "get_action_plan" => schemars::schema_for!(PlanRef),
        "approve_action_plan" => schemars::schema_for!(ApproveArgs),
        "prepare_screening_batch" => schemars::schema_for!(BatchArgs),
        "prepare_bing_queries" => schemars::schema_for!(BingArgs),
        "save_screening_results" => schemars::schema_for!(ResultsArgs),
        "get_screening_results" => schemars::schema_for!(ScreeningReadArgs),
        "complete_action_step" => schemars::schema_for!(CompleteArgs),
        _ => return None,
    };
    serde_json::to_value(schema).ok()
}

fn parse<T: DeserializeOwned>(args: &Value) -> Result<T> {
    serde_json::from_value(args.clone()).map_err(|e| Error::Validation(e.to_string()))
}
fn text(name: &str, value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max {
        return Err(Error::Validation(format!(
            "{name} must contain 1..={max} bytes"
        )));
    }
    Ok(())
}
fn decode(value: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&value).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn now() -> String {
    Utc::now().to_rfc3339()
}
fn secret_keys(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(key, value)| {
            ["api_key", "token", "password", "secret", "authorization"]
                .contains(&key.to_ascii_lowercase().as_str())
                || secret_keys(value)
        }),
        Value::Array(items) => items.iter().any(secret_keys),
        _ => false,
    }
}

impl WorkflowService {
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    pub fn execute(&self, tool: &str, args: &Value) -> Result<Value> {
        match tool {
            "get_search_policy" => self.search_policy(parse::<RunArgs>(args)?.run_id),
            "propose_action_plan" => self.propose(parse(args)?),
            "get_action_plan" => {
                let args: PlanRef = parse(args)?;
                self.get_plan(&args.run_id, &args.plan_id)
            }
            "approve_action_plan" => self.approve(parse(args)?),
            "prepare_screening_batch" => self.screening_batch(parse(args)?),
            "prepare_bing_queries" => self.bing_queries(parse(args)?),
            "save_screening_results" => self.save_results(parse(args)?),
            "get_screening_results" => {
                let args: ScreeningReadArgs = parse(args)?;
                self.screening_results(&args.run_id, &args.company_id, args.limit.unwrap_or(100))
            }
            "complete_action_step" => self.complete_step(parse(args)?),
            _ => Err(Error::NotFound(format!("Unknown workflow tool {tool}"))),
        }
    }

    pub fn require_approved_criteria(&self, run_id: &str) -> Result<i64> {
        let context = self
            .store
            .execute("get_run_context", &json!({"run_id":run_id}))?;
        let version = context["active_profile_version"].as_i64().unwrap_or(0);
        if version == 0 {
            return Err(Error::Conflict(
                "Finalize and obtain analyst approval of the qualitative criteria before discovery"
                    .into(),
            ));
        }
        Ok(version)
    }

    fn current_version(&self, run_id: &str) -> Result<i64> {
        let run = self
            .store
            .execute("get_run_context", &json!({"run_id":run_id}))?;
        Ok(run["active_profile_version"].as_i64().unwrap_or(0))
    }

    fn search_policy(&self, run_id: String) -> Result<Value> {
        let version = self.current_version(&run_id)?;
        let profile = if version > 0 {
            self.store
                .execute("get_active_screening_profile", &json!({"run_id":run_id}))?
        } else {
            self.store.with_connection(|conn| {
                conn.query_row("SELECT version,content_json,status FROM screening_profiles WHERE run_id=? ORDER BY version DESC LIMIT 1", [&run_id], |row| Ok(json!({"version":row.get::<_,i64>(0)?,"content":decode(row.get(1)?)?,"status":row.get::<_,String>(2)?}))).map_err(Error::from)
            })?
        };
        let criteria = self
            .store
            .execute("get_original_criteria", &json!({"run_id":run_id}))?;
        let content = &profile["content"];
        let mut unused = content
            .get("unused_criteria")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(map) = criteria.as_object() {
            for (key, value) in map {
                let normalized = key.to_ascii_lowercase();
                if [
                    "revenue",
                    "employee",
                    "geograph",
                    "countr",
                    "city",
                    "state",
                    "ownership",
                    "industry",
                    "size",
                    "financial",
                ]
                .iter()
                .any(|term| normalized.contains(term))
                {
                    unused.push(json!({"criterion":key,"value":value,"reason":"Preserved from the form; not used for qualitative company discovery"}));
                }
            }
        }
        Ok(json!({
            "run_id":run_id,"profile_version":profile["version"],"approved":version>0,
            "core_business_query":content.get("core_business_query").cloned().unwrap_or(Value::Null),
            "core_business_criteria":content.get("core_business_criteria").cloned().unwrap_or(Value::Null),
            "unused_criteria":unused,"original_criteria":criteria,
            "allowed_search_filters":["company_ids","approved_core_business_exclusions"],
            "core_business_exclusions":content.get("core_business_exclusions").cloned().unwrap_or(json!([])),
            "retrieval_policy":{"default_limit":1000,"maximum_limit":1000,"rerank_first":500,"retain_unranked_tail":true},
            "deferred_review_criteria":unused,
            "analyst_notice":"Discovery uses core-business descriptions and concepts. Financial, size, geographical, ownership, and source classification criteria are not applied as search filters.",
            "requires_orchestrator_interpretation":true
        }))
    }

    fn propose(&self, mut args: PlanArgs) -> Result<Value> {
        text("rationale", &args.rationale, 20000)?;
        let version = self.current_version(&args.run_id)?;
        if args.steps.is_empty() || args.steps.len() > 20 {
            return Err(Error::Validation("Plans require 1..=20 steps".into()));
        }
        let mut ids = HashSet::new();
        let mut iscc = 0;
        for step in &mut args.steps {
            text("step_id", &step.step_id, 80)?;
            if !ids.insert(step.step_id.clone()) {
                return Err(Error::Validation("Duplicate step_id".into()));
            }
            if step.depends_on.len() > 20 || step.company_ids.len() > 2000 {
                return Err(Error::Validation("Step scope exceeds limits".into()));
            }
            if !step.parameters.is_null() && !step.parameters.is_object() {
                return Err(Error::Validation("parameters must be an object".into()));
            }
            if secret_keys(&step.parameters) {
                return Err(Error::Validation(
                    "Do not store credentials in action plans".into(),
                ));
            }
            let mut companies = HashSet::new();
            for id in &mut step.company_ids {
                *id = self.store.resolve_company_id(id)?;
                if !companies.insert(id.clone()) {
                    return Err(Error::Validation("Duplicate company scope".into()));
                }
            }
            if step.kind == ActionKind::SearchIscc {
                iscc += 1;
            }
            if step.kind == ActionKind::BingResearch {
                let min = if step.company_ids.is_empty() { 1 } else { 3 };
                if !(min..=5).contains(&step.query_templates.len()) {
                    return Err(Error::Validation(format!(
                        "This Bing research scope requires {min}..=5 approved query templates"
                    )));
                }
            }
            if step.kind == ActionKind::M365Research && step.query_templates.is_empty() {
                return Err(Error::Validation(
                    "M365 research requires an approved literal question".into(),
                ));
            }
            if step.kind == ActionKind::M365Research
                && !step.company_ids.is_empty()
                && step.parameters.get("companies").is_some()
            {
                return Err(Error::Validation("Scoped M365 plans use company_ids; company names are derived from current context".into()));
            }
            let required_parameters = match step.kind {
                ActionKind::SearchMid | ActionKind::SearchIscc => vec!["query"],
                ActionKind::ImportPitchbook | ActionKind::ImportRogo => vec!["files"],
                ActionKind::Export => vec!["export_type"],
                _ => vec![],
            };
            for key in required_parameters {
                if step.parameters.get(key).is_none() {
                    return Err(Error::Validation(format!("Step parameters require {key}")));
                }
            }
            if step.query_templates.len() > 5 {
                return Err(Error::Validation(
                    "At most five query templates per step".into(),
                ));
            }
            for query in &step.query_templates {
                text("query_template", query, 4000)?;
            }
        }
        if iscc > 5 {
            return Err(Error::Validation(
                "At most five ISCC variations per plan".into(),
            ));
        }
        let by_id: HashMap<&str, &ActionStep> =
            args.steps.iter().map(|s| (s.step_id.as_str(), s)).collect();
        fn visit<'a>(
            id: &'a str,
            steps: &HashMap<&'a str, &'a ActionStep>,
            path: &mut HashSet<&'a str>,
            done: &mut HashSet<&'a str>,
        ) -> Result<()> {
            if done.contains(id) {
                return Ok(());
            }
            if !path.insert(id) {
                return Err(Error::Validation(
                    "Plan dependencies contain a cycle".into(),
                ));
            }
            let step = steps
                .get(id)
                .ok_or_else(|| Error::Validation(format!("Unknown dependency {id}")))?;
            for dependency in &step.depends_on {
                visit(dependency, steps, path, done)?;
            }
            path.remove(id);
            done.insert(id);
            Ok(())
        }
        for id in by_id.keys() {
            visit(id, &by_id, &mut HashSet::new(), &mut HashSet::new())?;
        }
        let encoded = serde_json::to_string(&args.steps)?;
        if encoded.len() > 200000 {
            return Err(Error::Validation("Plan exceeds 200000 bytes".into()));
        }
        let plan_id = format!("PLAN-{}", Uuid::new_v4());
        self.store.with_connection(|conn| {
            conn.execute("INSERT INTO action_plans(plan_id,run_id,profile_version,rationale,steps_json,status,proposed_at) VALUES(?,?,?,?,?,'PROPOSED',?)",params![plan_id,args.run_id,version,args.rationale,encoded,now()])?;
            Ok(())
        })?;
        self.get_plan(&args.run_id, &plan_id)
    }

    fn get_plan(&self, run_id: &str, plan_id: &str) -> Result<Value> {
        text("run_id", run_id, 160)?;
        text("plan_id", plan_id, 160)?;
        self.store.with_connection(|conn| {
            let mut plan=conn.query_row("SELECT plan_id,run_id,profile_version,rationale,steps_json,status,proposed_at,approved_at,approved_by FROM action_plans WHERE plan_id=? AND run_id=?",params![plan_id,run_id],|row|Ok(json!({"plan_id":row.get::<_,String>(0)?,"run_id":row.get::<_,String>(1)?,"profile_version":row.get::<_,i64>(2)?,"rationale":row.get::<_,String>(3)?,"steps":decode(row.get(4)?)?,"status":row.get::<_,String>(5)?,"proposed_at":row.get::<_,String>(6)?,"approved_at":row.get::<_,Option<String>>(7)?,"approved_by":row.get::<_,Option<String>>(8)?}))).optional()?.ok_or_else(||Error::NotFound("Action plan not found in run".into()))?;
            let mut statement=conn.prepare("SELECT step_id,receipt_ids_json,completed_at FROM action_step_progress WHERE plan_id=? ORDER BY step_id")?;
            plan["completed_steps"]=json!(statement.query_map([plan_id],|row|Ok(json!({"step_id":row.get::<_,String>(0)?,"receipt_ids":decode(row.get(1)?)?,"completed_at":row.get::<_,String>(2)?})))?.collect::<std::result::Result<Vec<_>,_>>()?);
            Ok(plan)
        })
    }

    fn approve(&self, args: ApproveArgs) -> Result<Value> {
        text("approved_by", &args.approved_by, 256)?;
        let plan = self.get_plan(&args.run_id, &args.plan_id)?;
        if plan["profile_version"].as_i64() != Some(self.current_version(&args.run_id)?) {
            return Err(Error::Conflict(
                "Profile changed; propose a fresh action plan".into(),
            ));
        }
        self.store.with_connection(|conn| {
            ensure_plan_version(conn,&args.run_id,&args.plan_id,plan["profile_version"].as_i64().unwrap_or(0),"PROPOSED")?;
            let changed=conn.execute("UPDATE action_plans SET status=?,approved_at=?,approved_by=? WHERE plan_id=? AND run_id=? AND status='PROPOSED'",params![if args.approve {"APPROVED"} else {"REJECTED"},now(),args.approved_by,args.plan_id,args.run_id])?;
            if changed!=1 { return Err(Error::Conflict("Action plan must be PROPOSED".into())); }
            Ok(())
        })?;
        self.get_plan(&args.run_id, &args.plan_id)
    }

    fn approved_step(&self, run_id: &str, plan_id: &str, step_id: &str) -> Result<ActionStep> {
        let plan = self.get_plan(run_id, plan_id)?;
        if plan["status"] != "APPROVED" {
            return Err(Error::Conflict(
                "Explicit analyst approval of the action plan is required".into(),
            ));
        }
        if plan["profile_version"].as_i64() != Some(self.current_version(run_id)?) {
            return Err(Error::Conflict(
                "Action plan is stale after a profile change".into(),
            ));
        }
        let steps: Vec<ActionStep> = parse(&plan["steps"])?;
        let step = steps
            .into_iter()
            .find(|s| s.step_id == step_id)
            .ok_or_else(|| Error::NotFound("Action step not found".into()))?;
        let completed: HashSet<&str> = plan["completed_steps"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| s["step_id"].as_str())
            .collect();
        if step
            .depends_on
            .iter()
            .any(|dependency| !completed.contains(dependency.as_str()))
        {
            return Err(Error::Conflict(
                "Complete the step dependencies before this operation".into(),
            ));
        }
        Ok(step)
    }

    fn scope(&self, step: &ActionStep, ids: &[String], max: usize) -> Result<Vec<String>> {
        if ids.is_empty() || ids.len() > max {
            return Err(Error::Validation(format!(
                "company_ids requires 1..={max} entries"
            )));
        }
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for id in ids {
            let id = self.store.resolve_company_id(id)?;
            if !step.company_ids.iter().any(|approved| {
                self.store.resolve_company_id(approved).ok().as_deref() == Some(id.as_str())
            }) {
                return Err(Error::Validation(format!(
                    "Company {id} is outside the approved step"
                )));
            }
            if !seen.insert(id.clone()) {
                return Err(Error::Validation("Duplicate company_ids".into()));
            }
            out.push(id);
        }
        Ok(out)
    }

    fn hydrated_company(&self, run_id: &str, id: &str) -> Result<Value> {
        let company = self
            .store
            .execute("get_company", &json!({"company_id":id}))?;
        let candidates = self.store.execute(
            "get_candidate_set",
            &json!({"run_id":run_id,"filters":{"company_ids":[id]},"limit":1}),
        )?;
        if candidates["count"] != 1 {
            return Err(Error::NotFound(format!(
                "Company {id} is not a candidate in this run"
            )));
        }
        let evidence = self
            .store
            .execute("get_evidence", &json!({"run_id":run_id,"company_id":id}))?;
        let mut company = company;
        company
            .as_object_mut()
            .expect("company object")
            .remove("embedding");
        Ok(
            json!({"company":company,"evidence":evidence,"screening_results":self.screening_results(run_id,id,20)?}),
        )
    }

    fn screening_batch(&self, args: BatchArgs) -> Result<Value> {
        self.require_approved_criteria(&args.run_id)?;
        let step = self.approved_step(&args.run_id, &args.plan_id, &args.step_id)?;
        let profile_version = self.get_plan(&args.run_id, &args.plan_id)?["profile_version"]
            .as_i64()
            .unwrap_or(0);
        let required = match args.engine {
            ScreeningEngine::LlmSuite => ActionKind::LlmScreening,
            ScreeningEngine::Copilot => ActionKind::M365Screening,
        };
        if step.kind != required {
            return Err(Error::Validation(
                "Engine does not match the approved step".into(),
            ));
        }
        text("prompt", &args.prompt, 100000)?;
        if args.output_columns.len() > 100 {
            return Err(Error::Validation("At most 100 output columns".into()));
        }
        for column in &args.output_columns {
            text("output column", column, 160)?;
        }
        let ids = self.scope(&step, &args.company_ids, 100)?;
        let mut companies = Vec::new();
        let mut missing_linkedin = Vec::new();
        for id in &ids {
            let mut context = self.hydrated_company(&args.run_id, id)?;
            if matches!(args.engine, ScreeningEngine::Copilot) {
                let company = &context["company"];
                let linkedin = company
                    .get("PB_LinkedIn URL")
                    .and_then(Value::as_str)
                    .filter(|s| valid_linkedin_url(s))
                    .map(str::to_owned);
                if let Some(linkedin) = linkedin {
                    context["company"]["linkedin_url"] = json!(linkedin);
                } else {
                    context["company"]["linkedin_url"] = Value::Null;
                    missing_linkedin.push(id.clone());
                }
            }
            companies.push(context);
        }
        let batch_id = format!("BATCH-{}", Uuid::new_v4());
        let payload = json!({"batch_id":batch_id,"run_id":args.run_id,"plan_id":args.plan_id,"step_id":args.step_id,"engine":args.engine,"profile_version":profile_version,"prompt":args.prompt,"output_columns":args.output_columns,"required_output":["company_id","fit_score","rationale"],"fit_score_contract":"number 0..10 or CHECK","companies":companies,"missing_optional_linkedin":missing_linkedin,"executed":false});
        if serde_json::to_vec(&payload)?.len() > 1000000 {
            return Err(Error::Validation(
                "Hydrated batch exceeds 1 MB; reduce company count".into(),
            ));
        }
        self.store.with_connection(|conn|{ensure_plan_version(conn,&args.run_id,&args.plan_id,profile_version,"APPROVED")?;conn.execute("INSERT INTO screening_batches(batch_id,run_id,plan_id,step_id,company_ids_json,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",params![batch_id,args.run_id,args.plan_id,args.step_id,serde_json::to_string(&ids)?,serde_json::to_string(&payload)?,now()])?;Ok(())})?;
        Ok(payload)
    }

    fn bing_queries(&self, args: BingArgs) -> Result<Value> {
        let step = self.approved_step(&args.run_id, &args.plan_id, &args.step_id)?;
        if step.kind != ActionKind::BingResearch {
            return Err(Error::Validation("Step must be bing_research".into()));
        }
        let ids = self.scope(&step, &args.company_ids, 100)?;
        let mut queries = Vec::new();
        for id in ids {
            let company = self.hydrated_company(&args.run_id, &id)?["company"].clone();
            let name = preferred(&company, "PB_Name", "name");
            let website = preferred(&company, "PB_Website", "website");
            for (index, template) in step.query_templates.iter().enumerate() {
                queries.push(json!({"company_id":id,"question_index":index+1,"query":template.replace("<company>",&format!("{name}; {website}")).replace("{company}",name).replace("{website}",website)}));
            }
        }
        Ok(
            json!({"run_id":args.run_id,"plan_id":args.plan_id,"step_id":args.step_id,"queries":queries,"executed":false}),
        )
    }

    pub fn normalize_m365_arguments(&self, args: &mut Value) -> Result<()> {
        let run = args["run_id"]
            .as_str()
            .ok_or_else(|| Error::Validation("run_id is required".into()))?
            .to_owned();
        let plan = args["plan_id"]
            .as_str()
            .ok_or_else(|| Error::Conflict("Approved M365 plan is required".into()))?;
        let step_id = args["step_id"]
            .as_str()
            .ok_or_else(|| Error::Validation("step_id is required".into()))?;
        let step = self.approved_step(&run, plan, step_id)?;
        if step.kind != ActionKind::M365Research {
            return Err(Error::Validation(
                "M365 research requires an m365_research step".into(),
            ));
        }
        let ids: Vec<String> = serde_json::from_value(
            args.get("company_ids")
                .cloned()
                .unwrap_or_else(|| json!([])),
        )?;
        let supplied: Vec<String> =
            serde_json::from_value(args.get("companies").cloned().unwrap_or_else(|| json!([])))?;
        if step.company_ids.is_empty() {
            if !ids.is_empty() {
                return Err(Error::Validation(
                    "Company IDs are outside the approved M365 scope".into(),
                ));
            }
            let approved: Vec<String> = serde_json::from_value(
                step.parameters
                    .get("companies")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            )?;
            if supplied != approved {
                return Err(Error::Validation(
                    "Companies differ from approved literal M365 research parameters".into(),
                ));
            }
            args["company_ids"] = json!([]);
            args["companies"] = json!(approved);
            return Ok(());
        }
        let ids = self.scope(&step, &ids, 100)?;
        let mut companies = Vec::new();
        for id in &ids {
            let company = self.hydrated_company(&run, id)?["company"].clone();
            companies.push(format!(
                "{}; {} [{}]",
                preferred(&company, "PB_Name", "name"),
                preferred(&company, "PB_Website", "website"),
                id
            ));
        }
        if !supplied.is_empty() && supplied != companies {
            return Err(Error::Validation("Scoped M365 company strings must match derived name, website and ID; omit companies to derive them".into()));
        }
        args["company_ids"] = json!(ids);
        args["companies"] = json!(companies);
        Ok(())
    }

    pub fn authorize_provider(&self, tool: &str, args: &Value) -> Result<()> {
        if !["bing_search", "m365_research"].contains(&tool) {
            return Ok(());
        }
        let run = args["run_id"]
            .as_str()
            .ok_or_else(|| Error::Validation("run_id is required for approved research".into()))?;
        let plan = args["plan_id"].as_str().ok_or_else(|| {
            Error::Conflict(
                "Propose the research plan and obtain analyst approval before calling the provider"
                    .into(),
            )
        })?;
        let step_id = args["step_id"]
            .as_str()
            .ok_or_else(|| Error::Validation("step_id is required".into()))?;
        let step = self.approved_step(run, plan, step_id)?;
        if tool == "m365_research" {
            let mut normalized = args.clone();
            self.normalize_m365_arguments(&mut normalized)?;
            if normalized["companies"]
                != args.get("companies").cloned().unwrap_or_else(|| json!([]))
            {
                return Err(Error::Validation(
                    "M365 company payload has not been hydrated from its approved scope".into(),
                ));
            }
            if step.kind != ActionKind::M365Research {
                return Err(Error::Validation("Use prepare_screening_batch for Copilot screening; m365_research requires an approved m365_research step".into()));
            }
            let question = args["question"]
                .as_str()
                .ok_or_else(|| Error::Validation("question is required".into()))?;
            if !step
                .query_templates
                .iter()
                .any(|template| template == question)
            {
                return Err(Error::Validation(
                    "Question differs from the approved M365 research plan".into(),
                ));
            }
            return Ok(());
        }
        if step.kind != ActionKind::BingResearch {
            return Err(Error::Validation(
                "Step does not authorize Bing research".into(),
            ));
        }
        let query = args["query"]
            .as_str()
            .ok_or_else(|| Error::Validation("query is required".into()))?;
        if let Some(id) = args["company_id"].as_str() {
            let prepared = self.bing_queries(BingArgs {
                run_id: run.into(),
                plan_id: plan.into(),
                step_id: step_id.into(),
                company_ids: vec![id.into()],
            })?;
            if !prepared["queries"]
                .as_array()
                .is_some_and(|queries| queries.iter().any(|item| item["query"] == query))
            {
                return Err(Error::Validation(
                    "Query differs from the approved company question templates".into(),
                ));
            }
        } else if !step.company_ids.is_empty()
            || !step
                .query_templates
                .iter()
                .any(|template| template == query)
        {
            return Err(Error::Validation("Criteria research must use a literal approved query; company research requires company_id".into()));
        }
        Ok(())
    }

    fn save_results(&self, args: ResultsArgs) -> Result<Value> {
        let step = self.approved_step(&args.run_id, &args.plan_id, &args.step_id)?;
        if ![ActionKind::LlmScreening, ActionKind::M365Screening].contains(&step.kind) {
            return Err(Error::Validation("Step is not screening".into()));
        }
        if args.results.is_empty() || args.results.len() > 100 {
            return Err(Error::Validation("Results require 1..=100 rows".into()));
        }
        let batch=self.store.with_connection(|conn|{conn.query_row("SELECT company_ids_json FROM screening_batches WHERE batch_id=? AND run_id=? AND plan_id=? AND step_id=?",params![args.batch_id,args.run_id,args.plan_id,args.step_id],|row|decode(row.get(0)?)).optional()?.ok_or_else(||Error::NotFound("Prepared screening batch not found".into()))})?;
        let mut seen = HashSet::new();
        let mut rows = Vec::new();
        for result in &args.results {
            let id = self.store.resolve_company_id(&result.company_id)?;
            if !batch.as_array().is_some_and(|ids| {
                ids.iter().any(|item| {
                    item.as_str()
                        .and_then(|raw| self.store.resolve_company_id(raw).ok())
                        .as_deref()
                        == Some(id.as_str())
                })
            }) || !seen.insert(id.clone())
            {
                return Err(Error::Validation(
                    "Result company is duplicate or outside prepared batch".into(),
                ));
            }
            if result.fit_score != "CHECK"
                && !result
                    .fit_score
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && (0.0..=10.0).contains(&n))
            {
                return Err(Error::Validation("fit_score must be 0..10 or CHECK".into()));
            }
            text("rationale", &result.rationale, 20000)?;
            if !result.additional_columns.is_null() && !result.additional_columns.is_object() {
                return Err(Error::Validation(
                    "additional_columns must be an object".into(),
                ));
            }
            rows.push((id,serde_json::to_string(&json!({"fit_score":result.fit_score,"rationale":result.rationale,"additional_columns":result.additional_columns}))?));
        }
        self.store.with_connection(|conn|{
            let tx=conn.transaction()?;
            let version:i64=tx.query_row("SELECT json_extract(payload_json,'$.profile_version') FROM screening_batches WHERE batch_id=?",[&args.batch_id],|row|row.get(0))?;
            ensure_plan_version(&tx,&args.run_id,&args.plan_id,version,"APPROVED")?;
            for (id,payload) in &rows {
                let old:Option<String>=tx.query_row("SELECT result_json FROM screening_results WHERE batch_id=? AND company_id=?",params![args.batch_id,id],|row|row.get(0)).optional()?;
                if old.as_ref().is_some_and(|old|old!=payload) {return Err(Error::Conflict("A different result already exists for this batch/company".into()));}
                tx.execute("INSERT OR IGNORE INTO screening_results(batch_id,company_id,result_json,created_at) VALUES(?,?,?,?)",params![args.batch_id,id,payload,now()])?;
            }
            tx.commit()?;Ok(())
        })?;
        Ok(
            json!({"batch_id":args.batch_id,"saved":rows.len(),"candidate_status_changed":false,"analyst_labels_changed":false}),
        )
    }

    pub fn screening_results(&self, run_id: &str, company_id: &str, limit: usize) -> Result<Value> {
        self.current_version(run_id)?;
        if !(1..=500).contains(&limit) {
            return Err(Error::Validation("limit requires 1..=500".into()));
        }
        let id = self.store.resolve_company_id(company_id)?;
        self.store.with_connection(|conn|{
            let mut statement=conn.prepare("SELECT r.batch_id,r.result_json,r.created_at,b.step_id,json_extract(b.payload_json,'$.profile_version'),json_extract(b.payload_json,'$.engine') FROM screening_results r JOIN screening_batches b ON b.batch_id=r.batch_id WHERE b.run_id=? AND r.company_id=? ORDER BY r.created_at DESC LIMIT ?")?;
            let rows=statement.query_map(params![run_id,id,limit as i64],|row|Ok(json!({"batch_id":row.get::<_,String>(0)?,"result":decode(row.get(1)?)?,"created_at":row.get::<_,String>(2)?,"step_id":row.get::<_,String>(3)?,"profile_version":row.get::<_,i64>(4)?,"engine":row.get::<_,String>(5)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
            Ok(json!(rows))
        })
    }

    pub fn record_receipt(&self, tool: &str, args: &Value, result: &Value) -> Result<String> {
        let receipt_id = format!("OP-{}", Uuid::new_v4());
        let run_id = args["run_id"]
            .as_str()
            .or_else(|| result["run_id"].as_str());
        let arguments = serde_json::to_string(args)?;
        let summary = json!({"query_id":result["query_id"],"company_id":args["company_id"],"batch_id":result["batch_id"],"saved":result["saved"],"processed":result["processed"],"path":result["path"]});
        self.store.with_connection(|conn|{conn.execute("INSERT INTO operation_receipts(receipt_id,run_id,tool,arguments_json,result_json,created_at) VALUES(?,?,?,?,?,?)",params![receipt_id,run_id,tool,arguments,serde_json::to_string(&summary)?,now()])?;Ok(())})?;
        Ok(receipt_id)
    }

    fn complete_step(&self, args: CompleteArgs) -> Result<Value> {
        let step = self.approved_step(&args.run_id, &args.plan_id, &args.step_id)?;
        let plan = self.get_plan(&args.run_id, &args.plan_id)?;
        let mut expected_bing: HashSet<(Option<String>, String)> = HashSet::new();
        if step.kind == ActionKind::BingResearch {
            if step.company_ids.is_empty() {
                expected_bing.extend(
                    step.query_templates
                        .iter()
                        .map(|query| (None, query.clone())),
                );
            } else {
                for company_ids in step.company_ids.chunks(100) {
                    let prepared = self.bing_queries(BingArgs {
                        run_id: args.run_id.clone(),
                        plan_id: args.plan_id.clone(),
                        step_id: args.step_id.clone(),
                        company_ids: company_ids.to_vec(),
                    })?;
                    expected_bing.extend(
                        prepared["queries"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|query| {
                                query["query"].as_str().map(|text| {
                                    (
                                        query["company_id"].as_str().map(str::to_owned),
                                        text.to_owned(),
                                    )
                                })
                            }),
                    );
                }
            }
        }
        let expected_companies: HashSet<String> = step
            .company_ids
            .iter()
            .map(|id| self.store.resolve_company_id(id))
            .collect::<Result<_>>()?;
        let mut expected_m365 = HashSet::<(Option<String>, String)>::new();
        if step.kind == ActionKind::M365Research {
            for question in &step.query_templates {
                if expected_companies.is_empty() {
                    expected_m365.insert((None, question.clone()));
                }
                for id in &expected_companies {
                    expected_m365.insert((Some(id.clone()), question.clone()));
                }
            }
        }
        if args.receipt_ids.is_empty() || args.receipt_ids.len() > 10000 {
            return Err(Error::Validation(
                "receipt_ids requires 1..=10000 entries".into(),
            ));
        }
        let expected = match step.kind {
            ActionKind::SearchMid => vec!["search_mid"],
            ActionKind::SearchIscc => vec!["search_iscc"],
            ActionKind::ImportPitchbook | ActionKind::ImportRogo => vec!["import_enrichment_files"],
            ActionKind::BingResearch => vec!["bing_search"],
            ActionKind::LlmScreening | ActionKind::M365Screening => vec!["save_screening_results"],
            ActionKind::M365Research => vec!["m365_research"],
            ActionKind::Export => vec!["export_candidate_set"],
        };
        self.store.with_connection(|conn|{
            let tx=conn.transaction()?;
            ensure_plan_version(&tx,&args.run_id,&args.plan_id,plan["profile_version"].as_i64().unwrap_or(0),"APPROVED")?;
            let mut seen=HashSet::new();
            let mut observed_bing=HashSet::new();
            let mut observed_m365=HashSet::new();
            let mut observed_companies=HashSet::new();
            for receipt in &args.receipt_ids {
                if !seen.insert(receipt) {return Err(Error::Validation("Duplicate receipt_ids".into()));}
                let record:Option<(Option<String>,String,Value,String)>=tx.query_row("SELECT run_id,tool,arguments_json,created_at FROM operation_receipts WHERE receipt_id=?",[receipt],|row|Ok((row.get(0)?,row.get(1)?,decode(row.get(2)?)?,row.get(3)?))).optional()?;
                let (run_id,tool,parameters,created_at)=record.ok_or_else(||Error::NotFound("Operation receipt not found".into()))?;
                if run_id.as_deref()!=Some(args.run_id.as_str()) || !expected.contains(&tool.as_str()) {return Err(Error::Validation("Receipt does not belong to this run and step operation".into()));}
                if ["bing_search","m365_research","save_screening_results"].contains(&tool.as_str()) && (parameters["plan_id"]!=args.plan_id || parameters["step_id"]!=args.step_id) {return Err(Error::Validation("Research receipt belongs to another plan or step".into()));}
                if Some(created_at.as_str())<plan["approved_at"].as_str() {return Err(Error::Validation("Receipt predates approval".into()));}
                if let Some(map)=step.parameters.as_object() {for (key,approved_value) in map {if parameters.get(key)!=Some(approved_value) {return Err(Error::Validation(format!("Receipt differs from approved parameter {key}")));}}}
                if tool=="bing_search" {if let Some(query)=parameters["query"].as_str() {
                    let company_id=parameters["company_id"].as_str().map(|id|resolve_in_connection(&tx,id)).transpose()?;
                    observed_bing.insert((company_id,query.to_owned()));
                }}
                if tool=="save_screening_results" {
                    let batch_id=parameters["batch_id"].as_str().ok_or_else(||Error::Validation("Receipt has no batch_id".into()))?;
                    let mut statement=tx.prepare("SELECT company_id FROM screening_results WHERE batch_id=?")?;
                    observed_companies.extend(statement.query_map([batch_id],|row|row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?);
                }
                if tool=="m365_research" {
                    let question=parameters["question"].as_str().ok_or_else(||Error::Validation("M365 receipt has no question".into()))?;
                    if !step.query_templates.iter().any(|approved|approved==question) {return Err(Error::Validation("M365 receipt question is outside approval".into()));}
                    let ids:Vec<String>=serde_json::from_value(parameters.get("company_ids").cloned().unwrap_or_else(||json!([])))?;
                    if ids.is_empty() {
                        if !expected_companies.is_empty() {return Err(Error::Validation("M365 receipt omits its approved company scope".into()));}
                        observed_m365.insert((None,question.to_owned()));
                    }
                    for id in ids {
                        let id=resolve_in_connection(&tx,&id)?;
                        if !expected_companies.contains(&id) {return Err(Error::Validation("M365 receipt company is outside approval".into()));}
                        observed_m365.insert((Some(id),question.to_owned()));
                    }
                }
                let owner:Option<(String,String)>=tx.query_row("SELECT plan_id,step_id FROM action_receipt_claims WHERE receipt_id=?",[receipt],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
                if owner.as_ref().is_some_and(|(p,s)|p!=&args.plan_id || s!=&args.step_id) {return Err(Error::Conflict("Receipt already belongs to another action step".into()));}
                tx.execute("INSERT OR IGNORE INTO action_receipt_claims(receipt_id,plan_id,step_id) VALUES(?,?,?)",params![receipt,args.plan_id,args.step_id])?;
            }
            if step.kind==ActionKind::BingResearch && !expected_bing.is_subset(&observed_bing) {return Err(Error::Conflict("Bing research is incomplete for the approved company questions".into()));}
            if step.kind==ActionKind::M365Research && !expected_m365.is_subset(&observed_m365) {return Err(Error::Conflict("M365 research is incomplete for the approved company questions".into()));}
            if [ActionKind::LlmScreening,ActionKind::M365Screening].contains(&step.kind) && !expected_companies.is_subset(&observed_companies) {return Err(Error::Conflict("Screening results are incomplete for the approved company scope".into()));}
            let existing:Option<String>=tx.query_row("SELECT receipt_ids_json FROM action_step_progress WHERE plan_id=? AND step_id=?",params![args.plan_id,args.step_id],|row|row.get(0)).optional()?;
            let encoded=serde_json::to_string(&args.receipt_ids)?;
            if existing.as_ref().is_some_and(|old|old!=&encoded) {return Err(Error::Conflict("Step was completed with different receipts".into()));}
            tx.execute("INSERT OR IGNORE INTO action_step_progress(plan_id,step_id,receipt_ids_json,completed_at) VALUES(?,?,?,?)",params![args.plan_id,args.step_id,encoded,now()])?;
            tx.commit()?;Ok(())
        })?;
        Ok(
            json!({"run_id":args.run_id,"plan_id":args.plan_id,"step_id":args.step_id,"status":"COMPLETED","receipt_ids":args.receipt_ids}),
        )
    }

    pub fn hydrate_bing_observation(&self, args: &Value, result: &mut Value) -> Result<()> {
        let Some(company_id) = args["company_id"].as_str() else {
            return Ok(());
        };
        let mut snippets: Vec<Value> = result["results"]
            .as_array()
            .into_iter()
            .flatten()
            .take(10)
            .map(|item| json!({"title":bounded_excerpt(&item["title"],1000),"url":bounded_excerpt(&item["url"],2000),"snippet":bounded_excerpt(&item["snippet"],4000)}))
            .collect();
        let query = args["query"].as_str().unwrap_or("");
        let answer = bounded_excerpt(&result["answer"], 8000);
        let mut value =
            json!({"question":query,"answer":answer,"sources":snippets,"excerpted":true});
        while serde_json::to_vec(&value)?.len() > 95000 && !snippets.is_empty() {
            snippets.pop();
            value["sources"] = json!(snippets);
        }
        let evidence=self.store.execute("save_evidence",&json!({"run_id":args["run_id"],"company_id":company_id,"claim":"bing_research_observation","value":value,"source_type":"bing","source_reference":result["query_id"],"confidence":"low","extraction_method":"Bounded search excerpts; research lead, not a verified fit conclusion. Full response is retained in search history."}))?;
        result["evidence_id"] = evidence["evidence_id"].clone();
        Ok(())
    }
}

fn bounded_excerpt(value: &Value, max_bytes: usize) -> Value {
    let Some(text) = value.as_str() else {
        return Value::Null;
    };
    let mut end = text.len().min(max_bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    json!(&text[..end])
}

fn preferred<'a>(company: &'a Value, pb: &str, original: &str) -> &'a str {
    company[pb]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| company[original].as_str())
        .unwrap_or("")
}

fn valid_linkedin_url(value: &str) -> bool {
    url::Url::parse(value.trim()).is_ok_and(|url| {
        matches!(url.scheme(), "https" | "http")
            && url.username().is_empty()
            && url.password().is_none()
            && url
                .host_str()
                .is_some_and(|host| host == "linkedin.com" || host.ends_with(".linkedin.com"))
            && !url.path().trim_matches('/').is_empty()
    })
}

fn ensure_plan_version(
    conn: &Connection,
    run_id: &str,
    plan_id: &str,
    expected: i64,
    status: &str,
) -> Result<()> {
    let current:i64=conn.query_row("SELECT COALESCE(MAX(version),0) FROM screening_profiles WHERE run_id=? AND status='APPROVED'",[run_id],|row|row.get(0))?;
    let plan: Option<(i64, String)> = conn
        .query_row(
            "SELECT profile_version,status FROM action_plans WHERE run_id=? AND plan_id=?",
            params![run_id, plan_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if current != expected
        || plan
            .as_ref()
            .is_none_or(|(version, actual)| *version != expected || actual != status)
    {
        return Err(Error::Conflict(
            "Profile or plan approval changed during this operation; rebuild the handoff".into(),
        ));
    }
    Ok(())
}

fn resolve_in_connection(conn: &Connection, supplied: &str) -> Result<String> {
    if let Some(id) = conn
        .query_row(
            "SELECT company_id FROM companies WHERE company_id=?",
            [supplied],
            |row| row.get(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    let normalized = crate::identity::normalized_identifier(Some(&json!(supplied)))
        .ok_or_else(|| Error::Validation("Missing company identifier".into()))?;
    conn.query_row(
        "SELECT company_id FROM company_identifiers WHERE kind='PK' AND identifier=?",
        [normalized],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| Error::NotFound(format!("Company no longer resolves: {supplied}")))
}
