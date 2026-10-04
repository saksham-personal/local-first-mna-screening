CREATE TABLE IF NOT EXISTS execution_reconciliations (
    reconciliation_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES execution_jobs(job_id),
    outcome TEXT NOT NULL CHECK(outcome IN ('response_received','confirmed_not_sent','abandon')),
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_transport_receipts (
    job_id TEXT NOT NULL REFERENCES execution_jobs(job_id),
    attempt INTEGER NOT NULL,
    response_hash TEXT NOT NULL,
    response_bytes BLOB NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(job_id,attempt)
);
CREATE TABLE IF NOT EXISTS embedding_vectors (
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON UPDATE CASCADE ON DELETE CASCADE,
    model TEXT NOT NULL,
    model_version TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK(dimensions > 0),
    text_hash TEXT NOT NULL,
    vector_blob BLOB NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(company_id, model, model_version)
);
CREATE INDEX IF NOT EXISTS embedding_vectors_model ON embedding_vectors(model, model_version);
CREATE TRIGGER IF NOT EXISTS immutable_execution_index_update
BEFORE UPDATE ON execution_index_map
BEGIN SELECT RAISE(ABORT,'execution index mapping is immutable'); END;
CREATE TRIGGER IF NOT EXISTS immutable_execution_index_delete
BEFORE DELETE ON execution_index_map
BEGIN SELECT RAISE(ABORT,'execution index mapping is immutable'); END;
CREATE TRIGGER IF NOT EXISTS immutable_model_assessment_update
BEFORE UPDATE ON model_assessments
BEGIN SELECT RAISE(ABORT,'model assessment is immutable'); END;
CREATE TRIGGER IF NOT EXISTS immutable_model_assessment_delete
BEFORE DELETE ON model_assessments
BEGIN SELECT RAISE(ABORT,'model assessment is immutable'); END;
PRAGMA user_version = 6;
