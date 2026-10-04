CREATE TABLE IF NOT EXISTS action_plans (
    plan_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id),
    profile_version INTEGER NOT NULL DEFAULT 0,
    rationale TEXT NOT NULL,
    steps_json TEXT NOT NULL CHECK (json_valid(steps_json)),
    status TEXT NOT NULL CHECK (status IN ('PROPOSED','APPROVED','REJECTED')),
    proposed_at TEXT NOT NULL,
    approved_at TEXT,
    approved_by TEXT
);
CREATE INDEX IF NOT EXISTS action_plans_run_created ON action_plans(run_id, proposed_at DESC);
-- An automatically initialized legacy profile is not a human approval.
UPDATE screening_profiles SET status='PROPOSED', approved_at=NULL, approved_by=NULL
WHERE status='APPROVED' AND approved_by='system_initialization';
UPDATE screening_runs SET status='DRAFT'
WHERE status='ACTIVE' AND NOT EXISTS (
    SELECT 1 FROM screening_profiles p WHERE p.run_id=screening_runs.run_id AND p.status='APPROVED'
);
CREATE TRIGGER IF NOT EXISTS immutable_action_plan
BEFORE UPDATE OF plan_id, run_id, profile_version, rationale, steps_json, proposed_at ON action_plans
BEGIN SELECT RAISE(ABORT, 'action plan is immutable; propose a new plan'); END;
CREATE TABLE IF NOT EXISTS screening_batches (
    batch_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id),
    plan_id TEXT NOT NULL REFERENCES action_plans(plan_id),
    step_id TEXT NOT NULL,
    company_ids_json TEXT NOT NULL CHECK(json_valid(company_ids_json)),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS screening_results (
    batch_id TEXT NOT NULL REFERENCES screening_batches(batch_id),
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON UPDATE CASCADE,
    result_json TEXT NOT NULL CHECK(json_valid(result_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(batch_id,company_id)
);
CREATE TABLE IF NOT EXISTS operation_receipts (
    receipt_id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES screening_runs(run_id),
    tool TEXT NOT NULL,
    arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json)),
    result_json TEXT NOT NULL CHECK(json_valid(result_json)),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS action_step_progress (
    plan_id TEXT NOT NULL REFERENCES action_plans(plan_id),
    step_id TEXT NOT NULL,
    receipt_ids_json TEXT NOT NULL CHECK(json_valid(receipt_ids_json)),
    completed_at TEXT NOT NULL,
    PRIMARY KEY(plan_id,step_id)
);
CREATE TABLE IF NOT EXISTS action_receipt_claims (
    receipt_id TEXT PRIMARY KEY REFERENCES operation_receipts(receipt_id),
    plan_id TEXT NOT NULL REFERENCES action_plans(plan_id),
    step_id TEXT NOT NULL
);
PRAGMA user_version = 3;
