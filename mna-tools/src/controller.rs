//! Markdown controller turns. Model output can only propose or use the narrow
//! action allowlist; every call still passes through the non-admin runtime.
use crate::{
    error::{Error, Result},
    instruction_set::{self, InstructionContext, ParsedReply},
    runtime::{tool_definitions, ToolCall, ToolDefinition},
    Runtime, Store,
};
use rusqlite::{params, OptionalExtension};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const CONTROLLER_ACTIONS: &[&str] = &[
    "search_mid",
    "score_mid_semantic",
    "search_mid_semantic",
    "search_iscc",
    "get_discovery_summary",
    "get_shortlist_context",
    "get_screening_grid",
    "get_company_detail",
    "get_criteria_history",
    "get_screening_rounds",
    "get_mid_index_status",
    "prepare_bing_queries",
    "propose_prepared_plan",
];

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TurnRequest {
    pub run_id: String,
    /// Latest analyst request (1..4000 characters).
    pub analyst_message: String,
    /// Optional subset of the fixed controller allowlist.
    pub allowed_actions: Option<Vec<String>>,
    #[serde(default)]
    pub new_conversation: bool,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ReadRequest {
    run_id: String,
    /// Number of recent turns, from 1 to 100 (default 20).
    limit: Option<usize>,
}

pub fn turn_input_schema() -> Value {
    serde_json::to_value(schemars::schema_for!(TurnRequest)).expect("schema serializes")
}

pub fn input_schema(tool: &str) -> Option<Value> {
    (tool == "get_controller_turns").then(|| {
        serde_json::to_value(schemars::schema_for!(ReadRequest)).expect("schema serializes")
    })
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn compact(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}
fn tokens(text: &str) -> i64 {
    text.chars().count().div_ceil(4) as i64
}

fn field_type(schema: &Value, root: &Value, depth: usize) -> String {
    if depth > 3 {
        return "value".into();
    }
    if let Some(reference) = schema["$ref"].as_str().and_then(|s| s.strip_prefix('#')) {
        return field_type(root.pointer(reference).unwrap_or(schema), root, depth + 1);
    }
    if let Some(values) = schema["enum"].as_array() {
        return format!(
            "allowed values: {}",
            values
                .iter()
                .map(|v| v
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| v.to_string()))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    if let Some(variants) = schema["anyOf"]
        .as_array()
        .or_else(|| schema["oneOf"].as_array())
    {
        return variants
            .iter()
            .map(|s| field_type(s, root, depth + 1))
            .collect::<Vec<_>>()
            .join(" or ");
    }
    let kind = schema["type"].as_str().unwrap_or("value");
    if kind == "array" {
        return format!("list of {}", field_type(&schema["items"], root, depth + 1));
    }
    if kind == "object" {
        if let Some(props) = schema["properties"].as_object() {
            return format!(
                "object with fields {}",
                props.keys().cloned().collect::<Vec<_>>().join(", ")
            );
        }
    }
    kind.into()
}

pub fn action_guide(catalog: &[ToolDefinition], allowed: &[&str]) -> String {
    let mut guide = Vec::new();
    for name in allowed {
        let Some(tool) = catalog.iter().find(|tool| tool.name == *name) else {
            continue;
        };
        let mut entry = format!("{}: {}\n", tool.name, tool.description);
        if let Some(fields) = tool.input_schema["properties"].as_object() {
            for (name, schema) in fields {
                if name == "run_id" || name == "loop_id" {
                    continue;
                }
                let required = tool.input_schema["required"]
                    .as_array()
                    .is_some_and(|values| values.iter().any(|value| value == name));
                entry.push_str(&format!(
                    "- {name}: {} ({}; {})\n",
                    schema["description"].as_str().unwrap_or(name),
                    if required { "required" } else { "optional" },
                    field_type(schema, &tool.input_schema, 0)
                ));
            }
        }
        guide.push(compact(&entry, 2000));
    }
    guide.join("\n")
}

pub(crate) fn recent_decisions(store: &Store, run_id: &str, limit: usize) -> Result<Vec<String>> {
    store.with_connection(|c| {
        let mut stmt = c.prepare("SELECT kind,analyst_message,parsed_json,results_json,status,error FROM controller_turns WHERE run_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?")?;
        let mut rows = Vec::new();
        for row in stmt.query_map(params![run_id, limit as i64], |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?,
            r.get::<_, String>(4)?, r.get::<_, Option<String>>(5)?
        )))? {
            let (kind, message, parsed, results, status, error) = row?;
            let parsed: Value = serde_json::from_str(parsed.as_deref().unwrap_or("{}"))?;
            let results: Value = serde_json::from_str(results.as_deref().unwrap_or("[]"))?;
            let outcomes = results.as_array().map(|rows| rows.iter().map(|r|
                format!("{} {}", r["action"].as_str().unwrap_or("instruction"), r["status"].as_str().unwrap_or("unknown"))
            ).collect::<Vec<_>>().join(", ")).unwrap_or_default();
            rows.push(format!("{kind}: {}; context: {}; reasoning: {}; outcome: {status} {outcomes} {}",
                compact(message.as_deref().unwrap_or(""), 200),
                compact(parsed["context"].as_str().unwrap_or(""), 300),
                compact(parsed["reasoning"].as_str().unwrap_or(""), 200),
                compact(error.as_deref().unwrap_or(""), 200)
            ).replace(['\n', '\r'], " "));
        }
        rows.reverse();
        Ok(rows)
    })
}

pub(crate) fn run_summary(store: &Store, run_id: &str) -> Result<String> {
    // These are the same authoritative revision and count readers used by tools.
    let criteria = store.execute("get_criteria_history", &json!({"run_id":run_id}))?;
    let current = &criteria["last_criteria"];
    let shortlist = store.execute("get_shortlist_context", &json!({"run_id":run_id,"limit":1}))?;
    let (sources, bundle, rounds) = store.with_connection(|c| {
        let mut stmt = c.prepare("SELECT discovery_source,COUNT(DISTINCT company_id) FROM candidate_discovery WHERE run_id=? GROUP BY discovery_source ORDER BY discovery_source")?;
        let sources = stmt.query_map([run_id], |r| Ok(format!("{}: {}",r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?
            .collect::<std::result::Result<Vec<_>,_>>()?.join(", ");
        let bundle = c.query_row("SELECT bundle_id,semantic_status FROM mid_bundles WHERE status='active'", [], |r|
            Ok(format!("{}; semantic: {}",r.get::<_,String>(0)?,r.get::<_,String>(1)?))
        ).optional()?.unwrap_or_else(|| "none; semantic: unavailable".into());
        let rounds: i64 = c.query_row("SELECT COUNT(*) FROM screening_rounds sr WHERE sr.run_id=? AND NOT EXISTS(SELECT 1 FROM discarded_plans d WHERE d.plan_id=sr.plan_id)", [run_id], |r| r.get(0))?;
        Ok((sources, bundle, rounds))
    })?;
    let approved = current["approved"] == true;
    Ok(format!("Criteria revision: {}; approved: {approved}\nApproved core business: {}\nCore-business exclusions: {}\nCandidates by source: {}\nConsidered: {}; hidden: {}\nActive MID bundle: {bundle}\nScreening rounds: {rounds}\nRecent outcomes:\n{}",
        if current["revision"].is_null() {"none".into()} else {current["revision"].to_string()}, if approved {compact(current["business_definition"].as_str().unwrap_or(""),600)} else {"none (analyst approval required)".into()},
        if approved {compact(&current["core_business_exclusions"].to_string(),1200)} else {"none approved".into()},
        if sources.is_empty() {"none"} else {&sources}, shortlist["considered_count"],shortlist["hidden_count"],
        recent_decisions(store,run_id,3)?.join("\n")
    ))
}

pub(crate) struct Conversation {
    pub(crate) id: String,
    pub(crate) estimated_tokens: i64,
}

pub(crate) fn conversation(
    store: &Store,
    run_id: &str,
    replace: Option<&str>,
) -> Result<Conversation> {
    store.with_connection(|c| {
        let tx = c.transaction()?;
        let active: Option<Conversation> = tx.query_row("SELECT conversation_id,estimated_tokens FROM llm_conversations WHERE run_id=? AND provider='llm_suite' AND status='active'", [run_id], |r|
            Ok(Conversation {id:r.get(0)?,estimated_tokens:r.get(1)?})
        ).optional()?;
        if replace.is_none() {
            if let Some(active) = active { return Ok(active); }
        }
        let rotated_from = active.as_ref().map(|active| active.id.clone());
        if let Some(status) = replace {
            tx.execute("UPDATE llm_conversations SET status=?,updated_at=? WHERE run_id=? AND provider='llm_suite' AND status='active'",params![status,now(),run_id])?;
        }
        let id = format!("conv-{}",Uuid::new_v4());
        tx.execute("INSERT INTO llm_conversations(conversation_id,run_id,provider,status,rotated_from,created_at,updated_at) VALUES(?,?,'llm_suite','active',?,?,?)",params![id,run_id,rotated_from,now(),now()])?;
        tx.commit()?;
        Ok(Conversation {id,estimated_tokens:0})
    })
}

/// Bound results recursively: no full grid, oversized description, or deeply
/// nested result can enter controller history or the next context summary.
pub fn summarize(value: &Value) -> Value {
    let summary = summarize_at(value, 0);
    // Row, key and depth caps still multiply; cap the whole summary as well.
    let size = serde_json::to_string(&summary).map_or(usize::MAX, |s| s.len());
    if size > MAX_SUMMARY_BYTES {
        let keys: Vec<&String> = value
            .as_object()
            .map(|o| o.keys().take(40).collect())
            .unwrap_or_default();
        return json!({"truncated": true, "summary_bytes": size, "keys": keys, "count": value.get("total").or_else(|| value.get("count")).cloned()});
    }
    summary
}
const MAX_SUMMARY_BYTES: usize = 32 * 1024;
fn summarize_at(value: &Value, depth: usize) -> Value {
    if depth >= 5 {
        return json!("[nested result omitted]");
    }
    match value {
        Value::String(s) => json!(compact(s, 600)),
        Value::Array(rows) => {
            json!({"count":rows.len(),"rows":rows.iter().take(20).map(|r|summarize_at(r,depth+1)).collect::<Vec<_>>(),"truncated":rows.len()>20})
        }
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .take(40)
                .map(|(key, value)| (key.clone(), summarize_at(value, depth + 1)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

pub(crate) struct PendingTurn<'a> {
    pub(crate) loop_id: Option<&'a str>,
    pub(crate) run_id: &'a str,
    pub(crate) conversation_id: &'a str,
    pub(crate) parent: Option<&'a str>,
    pub(crate) kind: &'a str,
    pub(crate) message: Option<&'a str>,
    pub(crate) prompt_id: &'a str,
    pub(crate) prompt: &'a str,
    pub(crate) model: &'a str,
    pub(crate) allowed: &'a [&'a str],
    pub(crate) catalog: &'a [ToolDefinition],
}

pub(crate) async fn execute_turn(
    runtime: &Runtime,
    store: &Store,
    turn: PendingTurn<'_>,
) -> Result<(String, String)> {
    let id = format!("turn-{}", Uuid::new_v4());
    let hash = format!("{:x}", Sha256::digest(turn.prompt.as_bytes()));
    let estimate = tokens(turn.prompt);
    store.with_connection(|c| {
        let tx = c.transaction()?;
        tx.execute("INSERT INTO controller_turns(turn_id,conversation_id,run_id,parent_turn_id,kind,analyst_message,prompt_id,prompt_hash,status,estimated_tokens,simulated,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?,?)",params![id,turn.conversation_id,turn.run_id,turn.parent,turn.kind,turn.message,turn.prompt_id,hash,estimate,crate::llmsuite::simulated(),now(),now()])?;
        if let Some(loop_id) = turn.loop_id {
            tx.execute("INSERT INTO controller_loop_turns(loop_id,turn,turn_id) SELECT loop_id,turns_used+1,? FROM controller_loops WHERE loop_id=?", params![id,loop_id])?;
        }
        tx.execute("UPDATE llm_conversations SET turn_count=turn_count+1,updated_at=? WHERE conversation_id=?",params![now(),turn.conversation_id])?;
        tx.commit()?; Ok(())
    })?;
    let reply = match crate::llmsuite::send(
        store,
        turn.run_id,
        &id,
        turn.conversation_id,
        turn.prompt,
        turn.model,
        turn.kind == "feedback",
    )
    .await
    {
        Ok(reply) => reply,
        Err(error) => {
            store.with_connection(|c| {
                let tx = c.transaction()?;
                tx.execute("UPDATE controller_turns SET status='failed',error=?,updated_at=? WHERE turn_id=?",params![error.to_string(),now(),id])?;
                // An audited send may have reached the provider even when its reply failed.
                tx.execute("UPDATE llm_conversations SET estimated_tokens=estimated_tokens+?,updated_at=? WHERE conversation_id=? AND EXISTS(SELECT 1 FROM execution_provider_audit WHERE request_key=?)",params![estimate,now(),turn.conversation_id,format!("text:{id}:0")])?;
                tx.commit()?; Ok(())
            })?;
            return Err(error);
        }
    };
    let estimate = estimate + tokens(&reply.text);
    let parsed: ParsedReply = instruction_set::parse_reply(&reply.text);
    let converted = instruction_set::to_tool_calls(
        &parsed,
        turn.allowed,
        turn.catalog,
        &InstructionContext {
            run_id: turn.run_id.into(),
            extra: turn
                .loop_id
                .map(|id| [("loop_id".into(), json!(id))].into_iter().collect())
                .unwrap_or_default(),
        },
    );
    // A handoff seeds context only, irrespective of any instructions in its reply.
    let calls = if turn.kind == "handoff" {
        Vec::new()
    } else {
        converted.calls
    };
    let parsed_json = serde_json::to_string(&parsed)?;
    store.with_connection(|c| {
        let tx=c.transaction()?;
        tx.execute("UPDATE controller_turns SET reply_markdown=?,parsed_json=?,calls_json=?,status='replied',estimated_tokens=?,updated_at=? WHERE turn_id=?",params![reply.text,parsed_json,serde_json::to_string(&calls)?,estimate,now(),id])?;
        tx.execute("UPDATE llm_conversations SET estimated_tokens=estimated_tokens+?,updated_at=? WHERE conversation_id=?",params![estimate,now(),turn.conversation_id])?;
        tx.commit()?; Ok(())
    })?;
    let mut results = Vec::new();
    if turn.kind != "handoff" {
        for rejected in &converted.rejected {
            let raw = parsed
                .instructions
                .iter()
                .find(|raw| raw.index == rejected.index);
            results.push(json!({"index":rejected.index,"action":rejected.name_text,"title":raw.and_then(|raw|raw.title.as_ref()),"status":"rejected","arguments":raw.map(|raw| &raw.fields),"result_summary":null,"reason":rejected.reason}));
        }
        for call in calls {
            let raw = parsed
                .instructions
                .iter()
                .find(|raw| raw.index == call.index);
            let result = if let Some(loop_id) = turn.loop_id {
                crate::controller_loop::execute_action(
                    runtime,
                    store,
                    loop_id,
                    &call.tool,
                    &call.arguments,
                )
                .await
            } else {
                runtime
                    .execute(ToolCall {
                        tool: call.tool.clone(),
                        arguments: call.arguments.clone(),
                    })
                    .await
            };
            let (status, summary, reason) = match result {
                Ok(result) => (
                    "executed",
                    if turn.loop_id.is_some() && call.tool == "inspect_band" {
                        result
                    } else {
                        summarize(&result)
                    },
                    None,
                ),
                Err(error) => (
                    "failed",
                    json!({"error_code":error.code(),"error":error.to_string()}),
                    Some(error.to_string()),
                ),
            };
            results.push(json!({"index":call.index,"action":call.tool,"title":raw.and_then(|raw|raw.title.as_ref()),"status":status,"arguments":call.arguments,"result_summary":summary,"reason":reason,"warnings":call.warnings}));
            // Save each result immediately, so completed work survives a later failure.
            store.with_connection(|c| {
                c.execute(
                    "UPDATE controller_turns SET results_json=?,updated_at=? WHERE turn_id=?",
                    params![serde_json::to_string(&results)?, now(), id],
                )?;
                Ok(())
            })?;
        }
    }
    results.sort_by_key(|result| result["index"].as_u64().unwrap_or(0));
    store.with_connection(|c| {
        c.execute("UPDATE controller_turns SET results_json=?,status='executed',updated_at=? WHERE turn_id=?",params![serde_json::to_string(&results)?,now(),id])?; Ok(())
    })?;
    let _usage = reply.usage; // Token estimates deliberately use the same chars/4 contract.
    Ok((
        id,
        if turn.kind == "handoff" {
            String::new()
        } else {
            converted.feedback
        },
    ))
}

pub async fn run_controller_turn(
    runtime: &Runtime,
    store: &Store,
    args: TurnRequest,
) -> Result<Value> {
    if args.analyst_message.trim().is_empty() || args.analyst_message.chars().count() > 4000 {
        return Err(Error::Validation(
            "analyst_message must be 1..4000 characters".into(),
        ));
    }
    store.execute("get_run_context", &json!({"run_id":args.run_id}))?;
    let allowed: Vec<&str> = match &args.allowed_actions {
        Some(actions) => {
            if actions.is_empty()
                || actions.len() > CONTROLLER_ACTIONS.len()
                || actions
                    .iter()
                    .any(|action| !CONTROLLER_ACTIONS.contains(&action.as_str()))
            {
                return Err(Error::Validation(
                    "allowed_actions must be a subset of CONTROLLER_ACTIONS".into(),
                ));
            }
            let mut unique: Vec<&str> = Vec::new();
            for action in actions {
                if !unique.contains(&action.as_str()) {
                    unique.push(action);
                }
            }
            unique
        }
        None => CONTROLLER_ACTIONS.to_vec(),
    };
    let model = std::env::var("MNA_LLMSUITE_DEPLOYMENT")
        .ok()
        .filter(|s| !s.trim().is_empty() && s.len() <= 160)
        .ok_or_else(|| {
            Error::ProviderUnavailable("Configure the LLM Suite controller model".into())
        })?;
    let catalog = tool_definitions();
    let guide = action_guide(&catalog, &allowed);
    let summary = run_summary(store, &args.run_id)?;
    let prompt = crate::prompts::render(
        "controller-instruction-set",
        &[
            ("action_guide", &guide),
            ("run_summary", &summary),
            ("analyst_message", &args.analyst_message),
        ],
    )?;
    let mut conversation = conversation(
        store,
        &args.run_id,
        args.new_conversation.then_some("closed"),
    )?;
    let threshold = std::env::var("MNA_LLMSUITE_ROTATE_TOKENS")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(180_000);
    let rotated = conversation.estimated_tokens + tokens(&prompt) > threshold
        && conversation.estimated_tokens > 0;
    let mut ids = Vec::new();
    if rotated {
        let previous = conversation.id.clone();
        conversation = self::conversation(store, &args.run_id, Some("rotated"))?;
        let decisions = recent_decisions(store, &args.run_id, 10)?.join("\n");
        let handoff = crate::prompts::render(
            "conversation-handoff",
            &[("run_summary", &summary), ("recent_decisions", &decisions)],
        )?;
        let id = execute_turn(
            runtime,
            store,
            PendingTurn {
                loop_id: None,
                run_id: &args.run_id,
                conversation_id: &conversation.id,
                parent: None,
                kind: "handoff",
                message: None,
                prompt_id: "conversation-handoff",
                prompt: &handoff,
                model: &model,
                allowed: &allowed,
                catalog: &catalog,
            },
        )
        .await;
        let id = match id {
            Ok((id, _)) => id,
            Err(error) => {
                // Without the hand-off the new conversation has no context: keep the old one.
                let failed = conversation.id.clone();
                store.with_connection(|c| {
                    let tx = c.transaction()?;
                    tx.execute("UPDATE llm_conversations SET status='closed',updated_at=? WHERE conversation_id=?", params![now(), failed])?;
                    tx.execute("UPDATE llm_conversations SET status='active',updated_at=? WHERE conversation_id=?", params![now(), previous])?;
                    tx.commit()?;
                    Ok(())
                })?;
                return Err(error);
            }
        };
        ids.push(id);
    }
    let (turn_id, mut feedback) = execute_turn(
        runtime,
        store,
        PendingTurn {
            loop_id: None,
            run_id: &args.run_id,
            conversation_id: &conversation.id,
            parent: None,
            kind: "analyst",
            message: Some(&args.analyst_message),
            prompt_id: "controller-instruction-set",
            prompt: &prompt,
            model: &model,
            allowed: &allowed,
            catalog: &catalog,
        },
    )
    .await?;
    ids.push(turn_id.clone());
    let mut parent = turn_id.clone();
    for _ in 0..2 {
        if feedback.is_empty() {
            break;
        }
        let prompt = crate::prompts::render(
            "instruction-feedback",
            &[("feedback", &feedback), ("allowed_actions", &guide)],
        )?;
        let (id, next) = execute_turn(
            runtime,
            store,
            PendingTurn {
                loop_id: None,
                run_id: &args.run_id,
                conversation_id: &conversation.id,
                parent: Some(&parent),
                kind: "feedback",
                message: None,
                prompt_id: "instruction-feedback",
                prompt: &prompt,
                model: &model,
                allowed: &allowed,
                catalog: &catalog,
            },
        )
        .await?;
        ids.push(id.clone());
        parent = id;
        feedback = next;
    }
    let mut result = get_controller_turns(store, &json!({"run_id":args.run_id,"limit":100}))?;
    result["turn_id"] = json!(turn_id);
    result["conversation_id"] = json!(conversation.id);
    result["rotated"] = json!(rotated || args.new_conversation);
    result["turns"]
        .as_array_mut()
        .expect("stored turns array")
        .retain(|turn| {
            turn["turn_id"]
                .as_str()
                .is_some_and(|id| ids.iter().any(|saved| saved == id))
        });
    Ok(result)
}

pub fn get_controller_turns(store: &Store, arguments: &Value) -> Result<Value> {
    let args: ReadRequest =
        serde_json::from_value(arguments.clone()).map_err(|e| Error::Validation(e.to_string()))?;
    let limit = args.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(Error::Validation("limit must be 1..100".into()));
    }
    store.execute("get_run_context", &json!({"run_id":args.run_id}))?;
    store.with_connection(|c| {
        let mut stmt=c.prepare("SELECT turn_id,conversation_id,parent_turn_id,kind,analyst_message,prompt_id,prompt_hash,reply_markdown,parsed_json,calls_json,results_json,status,error,estimated_tokens,simulated,created_at FROM controller_turns WHERE run_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?")?;
        let mut turns=Vec::new();
        for row in stmt.query_map(params![args.run_id,limit as i64], |r| {
            Ok(json!({"turn_id":r.get::<_,String>(0)?,"conversation_id":r.get::<_,String>(1)?,"parent_turn_id":r.get::<_,Option<String>>(2)?,"kind":r.get::<_,String>(3)?,"analyst_message":r.get::<_,Option<String>>(4)?,"prompt_id":r.get::<_,String>(5)?,"prompt_hash":r.get::<_,String>(6)?,"reply_markdown":r.get::<_,Option<String>>(7)?,"parsed_json":r.get::<_,Option<String>>(8)?,"calls_json":r.get::<_,Option<String>>(9)?,"results_json":r.get::<_,Option<String>>(10)?,"status":r.get::<_,String>(11)?,"error":r.get::<_,Option<String>>(12)?,"estimated_tokens":r.get::<_,i64>(13)?,"simulated":r.get::<_,bool>(14)?,"created_at":r.get::<_,String>(15)?}))
        })? {
            let mut turn=row?;
            let parsed:Value=serde_json::from_str(turn["parsed_json"].as_str().unwrap_or("{}"))?;
            turn["context"]=parsed["context"].clone(); turn["reasoning"]=parsed["reasoning"].clone(); turn["notes"]=parsed["notes"].clone(); turn["warnings"]=parsed["warnings"].clone();
            turn["instructions"]=serde_json::from_str(turn["results_json"].as_str().unwrap_or("[]"))?;
            turn["parsed"]=parsed;
            turn["calls"]=serde_json::from_str(turn["calls_json"].as_str().unwrap_or("[]"))?;
            turn["feedback_sent"]=json!(c.query_row("SELECT COUNT(*) FROM controller_turns child JOIN execution_provider_audit a ON a.request_key='text:'||child.turn_id||':0' WHERE child.parent_turn_id=? AND child.kind='feedback'",[turn["turn_id"].as_str().unwrap_or("")],|r|r.get::<_,i64>(0))?>0);
            let map=turn.as_object_mut().expect("turn object");
            for key in ["parsed_json","calls_json","results_json"] {map.remove(key);}
            turns.push(turn);
        }
        turns.reverse();
        let active:Option<(String,i64,Option<String>)>=c.query_row("SELECT conversation_id,estimated_tokens,rotated_from FROM llm_conversations WHERE run_id=? AND provider='llm_suite' AND status='active'",[&args.run_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        Ok(json!({"turn_id":turns.iter().rev().find(|t|t["kind"]=="analyst").map(|t|&t["turn_id"]),"conversation_id":active.as_ref().map(|a|&a.0),"rotated":active.as_ref().is_some_and(|a|a.2.is_some()),"rotated_from":active.as_ref().and_then(|a|a.2.as_ref()),"rotation":active.as_ref().filter(|a|a.2.is_some()).map(|a|if turns.iter().any(|t|t["kind"]=="handoff"&&t["conversation_id"]==a.0.as_str()){"token_budget"}else{"new_conversation"}),"estimated_tokens":active.as_ref().map(|a|a.1).unwrap_or(0),"turns":turns}))
    })
}

#[cfg(test)]
mod run_summary_tests {
    use super::run_summary;
    use crate::{run_control, Store};
    use serde_json::json;

    #[test]
    fn summary_round_count_excludes_discarded_plans() {
        let store = Store::open(":memory:").unwrap();
        store
            .execute(
                "create_run",
                &json!({"run_id":"R","objective":"Screen target","original_criteria":{}}),
            )
            .unwrap();
        store
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO prepared_plans(plan_id,run_id,schema_version,digest,status,spec_json,snapshot_json,proposed_at,approved_at,approved_by)
                     VALUES('summary-plan','R',2,'digest','APPROVED',?,'{}','2026-01-01','2026-01-01','analyst')",
                    [json!({"mode":"screening"}).to_string()],
                )?;
                connection.execute(
                    "INSERT INTO screening_rounds(run_id,round_no,plan_id,provider,created_at)
                     VALUES('R',1,'summary-plan','llm_suite','2026-01-01')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        assert!(run_summary(&store, "R")
            .unwrap()
            .contains("Screening rounds: 1"));
        run_control::execute(
            &store,
            "discard_plan_results",
            &json!({"run_id":"R","plan_id":"summary-plan","kind":"screening"}),
            true,
        )
        .unwrap();
        assert!(run_summary(&store, "R")
            .unwrap()
            .contains("Screening rounds: 0"));
    }
}
