-- Keep source retrieval, model assessment, and claim confidence separate.
CREATE TABLE IF NOT EXISTS evidence_claim_state (
    evidence_id TEXT PRIMARY KEY REFERENCES evidence(evidence_id) ON DELETE CASCADE,
    verification_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(verification_status IN ('UNKNOWN','VERIFIED','REJECTED')),
    claim_provenance_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(claim_provenance_json)),
    reviewed_by TEXT,
    review_reason TEXT,
    reviewed_at TEXT
);
INSERT OR IGNORE INTO evidence_claim_state(evidence_id) SELECT evidence_id FROM evidence;
CREATE TABLE IF NOT EXISTS agent_command_attempts (
    request_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 2),
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id),
    response_hash TEXT NOT NULL,
    tool TEXT,
    outcome TEXT NOT NULL,
    response_json TEXT NOT NULL CHECK(json_valid(response_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(request_id,attempt)
);
CREATE INDEX IF NOT EXISTS command_run_attempts ON agent_command_attempts(run_id,created_at);
PRAGMA user_version = 5;
