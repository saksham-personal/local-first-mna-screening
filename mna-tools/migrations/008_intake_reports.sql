-- Phase 1: Intake Form storage, approved core-business exclusions, PitchBook/ROGO
-- match reports, de-duplicated identity quarantine and one current PBID per company.
--
-- Applied once, atomically, by Store::open (guarded on criteria_revisions.intake_form_json).
-- Criteria revisions stay immutable for UPDATE/DELETE; ADD COLUMN and INSERT are unaffected
-- by the immutability triggers. Existing rows receive the column defaults below.
ALTER TABLE criteria_revisions ADD COLUMN intake_form_json TEXT CHECK(intake_form_json IS NULL OR json_valid(intake_form_json));
ALTER TABLE criteria_revisions ADD COLUMN core_business_exclusions_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(core_business_exclusions_json));

CREATE TABLE IF NOT EXISTS enrichment_import_reports (
    report_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES screening_runs(run_id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('pitchbook','rogo')),
    files_json TEXT NOT NULL CHECK(json_valid(files_json)),
    summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
    matched_json TEXT NOT NULL CHECK(json_valid(matched_json)),
    not_matched_json TEXT NOT NULL CHECK(json_valid(not_matched_json)),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS enrichment_import_reports_run ON enrichment_import_reports(run_id, purpose, created_at);

-- Re-imports must not inflate quarantine. content_hash is a SHA-256 of source, reason and row
-- text. Existing rows start NULL (NULLs never collide in a unique index); Store::open then
-- computes the hashes, deleting earlier duplicates, before any new quarantine insert runs.
ALTER TABLE identity_quarantine ADD COLUMN content_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS identity_quarantine_content_hash ON identity_quarantine(content_hash);

-- One current PBID per company. Keep the newest identifier (latest first_seen_at, then the
-- greater identifier as a deterministic tie-break) before enforcing the invariant.
DELETE FROM company_identifiers
WHERE kind='PBID' AND EXISTS (
    SELECT 1 FROM company_identifiers newer
    WHERE newer.kind='PBID' AND newer.company_id=company_identifiers.company_id
      AND (newer.first_seen_at>company_identifiers.first_seen_at
           OR (newer.first_seen_at=company_identifiers.first_seen_at AND newer.identifier>company_identifiers.identifier))
);
CREATE UNIQUE INDEX IF NOT EXISTS company_one_current_pbid ON company_identifiers(company_id) WHERE kind='PBID';

PRAGMA user_version = 8;
