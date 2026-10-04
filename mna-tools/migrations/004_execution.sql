CREATE TABLE IF NOT EXISTS prepared_plans (
    plan_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id),
    schema_version INTEGER NOT NULL CHECK(schema_version=2),
    digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('PROPOSED','APPROVED','CANCELLED','STALE')),
    spec_json TEXT NOT NULL CHECK(json_valid(spec_json)),
    snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
    proposed_at TEXT NOT NULL,
    approved_at TEXT,
    approved_by TEXT,
    cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS prepared_plans_run ON prepared_plans(run_id, proposed_at DESC);
CREATE TRIGGER IF NOT EXISTS immutable_prepared_plan
BEFORE UPDATE OF plan_id,run_id,schema_version,digest,spec_json,snapshot_json,proposed_at ON prepared_plans
BEGIN SELECT RAISE(ABORT,'prepared plan content is immutable'); END;

CREATE TABLE IF NOT EXISTS prepared_plan_approvals (
    plan_id TEXT PRIMARY KEY REFERENCES prepared_plans(plan_id),
    approval_key TEXT NOT NULL,
    digest TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    approved_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_jobs (
    job_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES prepared_plans(plan_id),
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id),
    ordinal INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('READY','LEASED','WAITING_RATE','RUNNING','PARSE_REVIEW','SUCCEEDED','FAILED','CANCELLED','STALE','AMBIGUOUS')),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    input_hash TEXT NOT NULL,
    lease_token TEXT,
    lease_expires_at TEXT,
    next_eligible_at TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    repair_attempt INTEGER NOT NULL DEFAULT 0,
    dispatched_at TEXT,
    completed_at TEXT,
    response_hash TEXT,
    raw_response TEXT,
    repair_prompt TEXT,
    error_text TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(plan_id,ordinal)
);
CREATE INDEX IF NOT EXISTS execution_jobs_state ON execution_jobs(state,updated_at);
CREATE TRIGGER IF NOT EXISTS immutable_execution_job_input
BEFORE UPDATE OF job_id,plan_id,run_id,ordinal,payload_json,input_hash,created_at ON execution_jobs
BEGIN SELECT RAISE(ABORT,'execution job input is immutable'); END;

CREATE TABLE IF NOT EXISTS execution_index_map (
    plan_id TEXT NOT NULL REFERENCES prepared_plans(plan_id),
    row_index INTEGER NOT NULL,
    company_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES execution_jobs(job_id),
    row_hash TEXT NOT NULL,
    PRIMARY KEY(plan_id,row_index),
    UNIQUE(plan_id,company_id)
);

CREATE TABLE IF NOT EXISTS execution_outbox (
    event_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES prepared_plans(plan_id),
    job_id TEXT NOT NULL REFERENCES execution_jobs(job_id),
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    created_at TEXT NOT NULL,
    consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS execution_responses (
    response_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES execution_jobs(job_id),
    attempt INTEGER NOT NULL,
    response_hash TEXT NOT NULL,
    raw_response TEXT NOT NULL,
    parse_status TEXT NOT NULL CHECK(parse_status IN ('ACCEPTED','QUARANTINED')),
    parse_error TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(job_id,attempt)
);

CREATE TABLE IF NOT EXISTS model_assessments (
    assessment_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id),
    plan_id TEXT NOT NULL REFERENCES prepared_plans(plan_id),
    job_id TEXT NOT NULL REFERENCES execution_jobs(job_id),
    company_id TEXT NOT NULL,
    row_index INTEGER NOT NULL,
    provider TEXT NOT NULL,
    prompt TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK(json_valid(result_json)),
    created_at TEXT NOT NULL,
    UNIQUE(plan_id,row_index)
);

CREATE TABLE IF NOT EXISTS execution_question_answers (
    answer_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id),
    plan_id TEXT NOT NULL REFERENCES prepared_plans(plan_id),
    job_id TEXT NOT NULL REFERENCES execution_jobs(job_id),
    provider TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    attribution_json TEXT NOT NULL CHECK(json_valid(attribution_json)),
    created_at TEXT NOT NULL,
    UNIQUE(job_id)
);

CREATE TABLE IF NOT EXISTS llmsuite_slots (
    request_key TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,
    reserved_at TEXT NOT NULL,
    window_epoch INTEGER NOT NULL,
    consumed_epoch INTEGER
);
CREATE INDEX IF NOT EXISTS llmsuite_slots_window ON llmsuite_slots(window_epoch);

CREATE TABLE IF NOT EXISTS execution_provider_audit (
    audit_id TEXT PRIMARY KEY,
    job_id TEXT REFERENCES execution_jobs(job_id),
    provider TEXT NOT NULL,
    purpose TEXT NOT NULL,
    request_key TEXT NOT NULL,
    payload_hash TEXT,
    recorded_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS execution_provider_unique_request ON execution_provider_audit(request_key);
PRAGMA user_version = 4;
