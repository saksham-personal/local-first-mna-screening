ALTER TABLE candidates ADD COLUMN considered INTEGER NOT NULL DEFAULT 1 CHECK(considered IN (0,1));
ALTER TABLE candidates ADD COLUMN consideration_reason TEXT;

CREATE TABLE shortlist_reviews (
    review_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    keep_company_ids_json TEXT NOT NULL CHECK(json_valid(keep_company_ids_json)),
    review_columns_json TEXT NOT NULL CHECK(json_valid(review_columns_json)),
    considered_count INTEGER NOT NULL,
    hidden_count INTEGER NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX shortlist_reviews_run ON shortlist_reviews(run_id,created_at,review_id);
CREATE TRIGGER immutable_shortlist_review_update BEFORE UPDATE ON shortlist_reviews
BEGIN SELECT RAISE(ABORT,'shortlist review audit is immutable'); END;
CREATE TRIGGER immutable_shortlist_review_delete BEFORE DELETE ON shortlist_reviews
BEGIN SELECT RAISE(ABORT,'shortlist review audit is immutable'); END;

CREATE TABLE shortlist_review_columns (
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES prepared_plans(plan_id),
    columns_json TEXT NOT NULL CHECK(json_valid(columns_json)),
    PRIMARY KEY(run_id,plan_id)
);

CREATE TABLE criteria_revisions (
    revision_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    digest TEXT NOT NULL,
    criteria_text TEXT NOT NULL,
    business_definition TEXT NOT NULL,
    good_fit_examples_json TEXT NOT NULL CHECK(json_valid(good_fit_examples_json)),
    bad_fit_examples_json TEXT NOT NULL CHECK(json_valid(bad_fit_examples_json)),
    created_at TEXT NOT NULL,
    UNIQUE(run_id,revision)
);
CREATE TABLE criteria_revision_approvals (
    revision_id TEXT PRIMARY KEY REFERENCES criteria_revisions(revision_id) ON DELETE CASCADE,
    approved_by TEXT NOT NULL,
    approved_at TEXT NOT NULL
);
CREATE TRIGGER immutable_criteria_revision_update BEFORE UPDATE ON criteria_revisions
BEGIN SELECT RAISE(ABORT,'criteria revision is immutable'); END;
CREATE TRIGGER immutable_criteria_revision_delete BEFORE DELETE ON criteria_revisions
BEGIN SELECT RAISE(ABORT,'criteria revision is immutable'); END;

-- One durable mutation clock covers canonical data, source rows, enrichment,
-- accepted assessments and candidate membership. A source hash is stable
-- across pages and changes even when descriptions change without a timestamp.
CREATE TABLE source_change_counter (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
INSERT INTO source_change_counter VALUES(1,0);
CREATE TRIGGER source_change_companies_insert AFTER INSERT ON companies BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_companies_update AFTER UPDATE ON companies BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_companies_delete AFTER DELETE ON companies BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_source_rows_insert AFTER INSERT ON source_rows BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_source_rows_update AFTER UPDATE ON source_rows BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_source_rows_delete AFTER DELETE ON source_rows BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_enrichment_rows_insert AFTER INSERT ON enrichment_rows BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_enrichment_rows_update AFTER UPDATE ON enrichment_rows BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_enrichment_rows_delete AFTER DELETE ON enrichment_rows BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_company_enrichment_insert AFTER INSERT ON company_enrichment BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_company_enrichment_update AFTER UPDATE ON company_enrichment BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_company_enrichment_delete AFTER DELETE ON company_enrichment BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_assessments_insert AFTER INSERT ON model_assessments BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_assessments_update AFTER UPDATE ON model_assessments BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_assessments_delete AFTER DELETE ON model_assessments BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_candidates_insert AFTER INSERT ON candidates BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_candidates_update AFTER UPDATE ON candidates BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_candidates_delete AFTER DELETE ON candidates BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_identifiers_insert AFTER INSERT ON company_identifiers BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_identifiers_update AFTER UPDATE ON company_identifiers BEGIN UPDATE source_change_counter SET version=version+1; END;
CREATE TRIGGER source_change_identifiers_delete AFTER DELETE ON company_identifiers BEGIN UPDATE source_change_counter SET version=version+1; END;
PRAGMA user_version = 7;
