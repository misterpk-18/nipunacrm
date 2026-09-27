-- Phase 4: academics (batches, allocations, transfers, documents, certificates, LMS identity)
-- Depends on: 005_phase3_admission_money.sql

-- ---------------------------------------------------------------------------
-- LMS identity: one Person = one Student Master / LMS account
-- ---------------------------------------------------------------------------
ALTER TABLE persons
    ADD COLUMN lms_user_id VARCHAR(100) UNIQUE,
    ADD COLUMN lms_provisioned_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE admissions
    ADD COLUMN lms_last_synced_at TIMESTAMP WITH TIME ZONE,   -- last successful update from the LMS
    ADD COLUMN lms_last_activity_at TIMESTAMP WITH TIME ZONE; -- NULL = student hasn't started

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE batch_status AS ENUM ('Planned', 'Open', 'In Progress', 'Completed', 'Cancelled');

CREATE TYPE allocation_status AS ENUM ('Active', 'Moved', 'Withdrawn', 'Completed');

CREATE TYPE document_status AS ENUM ('Review Required', 'Verified', 'Rejected');

CREATE TYPE certificate_status AS ENUM ('Eligibility Pending', 'Eligible', 'Not Eligible', 'Issued', 'Revoked');

-- ---------------------------------------------------------------------------
-- Batches
-- ---------------------------------------------------------------------------
CREATE TABLE batches (
    batch_id SERIAL PRIMARY KEY,
    batch_code VARCHAR(30) UNIQUE NOT NULL,         -- e.g., 'GNT-B-0001' (auto-generated)
    batch_name VARCHAR(150) NOT NULL,               -- e.g., 'Data Science · Weekend Morning'
    course_id INT NOT NULL REFERENCES courses(course_id),   -- a standalone course, never a combo
    branch_id INT NOT NULL REFERENCES branches(branch_id),
    delivery_mode delivery_mode NOT NULL DEFAULT 'Classroom',
    trainer_user_id INT REFERENCES users(user_id),
    schedule_days VARCHAR(50),                      -- e.g., 'Sat, Sun'
    start_time TIME,
    end_time TIME,
    start_date DATE NOT NULL,
    end_date DATE,
    capacity SMALLINT NOT NULL CHECK (capacity > 0),
    status batch_status NOT NULL DEFAULT 'Planned',
    lms_course_id VARCHAR(100),                     -- matching course/cohort in the LMS
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CHECK (end_date IS NULL OR end_date >= start_date),
    CHECK (start_time IS NULL OR end_time IS NULL OR end_time > start_time)
);

CREATE INDEX batches_course_branch_status_idx ON batches (course_id, branch_id, status);
CREATE INDEX batches_trainer_idx ON batches (trainer_user_id);

CREATE OR REPLACE FUNCTION before_batch_insert() RETURNS trigger AS $$
DECLARE
    v_prefix VARCHAR;
BEGIN
    IF (SELECT is_combo FROM courses WHERE course_id = NEW.course_id) THEN
        RAISE EXCEPTION 'Batches run standalone courses; create one batch per course in the combo';
    END IF;

    IF NEW.batch_code IS NULL THEN
        SELECT receipt_prefix INTO v_prefix FROM branches WHERE branch_id = NEW.branch_id;
        NEW.batch_code = v_prefix || '-B-' || LPAD(next_number('BATCH-' || v_prefix)::TEXT, 4, '0');
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_batches_before_insert
    BEFORE INSERT ON batches
    FOR EACH ROW EXECUTE FUNCTION before_batch_insert();

CREATE TRIGGER trg_batches_updated_at
    BEFORE UPDATE ON batches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Batch allocations: admission -> batch. A combo admission gets one active
-- allocation per component course. Moving batch = close old row, add new one.
-- ---------------------------------------------------------------------------
CREATE TABLE batch_allocations (
    allocation_id SERIAL PRIMARY KEY,
    admission_id INT NOT NULL REFERENCES admissions(admission_id),
    batch_id INT NOT NULL REFERENCES batches(batch_id),
    course_id INT NOT NULL REFERENCES courses(course_id),  -- copied from the batch
    status allocation_status NOT NULL DEFAULT 'Active',
    joining_date DATE,                              -- first confirmed regular class (demos excluded)
    allocated_by INT REFERENCES users(user_id),
    allocated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP WITH TIME ZONE,
    end_reason TEXT,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT batch_allocations_end_recorded
        CHECK (status = 'Active' OR ended_at IS NOT NULL)
);

-- One active batch per admission per course
CREATE UNIQUE INDEX batch_allocations_one_active
    ON batch_allocations (admission_id, course_id) WHERE status = 'Active';
CREATE INDEX batch_allocations_batch_idx ON batch_allocations (batch_id, status);

CREATE OR REPLACE FUNCTION before_allocation_insert() RETURNS trigger AS $$
DECLARE
    v_batch batches%ROWTYPE;
    v_admission admissions%ROWTYPE;
    v_taken INT;
BEGIN
    -- Lock the batch so two coordinators can't fill the last seat at once
    SELECT * INTO v_batch FROM batches WHERE batch_id = NEW.batch_id FOR UPDATE;
    SELECT * INTO v_admission FROM admissions WHERE admission_id = NEW.admission_id;

    NEW.course_id = v_batch.course_id;

    IF v_admission.enrolment_status = 'Cancelled' THEN
        RAISE EXCEPTION 'Admission % is cancelled', v_admission.admission_code;
    END IF;

    IF v_batch.status IN ('Completed', 'Cancelled') THEN
        RAISE EXCEPTION 'Batch % is %', v_batch.batch_code, v_batch.status;
    END IF;

    -- Batch course must be the admission's course, or one of its combo components
    IF v_batch.course_id <> v_admission.course_id AND NOT EXISTS (
        SELECT 1 FROM combo_courses
        WHERE combo_course_id = v_admission.course_id AND component_course_id = v_batch.course_id
    ) THEN
        RAISE EXCEPTION 'Batch % is for a course that is not part of admission %',
            v_batch.batch_code, v_admission.admission_code;
    END IF;

    IF NEW.status = 'Active' THEN
        SELECT COUNT(*) INTO v_taken FROM batch_allocations WHERE batch_id = NEW.batch_id AND status = 'Active';
        IF v_taken >= v_batch.capacity THEN
            RAISE EXCEPTION 'Batch % is full (% of % seats)', v_batch.batch_code, v_taken, v_batch.capacity;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_batch_allocations_before_insert
    BEFORE INSERT ON batch_allocations
    FOR EACH ROW EXECUTE FUNCTION before_allocation_insert();

CREATE OR REPLACE FUNCTION prevent_allocation_rebind() RETURNS trigger AS $$
BEGIN
    IF (NEW.admission_id, NEW.batch_id, NEW.course_id) IS DISTINCT FROM (OLD.admission_id, OLD.batch_id, OLD.course_id) THEN
        RAISE EXCEPTION 'To change batch, close this allocation and create a new one';
    END IF;
    IF OLD.status <> 'Active' AND NEW.status = 'Active' THEN
        RAISE EXCEPTION 'A closed allocation cannot be reopened; create a new one';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_batch_allocations_no_rebind
    BEFORE UPDATE ON batch_allocations
    FOR EACH ROW EXECUTE FUNCTION prevent_allocation_rebind();

CREATE TRIGGER trg_batch_allocations_updated_at
    BEFORE UPDATE ON batch_allocations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Keep the admission's enrolment status moving forward:
--   first allocation      -> Scheduled   (from Awaiting Batch Allocation)
--   first joining date    -> In Progress (from Awaiting Batch Allocation / Scheduled)
CREATE OR REPLACE FUNCTION sync_enrolment_from_allocation() RETURNS trigger AS $$
BEGIN
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

CREATE TRIGGER trg_batch_allocations_sync_insert
    AFTER INSERT ON batch_allocations
    FOR EACH ROW EXECUTE FUNCTION sync_enrolment_from_allocation();

CREATE TRIGGER trg_batch_allocations_sync_joining
    AFTER UPDATE OF joining_date ON batch_allocations
    FOR EACH ROW WHEN (OLD.joining_date IS NULL AND NEW.joining_date IS NOT NULL)
    EXECUTE FUNCTION sync_enrolment_from_allocation();

-- ---------------------------------------------------------------------------
-- Admission transfers: service branch history (original branch never changes)
-- ---------------------------------------------------------------------------
CREATE TABLE admission_transfers (
    transfer_id SERIAL PRIMARY KEY,
    admission_id INT NOT NULL REFERENCES admissions(admission_id),
    from_branch_id INT NOT NULL REFERENCES branches(branch_id),
    to_branch_id INT NOT NULL REFERENCES branches(branch_id),
    effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
    reason TEXT NOT NULL,
    requested_by INT REFERENCES users(user_id),
    approved_by INT NOT NULL REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT admission_transfers_different_branch
        CHECK (from_branch_id <> to_branch_id)
);

CREATE INDEX admission_transfers_admission_idx ON admission_transfers (admission_id);

-- from_branch is always the admission's current service branch; then move it
CREATE OR REPLACE FUNCTION before_transfer_insert() RETURNS trigger AS $$
BEGIN
    SELECT service_branch_id INTO NEW.from_branch_id
    FROM admissions WHERE admission_id = NEW.admission_id FOR UPDATE;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_admission_transfers_before_insert
    BEFORE INSERT ON admission_transfers
    FOR EACH ROW EXECUTE FUNCTION before_transfer_insert();

CREATE OR REPLACE FUNCTION after_transfer_insert() RETURNS trigger AS $$
BEGIN
    UPDATE admissions SET service_branch_id = NEW.to_branch_id WHERE admission_id = NEW.admission_id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_admission_transfers_after_insert
    AFTER INSERT ON admission_transfers
    FOR EACH ROW EXECUTE FUNCTION after_transfer_insert();

-- ---------------------------------------------------------------------------
-- Documents (identity proof etc.). Files live in storage; the DB keeps the path.
-- ---------------------------------------------------------------------------
CREATE TABLE document_types (
    document_type_id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    label VARCHAR(100) NOT NULL,
    is_mandatory BOOLEAN NOT NULL DEFAULT FALSE,    -- required for every admitted student
    sort_order SMALLINT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO document_types (code, label, is_mandatory, sort_order) VALUES
    ('IDENTITY_PROOF', 'Identity proof', TRUE, 1),
    ('PHOTO', 'Photograph', FALSE, 2),
    ('ADDRESS_PROOF', 'Address proof', FALSE, 3),
    ('EDUCATION_CERTIFICATE', 'Education certificate', FALSE, 4);

CREATE TABLE documents (
    document_id SERIAL PRIMARY KEY,
    person_id INT NOT NULL REFERENCES persons(person_id),
    admission_id INT REFERENCES admissions(admission_id), -- NULL for person-level documents like ID
    document_type_id INT NOT NULL REFERENCES document_types(document_type_id),
    status document_status NOT NULL DEFAULT 'Review Required',
    file_path VARCHAR(500) NOT NULL,                -- storage key / URL
    original_filename VARCHAR(255),
    mime_type VARCHAR(100),
    file_size_bytes INT CHECK (file_size_bytes >= 0),
    uploaded_by INT REFERENCES users(user_id),
    uploaded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_by INT REFERENCES users(user_id),
    reviewed_at TIMESTAMP WITH TIME ZONE,
    rejection_reason TEXT,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT documents_review_recorded
        CHECK (status = 'Review Required' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
    CONSTRAINT documents_rejection_reason
        CHECK (status <> 'Rejected' OR rejection_reason IS NOT NULL)
);

-- Re-upload is allowed only after a rejection
CREATE UNIQUE INDEX documents_one_live_per_type
    ON documents (person_id, document_type_id, COALESCE(admission_id, 0)) WHERE status <> 'Rejected';
CREATE INDEX documents_review_queue_idx ON documents (status) WHERE status = 'Review Required';

CREATE OR REPLACE FUNCTION stamp_document_review() RETURNS trigger AS $$
BEGIN
    NEW.reviewed_at = COALESCE(NEW.reviewed_at, CURRENT_TIMESTAMP);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_documents_review
    BEFORE UPDATE OF status ON documents
    FOR EACH ROW WHEN (NEW.status <> 'Review Required' AND OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION stamp_document_review();

CREATE TRIGGER trg_documents_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Certificates: one per admission per course (combo = one per component, if needed)
-- ---------------------------------------------------------------------------
CREATE TABLE certificates (
    certificate_id SERIAL PRIMARY KEY,
    certificate_number VARCHAR(30) UNIQUE,          -- assigned on issue, e.g., 'GNT-C-2627-00001'
    admission_id INT NOT NULL REFERENCES admissions(admission_id),
    course_id INT NOT NULL REFERENCES courses(course_id),
    status certificate_status NOT NULL DEFAULT 'Eligibility Pending',
    eligibility_notes TEXT,                         -- rules pending (Module 22); record the basis here
    file_path VARCHAR(500),
    issued_by INT REFERENCES users(user_id),
    issued_at TIMESTAMP WITH TIME ZONE,
    revoked_by INT REFERENCES users(user_id),
    revoked_at TIMESTAMP WITH TIME ZONE,
    revoke_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT certificates_issue_recorded
        CHECK (status NOT IN ('Issued', 'Revoked')
               OR (certificate_number IS NOT NULL AND issued_by IS NOT NULL AND issued_at IS NOT NULL)),
    CONSTRAINT certificates_revoke_recorded
        CHECK (status <> 'Revoked' OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);

CREATE UNIQUE INDEX certificates_one_live_per_course
    ON certificates (admission_id, course_id) WHERE status <> 'Revoked';

-- On issue: number by service branch + financial year, stamp issued_at
CREATE OR REPLACE FUNCTION before_certificate_issue() RETURNS trigger AS $$
DECLARE
    v_prefix VARCHAR;
    v_fy TEXT := fy_code(CURRENT_DATE);
BEGIN
    IF (TG_OP = 'UPDATE' AND OLD.status IN ('Issued', 'Revoked')) THEN
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

CREATE TRIGGER trg_certificates_issue_insert
    BEFORE INSERT ON certificates
    FOR EACH ROW WHEN (NEW.status = 'Issued')
    EXECUTE FUNCTION before_certificate_issue();

CREATE TRIGGER trg_certificates_issue_update
    BEFORE UPDATE OF status ON certificates
    FOR EACH ROW WHEN (NEW.status = 'Issued' AND OLD.status IS DISTINCT FROM 'Issued')
    EXECUTE FUNCTION before_certificate_issue();

CREATE TRIGGER trg_certificates_updated_at
    BEFORE UPDATE ON certificates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
CREATE VIEW batch_occupancy AS
SELECT
    b.batch_id,
    b.batch_code,
    b.batch_name,
    b.course_id,
    b.branch_id,
    b.status,
    b.start_date,
    b.capacity,
    COUNT(a.allocation_id) AS allocated,
    b.capacity - COUNT(a.allocation_id) AS seats_left
FROM batches b
LEFT JOIN batch_allocations a ON a.batch_id = b.batch_id AND a.status = 'Active'
GROUP BY b.batch_id;

-- Every admitted person x every mandatory document type, with current state
CREATE VIEW document_checklist AS
SELECT
    p.person_id,
    p.person_code,
    t.document_type_id,
    t.label AS document_type,
    COALESCE(d.status::TEXT, 'Not Uploaded') AS status,
    d.document_id,
    d.uploaded_at
FROM persons p
CROSS JOIN document_types t
LEFT JOIN LATERAL (
    SELECT * FROM documents d
    WHERE d.person_id = p.person_id AND d.document_type_id = t.document_type_id
    ORDER BY (d.status = 'Rejected'), d.uploaded_at DESC
    LIMIT 1
) d ON TRUE
WHERE t.is_mandatory AND t.is_active
  AND EXISTS (SELECT 1 FROM admissions a WHERE a.person_id = p.person_id);
