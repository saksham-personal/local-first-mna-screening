-- Durable discovery decisions. Search scores are frozen per query, never averaged.
CREATE TABLE IF NOT EXISTS controller_loops (
    loop_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id),
    conversation_id TEXT NOT NULL REFERENCES llm_conversations(conversation_id),
    status TEXT NOT NULL CHECK(status IN ('running','paused','consolidating','completed','cancelled','failed')),
    max_turns INTEGER NOT NULL DEFAULT 50 CHECK(max_turns BETWEEN 1 AND 50),
    turns_used INTEGER NOT NULL DEFAULT 0,
    analyst_message TEXT NOT NULL,
    selection_revision_before INTEGER NOT NULL,
    applied_review_id TEXT REFERENCES shortlist_reviews(review_id),
    final_count INTEGER,
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    criteria_revision_id TEXT NOT NULL,
    selection_before_json TEXT NOT NULL CHECK(json_valid(selection_before_json)),
    observations TEXT NOT NULL DEFAULT '',
    none_count INTEGER NOT NULL DEFAULT 0,
    finish_requested INTEGER NOT NULL DEFAULT 0,
    undone_review_id TEXT
);
CREATE INDEX IF NOT EXISTS controller_loops_run ON controller_loops(run_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS controller_loops_one_running ON controller_loops(run_id)
    WHERE status IN ('running','paused','consolidating');
CREATE TABLE IF NOT EXISTS controller_loop_queries (
    loop_id TEXT NOT NULL REFERENCES controller_loops(loop_id),
    query_id TEXT NOT NULL REFERENCES search_queries(query_id),
    source TEXT NOT NULL CHECK(source IN ('MID_KEYWORD','MID_SEMANTIC','ISCC')),
    label TEXT NOT NULL,
    turn INTEGER NOT NULL,
    total INTEGER NOT NULL,
    histogram_json TEXT NOT NULL CHECK(json_valid(histogram_json)),
    short_id TEXT NOT NULL,
    PRIMARY KEY(loop_id,query_id), UNIQUE(loop_id,short_id)
);
CREATE TABLE IF NOT EXISTS controller_loop_keeps (
    loop_id TEXT NOT NULL,
    query_id TEXT NOT NULL,
    min_score REAL NOT NULL,
    kept_count INTEGER NOT NULL,
    note TEXT NOT NULL,
    turn INTEGER NOT NULL,
    PRIMARY KEY(loop_id,query_id),
    FOREIGN KEY(loop_id,query_id) REFERENCES controller_loop_queries(loop_id,query_id)
);
CREATE TABLE IF NOT EXISTS controller_loop_drops (
    loop_id TEXT NOT NULL REFERENCES controller_loops(loop_id),
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON UPDATE CASCADE,
    reason TEXT NOT NULL,
    turn INTEGER NOT NULL,
    PRIMARY KEY(loop_id,company_id)
);
-- Immutable membership avoids later semantic scoring overwriting an earlier query.
CREATE TABLE IF NOT EXISTS controller_loop_hits (
    loop_id TEXT NOT NULL, query_id TEXT NOT NULL, company_id TEXT NOT NULL REFERENCES companies(company_id) ON UPDATE CASCADE,
    score REAL NOT NULL, matched_json TEXT NOT NULL DEFAULT '[]', simulated INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(loop_id,query_id,company_id),
    FOREIGN KEY(loop_id,query_id) REFERENCES controller_loop_queries(loop_id,query_id)
);
CREATE TABLE IF NOT EXISTS controller_loop_turns (
    loop_id TEXT NOT NULL REFERENCES controller_loops(loop_id), turn INTEGER NOT NULL,
    turn_id TEXT NOT NULL REFERENCES controller_turns(turn_id),
    PRIMARY KEY(loop_id,turn_id)
);
