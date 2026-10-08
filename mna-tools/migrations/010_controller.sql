-- Phase 3: LLM Suite controller conversations and instruction-set turns.
--
-- Idempotent (CREATE ... IF NOT EXISTS); Store::open runs it on every open.
--
-- An LLM Suite chat/context is identified by its conversation_id: a new id starts a new
-- context, reusing it continues the same one. One active conversation per run; rotating
-- (before the context fills up) closes the old row and opens a new one seeded with a
-- hand-off summary.

CREATE TABLE IF NOT EXISTS llm_conversations (
    conversation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','rotated','closed')),
    rotated_from TEXT REFERENCES llm_conversations(conversation_id),
    estimated_tokens INTEGER NOT NULL DEFAULT 0,
    turn_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
-- At most one active conversation per run and provider.
CREATE UNIQUE INDEX IF NOT EXISTS llm_conversations_one_active
    ON llm_conversations(run_id, provider) WHERE status = 'active';

-- One row per controller turn (analyst message or feedback round). The raw reply and the
-- parsed instruction set are kept verbatim: they are the training data for a future
-- instruction classifier.
CREATE TABLE IF NOT EXISTS controller_turns (
    turn_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES llm_conversations(conversation_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    parent_turn_id TEXT REFERENCES controller_turns(turn_id),
    kind TEXT NOT NULL CHECK(kind IN ('analyst','feedback','handoff')),
    analyst_message TEXT,
    prompt_id TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    reply_markdown TEXT,
    parsed_json TEXT CHECK(parsed_json IS NULL OR json_valid(parsed_json)),
    calls_json TEXT CHECK(calls_json IS NULL OR json_valid(calls_json)),
    results_json TEXT CHECK(results_json IS NULL OR json_valid(results_json)),
    status TEXT NOT NULL CHECK(status IN ('pending','replied','executed','failed')),
    error TEXT,
    estimated_tokens INTEGER NOT NULL DEFAULT 0,
    simulated INTEGER NOT NULL DEFAULT 0 CHECK(simulated IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS controller_turns_run ON controller_turns(run_id, created_at);
CREATE INDEX IF NOT EXISTS controller_turns_conversation ON controller_turns(conversation_id, created_at);
