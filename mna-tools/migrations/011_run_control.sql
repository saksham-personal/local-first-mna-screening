-- 011: analysts can cancel a background run (Bing research, LLM Suite or M365 screening)
-- and choose to keep or discard the results it already produced.
--
-- Discard is a soft, auditable decision: nothing is deleted. A discarded plan's model
-- assessments and research observations stay in the store for history, but every reader
-- (grid, company detail, shortlist coverage, run projection, context packets, exports and
-- the LLM controller summary) must ignore them.
--
-- kind: 'screening' = a prepared plan (LLM Suite / M365 screening round, prepared_plans.plan_id)
--       'research'  = an action plan step (Bing research, action plan plan_id)
-- Store::open also adds `evidence.discarded_plan_id` (nullable): set on research evidence of
-- a discarded plan so evidence readers can filter with one indexed column.
CREATE TABLE IF NOT EXISTS discarded_plans (
    plan_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('screening','research')),
    discarded_by TEXT NOT NULL,
    reason TEXT,
    discarded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS discarded_plans_run ON discarded_plans(run_id);
