-- LMS round 3: curriculum mapping is done in the CRM again and pushed to the Nipuna LMS; the LMS still owns curriculum
-- content and versions. Batches, allocation, joining dates, completion and certificates stay LMS-owned.
--
--   curriculum_versions   the LMS's catalogue, mirrored from the pull's curriculum_versions[]: track_code (a combo's
--                         track, NULL for a single course), lms_status (Draft / Active / Retired; only Active is
--                         mappable), lms_published_at. A version can now be mirrored before any student is on it.
--   admission_curricula   a mapping made in the CRM waits for the LMS: lms_sync_status Pending LMS → Confirmed (the LMS
--                         applied the event, or the pull shows the same label) or Refused (with the LMS's reason).
--                         NULL = not pushed by the CRM (mirrored from the pull, or made while the CRM owned academics).
--   lms_outbox            new event AdmissionCurriculumMapped (record key admission:<id>, version key curriculum:<id>).
--   lms_pull_state        last_reconcile_at: when the daily CRM ↔ LMS drift check last ran.
--
-- Contract: nipuna crm-docs/CRM_ROUND3_BRIEF.md and CRM_ROUND3_LMS_CHANGES.md.
-- Depends on: 029_lms_branch_events.sql

CREATE TYPE curriculum_lms_status AS ENUM ('Draft', 'Active', 'Retired');
CREATE TYPE curriculum_lms_sync AS ENUM ('Pending LMS', 'Confirmed', 'Refused');

-- ---------------------------------------------------------------------------
-- The LMS catalogue
-- ---------------------------------------------------------------------------
ALTER TABLE curriculum_versions
    ADD COLUMN track_code VARCHAR(40),
    ADD COLUMN lms_status curriculum_lms_status,
    ADD COLUMN lms_published_at TIMESTAMP WITH TIME ZONE,
    ADD CONSTRAINT curriculum_versions_lms_fields_mirrored
        CHECK (lms_mirrored OR (track_code IS NULL AND lms_status IS NULL AND lms_published_at IS NULL));

-- A combo's tracks can each have a version with the same label
ALTER TABLE curriculum_versions DROP CONSTRAINT curriculum_versions_course_id_version_label_key;
CREATE UNIQUE INDEX curriculum_versions_course_track_label
    ON curriculum_versions (course_id, track_code, version_label) NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------
-- Mappings pushed to the LMS
-- ---------------------------------------------------------------------------
ALTER TABLE admission_curricula
    ADD COLUMN lms_sync_status curriculum_lms_sync,
    ADD COLUMN lms_outbox_id BIGINT REFERENCES lms_outbox(outbox_id) ON DELETE SET NULL,  -- the event that sent it
    ADD COLUMN mapping_reason TEXT,              -- required by the API when an existing mapping is changed
    ADD COLUMN lms_refusal_reason TEXT,
    ADD COLUMN lms_confirmed_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN lms_resent_at TIMESTAMP WITH TIME ZONE,  -- sent again once when the LMS still showed Mapping Pending
    ADD CONSTRAINT admission_curricula_refusal_has_reason
        CHECK (lms_sync_status IS DISTINCT FROM 'Refused' OR lms_refusal_reason IS NOT NULL),
    ADD CONSTRAINT admission_curricula_confirmed_has_time
        CHECK (lms_sync_status IS DISTINCT FROM 'Confirmed' OR lms_confirmed_at IS NOT NULL);

CREATE INDEX admission_curricula_pending_idx ON admission_curricula (admission_id) WHERE lms_sync_status = 'Pending LMS';

-- A refused mapping is kept to show the reason, but it doesn't make the curriculum Mapped
CREATE OR REPLACE FUNCTION check_curriculum_mapped() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM admission_curricula WHERE admission_id = NEW.admission_id
                                                     AND lms_sync_status IS DISTINCT FROM 'Refused') THEN
        RAISE EXCEPTION 'Map a curriculum version before marking curriculum as Mapped';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The daily drift check (job lms-reconcile) runs once per business day
ALTER TABLE lms_pull_state ADD COLUMN last_reconcile_at TIMESTAMP WITH TIME ZONE;

-- ---------------------------------------------------------------------------
-- The new outbox event
-- ---------------------------------------------------------------------------
ALTER TABLE lms_outbox DROP CONSTRAINT lms_outbox_event_type_valid;
ALTER TABLE lms_outbox ADD CONSTRAINT lms_outbox_event_type_valid CHECK (event_type IN (
    'CourseUpserted', 'AdmissionQualified', 'AdmissionUpdated', 'AdmissionCancelled', 'FinanceSummaryUpdated',
    'BranchUpserted', 'BranchFinanceSnapshot', 'AdmissionCurriculumMapped'));
