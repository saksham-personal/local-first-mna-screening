use crate::{
    error::{Error, Result},
    store::Store,
};
use schemars::JsonSchema;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

const DEFAULT_MAX_CHARS: usize = 12_000;
const MAX_CONTEXT_BYTES: usize = 1_000_000;
const MAX_ID_BYTES: usize = 160;
const MAX_SUBJECTS: usize = 100;
const MAX_BATCH_FIELDS: usize = 32;
const DEFAULT_EXAMPLE_LIMIT: usize = 12;
const DEFAULT_EVENT_LIMIT: usize = 30;

#[derive(Clone)]
pub struct ContextService {
    store: Store,
}

pub fn input_schema(tool: &str) -> Option<Value> {
    let schema = match tool {
        "get_company_context" => serde_json::to_value(schemars::schema_for!(CompanyContextArgs)),
        "get_candidate_context" => {
            serde_json::to_value(schemars::schema_for!(CandidateContextArgs))
        }
        "get_candidate_batch_context" => {
            serde_json::to_value(schemars::schema_for!(CandidateBatchArgs))
        }
        "build_context_packet" => serde_json::to_value(schemars::schema_for!(BuildPacketArgs)),
        _ => return None,
    };
    schema.ok()
}

impl ContextService {
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    pub fn execute(&self, tool: &str, arguments: &Value) -> Result<Value> {
        let normalized = self.store.normalize_company_references(arguments);
        let arguments = &normalized;
        match tool {
            "get_company_context" => self.get_company_context(parse_arguments(tool, arguments)?),
            "get_candidate_context" => {
                self.get_candidate_context(parse_arguments(tool, arguments)?)
            }
            "get_candidate_batch_context" => {
                self.get_candidate_batch_context(parse_arguments(tool, arguments)?)
            }
            "build_context_packet" => self.build_context_packet(parse_arguments(tool, arguments)?),
            _ => Err(Error::NotFound(format!("unknown context tool `{tool}`"))),
        }
    }

    fn get_company_context(&self, args: CompanyContextArgs) -> Result<Value> {
        validate_id("company_id", &args.company_id)?;
        validate_byte_limit("max_chars", args.max_chars)?;
        validate_unique("sections", &args.sections)?;
        if args.sections.is_empty() {
            return Err(Error::Validation("sections must not be empty".into()));
        }
        if args.sections.len() > CompanySection::ALL.len() {
            return Err(Error::Validation("too many sections requested".into()));
        }
        if args.sections.iter().any(CompanySection::is_run_scoped) {
            let run_id = args.run_id.as_deref().ok_or_else(|| {
                Error::Validation(
                    "run_id is required for evidence, analyst_notes, screening_history, or external_research"
                        .into(),
                )
            })?;
            validate_id("run_id", run_id)?;
        }
        if let Some(run_id) = &args.run_id {
            validate_id("run_id", run_id)?;
        }

        let company = self
            .store
            .execute("get_company", &json!({"company_id": args.company_id}))?;
        let mut requested = Vec::with_capacity(args.sections.len());
        for section in &args.sections {
            let value = self.company_section(&args, &company, *section)?;
            requested.push((section.as_str().to_owned(), value));
        }

        let envelope = json!({
            "company_id": args.company_id,
            "run_id": args.run_id,
            "requested_sections": args.sections.iter().map(CompanySection::as_str).collect::<Vec<_>>(),
            "sections": {},
        });
        fit_named_blocks(envelope, "sections", requested, args.max_chars, "max_chars")
    }

    fn company_section(
        &self,
        args: &CompanyContextArgs,
        company: &Value,
        section: CompanySection,
    ) -> Result<Value> {
        let value = match section {
            CompanySection::Core => company_core(company),
            CompanySection::Description => field_or_null(company, "description"),
            CompanySection::Financials => select_fields(
                company,
                &["financials", "revenue", "ebitda", "currency", "fiscal_year"],
            ),
            CompanySection::Products => field_or_null(company, "products"),
            CompanySection::Services => field_or_null(company, "services"),
            CompanySection::Keywords => field_or_null(company, "keywords"),
            // This is the only section that deliberately crosses run boundaries.
            CompanySection::PreviousResearch => self.store.execute(
                "get_previous_research",
                &json!({"company_id": args.company_id}),
            )?,
            CompanySection::AnalystNotes => self.store.execute(
                "get_labelled_examples",
                &json!({"run_id": required_run_id(args)?, "company_id": args.company_id}),
            )?,
            CompanySection::Evidence => self.store.execute(
                "get_evidence",
                &json!({"run_id": required_run_id(args)?, "company_id": args.company_id}),
            )?,
            CompanySection::ScreeningHistory => {
                let candidate = self.candidate_for_run(required_run_id(args)?, &args.company_id)?;
                json!({"candidate": candidate})
            }
            CompanySection::ExternalResearch => {
                let evidence = self.store.execute(
                    "get_evidence",
                    &json!({"run_id": required_run_id(args)?, "company_id": args.company_id}),
                )?;
                filter_external_evidence(evidence)
            }
            CompanySection::Identifiers => field_or_null(company, "identifiers"),
            CompanySection::Enrichment => select_fields(
                company,
                &[
                    "PB_Website",
                    "PB_Name",
                    "PB_Description",
                    "PB_LinkedIn URL",
                    "PB_HQ Location",
                    "PB_Active Investors",
                    "PB_Universe",
                    "ROGO",
                ],
            ),
            CompanySection::ScreeningResults => crate::workflow::WorkflowService::new(
                self.store.clone(),
            )
            .screening_results(required_run_id(args)?, &args.company_id, 100)?,
        };
        Ok(value)
    }

    fn get_candidate_context(&self, args: CandidateContextArgs) -> Result<Value> {
        validate_id("run_id", &args.run_id)?;
        validate_id("company_id", &args.company_id)?;
        validate_byte_limit("max_chars", args.max_chars)?;

        let company = self
            .store
            .execute("get_company", &json!({"company_id": args.company_id}))?;
        let candidate = self.candidate_for_run(&args.run_id, &args.company_id)?;
        let evidence = self.store.execute(
            "get_evidence",
            &json!({"run_id": args.run_id, "company_id": args.company_id}),
        )?;
        let missing = self.store.execute(
            "get_missing_evidence",
            &json!({
                "run_id": args.run_id,
                "company_id": args.company_id,
            }),
        )?;
        let feedback = self.store.execute(
            "get_labelled_examples",
            &json!({"run_id": args.run_id, "company_id": args.company_id}),
        )?;

        let envelope = json!({
            "run_id": args.run_id,
            "company_id": args.company_id,
            "context": {},
        });
        fit_named_blocks(
            envelope,
            "context",
            vec![
                ("company".into(), reasoning_company(company)),
                ("candidate".into(), candidate.clone()),
                ("evidence".into(), evidence),
                ("missing_attributes".into(), missing),
                ("analyst_feedback".into(), feedback),
                ("research_status".into(), research_status(&candidate)),
                (
                    "screening_results".into(),
                    crate::workflow::WorkflowService::new(self.store.clone()).screening_results(
                        &args.run_id,
                        &args.company_id,
                        20,
                    )?,
                ),
            ],
            args.max_chars,
            "max_chars",
        )
    }

    fn get_candidate_batch_context(&self, args: CandidateBatchArgs) -> Result<Value> {
        validate_id("run_id", &args.run_id)?;
        validate_id_list("company_ids", &args.company_ids, MAX_SUBJECTS)?;
        if args.fields.is_empty() || args.fields.len() > MAX_BATCH_FIELDS {
            return Err(Error::Validation(format!(
                "fields must contain between 1 and {MAX_BATCH_FIELDS} entries"
            )));
        }
        validate_unique("fields", &args.fields)?;
        for field in &args.fields {
            validate_field_name(field)?;
        }
        validate_byte_limit("max_per_company", args.max_per_company)?;

        let mut companies = Vec::with_capacity(args.company_ids.len());
        for company_id in &args.company_ids {
            let company = self
                .store
                .execute("get_company", &json!({"company_id": company_id}))?;
            let candidate = self.candidate_for_run(&args.run_id, company_id)?;
            let available =
                self.batch_fields(&args.run_id, company_id, company, candidate, &args.fields)?;
            let blocks = args
                .fields
                .iter()
                .map(|field| {
                    let value = available.get(field).cloned().unwrap_or(Value::Null);
                    (field.clone(), value)
                })
                .collect();
            let envelope = json!({"company_id": company_id, "fields": {}});
            companies.push(fit_named_blocks(
                envelope,
                "fields",
                blocks,
                args.max_per_company,
                "max_per_company",
            )?);
        }

        Ok(json!({
            "run_id": args.run_id,
            "requested_fields": args.fields,
            "max_per_company": args.max_per_company,
            "companies": companies,
        }))
    }

    fn batch_fields(
        &self,
        run_id: &str,
        company_id: &str,
        company: Value,
        candidate: Value,
        requested_fields: &[String],
    ) -> Result<Map<String, Value>> {
        let mut available = company.as_object().cloned().unwrap_or_default();
        if let Some(candidate_object) = candidate.as_object() {
            for (key, value) in candidate_object {
                available
                    .entry(key.clone())
                    .or_insert_with(|| value.clone());
            }
        }
        available.insert("company".into(), company);
        available.insert("candidate".into(), candidate.clone());
        if requested_fields
            .iter()
            .any(|field| field == "screening_results")
        {
            available.insert(
                "screening_results".into(),
                crate::workflow::WorkflowService::new(self.store.clone())
                    .screening_results(run_id, company_id, 20)?,
            );
        }
        if requested_fields.iter().any(|field| field == "evidence") {
            available.insert(
                "evidence".into(),
                self.store.execute(
                    "get_evidence",
                    &json!({"run_id": run_id, "company_id": company_id}),
                )?,
            );
        }
        if requested_fields
            .iter()
            .any(|field| field == "missing_attributes")
        {
            available.insert(
                "missing_attributes".into(),
                self.store.execute(
                    "get_missing_evidence",
                    &json!({
                        "run_id": run_id,
                        "company_id": company_id,
                    }),
                )?,
            );
        }
        if requested_fields
            .iter()
            .any(|field| field == "analyst_feedback")
        {
            available.insert(
                "analyst_feedback".into(),
                self.store.execute(
                    "get_labelled_examples",
                    &json!({"run_id": run_id, "company_id": company_id}),
                )?,
            );
        }
        if requested_fields
            .iter()
            .any(|field| field == "research_status")
        {
            available.insert("research_status".into(), research_status(&candidate));
        }
        Ok(available)
    }

    fn build_context_packet(&self, args: BuildPacketArgs) -> Result<Value> {
        validate_id("run_id", &args.run_id)?;
        validate_id("task_type", &args.task_type)?;
        validate_optional_id_list("subject_ids", &args.subject_ids, MAX_SUBJECTS)?;
        if task_requires_subjects(&args.task_type) && args.subject_ids.is_empty() {
            return Err(Error::Validation(format!(
                "task_type `{}` requires at least one subject_id",
                args.task_type
            )));
        }
        if !(128..=MAX_CONTEXT_BYTES).contains(&args.token_budget) {
            return Err(Error::Validation(format!(
                "token_budget must be between 128 and {MAX_CONTEXT_BYTES}"
            )));
        }

        let mandate = self
            .store
            .execute("get_original_criteria", &json!({"run_id": args.run_id}))?;
        let policy = crate::workflow::WorkflowService::new(self.store.clone())
            .execute("get_search_policy", &json!({"run_id":args.run_id}))?;
        let profile_approved = policy["approved"] == true;
        if !profile_approved && !args.subject_ids.is_empty() {
            return Err(Error::Conflict(
                "Approve criteria before building a candidate task packet".into(),
            ));
        }
        let profile = self.store.execute(
            "get_screening_profile_version",
            &json!({"run_id":args.run_id,"version":policy["profile_version"]}),
        )?;
        let run_context = self.store.execute(
            "get_run_context",
            &json!({"run_id": args.run_id, "detail_level": "summary"}),
        )?;

        let mut subject_details = Vec::with_capacity(args.subject_ids.len());
        let mut evidence_by_subject = Map::new();
        for company_id in &args.subject_ids {
            let company = self
                .store
                .execute("get_company", &json!({"company_id": company_id}))?;
            let candidate = self.candidate_for_run(&args.run_id, company_id)?;
            subject_details
                .push(json!({"company": reasoning_company(company), "candidate": candidate}));
            evidence_by_subject.insert(
                company_id.clone(),
                self.store.execute(
                    "get_evidence",
                    &json!({"run_id": args.run_id, "company_id": company_id}),
                )?,
            );
        }

        let examples = self.store.execute(
            "get_representative_examples",
            &json!({"run_id": args.run_id, "limit": DEFAULT_EXAMPLE_LIMIT}),
        )?;
        let events = self.store.execute(
            "get_recent_agent_events",
            &json!({"run_id": args.run_id, "limit": DEFAULT_EVENT_LIMIT}),
        )?;

        // serialized UTF-8 bytes are an intentionally conservative upper bound: a
        // tokenizer cannot emit more tokens than input bytes. The final metadata is
        // included in this calculation, and no JSON string is ever sliced.
        let mut packet = json!({
            "run_id": args.run_id,
            "task_type": args.task_type,
            "subject_ids": args.subject_ids,
            "token_budget": args.token_budget,
            "context": {
                "mandate": mandate,
                "active_profile": if profile_approved {profile.clone()} else {Value::Null},
                "working_profile": if profile_approved {Value::Null} else {profile},
                "search_policy":select_fields(&policy,&["approved","core_business_query","core_business_criteria","unused_criteria","analyst_notice"]),
                "task": {
                    "run_context": select_fields(&run_context, &["run_id","objective","status","active_criteria_version","active_profile_version","candidate_counts"]),
                    "subjects": subject_details.iter().map(|s| json!({"company":company_core(&s["company"]), "status":s["candidate"]["status"]})).collect::<Vec<_>>(),
                },
            },
        });
        let optional = vec![
            ("subject_details".to_owned(), Value::Array(subject_details)),
            ("evidence".to_owned(), Value::Object(evidence_by_subject)),
            (
                "open_questions".to_owned(),
                run_context["open_questions"].clone(),
            ),
            ("examples".to_owned(), examples),
            ("events".to_owned(), events),
        ];
        let mut omitted: Vec<String> = optional.iter().map(|(name, _)| name.clone()).collect();

        set_budget_metadata(&mut packet, &omitted, args.token_budget, "token_budget")?;
        if serialized_bytes(&packet)? > args.token_budget {
            return Err(Error::Validation(format!(
                "token_budget {} cannot fit mandatory mandate, active_profile, task, and packet metadata",
                args.token_budget
            )));
        }

        for (name, value) in optional {
            insert_named(&mut packet, "context", &name, value)?;
            let proposed_omitted = omitted
                .iter()
                .filter(|entry| entry.as_str() != name)
                .cloned()
                .collect::<Vec<_>>();
            set_budget_metadata(
                &mut packet,
                &proposed_omitted,
                args.token_budget,
                "token_budget",
            )?;
            if serialized_bytes(&packet)? <= args.token_budget {
                omitted = proposed_omitted;
            } else {
                remove_named(&mut packet, "context", &name)?;
                set_budget_metadata(&mut packet, &omitted, args.token_budget, "token_budget")?;
            }
        }
        ensure_within(&packet, args.token_budget, "token_budget")?;
        let current_policy = crate::workflow::WorkflowService::new(self.store.clone())
            .execute("get_search_policy", &json!({"run_id":args.run_id}))?;
        if current_policy["profile_version"] != policy["profile_version"]
            || current_policy["approved"] != policy["approved"]
        {
            return Err(Error::Conflict(
                "Active profile changed while building context; rebuild the packet".into(),
            ));
        }
        Ok(packet)
    }

    fn candidate_for_run(&self, run_id: &str, company_id: &str) -> Result<Value> {
        let result = self.store.execute(
            "get_candidate_set",
            &json!({
                "run_id": run_id,
                "filters": {"company_ids": [company_id]},
                "limit": 1
            }),
        )?;
        find_candidate(result, run_id, company_id)
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CompanyContextArgs {
    company_id: String,
    #[serde(default)]
    run_id: Option<String>,
    sections: Vec<CompanySection>,
    #[serde(default = "default_max_chars")]
    max_chars: usize,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
enum CompanySection {
    Core,
    Description,
    Financials,
    Products,
    Services,
    Keywords,
    PreviousResearch,
    AnalystNotes,
    Evidence,
    ScreeningHistory,
    ExternalResearch,
    Identifiers,
    Enrichment,
    ScreeningResults,
}

impl CompanySection {
    const ALL: [Self; 14] = [
        Self::Core,
        Self::Description,
        Self::Financials,
        Self::Products,
        Self::Services,
        Self::Keywords,
        Self::PreviousResearch,
        Self::AnalystNotes,
        Self::Evidence,
        Self::ScreeningHistory,
        Self::ExternalResearch,
        Self::Identifiers,
        Self::Enrichment,
        Self::ScreeningResults,
    ];

    fn as_str(&self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Description => "description",
            Self::Financials => "financials",
            Self::Products => "products",
            Self::Services => "services",
            Self::Keywords => "keywords",
            Self::PreviousResearch => "previous_research",
            Self::AnalystNotes => "analyst_notes",
            Self::Evidence => "evidence",
            Self::ScreeningHistory => "screening_history",
            Self::ExternalResearch => "external_research",
            Self::Identifiers => "identifiers",
            Self::Enrichment => "enrichment",
            Self::ScreeningResults => "screening_results",
        }
    }

    fn is_run_scoped(&self) -> bool {
        matches!(
            self,
            Self::AnalystNotes
                | Self::Evidence
                | Self::ScreeningHistory
                | Self::ExternalResearch
                | Self::ScreeningResults
        )
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CandidateContextArgs {
    run_id: String,
    company_id: String,
    #[serde(default = "default_max_chars")]
    max_chars: usize,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CandidateBatchArgs {
    run_id: String,
    company_ids: Vec<String>,
    fields: Vec<String>,
    max_per_company: usize,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct BuildPacketArgs {
    run_id: String,
    task_type: String,
    subject_ids: Vec<String>,
    token_budget: usize,
}

fn default_max_chars() -> usize {
    DEFAULT_MAX_CHARS
}

fn reasoning_company(mut company: Value) -> Value {
    if let Some(record) = company.as_object_mut() {
        record.remove("embedding");
        record.remove("_vectors");
    }
    company
}

fn parse_arguments<T: DeserializeOwned>(tool: &str, arguments: &Value) -> Result<T> {
    serde_json::from_value(arguments.clone())
        .map_err(|error| Error::Validation(format!("invalid arguments for `{tool}`: {error}")))
}

fn validate_id(name: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > MAX_ID_BYTES {
        return Err(Error::Validation(format!(
            "{name} must contain 1 to {MAX_ID_BYTES} bytes"
        )));
    }
    Ok(())
}

fn validate_id_list(name: &str, values: &[String], max: usize) -> Result<()> {
    if values.is_empty() || values.len() > max {
        return Err(Error::Validation(format!(
            "{name} must contain between 1 and {max} entries"
        )));
    }
    validate_unique(name, values)?;
    for value in values {
        validate_id(name, value)?;
    }
    Ok(())
}

fn validate_optional_id_list(name: &str, values: &[String], max: usize) -> Result<()> {
    if values.len() > max {
        return Err(Error::Validation(format!(
            "{name} must contain no more than {max} entries"
        )));
    }
    validate_unique(name, values)?;
    for value in values {
        validate_id(name, value)?;
    }
    Ok(())
}

fn task_requires_subjects(task_type: &str) -> bool {
    let normalized = task_type.to_ascii_uppercase();
    normalized.contains("CANDIDATE")
        && (normalized.contains("SCREEN")
            || normalized.contains("CLASSIF")
            || normalized.contains("RANK")
            || normalized.contains("REVIEW"))
}

fn validate_unique<T: Eq + std::hash::Hash>(name: &str, values: &[T]) -> Result<()> {
    let mut unique = HashSet::with_capacity(values.len());
    if values.iter().any(|value| !unique.insert(value)) {
        return Err(Error::Validation(format!(
            "{name} must not contain duplicates"
        )));
    }
    Ok(())
}

fn validate_byte_limit(name: &str, value: usize) -> Result<()> {
    if !(128..=MAX_CONTEXT_BYTES).contains(&value) {
        return Err(Error::Validation(format!(
            "{name} must be between 128 and {MAX_CONTEXT_BYTES}"
        )));
    }
    Ok(())
}

fn validate_field_name(field: &str) -> Result<()> {
    if field.is_empty()
        || field.len() > 64
        || !field
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(Error::Validation(format!(
            "invalid field `{field}`; use 1-64 ASCII letters, digits, or underscores"
        )));
    }
    Ok(())
}

fn required_run_id(args: &CompanyContextArgs) -> Result<&str> {
    args.run_id
        .as_deref()
        .ok_or_else(|| Error::Validation("run_id is required for this section".into()))
}

fn company_core(company: &Value) -> Value {
    select_fields(
        company,
        &[
            "company_id",
            "name",
            "website",
            "industry",
            "country",
            "headquarters",
            "founded_year",
            "employee_count",
            "ownership",
            "provenance",
        ],
    )
}

fn select_fields(value: &Value, fields: &[&str]) -> Value {
    let mut selected = Map::new();
    if let Some(object) = value.as_object() {
        for field in fields {
            if let Some(value) = object.get(*field) {
                selected.insert((*field).to_owned(), value.clone());
            }
        }
    }
    Value::Object(selected)
}

fn field_or_null(value: &Value, field: &str) -> Value {
    value.get(field).cloned().unwrap_or(Value::Null)
}

fn research_status(candidate: &Value) -> Value {
    select_fields(
        candidate,
        &["research_status", "status", "classification", "updated_at"],
    )
}

fn filter_external_evidence(value: Value) -> Value {
    let Some(items) = value.as_array() else {
        return value;
    };
    Value::Array(
        items
            .iter()
            .filter(|item| {
                ["source", "source_type", "provider", "provenance"]
                    .iter()
                    .filter_map(|key| item.get(key))
                    .any(|value| {
                        value
                            .as_str()
                            .map(|text| {
                                let normalized = text.to_ascii_lowercase();
                                normalized.contains("external")
                                    || normalized.contains("bing")
                                    || normalized.contains("m365")
                                    || normalized.contains("iscc")
                                    || normalized.starts_with("http")
                            })
                            .unwrap_or(false)
                    })
            })
            .cloned()
            .collect(),
    )
}

fn find_candidate(value: Value, run_id: &str, company_id: &str) -> Result<Value> {
    let candidates = match &value {
        Value::Array(items) => Some(items.as_slice()),
        Value::Object(object) => object
            .get("candidates")
            .or_else(|| object.get("results"))
            .and_then(Value::as_array)
            .map(Vec::as_slice),
        _ => None,
    }
    .ok_or_else(|| {
        Error::Internal("get_candidate_set returned an unsupported response shape".into())
    })?;

    candidates
        .iter()
        .find(|candidate| candidate.get("company_id").and_then(Value::as_str) == Some(company_id))
        .cloned()
        .ok_or_else(|| {
            Error::NotFound(format!(
                "company `{company_id}` is not a candidate in run `{run_id}`"
            ))
        })
}

fn fit_named_blocks(
    mut envelope: Value,
    container: &str,
    blocks: Vec<(String, Value)>,
    limit: usize,
    limit_name: &str,
) -> Result<Value> {
    let mut omitted = blocks
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    set_budget_metadata(&mut envelope, &omitted, limit, limit_name)?;
    ensure_within(&envelope, limit, limit_name)?;

    for (name, value) in blocks {
        insert_named(&mut envelope, container, &name, value)?;
        let proposed_omitted = omitted
            .iter()
            .filter(|entry| entry.as_str() != name)
            .cloned()
            .collect::<Vec<_>>();
        set_budget_metadata(&mut envelope, &proposed_omitted, limit, limit_name)?;
        if serialized_bytes(&envelope)? <= limit {
            omitted = proposed_omitted;
        } else {
            remove_named(&mut envelope, container, &name)?;
            set_budget_metadata(&mut envelope, &omitted, limit, limit_name)?;
        }
    }
    ensure_within(&envelope, limit, limit_name)?;
    Ok(envelope)
}

fn insert_named(root: &mut Value, container: &str, name: &str, value: Value) -> Result<()> {
    root.get_mut(container)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| Error::Internal(format!("missing object container `{container}`")))?
        .insert(name.to_owned(), value);
    Ok(())
}

fn remove_named(root: &mut Value, container: &str, name: &str) -> Result<()> {
    root.get_mut(container)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| Error::Internal(format!("missing object container `{container}`")))?
        .remove(name);
    Ok(())
}

fn set_budget_metadata(
    value: &mut Value,
    omitted: &[String],
    limit: usize,
    limit_name: &str,
) -> Result<()> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| Error::Internal("context envelope must be a JSON object".into()))?;
    object.insert(
        "metadata".into(),
        json!({
            "budget_unit": "serialized_utf8_bytes_upper_bound",
            "budget_limit": limit,
            "budget_argument": limit_name,
            "serialized_bytes": 0,
            "estimated_tokens_upper_bound": 0,
            "truncated": !omitted.is_empty(),
            "omitted": omitted,
        }),
    );

    for _ in 0..16 {
        let bytes = serialized_bytes(value)?;
        let metadata = value
            .get_mut("metadata")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| Error::Internal("budget metadata disappeared".into()))?;
        let old = metadata
            .get("serialized_bytes")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        metadata.insert("serialized_bytes".into(), json!(bytes));
        metadata.insert("estimated_tokens_upper_bound".into(), json!(bytes));
        if old == bytes as u64 && serialized_bytes(value)? == bytes {
            return Ok(());
        }
    }
    Err(Error::Internal(
        "serialized byte accounting did not converge".into(),
    ))
}

fn ensure_within(value: &Value, limit: usize, limit_name: &str) -> Result<()> {
    let bytes = serialized_bytes(value)?;
    if bytes > limit {
        return Err(Error::Validation(format!(
            "{limit_name} {limit} is too small for the required response envelope ({bytes} bytes)"
        )));
    }
    Ok(())
}

fn serialized_bytes(value: &Value) -> Result<usize> {
    Ok(serde_json::to_vec(value)?.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_cross_run_section_without_explicit_request_and_run_scope() {
        let args: CompanyContextArgs = parse_arguments(
            "get_company_context",
            &json!({
                "company_id": "C1",
                "sections": ["evidence"],
                "max_chars": 1000
            }),
        )
        .unwrap();
        assert!(args.sections[0].is_run_scoped());
        assert!(required_run_id(&args).is_err());

        let previous: CompanyContextArgs = parse_arguments(
            "get_company_context",
            &json!({
                "company_id": "C1",
                "sections": ["previous_research"],
                "max_chars": 1000
            }),
        )
        .unwrap();
        assert!(!previous.sections[0].is_run_scoped());
    }

    #[test]
    fn bounded_json_omits_whole_unicode_field_and_remains_valid() {
        let envelope = json!({"company_id": "会社-α", "sections": {}});
        let value = "研究🔎".repeat(200);
        let fitted = fit_named_blocks(
            envelope,
            "sections",
            vec![
                ("core".into(), json!({"name": "会社"})),
                ("evidence".into(), json!(value)),
            ],
            360,
            "max_chars",
        )
        .unwrap();
        let encoded = serde_json::to_vec(&fitted).unwrap();
        assert!(encoded.len() <= 360);
        assert_eq!(fitted["sections"]["core"]["name"], "会社");
        assert!(fitted["sections"].get("evidence").is_none());
        assert_eq!(fitted["metadata"]["omitted"], json!(["evidence"]));
        assert_eq!(fitted["metadata"]["serialized_bytes"], encoded.len());
        assert_eq!(serde_json::from_slice::<Value>(&encoded).unwrap(), fitted);
    }

    #[test]
    fn budget_counts_complete_metadata_and_does_not_slice_json() {
        let envelope = json!({"run_id": "R1", "context": {}});
        let fitted = fit_named_blocks(
            envelope,
            "context",
            vec![
                ("mandate".into(), json!({"criterion": "retain me"})),
                ("events".into(), json!(["x".repeat(500)])),
            ],
            350,
            "token_budget",
        )
        .unwrap();
        let bytes = serialized_bytes(&fitted).unwrap();
        assert!(bytes <= 350);
        assert_eq!(fitted["metadata"]["estimated_tokens_upper_bound"], bytes);
        assert_eq!(fitted["context"]["mandate"]["criterion"], "retain me");
        assert!(fitted["context"].get("events").is_none());
    }

    #[test]
    fn dto_rejects_unknown_fields_and_duplicate_batch_fields() {
        let error = parse_arguments::<BuildPacketArgs>(
            "build_context_packet",
            &json!({
                "run_id":"R1", "task_type":"SCREEN", "subject_ids":["C1"],
                "token_budget":1000, "surprise":true
            }),
        )
        .unwrap_err();
        assert!(matches!(error, Error::Validation(_)));

        assert!(validate_unique("fields", &["name", "name"]).is_err());
        assert!(input_schema("build_context_packet").is_some());
        assert!(input_schema("not_a_context_tool").is_none());
    }

    #[test]
    fn planner_tasks_allow_no_subjects_but_screening_requires_them() {
        assert!(!task_requires_subjects("PLAN_RESEARCH"));
        assert!(!task_requires_subjects("DISCOVER_CANDIDATES"));
        assert!(task_requires_subjects("SCREEN_CANDIDATES"));
        assert!(validate_optional_id_list("subject_ids", &[], MAX_SUBJECTS).is_ok());
    }

    #[test]
    fn candidate_lookup_never_leaks_a_different_run_candidate() {
        let response = json!({"candidates": [
            {"company_id":"C2", "status":"RESEARCH"},
            {"company_id":"C1", "status":"SHORTLISTED"}
        ]});
        assert_eq!(
            find_candidate(response.clone(), "R-current", "C1").unwrap()["status"],
            "SHORTLISTED"
        );
        assert!(matches!(
            find_candidate(response, "R-current", "C3"),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn external_filter_retains_provenance_objects() {
        let filtered = filter_external_evidence(json!([
            {"evidence_id":"E1", "source":"analyst", "quote":"internal"},
            {"evidence_id":"E2", "source":"https://example.test", "quote":"évidence", "provenance":{"url":"https://example.test"}}
        ]));
        assert_eq!(filtered.as_array().unwrap().len(), 1);
        assert_eq!(filtered[0]["provenance"]["url"], "https://example.test");
    }
}
