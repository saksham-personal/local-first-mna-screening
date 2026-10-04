CREATE TABLE IF NOT EXISTS company_identifiers (
    kind TEXT NOT NULL CHECK(kind IN ('PK','ECID','CID','PBID')),
    identifier TEXT NOT NULL,
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON UPDATE CASCADE ON DELETE CASCADE,
    first_seen_at TEXT NOT NULL,
    PRIMARY KEY(kind,identifier)
);
CREATE INDEX IF NOT EXISTS company_identifiers_company ON company_identifiers(company_id);

CREATE TABLE IF NOT EXISTS identity_quarantine (
    quarantine_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    reason TEXT NOT NULL,
    row_json TEXT NOT NULL CHECK(json_valid(row_json)),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_rows (
    source_row_id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK(source IN ('MID','ISCC')),
    run_scope TEXT NOT NULL DEFAULT '',
    query_scope TEXT NOT NULL DEFAULT '',
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON UPDATE CASCADE ON DELETE CASCADE,
    row_hash TEXT NOT NULL,
    row_json TEXT NOT NULL CHECK(json_valid(row_json)),
    relevance_score REAL,
    imported_at TEXT NOT NULL,
    UNIQUE(source,run_scope,query_scope,row_hash)
);
CREATE INDEX IF NOT EXISTS source_rows_company_source ON source_rows(company_id,source);
CREATE INDEX IF NOT EXISTS source_rows_scope_source ON source_rows(run_scope,source);
CREATE INDEX IF NOT EXISTS source_rows_query_scope ON source_rows(run_scope,query_scope);

CREATE TABLE IF NOT EXISTS enrichment_rows (
    enrichment_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('PB_MAPPING','PB_DATA','ROGO')),
    company_id TEXT REFERENCES companies(company_id) ON UPDATE CASCADE ON DELETE SET NULL,
    row_hash TEXT NOT NULL,
    row_json TEXT NOT NULL CHECK(json_valid(row_json)),
    parquet_path TEXT,
    imported_at TEXT NOT NULL,
    UNIQUE(kind,row_hash)
);
CREATE INDEX IF NOT EXISTS enrichment_rows_company_kind ON enrichment_rows(company_id,kind);

CREATE TABLE IF NOT EXISTS company_enrichment (
    company_id TEXT PRIMARY KEY REFERENCES companies(company_id) ON UPDATE CASCADE ON DELETE CASCADE,
    pb_website TEXT,
    pb_name TEXT,
    pb_description TEXT,
    pb_linkedin_url TEXT,
    pb_hq_location TEXT,
    pb_active_investors TEXT,
    pb_universe TEXT,
    rogo_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(rogo_json)),
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS enrichment_pb_website ON company_enrichment(pb_website);
CREATE INDEX IF NOT EXISTS companies_website ON companies(website);

PRAGMA user_version = 2;
