-- LMS status pull (round 2): the CRM mirrors what the Nipuna LMS owns — the student's LMS login and status, enrolment
-- and curriculum status, batches, batch allocations, academic completion and the certificate register.
-- The CRM reads GET {LMS}/api/v1/integrations/crm/status?since=… (services/lms_pull.py, job lms-status-pull) and writes
-- each record in a transaction that has set app.sync_source = 'LMS'. Those writes are facts already checked by the LMS:
-- the allocation, batch, certificate and enrolment triggers below let them through unchanged. Every other writer still
-- gets the CRM's own rules. Contract: LMS repo docs/CRM_INTEGRATION.md §2.2, nipuna crm-docs/CRM_ROUND2_LMS_REPLY.md.
-- Depends on: 027_lms_pull_enums.sql

-- ---------------------------------------------------------------------------
-- The sync session
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lms_sync_session() RETURNS BOOLEAN AS $$
    SELECT COALESCE(current_setting('app.sync_source', TRUE), '') = 'LMS';
$$ LANGUAGE sql STABLE;

-- Who owns academics. On: batches, allocation, joining date, curriculum, completion and certificates are read-only in
-- the CRM (the API refuses them) and come from the LMS pull. Off: the CRM's own academic screens work as before.
INSERT INTO app_settings (setting_key, setting_value, description) VALUES
    ('academics_managed_in_lms', 'true',
     'Batches, allocations, joining dates, curriculum, completion and certificates are managed in the Nipuna LMS and mirrored into the CRM (read-only here)')
ON CONFLICT (setting_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Pull watermark (one row) and held records
-- ---------------------------------------------------------------------------
CREATE TABLE lms_pull_state (
    pull_state_id SMALLINT PRIMARY KEY DEFAULT 1,
    since TEXT NOT NULL DEFAULT '1970-01-01T00:00:00+00:00',   -- the LMS's last as_of, exactly as returned
    last_attempt_at TIMESTAMP WITH TIME ZONE,
    last_success_at TIMESTAMP WITH TIME ZONE,                  -- shown as "last synced" on LMS access
    last_http_status SMALLINT,
    last_error TEXT,
    last_counts JSONB,
    locked_until TIMESTAMP WITH TIME ZONE,                     -- a running pull's claim, so two runs never overlap
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT lms_pull_state_single_row CHECK (pull_state_id = 1)
);

INSERT INTO lms_pull_state (pull_state_id) VALUES (1);

CREATE TRIGGER trg_lms_pull_state_updated_at BEFORE UPDATE ON lms_pull_state
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A pulled record that couldn't be applied yet (e.g. an allocation to a batch the pull never sent): kept with its full
-- state and retried on every pull until it applies. A newer copy of the same record replaces the held one.
CREATE TABLE lms_pull_holds (
    record_key VARCHAR(60) PRIMARY KEY,            -- 'academics:<crm admission id>', 'certificates:<number>/<version>' …
    payload JSONB NOT NULL,
    reason TEXT NOT NULL,
    attempts INT NOT NULL DEFAULT 1,
    first_held_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_tried_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_lms_pull_holds_updated_at BEFORE UPDATE ON lms_pull_holds
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Admissions: no Deferred; completion authorised in the LMS
-- ---------------------------------------------------------------------------
-- The LMS has no Deferred status and the pull overwrites enrolment_status, so the value is refused (it stays in the
-- enum type only because retyping the column would mean rebuilding every view on admissions). A student who must wait
-- is paused (POST /admissions/{id}/pause).
ALTER TABLE admissions
    ADD CONSTRAINT admissions_no_deferred CHECK (enrolment_status <> 'Deferred');

-- The LMS reports the Academic Coordinator who decided the completion by email; a CRM user id when one matches.
ALTER TABLE admissions
    ADD COLUMN completion_authorised_by_email VARCHAR(255),
    DROP CONSTRAINT admissions_completion_authorised,
    ADD CONSTRAINT admissions_completion_authorised
        CHECK (enrolment_status <> 'Completed' OR completion_authorised_by IS NOT NULL
               OR completion_authorised_by_email IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Curriculum versions mirrored from the LMS (matched by course + label)
-- ---------------------------------------------------------------------------
-- The LMS can run several versions of a course at once (older enrolments keep theirs), so mirrored versions don't take
-- part in the CRM's one-published-per-course rule and have no CRM publisher.
ALTER TABLE curriculum_versions
    ADD COLUMN lms_mirrored BOOLEAN NOT NULL DEFAULT FALSE,
    DROP CONSTRAINT curriculum_versions_published_recorded,
    ADD CONSTRAINT curriculum_versions_published_recorded
        CHECK (status <> 'Published' OR lms_mirrored OR (published_by IS NOT NULL AND published_at IS NOT NULL));

DROP INDEX curriculum_versions_one_published;
CREATE UNIQUE INDEX curriculum_versions_one_published
    ON curriculum_versions (course_id) WHERE status = 'Published' AND NOT lms_mirrored;

-- ---------------------------------------------------------------------------
-- Batches mirrored from the LMS (lms_course_id = the LMS batch_code)
-- ---------------------------------------------------------------------------
ALTER TABLE batches
    ADD COLUMN lms_mirrored BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN lead_trainer_email VARCHAR(255),          -- trainer_user_id is set when a CRM user has this email
    ADD COLUMN trainer_emails TEXT[] NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX batches_lms_course_id_key ON batches (lms_course_id) WHERE lms_course_id IS NOT NULL;

-- The LMS allocates a combo's tracks to batches of the combo course itself; only the CRM's own batches stay
-- standalone-only.
CREATE OR REPLACE FUNCTION before_batch_insert() RETURNS trigger AS $$
DECLARE
    v_prefix VARCHAR;
BEGIN
    IF NOT lms_sync_session() AND (SELECT is_combo FROM courses WHERE course_id = NEW.course_id) THEN
        RAISE EXCEPTION 'Batches run standalone courses; create one batch per course in the combo';
    END IF;

    IF NEW.batch_code IS NULL THEN
        SELECT receipt_prefix INTO v_prefix FROM branches WHERE branch_id = NEW.branch_id;
        NEW.batch_code = v_prefix || '-B-' || LPAD(next_number('BATCH-' || v_prefix)::TEXT, 4, '0');
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Batch allocations: one per combo track; mirrored rows keyed like the LMS
-- ---------------------------------------------------------------------------
ALTER TABLE batch_allocations
    ADD COLUMN track_code VARCHAR(60),                   -- LMS combo track (e.g. NIT-CRS-900/T1); NULL for a single course
    ADD COLUMN lms_allocated_on DATE,                    -- the LMS allocated_on (part of the mirror key)
    ADD COLUMN lms_mirrored BOOLEAN NOT NULL DEFAULT FALSE;

-- One active allocation per admission and track (two tracks of a combo can share a course)
DROP INDEX batch_allocations_one_active;
CREATE UNIQUE INDEX batch_allocations_one_active
    ON batch_allocations (admission_id, course_id, COALESCE(track_code, '')) WHERE status = 'Active';

CREATE UNIQUE INDEX batch_allocations_lms_key
    ON batch_allocations (admission_id, course_id, COALESCE(track_code, ''), batch_id, lms_allocated_on)
    WHERE lms_mirrored;

-- Mirrored rows keep the course the LMS names (a combo track's component course) and skip the CRM's checks.
CREATE OR REPLACE FUNCTION before_allocation_insert() RETURNS trigger AS $$
DECLARE
    v_batch batches%ROWTYPE;
    v_admission admissions%ROWTYPE;
    v_taken INT;
BEGIN
    IF lms_sync_session() THEN
        NEW.course_id = COALESCE(NEW.course_id, (SELECT course_id FROM batches WHERE batch_id = NEW.batch_id));
        RETURN NEW;
    END IF;

    SELECT * INTO v_batch FROM batches WHERE batch_id = NEW.batch_id FOR UPDATE;
    SELECT * INTO v_admission FROM admissions WHERE admission_id = NEW.admission_id;
    NEW.course_id = v_batch.course_id;

    IF v_admission.enrolment_status IN ('Cancelled', 'Paused', 'Completed') THEN
        RAISE EXCEPTION 'Enrolment of % is %; allocation blocked', v_admission.admission_code, v_admission.enrolment_status;
    END IF;
    IF v_batch.status IN ('Completed', 'Cancelled') THEN
        RAISE EXCEPTION 'Batch % is %', v_batch.batch_code, v_batch.status;
    END IF;
    IF v_batch.branch_id <> v_admission.service_branch_id THEN
        RAISE EXCEPTION 'Wrong branch: batch % is not at the student''s service branch. Cross-branch allocation is never automatic',
            v_batch.batch_code;
    END IF;
    IF v_batch.course_id <> v_admission.course_id AND NOT EXISTS (
        SELECT 1 FROM combo_courses WHERE combo_course_id = v_admission.course_id AND component_course_id = v_batch.course_id
    ) THEN
        RAISE EXCEPTION 'Batch % is for a course that is not part of admission %', v_batch.batch_code, v_admission.admission_code;
    END IF;
    IF v_admission.curriculum_status <> 'Mapped' THEN
        RAISE EXCEPTION 'Curriculum Mapping Pending — map a published curriculum version to % first', v_admission.admission_code;
    END IF;
    IF v_batch.curriculum_version_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM admission_curricula WHERE admission_id = NEW.admission_id AND curriculum_version_id = v_batch.curriculum_version_id
    ) THEN
        RAISE EXCEPTION 'Batch % follows a different curriculum version than the one mapped to %', v_batch.batch_code, v_admission.admission_code;
    END IF;
    IF NEW.status = 'Active' THEN
        SELECT COUNT(*) INTO v_taken FROM batch_allocations WHERE batch_id = NEW.batch_id AND status = 'Active';
        IF v_taken >= v_batch.capacity THEN
            RAISE EXCEPTION 'Full capacity: batch % has % of % seats taken', v_batch.batch_code, v_taken, v_batch.capacity;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_allocation_rebind() RETURNS trigger AS $$
BEGIN
    IF lms_sync_session() THEN
        RETURN NEW;                                       -- the LMS's record is the truth
    END IF;
    IF (NEW.admission_id, NEW.batch_id, NEW.course_id) IS DISTINCT FROM (OLD.admission_id, OLD.batch_id, OLD.course_id) THEN
        RAISE EXCEPTION 'To change batch, close this allocation and create a new one';
    END IF;
    IF OLD.status <> 'Active' AND NEW.status = 'Active' THEN
        RAISE EXCEPTION 'A closed allocation cannot be reopened; create a new one';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The mirrored enrolment status comes with the allocations; don't move it here
CREATE OR REPLACE FUNCTION sync_enrolment_from_allocation() RETURNS trigger AS $$
BEGIN
    IF lms_sync_session() THEN
        RETURN NULL;
    END IF;

    IF NEW.status = 'Active' THEN
        UPDATE admissions SET enrolment_status = 'Scheduled'
        WHERE admission_id = NEW.admission_id AND enrolment_status = 'Awaiting Batch Allocation';
    END IF;

    IF NEW.joining_date IS NOT NULL THEN
        UPDATE admissions SET enrolment_status = 'In Progress'
        WHERE admission_id = NEW.admission_id
          AND enrolment_status IN ('Awaiting Batch Allocation', 'Scheduled');
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Certificates: the LMS register (number + version; Issued / Superseded / Revoked)
-- ---------------------------------------------------------------------------
ALTER TABLE certificates
    ADD COLUMN version SMALLINT NOT NULL DEFAULT 1,
    ADD COLUMN certificate_type VARCHAR(60),             -- LMS: Course Completion Certificate · Internship Certificate
    ADD COLUMN holder_name VARCHAR(150),
    ADD COLUMN enrolment_code VARCHAR(30),               -- the LMS enrolment
    ADD COLUMN issued_by_email VARCHAR(255),
    ADD COLUMN revoked_by_email VARCHAR(255),
    ADD COLUMN reissue_reason TEXT,                      -- why this version exists (a reissue)
    ADD COLUMN supersedes_version SMALLINT,
    ADD COLUMN lms_changed_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN lms_mirrored BOOLEAN NOT NULL DEFAULT FALSE,
    ADD CONSTRAINT certificates_version_check CHECK (version > 0),
    DROP CONSTRAINT certificates_certificate_number_key,
    ADD CONSTRAINT certificates_number_version_key UNIQUE (certificate_number, version),
    DROP CONSTRAINT certificates_issue_recorded,
    ADD CONSTRAINT certificates_issue_recorded
        CHECK (status NOT IN ('Issued', 'Superseded', 'Revoked')
               OR (certificate_number IS NOT NULL AND issued_at IS NOT NULL AND (issued_by IS NOT NULL OR lms_mirrored))),
    DROP CONSTRAINT certificates_revoke_recorded,
    ADD CONSTRAINT certificates_revoke_recorded
        CHECK (status <> 'Revoked'
               OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL AND (revoked_by IS NOT NULL OR lms_mirrored)));

-- One live certificate per admission, course and type
DROP INDEX certificates_one_live_per_course;
CREATE UNIQUE INDEX certificates_one_live_per_course
    ON certificates (admission_id, course_id, COALESCE(certificate_type, '')) WHERE status NOT IN ('Revoked', 'Superseded');

-- Mirrored certificates keep the LMS number and dates
CREATE OR REPLACE FUNCTION before_certificate_issue() RETURNS trigger AS $$
DECLARE
    v_prefix VARCHAR;
    v_fy TEXT := fy_code(CURRENT_DATE);
BEGIN
    IF lms_sync_session() THEN
        RETURN NEW;
    END IF;

    IF (TG_OP = 'UPDATE' AND OLD.status IN ('Issued', 'Revoked', 'Superseded')) THEN
        RAISE EXCEPTION 'Certificate % is already %', OLD.certificate_number, OLD.status;
    END IF;

    IF NEW.certificate_number IS NULL THEN
        SELECT b.receipt_prefix INTO v_prefix
        FROM admissions a JOIN branches b ON b.branch_id = a.service_branch_id
        WHERE a.admission_id = NEW.admission_id;
        NEW.certificate_number = v_prefix || '-C-' || v_fy || '-'
            || LPAD(next_number('CERTIFICATE-' || v_prefix || '-' || v_fy)::TEXT, 5, '0');
    END IF;
    NEW.issued_at = COALESCE(NEW.issued_at, CURRENT_TIMESTAMP);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
