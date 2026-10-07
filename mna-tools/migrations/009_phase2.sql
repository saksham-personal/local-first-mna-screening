-- Phase 2: MID index bundles and builds, keyword and semantic MID search, screening rounds,
-- and labelled simulated provider output.
--
-- Idempotent (CREATE ... IF NOT EXISTS); Store::open runs it on every open. The `simulated`
-- columns are added by Store::open with one probe per column (ALTER TABLE ... ADD COLUMN
-- cannot be made idempotent in SQL); ADD COLUMN is unaffected by the immutability triggers.
--
-- Per-bundle FTS5 tables are NOT created here: an index build creates, for bundle row id N
-- (mid_bundles.fts_id), two contentless tables whose rowid is mid_rows.row_no:
--   mid_fts_N        fts5(<configured fts5 column names>, content='', tokenize='porter unicode61')
--   mid_fts_exact_N  fts5(<configured fts5 column names>, content='', tokenize='unicode61')
-- Deleting or superseding a bundle drops both tables.

CREATE TABLE IF NOT EXISTS mid_bundles (
    bundle_id TEXT PRIMARY KEY,
    fts_id INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('building','ready','active','failed','superseded','cancelled')),
    source_file TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    config_json TEXT NOT NULL CHECK(json_valid(config_json)),
    config_hash TEXT NOT NULL,
    semantic_status TEXT NOT NULL DEFAULT 'pending' CHECK(semantic_status IN ('pending','ready','skipped','failed')),
    semantic_model TEXT,
    created_at TEXT NOT NULL,
    activated_at TEXT,
    error TEXT
);
-- At most one active bundle.
CREATE UNIQUE INDEX IF NOT EXISTS mid_bundles_one_active ON mid_bundles(status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS index_builds (
    build_id TEXT PRIMARY KEY,
    bundle_id TEXT NOT NULL REFERENCES mid_bundles(bundle_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','interrupted')),
    current_step TEXT,
    steps_json TEXT NOT NULL CHECK(json_valid(steps_json)),
    rows_total INTEGER,
    rows_done INTEGER NOT NULL DEFAULT 0,
    activate_on_success INTEGER NOT NULL DEFAULT 1 CHECK(activate_on_success IN (0,1)),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
    log_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(log_json)),
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT
);
CREATE INDEX IF NOT EXISTS index_builds_started ON index_builds(started_at);

-- One row per company per bundle. row_no is the FTS rowid. desc_text joins the configured
-- llm_description_columns ("Label: text" lines); desc_hash is its SHA-256 (embedding skip key).
CREATE TABLE IF NOT EXISTS mid_rows (
    row_no INTEGER PRIMARY KEY,
    bundle_id TEXT NOT NULL REFERENCES mid_bundles(bundle_id) ON DELETE CASCADE,
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON UPDATE CASCADE ON DELETE CASCADE,
    row_json TEXT NOT NULL CHECK(json_valid(row_json)),
    desc_text TEXT NOT NULL DEFAULT '',
    desc_hash TEXT NOT NULL,
    UNIQUE(bundle_id, company_id)
);
CREATE INDEX IF NOT EXISTS mid_rows_company ON mid_rows(company_id);

-- search_mid v2 (keyword list + expression). One query row per call.
CREATE TABLE IF NOT EXISTS mid_keyword_queries (
    query_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    bundle_id TEXT NOT NULL REFERENCES mid_bundles(bundle_id),
    rationale TEXT NOT NULL,
    keywords_json TEXT NOT NULL CHECK(json_valid(keywords_json)),
    expression TEXT NOT NULL,
    hit_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mid_keyword_queries_run ON mid_keyword_queries(run_id, created_at);

CREATE TABLE IF NOT EXISTS mid_keyword_hits (
    query_id TEXT NOT NULL REFERENCES mid_keyword_queries(query_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON UPDATE CASCADE ON DELETE CASCADE,
    matched_json TEXT NOT NULL CHECK(json_valid(matched_json)),
    match_pct REAL NOT NULL CHECK(match_pct >= 0 AND match_pct <= 100),
    hit_count INTEGER NOT NULL,
    bm25 REAL,
    PRIMARY KEY(query_id, company_id)
);
CREATE INDEX IF NOT EXISTS mid_keyword_hits_run_company ON mid_keyword_hits(run_id, company_id);

-- MID semantic score = round(10 * max(0, cosine), 1) against the approved criteria revision.
CREATE TABLE IF NOT EXISTS mid_semantic_scores (
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON UPDATE CASCADE ON DELETE CASCADE,
    criteria_revision INTEGER NOT NULL,
    score REAL NOT NULL CHECK(score >= 0 AND score <= 10),
    cosine REAL NOT NULL,
    model TEXT NOT NULL,
    computed_at TEXT NOT NULL,
    PRIMARY KEY(run_id, company_id, criteria_revision)
);

-- A screening round per approved prepared plan, numbered per run from 1.
CREATE TABLE IF NOT EXISTS screening_rounds (
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    round_no INTEGER NOT NULL CHECK(round_no >= 1),
    plan_id TEXT NOT NULL UNIQUE REFERENCES prepared_plans(plan_id),
    provider TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(run_id, round_no)
);

-- Simulated (dev-only, MNA_SIMULATE=1) provider output is always labelled: Store::open adds
-- `simulated INTEGER NOT NULL DEFAULT 0 CHECK(simulated IN (0,1))` to source_rows,
-- model_assessments and evidence.
