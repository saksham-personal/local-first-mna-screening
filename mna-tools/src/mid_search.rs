use crate::error::{Error, Result};
use crate::mid_config::MidIndexConfig;
use crate::retrieval::{self, Embedder, LocalHttpAdapter, RetrievalConfig};
use crate::store::Store;
use crate::workflow::WorkflowService;
use rusqlite::{params, OptionalExtension};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[derive(Clone, Copy, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum Match {
    #[default]
    Stem,
    Exact,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Keyword {
    id: String,
    text: String,
    #[serde(default = "one")]
    weight: f64,
    #[serde(default)]
    r#match: Match,
}
fn one() -> f64 {
    1.0
}
fn yes() -> bool {
    true
}
fn keyword_limit() -> usize {
    5000
}
fn semantic_limit() -> usize {
    1000
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct KeywordArgs {
    run_id: String,
    rationale: String,
    keywords: Vec<Keyword>,
    expression: Option<String>,
    columns: Option<Vec<String>>,
    #[serde(default = "keyword_limit")]
    limit: usize,
    #[serde(default = "yes")]
    add_to_run: bool,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RunArgs {
    run_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SemanticArgs {
    run_id: String,
    rationale: String,
    min_score: f64,
    #[serde(default = "semantic_limit")]
    limit: usize,
    #[serde(default = "yes")]
    add_to_run: bool,
}
pub fn input_schema(tool: &str) -> Option<Value> {
    match tool {
        "search_mid" => serde_json::to_value(schemars::schema_for!(KeywordArgs)).ok(),
        "score_mid_semantic" => serde_json::to_value(schemars::schema_for!(RunArgs)).ok(),
        "search_mid_semantic" => serde_json::to_value(schemars::schema_for!(SemanticArgs)).ok(),
        _ => None,
    }
}
fn parse<T: serde::de::DeserializeOwned>(v: &Value) -> Result<T> {
    serde_json::from_value(v.clone()).map_err(|e| Error::Validation(e.to_string()))
}
fn invalid(s: impl Into<String>) -> Error {
    Error::Validation(s.into())
}
fn text(s: &str, max: usize) -> Result<()> {
    if s.trim().is_empty() || s.chars().count() > max {
        Err(invalid(format!("Text must contain 1..{max} characters")))
    } else {
        Ok(())
    }
}
struct Bundle {
    id: String,
    fts: i64,
    config: MidIndexConfig,
    semantic: String,
}
fn active(store: &Store) -> Result<Option<Bundle>> {
    store.with_connection(|c| {
        let row = c.query_row("SELECT bundle_id,fts_id,config_json,semantic_status FROM mid_bundles WHERE status='active'", [], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).optional()?;
        row.map(|(id,fts,raw,semantic)| { let config: MidIndexConfig = serde_json::from_str(&raw)?; config.validate()?; if fts < 1 { return Err(invalid("Invalid MID FTS identifier")); } Ok(Bundle{id,fts,config,semantic}) }).transpose()
    })
}
fn approved(store: &Store, run: &str) -> Result<Value> {
    WorkflowService::new(store.clone()).require_approved_criteria(run)?;
    store.execute("get_active_screening_profile", &json!({"run_id":run}))
}
fn normalized(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn phrase(s: &str) -> Result<String> {
    let tokens = s
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    if tokens.is_empty() {
        return Err(invalid("Keyword must contain letters or digits"));
    }
    let prefix = s.trim_end().ends_with('*');
    if prefix && tokens.len() != 1 {
        return Err(invalid("Use * only on single words"));
    }
    Ok(format!(
        "\"{}\"{}",
        tokens.join(" "),
        if prefix { "*" } else { "" }
    ))
}
#[derive(Debug)]
enum Expr {
    Id(String),
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Minus(Box<Expr>, Box<Expr>),
}
struct Parser {
    tokens: Vec<String>,
    at: usize,
    operators: usize,
}
impl Parser {
    fn peek(&self) -> &str {
        self.tokens.get(self.at).map(String::as_str).unwrap_or("")
    }
    fn operator(&mut self) -> Result<()> {
        self.at += 1;
        self.operators += 1;
        if self.operators > 50 {
            Err(invalid("Expression exceeds 50 operators"))
        } else {
            Ok(())
        }
    }
    fn atom(&mut self) -> Result<Expr> {
        let token = self.peek().to_owned();
        self.at += 1;
        match token.as_str() {
            "(" => {
                let e = self.or()?;
                if self.peek() != ")" {
                    return Err(invalid("Unclosed expression group"));
                }
                self.at += 1;
                Ok(e)
            }
            "" | ")" | "AND" | "OR" | "NOT" => Err(invalid(
                "Expected keyword id; NOT is only allowed after AND",
            )),
            _ => Ok(Expr::Id(token)),
        }
    }
    fn and(&mut self) -> Result<Expr> {
        let mut e = self.atom()?;
        while self.peek() == "AND" {
            self.operator()?;
            let negative = self.peek() == "NOT";
            if negative {
                self.operator()?;
            }
            let rhs = self.atom()?;
            e = if negative {
                Expr::Minus(Box::new(e), Box::new(rhs))
            } else {
                Expr::And(Box::new(e), Box::new(rhs))
            };
        }
        Ok(e)
    }
    fn or(&mut self) -> Result<Expr> {
        let mut e = self.and()?;
        while self.peek() == "OR" {
            self.operator()?;
            e = Expr::Or(Box::new(e), Box::new(self.and()?));
        }
        Ok(e)
    }
}
impl Expr {
    fn ids(
        &self,
        negative: bool,
        positive: &mut BTreeSet<String>,
        negatives: &mut BTreeSet<String>,
    ) {
        match self {
            Self::Id(id) => {
                if negative {
                    negatives.insert(id.clone());
                } else {
                    positive.insert(id.clone());
                }
            }
            Self::And(a, b) | Self::Or(a, b) => {
                a.ids(negative, positive, negatives);
                b.ids(negative, positive, negatives);
            }
            Self::Minus(a, b) => {
                a.ids(negative, positive, negatives);
                b.ids(true, positive, negatives);
            }
        }
    }
    fn eval(&self, hits: &BTreeMap<String, BTreeMap<String, f64>>) -> BTreeSet<String> {
        match self {
            Self::Id(id) => hits[id].keys().cloned().collect(),
            Self::And(a, b) => a.eval(hits).intersection(&b.eval(hits)).cloned().collect(),
            Self::Or(a, b) => a.eval(hits).union(&b.eval(hits)).cloned().collect(),
            Self::Minus(a, b) => a.eval(hits).difference(&b.eval(hits)).cloned().collect(),
        }
    }
}
fn expression(s: &str) -> Result<(Expr, Vec<String>)> {
    if s.chars().count() > 500 {
        return Err(invalid("Expression exceeds 500 characters"));
    }
    let spaced = s.replace('(', " ( ").replace(')', " ) ");
    let tokens = spaced
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut parser = Parser {
        tokens: tokens.clone(),
        at: 0,
        operators: 0,
    };
    let tree = parser.or()?;
    if parser.at != tokens.len() {
        return Err(invalid("Unexpected expression token"));
    }
    Ok((tree, tokens))
}

/// Format a saved keyword query the same way `search_mid` displays it to users.
/// The database stores the expression and keyword definitions separately, so this
/// helper rebuilds the display string from those persisted values.
pub(crate) fn display_keyword_query(rationale: &str, expression: &str, keywords: &Value) -> String {
    let by_id: HashMap<&str, &str> = keywords
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|keyword| Some((keyword.get("id")?.as_str()?, keyword.get("text")?.as_str()?)))
        .collect();
    let spaced = expression.replace('(', " ( ").replace(')', " ) ");
    let tokens = spaced
        .split_whitespace()
        .map(|token| by_id.get(token).copied().unwrap_or(token))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{rationale} ({tokens})")
}

fn add(store: &Store, run: &str, query: &Value, companies: &[Value]) -> Result<()> {
    // The store's public mutation accepts at most 1,000 records per call.
    for chunk in companies.chunks(1000) {
        store.execute(
            "add_candidates",
            &json!({"run_id":run,"companies":chunk,"discovery_source":"MID","query_id":query}),
        )?;
    }
    Ok(())
}
pub fn search(store: &Store, arguments: &Value) -> Result<Value> {
    let args: KeywordArgs = parse(arguments)?;
    text(&args.rationale, 300)?;
    if !(1..=50).contains(&args.keywords.len()) || !(1..=20000).contains(&args.limit) {
        return Err(invalid(
            "keywords must contain 1..50 entries and limit must be 1..20000",
        ));
    }
    let profile = approved(store, &args.run_id)?;
    let bundle = active(store)?
        .ok_or_else(|| invalid("Build and activate the MID index before keyword search."))?;
    let mut keywords = BTreeMap::new();
    for k in &args.keywords {
        text(&k.text, 80)?;
        if k.id.len() > 16
            || !k.id.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
            || !k
                .id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            || keywords.insert(k.id.clone(), k).is_some()
        {
            return Err(invalid(
                "Keyword ids must be unique and match ^[a-z][a-z0-9_]{0,15}$",
            ));
        }
        if !k.weight.is_finite() || !(0.1..=10.0).contains(&k.weight) {
            return Err(invalid("Keyword weight must be 0.1..10"));
        }
    }
    let expr = args.expression.clone().unwrap_or_else(|| {
        args.keywords
            .iter()
            .map(|k| k.id.clone())
            .collect::<Vec<_>>()
            .join(" OR ")
    });
    let (tree, _tokens) = expression(&expr)?;
    let mut positives = BTreeSet::new();
    let mut negatives = BTreeSet::new();
    tree.ids(false, &mut positives, &mut negatives);
    for id in positives.union(&negatives) {
        if !keywords.contains_key(id) {
            return Err(invalid(format!("Unknown keyword id: {id}")));
        }
    }
    let exclusions = profile["content"]["core_business_exclusions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for id in &negatives {
        let k = keywords[id];
        if !exclusions
            .iter()
            .filter_map(Value::as_str)
            .any(|s| normalized(s) == normalized(&k.text))
        {
            return Err(invalid(format!("Exclusions in keyword search must come from the approved core-business exclusions: {}",k.text)));
        }
    }
    // A keyword used negatively is never counted towards Match %.
    positives = keywords
        .keys()
        .filter(|id| !negatives.contains(*id))
        .cloned()
        .collect();
    let names = bundle
        .config
        .search_columns
        .iter()
        .map(|c| bundle.config.fts5_column_names[c].clone())
        .collect::<Vec<_>>();
    let columns = args.columns.as_ref().unwrap_or(&names);
    if columns.is_empty() || columns.iter().any(|c| !names.contains(c)) {
        return Err(invalid("columns must contain configured FTS column names"));
    }
    let weights = names
        .iter()
        .map(|n| bundle.config.source_weights[n].to_string())
        .collect::<Vec<_>>()
        .join(",");
    // Hit sets hold only company ids and bm25; names are read for the returned rows only.
    let hits = store.with_connection(|c| {
        let mut hits = BTreeMap::new();
        for k in &args.keywords {
            let table = format!(
                "mid_fts_{}{}",
                if matches!(k.r#match, Match::Exact) { "exact_" } else { "" },
                bundle.fts
            );
            let query = format!("{{{}}} : {}", columns.join(" "), phrase(&k.text)?);
            let sql = format!("SELECT m.company_id,bm25({table},{weights}) FROM {table} JOIN mid_rows m ON m.row_no={table}.rowid AND m.bundle_id=? WHERE {table} MATCH ?");
            let mut records = BTreeMap::new();
            let mut statement = c.prepare(&sql)?;
            let mut rows = statement.query(params![bundle.id, query])?;
            while let Some(row) = rows.next()? {
                records.insert(row.get::<_, String>(0)?, row.get::<_, f64>(1)?);
            }
            hits.insert(k.id.clone(), records);
        }
        Ok(hits)
    })?;
    let weight: f64 = positives.iter().map(|id| keywords[id].weight).sum();
    let mut ranked = tree
        .eval(&hits)
        .into_iter()
        .map(|id| {
            let matched: Vec<&String> = positives
                .iter()
                .filter(|k| hits[*k].contains_key(&id))
                .collect();
            let sum: f64 = matched.iter().map(|k| keywords[*k].weight).sum();
            let pct = if weight > 0.0 {
                (sum / weight * 1000.0).round() / 10.0
            } else {
                0.0
            };
            let bm25 = matched
                .iter()
                .filter_map(|k| hits[*k].get(&id))
                .copied()
                .reduce(f64::min);
            (id, pct, bm25, matched)
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| {
        b.1.total_cmp(&a.1)
            .then_with(|| {
                a.2.unwrap_or(f64::INFINITY)
                    .total_cmp(&b.2.unwrap_or(f64::INFINITY))
            })
            .then_with(|| a.0.cmp(&b.0))
    });
    let total = ranked.len();
    ranked.truncate(args.limit);
    let company_names = store.with_connection(|c| {
        let mut statement = c.prepare("SELECT name FROM companies WHERE company_id=?")?;
        let mut names = BTreeMap::new();
        for (id, ..) in &ranked {
            names.insert(
                id.clone(),
                statement.query_row([id], |r| r.get::<_, String>(0))?,
            );
        }
        Ok(names)
    })?;
    let rows = ranked
        .iter()
        .enumerate()
        .map(|(i, (id, pct, bm25, matched))| {
            json!({
                "company_id": id,
                "name": company_names[id],
                "match_pct": pct,
                "hit_count": matched.len(),
                "matched": matched.iter().map(|k| json!({"id": k, "text": keywords[*k].text})).collect::<Vec<_>>(),
                "bm25": bm25,
                "rank": i + 1,
            })
        })
        .collect::<Vec<_>>();
    let display = display_keyword_query(
        &args.rationale,
        &expr,
        &serde_json::to_value(&args.keywords)?,
    );
    let mut result = json!({"bundle_id":bundle.id,"rationale":args.rationale,"expression":expr,"display_query":display,"total_matched":total,"returned":rows.len(),"keyword_stats":args.keywords.iter().map(|k|json!({"id":k.id,"text":k.text,"match":k.r#match,"hits":hits[&k.id].len()})).collect::<Vec<_>>(),"results":rows,"added_to_run":args.add_to_run,"search_scope":"qualitative_core_business"});
    let record = store.record_search(Some(&args.run_id), "MID", &display, arguments, &result)?;
    result["query_id"] = record["query_id"].clone();
    store.with_connection(|c| { let tx=c.transaction()?;
        tx.execute("INSERT INTO mid_keyword_queries(query_id,run_id,bundle_id,rationale,keywords_json,expression,hit_count,created_at) VALUES(?,?,?,?,?,?,?,datetime('now'))",params![record["query_id"].as_str(),args.run_id,bundle.id,args.rationale,serde_json::to_string(&args.keywords)?,expr,total])?;
        for row in &rows { tx.execute("INSERT INTO mid_keyword_hits(query_id,run_id,company_id,matched_json,match_pct,hit_count,bm25) VALUES(?,?,?,?,?,?,?)",params![record["query_id"].as_str(),args.run_id,row["company_id"].as_str(),row["matched"].to_string(),row["match_pct"].as_f64(),row["hit_count"].as_i64(),row["bm25"].as_f64()])?; }
        tx.commit()?; Ok(())
    })?;
    if args.add_to_run {
        add(store,&args.run_id,&record["query_id"],&rows.iter().map(|r|json!({"company_id":r["company_id"],"rank":r["rank"],"retrieval_score":r["match_pct"].as_f64().unwrap()/100.0})).collect::<Vec<_>>())?;
    }
    Ok(result)
}

struct SemanticContext {
    bundle: Bundle,
    adapter: LocalHttpAdapter,
    revision: i64,
    definition: String,
}
fn semantic_context(
    store: &Store,
    run: &str,
) -> Result<std::result::Result<SemanticContext, String>> {
    let profile = approved(store, run)?;
    let Some(bundle) = active(store)? else {
        return Ok(Err(
            "Build and activate the MID index before semantic scoring.".into(),
        ));
    };
    if bundle.semantic != "ready" {
        return Ok(Err(format!(
            "MID bundle embeddings are not ready ({}).",
            bundle.semantic
        )));
    }
    let config = RetrievalConfig::from_env()?;
    if config.embed_endpoint.is_none() {
        return Ok(Err(
            "Embedding model not configured (set MNA_EMBED_ENDPOINT).".into(),
        ));
    }
    let revision=store.with_connection(|c| Ok(c.query_row("SELECT r.revision FROM criteria_revisions r JOIN criteria_revision_approvals a USING(revision_id) WHERE r.run_id=? ORDER BY r.revision DESC LIMIT 1",[run],|r|r.get::<_,i64>(0)).optional()?))?;
    let Some(revision) = revision else {
        return Ok(Err(
            "The run has no approved criteria revision for semantic scoring.".into(),
        ));
    };
    let definition = profile["content"]["core_business_query"]
        .as_str()
        .or_else(|| profile["content"]["business_definition"].as_str())
        .unwrap_or("");
    let marker =
        regex::Regex::new(r"(?i)\b(?:exclude(?:s|d)?|excluding|except|do\s+not\s+include)\b")
            .expect("constant exclusion pattern");
    let definition = marker
        .find(definition)
        .map_or(definition, |m| &definition[..m.start()])
        .trim()
        .trim_end_matches(['.', ';', ',', ':'])
        .trim()
        .to_owned();
    if definition.trim().is_empty() {
        return Ok(Err("The approved core-business definition is empty.".into()));
    }
    Ok(Ok(SemanticContext {
        bundle,
        adapter: LocalHttpAdapter::new(config)?,
        revision,
        definition,
    }))
}
struct VectorRow {
    row_no: i64,
    id: String,
    name: String,
    dimensions: Option<i64>,
    blob: Option<Vec<u8>>,
    hash: String,
    vector_hash: Option<String>,
}
fn vector_page(
    store: &Store,
    context: &SemanticContext,
    run: &str,
    cursor: i64,
    candidates: bool,
) -> Result<Vec<VectorRow>> {
    let model = &context.adapter.config().embedder;
    store.with_connection(|c| {
        let membership=if candidates {"EXISTS"} else {"NOT EXISTS"};
        let sql=format!("SELECT r.row_no,r.company_id,c.name,e.dimensions,e.vector_blob,r.desc_hash,e.text_hash FROM mid_rows r JOIN companies c USING(company_id) LEFT JOIN embedding_vectors e ON e.company_id=r.company_id AND e.model=? AND e.model_version=? WHERE r.bundle_id=? AND r.row_no>? AND {membership}(SELECT 1 FROM candidates x WHERE x.run_id=? AND x.company_id=r.company_id) ORDER BY r.row_no LIMIT 256");
        Ok(c.prepare(&sql)?.query_map(params![model.model,model.version,context.bundle.id,cursor,run],|r|Ok(VectorRow {row_no:r.get(0)?,id:r.get(1)?,name:r.get(2)?,dimensions:r.get(3)?,blob:r.get(4)?,hash:r.get(5)?,vector_hash:r.get(6)?}))?.collect::<std::result::Result<Vec<_>,_>>()?)
    })
}
fn cosine(row: &VectorRow, context: &SemanticContext, query: &[f32]) -> Option<f64> {
    let identity = &context.adapter.config().embedder;
    if row.dimensions != Some(identity.dimensions as i64)
        || row.vector_hash.as_ref() != Some(&row.hash)
    {
        return None;
    }
    let blob = row.blob.as_ref()?;
    if blob.len() != identity.dimensions * 4 {
        return None;
    }
    let vector = blob
        .as_chunks::<4>()
        .0
        .iter()
        .map(|v| f32::from_le_bytes(*v))
        .collect::<Vec<_>>();
    if retrieval::validate_vector(&vector, identity).is_err() {
        return None;
    }
    let dot: f64 = vector
        .iter()
        .zip(query)
        .map(|(a, b)| f64::from(*a) * f64::from(*b))
        .sum();
    let norm = |v: &[f32]| v.iter().map(|n| f64::from(*n).powi(2)).sum::<f64>().sqrt();
    Some((dot / (norm(&vector) * norm(query))).clamp(-1.0, 1.0))
}
fn score(cos: f64) -> f64 {
    (100.0 * cos.max(0.0)).round() / 10.0
}
fn save_scores(
    store: &Store,
    run: &str,
    context: &SemanticContext,
    rows: &[(String, f64)],
) -> Result<()> {
    store.with_connection(|c| { let tx=c.transaction()?;
        for (id,cos) in rows { tx.execute("INSERT INTO mid_semantic_scores(run_id,company_id,criteria_revision,score,cosine,model,computed_at) VALUES(?,?,?,?,?,?,datetime('now')) ON CONFLICT(run_id,company_id,criteria_revision) DO UPDATE SET score=excluded.score,cosine=excluded.cosine,model=excluded.model,computed_at=excluded.computed_at",params![run,id,context.revision,score(*cos),cos,context.adapter.config().embedder.model])?; }
        tx.commit()?; Ok(())
    })
}
pub async fn score_run(store: &Store, arguments: &Value) -> Result<Value> {
    let args: RunArgs = parse(arguments)?;
    let context = match semantic_context(store, &args.run_id)? {
        Ok(c) => c,
        Err(reason) => return Ok(json!({"status":"skipped","reason":reason})),
    };
    let query = context
        .adapter
        .embed(&[format!("query: {}", context.definition)])
        .await?
        .remove(0);
    let mut cursor = 0;
    let mut scored = 0;
    let mut missing = 0;
    loop {
        let rows = vector_page(store, &context, &args.run_id, cursor, true)?;
        if rows.is_empty() {
            break;
        }
        let mut scores = Vec::new();
        for row in rows {
            cursor = row.row_no;
            if let Some(cos) = cosine(&row, &context, &query) {
                scores.push((row.id, cos));
            } else {
                missing += 1;
            }
        }
        save_scores(store, &args.run_id, &context, &scores)?;
        scored += scores.len();
    }
    Ok(
        json!({"status":"scored","scored":scored,"missing_vector":missing,"criteria_revision":context.revision,"model":context.adapter.config().embedder.model}),
    )
}
pub async fn search_semantic(store: &Store, arguments: &Value) -> Result<Value> {
    let args: SemanticArgs = parse(arguments)?;
    text(&args.rationale, 300)?;
    if !args.min_score.is_finite()
        || !(0.0..=10.0).contains(&args.min_score)
        || !(1..=5000).contains(&args.limit)
    {
        return Err(invalid("min_score must be 0..10 and limit must be 1..5000"));
    }
    let context = match semantic_context(store, &args.run_id)? {
        Ok(c) => c,
        Err(reason) => return Ok(json!({"status":"skipped","reason":reason})),
    };
    let query = context
        .adapter
        .embed(&[format!("query: {}", context.definition)])
        .await?
        .remove(0);
    let mut cursor = 0;
    let mut considered = 0;
    let mut missing = 0;
    let mut best: Vec<(String, String, f64)> = Vec::new();
    loop {
        let rows = vector_page(store, &context, &args.run_id, cursor, false)?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            cursor = row.row_no;
            considered += 1;
            if let Some(cos) = cosine(&row, &context, &query) {
                if score(cos) >= args.min_score {
                    best.push((row.id, row.name, cos));
                }
            } else {
                missing += 1;
            }
        }
        best.sort_by(|a, b| {
            score(b.2)
                .total_cmp(&score(a.2))
                .then_with(|| a.0.cmp(&b.0))
        });
        best.truncate(args.limit);
    }
    let rows = best
        .iter()
        .map(|(id, name, cos)| json!({"company_id":id,"name":name,"score":score(*cos)}))
        .collect::<Vec<_>>();
    let mut result = json!({"status":"added","considered":considered,"returned":rows.len(),"results":rows,"missing_vector":missing,"added_to_run":args.add_to_run,"search_scope":"qualitative_core_business"});
    let display = format!("semantic: {} (≥{})", args.rationale, args.min_score);
    let record = store.record_search(Some(&args.run_id), "MID", &display, arguments, &result)?;
    result["query_id"] = record["query_id"].clone();
    save_scores(
        store,
        &args.run_id,
        &context,
        &best
            .iter()
            .map(|(id, _, cos)| (id.clone(), *cos))
            .collect::<Vec<_>>(),
    )?;
    if args.add_to_run {
        add(store,&args.run_id,&record["query_id"],&best.iter().enumerate().map(|(i,(id,_,cos))|json!({"company_id":id,"rank":i+1,"retrieval_score":score(*cos)/10.0})).collect::<Vec<_>>())?;
    }
    Ok(result)
}
