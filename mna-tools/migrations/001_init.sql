PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
    company_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    website TEXT,
    linkedin_url TEXT,
    industry TEXT,
    sub_industry TEXT,
    country TEXT,
    city TEXT,
    description TEXT,
    revenue REAL,
    employees INTEGER,
    ownership TEXT,
    services_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(services_json)),
    products_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(products_json)),
    keywords_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(keywords_json)),
    embedding_json TEXT CHECK (embedding_json IS NULL OR json_valid(embedding_json)),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS screening_runs (
    run_id TEXT PRIMARY KEY,
    objective TEXT NOT NULL,
    status TEXT NOT NULL,
    original_criteria_json TEXT NOT NULL CHECK (json_valid(original_criteria_json)),
    active_criteria_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS screening_profiles (
    profile_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    content_json TEXT NOT NULL CHECK (json_valid(content_json)),
    rationale TEXT,
    supporting_examples_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(supporting_examples_json)),
    status TEXT NOT NULL CHECK (status IN ('PROPOSED','APPROVED','SUPERSEDED','REJECTED')),
    proposed_at TEXT NOT NULL,
    approved_at TEXT,
    approved_by TEXT,
    UNIQUE(run_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_approved_profile_per_run
    ON screening_profiles(run_id) WHERE status = 'APPROVED';

CREATE TABLE IF NOT EXISTS company_labels (
    label_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE RESTRICT,
    label TEXT NOT NULL CHECK (label IN ('BEST_FIT','FIT','BORDERLINE','MISFIT')),
    analyst_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, company_id)
);

CREATE TABLE IF NOT EXISTS evidence (
    evidence_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE RESTRICT,
    claim TEXT NOT NULL,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    source_type TEXT NOT NULL,
    source_reference TEXT NOT NULL,
    source_url TEXT,
    confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
    extraction_method TEXT,
    retrieved_at TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    UNIQUE(run_id, company_id, claim, source_type, source_reference, content_hash)
);

CREATE TABLE IF NOT EXISTS search_queries (
    query_id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    query TEXT NOT NULL,
    normalized_query TEXT NOT NULL,
    parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json)),
    results_json TEXT NOT NULL CHECK (json_valid(results_json)),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS search_queries_run_created ON search_queries(run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS candidates (
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE RESTRICT,
    status TEXT NOT NULL,
    reason TEXT,
    discovered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(run_id, company_id)
);

CREATE TABLE IF NOT EXISTS candidate_discovery (
    discovery_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    discovery_source TEXT NOT NULL,
    query_id TEXT REFERENCES search_queries(query_id) ON DELETE SET NULL,
    retrieval_score REAL,
    rank INTEGER,
    discovered_at TEXT NOT NULL,
    UNIQUE(run_id, company_id, discovery_source, query_id),
    FOREIGN KEY(run_id, company_id) REFERENCES candidates(run_id, company_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS research_questions (
    question_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    company_id TEXT REFERENCES companies(company_id) ON DELETE RESTRICT,
    question TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('OPEN','RESOLVED')),
    answer TEXT,
    evidence_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
    created_at TEXT NOT NULL,
    resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    major INTEGER NOT NULL DEFAULT 0 CHECK (major IN (0,1)),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    namespace TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    created_at TEXT NOT NULL,
    UNIQUE(run_id, namespace, sequence)
);

CREATE TABLE IF NOT EXISTS tool_runs (
    tool_run_id TEXT PRIMARY KEY,
    tool TEXT NOT NULL,
    arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
    status TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS evidence_run_company ON evidence(run_id, company_id, retrieved_at DESC);
CREATE INDEX IF NOT EXISTS labels_run_label ON company_labels(run_id, label, updated_at DESC);
CREATE INDEX IF NOT EXISTS candidates_run_status ON candidates(run_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS events_run_created ON agent_events(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS questions_run_status ON research_questions(run_id, status, created_at DESC);

CREATE TRIGGER IF NOT EXISTS immutable_original_criteria
BEFORE UPDATE OF original_criteria_json, active_criteria_version ON screening_runs
WHEN NEW.original_criteria_json != OLD.original_criteria_json OR NEW.active_criteria_version != OLD.active_criteria_version
BEGIN SELECT RAISE(ABORT, 'original mandate criteria are immutable'); END;

CREATE TRIGGER IF NOT EXISTS immutable_profile_content
BEFORE UPDATE OF content_json, rationale, supporting_examples_json, version, run_id ON screening_profiles
BEGIN SELECT RAISE(ABORT, 'profile content and lineage are immutable; propose a new version'); END;

CREATE UNIQUE INDEX IF NOT EXISTS unique_unqueried_discovery
ON candidate_discovery(run_id, company_id, discovery_source) WHERE query_id IS NULL;

PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS source_documents (
    document_id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES screening_runs(run_id),
    source_url TEXT,
    artifact_ref TEXT,
    content_hash TEXT,
    metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
    retrieved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_run_url ON source_documents(run_id, source_url);

CREATE TABLE IF NOT EXISTS meilisearch_sync_state (
    index_key TEXT NOT NULL,
    company_id TEXT NOT NULL REFERENCES companies(company_id),
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(index_key, company_id)
);
