-- Phase 6: management & extras (settings, shifts/SLA, targets, alumni, placement, admin)
-- Depends on: 007_phase5_operations.sql

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE target_status AS ENUM ('Draft', 'Approved', 'Superseded');

CREATE TYPE employment_type AS ENUM ('Full-time', 'Part-time', 'Internship', 'Contract');

CREATE TYPE work_mode AS ENUM ('On-site', 'Hybrid', 'Remote');

CREATE TYPE job_status AS ENUM ('Review Required', 'Open', 'On Hold', 'Closed', 'Filled');

CREATE TYPE placement_readiness AS ENUM ('Not Yet Assessed', 'In Preparation', 'Ready', 'Not Seeking');

CREATE TYPE cv_review_status AS ENUM ('No CV', 'Review Pending', 'Approved', 'Changes Requested');

CREATE TYPE consent_status AS ENUM ('Not Recorded', 'Explicit Consent', 'Withdrawn');

CREATE TYPE evidence_status AS ENUM ('Student Reported', 'Verification Pending', 'Verified');

CREATE TYPE application_stage AS ENUM (
    'Applied', 'Shortlisted', 'Interview Scheduled', 'Interview Attended', 'Selected',
    'Offer Received', 'Offer Accepted', 'Joined',
    'Rejected', 'Withdrawn', 'Offer Declined'
);

CREATE TYPE application_event_type AS ENUM (
    'Stage Change', 'Interview Scheduled', 'Interview No-show', 'Note', 'Evidence Added'
);

CREATE TYPE integration_state AS ENUM ('Planned', 'Manual', 'Configured', 'Live', 'Disabled');

CREATE TYPE verification_state AS ENUM ('Pending Verification', 'Verified', 'Failed');

CREATE TYPE incident_severity AS ENUM ('Not Set', 'Low', 'Medium', 'High', 'Critical');

CREATE TYPE incident_status AS ENUM ('Open', 'Investigating', 'Resolved', 'Closed');

CREATE TYPE report_frequency AS ENUM ('Daily', 'Weekly', 'Monthly');

CREATE TYPE report_format AS ENUM ('Excel', 'CSV', 'PDF');

-- ---------------------------------------------------------------------------
-- App settings: admin-editable values read by the app and some triggers
-- ---------------------------------------------------------------------------
CREATE TABLE app_settings (
    setting_key VARCHAR(100) PRIMARY KEY,
    setting_value JSONB NOT NULL,
    description TEXT,
    updated_by INT REFERENCES users(user_id),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_app_settings_updated_at
    BEFORE UPDATE ON app_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO app_settings (setting_key, setting_value, description) VALUES
    ('business_timezone', '"Asia/Kolkata"', 'Timezone for staffed-time and report periods'),
    ('alumni_support_months', '6', 'Standard support after academic completion'),
    ('refund_decision_target_working_days', '7', 'Refund decision target (normally 3–7 working days)'),
    ('refund_payout_target_working_days', '18', 'Payout target after approval + verified payout details'),
    ('sla_at_risk_minutes', '30', 'Minutes before an SLA deadline when an item shows At Risk');

-- ---------------------------------------------------------------------------
-- Shift / SLA configuration: when each branch is staffed
-- ---------------------------------------------------------------------------
CREATE TABLE branch_shifts (
    branch_id INT REFERENCES branches(branch_id) ON DELETE CASCADE,
    day_of_week SMALLINT CHECK (day_of_week BETWEEN 1 AND 7),   -- ISO: 1 = Monday, 7 = Sunday
    opens_at TIME NOT NULL,
    closes_at TIME NOT NULL,
    PRIMARY KEY (branch_id, day_of_week),
    CHECK (closes_at > opens_at)
);

-- Placeholder hours (Mon–Sat 09:00–19:00); replace with the real shifts
INSERT INTO branch_shifts (branch_id, day_of_week, opens_at, closes_at)
    SELECT b.branch_id, d, '09:00', '19:00' FROM branches b, generate_series(1, 6) d;

CREATE TABLE holidays (
    holiday_id SERIAL PRIMARY KEY,
    branch_id INT REFERENCES branches(branch_id),   -- NULL = all branches
    holiday_date DATE NOT NULL,
    name VARCHAR(100) NOT NULL
);

CREATE UNIQUE INDEX holidays_branch_date_key ON holidays (COALESCE(branch_id, 0), holiday_date);

-- Deadline after N staffed minutes, skipping closed hours, off days and holidays.
-- e.g., add_staffed_minutes(1, now(), 5) for the 5 staffed-minute SCR target.
CREATE OR REPLACE FUNCTION add_staffed_minutes(p_branch_id INT, p_start TIMESTAMPTZ, p_minutes INT)
RETURNS TIMESTAMPTZ AS $$
DECLARE
    v_tz TEXT := COALESCE((SELECT setting_value #>> '{}' FROM app_settings WHERE setting_key = 'business_timezone'), 'Asia/Kolkata');
    v_cursor TIMESTAMP := p_start AT TIME ZONE v_tz;   -- local wall-clock time
    v_day DATE := v_cursor::DATE;
    v_remaining INTERVAL := make_interval(mins => p_minutes);
    v_open TIMESTAMP;
    v_close TIMESTAMP;
    v_shift branch_shifts%ROWTYPE;
BEGIN
    IF p_minutes <= 0 THEN
        RETURN p_start;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM branch_shifts WHERE branch_id = p_branch_id) THEN
        RAISE EXCEPTION 'Branch % has no shifts configured', p_branch_id;
    END IF;

    FOR i IN 1..400 LOOP
        SELECT * INTO v_shift FROM branch_shifts
        WHERE branch_id = p_branch_id AND day_of_week = EXTRACT(ISODOW FROM v_day);

        IF FOUND AND NOT EXISTS (
            SELECT 1 FROM holidays
            WHERE holiday_date = v_day AND (branch_id IS NULL OR branch_id = p_branch_id)
        ) THEN
            v_open := v_day + v_shift.opens_at;
            v_close := v_day + v_shift.closes_at;
            v_cursor := GREATEST(v_cursor, v_open);
            IF v_cursor < v_close THEN
                IF v_remaining <= v_close - v_cursor THEN
                    RETURN (v_cursor + v_remaining) AT TIME ZONE v_tz;
                END IF;
                v_remaining := v_remaining - (v_close - v_cursor);
            END IF;
        END IF;

        v_day := v_day + 1;
        v_cursor := v_day::TIMESTAMP;
    END LOOP;

    RAISE EXCEPTION 'No staffed time found within 400 days for branch %', p_branch_id;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- Target Master: versions approved as a whole, one line per scope
-- ---------------------------------------------------------------------------
CREATE TABLE target_versions (
    target_version_id SERIAL PRIMARY KEY,
    version_code VARCHAR(30) UNIQUE NOT NULL,       -- e.g., 'TM-2026-10-v1' (auto-generated)
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    status target_status NOT NULL DEFAULT 'Draft',
    notes TEXT,
    approved_by INT REFERENCES users(user_id),
    approved_at TIMESTAMP WITH TIME ZONE,
    superseded_by_id INT REFERENCES target_versions(target_version_id),
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT target_versions_period CHECK (period_end >= period_start),
    CONSTRAINT target_versions_approval_recorded
        CHECK (status = 'Draft' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
    -- Only one approved version can cover any given day
    CONSTRAINT target_versions_no_overlap
        EXCLUDE USING gist (daterange(period_start, period_end, '[]') WITH &&) WHERE (status = 'Approved')
);

CREATE TABLE target_lines (
    target_version_id INT REFERENCES target_versions(target_version_id) ON DELETE CASCADE,
    branch_id INT REFERENCES branches(branch_id),   -- NULL = Company
    verified_collections_target NUMERIC(12, 2) CHECK (verified_collections_target >= 0), -- NULL = Not Set
    paid_admissions_target INT CHECK (paid_admissions_target >= 0),                      -- NULL = Not Set
    UNIQUE NULLS NOT DISTINCT (target_version_id, branch_id)
);

CREATE OR REPLACE FUNCTION before_target_version_write() RETURNS trigger AS $$
DECLARE
    v_month TEXT;
BEGIN
    IF TG_OP = 'INSERT' AND NEW.version_code IS NULL THEN
        v_month = TO_CHAR(NEW.period_start, 'YYYY-MM');
        NEW.version_code = 'TM-' || v_month || '-v' || next_number('TARGET-' || v_month);
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.status <> 'Draft' AND (NEW.period_start, NEW.period_end) IS DISTINCT FROM (OLD.period_start, OLD.period_end) THEN
            RAISE EXCEPTION 'Target version % is %; create a new version instead', OLD.version_code, OLD.status;
        END IF;
        IF OLD.status = 'Superseded' AND NEW.status <> 'Superseded' THEN
            RAISE EXCEPTION 'Target version % is superseded', OLD.version_code;
        END IF;

        -- Approving replaces any overlapping approved version (history is kept)
        IF NEW.status = 'Approved' AND OLD.status = 'Draft' THEN
            NEW.approved_at = COALESCE(NEW.approved_at, CURRENT_TIMESTAMP);
            UPDATE target_versions
            SET status = 'Superseded', superseded_by_id = NEW.target_version_id
            WHERE status = 'Approved'
              AND target_version_id <> NEW.target_version_id
              AND daterange(period_start, period_end, '[]') && daterange(NEW.period_start, NEW.period_end, '[]');
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_target_versions_before_write
    BEFORE INSERT OR UPDATE ON target_versions
    FOR EACH ROW EXECUTE FUNCTION before_target_version_write();

CREATE TRIGGER trg_target_versions_updated_at
    BEFORE UPDATE ON target_versions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Lines can only change while their version is a Draft
CREATE OR REPLACE FUNCTION prevent_target_line_change() RETURNS trigger AS $$
DECLARE
    v_status target_status;
BEGIN
    SELECT status INTO v_status FROM target_versions
    WHERE target_version_id = COALESCE(NEW.target_version_id, OLD.target_version_id);
    IF v_status <> 'Draft' THEN
        RAISE EXCEPTION 'Target lines are locked once the version is %', v_status;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_target_lines_locked
    BEFORE INSERT OR UPDATE OR DELETE ON target_lines
    FOR EACH ROW EXECUTE FUNCTION prevent_target_line_change();

-- ---------------------------------------------------------------------------
-- Alumni: authorised academic completion + support window
-- ---------------------------------------------------------------------------
ALTER TABLE admissions
    ADD COLUMN academic_completed_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN completion_authorised_by INT REFERENCES users(user_id),
    ADD COLUMN support_until DATE,
    ADD CONSTRAINT admissions_completion_authorised
        CHECK (enrolment_status <> 'Completed' OR completion_authorised_by IS NOT NULL);

CREATE OR REPLACE FUNCTION stamp_academic_completion() RETURNS trigger AS $$
DECLARE
    v_months INT := COALESCE((SELECT (setting_value #>> '{}')::INT FROM app_settings
                              WHERE setting_key = 'alumni_support_months'), 6);
BEGIN
    NEW.academic_completed_at = COALESCE(NEW.academic_completed_at, CURRENT_TIMESTAMP);
    NEW.support_until = COALESCE(NEW.support_until,
        (NEW.academic_completed_at + make_interval(months => v_months))::DATE);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_admissions_completion
    BEFORE UPDATE OF enrolment_status ON admissions
    FOR EACH ROW WHEN (NEW.enrolment_status = 'Completed' AND OLD.enrolment_status IS DISTINCT FROM 'Completed')
    EXECUTE FUNCTION stamp_academic_completion();

CREATE TABLE support_extensions (
    extension_id SERIAL PRIMARY KEY,
    admission_id INT NOT NULL REFERENCES admissions(admission_id),
    previous_until DATE NOT NULL,
    extended_until DATE NOT NULL,
    reason TEXT NOT NULL,
    approved_by INT NOT NULL REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT support_extensions_later CHECK (extended_until > previous_until)
);

CREATE INDEX support_extensions_admission_idx ON support_extensions (admission_id);

-- Only Founder / CEO or Super Admin; previous_until comes from the admission
CREATE OR REPLACE FUNCTION before_support_extension() RETURNS trigger AS $$
DECLARE
    v_role VARCHAR;
BEGIN
    SELECT r.role_code INTO v_role FROM users u JOIN roles r USING (role_id) WHERE u.user_id = NEW.approved_by;
    IF v_role IS NULL OR v_role NOT IN ('FOUNDER_CEO', 'SUPER_ADMIN') THEN
        RAISE EXCEPTION 'Support extensions need Founder / CEO or Super Admin';
    END IF;

    SELECT support_until INTO NEW.previous_until FROM admissions WHERE admission_id = NEW.admission_id FOR UPDATE;
    IF NEW.previous_until IS NULL THEN
        RAISE EXCEPTION 'Admission % has no support period yet (not completed)', NEW.admission_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_support_extensions_before_insert
    BEFORE INSERT ON support_extensions
    FOR EACH ROW EXECUTE FUNCTION before_support_extension();

CREATE OR REPLACE FUNCTION after_support_extension() RETURNS trigger AS $$
BEGIN
    UPDATE admissions SET support_until = NEW.extended_until WHERE admission_id = NEW.admission_id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_support_extensions_after_insert
    AFTER INSERT ON support_extensions
    FOR EACH ROW EXECUTE FUNCTION after_support_extension();

-- ---------------------------------------------------------------------------
-- Placement: career assistance only, no guaranteed placement
-- ---------------------------------------------------------------------------
CREATE TABLE companies (
    company_id SERIAL PRIMARY KEY,
    company_name VARCHAR(200) NOT NULL,
    industry VARCHAR(100),
    website VARCHAR(255),
    city VARCHAR(100),
    contact_name VARCHAR(150),
    contact_email VARCHAR(255),
    contact_phone VARCHAR(20),
    notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX companies_name_lower_key ON companies (LOWER(company_name));

CREATE TRIGGER trg_companies_updated_at
    BEFORE UPDATE ON companies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE job_openings (
    job_opening_id SERIAL PRIMARY KEY,
    job_code VARCHAR(20) UNIQUE NOT NULL,           -- e.g., 'JOB-00001' (auto-generated)
    company_id INT NOT NULL REFERENCES companies(company_id),
    job_title VARCHAR(200) NOT NULL,
    employment_type employment_type NOT NULL DEFAULT 'Full-time',
    location VARCHAR(150),
    work_mode work_mode NOT NULL DEFAULT 'On-site',
    branch_id INT REFERENCES branches(branch_id),   -- NULL = all branches
    required_skills TEXT,
    salary_ctc VARCHAR(100),                        -- free text: 'Not Disclosed', '3–4 LPA'
    openings_count SMALLINT CHECK (openings_count > 0),
    closing_date DATE,
    source VARCHAR(150),                            -- where the opening came from
    last_verified_at TIMESTAMP WITH TIME ZONE,
    status job_status NOT NULL DEFAULT 'Review Required',
    placement_owner_id INT REFERENCES users(user_id),
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX job_openings_status_idx ON job_openings (status);
CREATE INDEX job_openings_company_idx ON job_openings (company_id);

CREATE OR REPLACE FUNCTION set_job_code() RETURNS trigger AS $$
BEGIN
    NEW.job_code = 'JOB-' || LPAD(next_number('JOB')::TEXT, 5, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_job_openings_code
    BEFORE INSERT ON job_openings
    FOR EACH ROW WHEN (NEW.job_code IS NULL)
    EXECUTE FUNCTION set_job_code();

CREATE TRIGGER trg_job_openings_updated_at
    BEFORE UPDATE ON job_openings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE placement_profiles (
    profile_id SERIAL PRIMARY KEY,
    person_id INT UNIQUE NOT NULL REFERENCES persons(person_id),   -- one profile per person
    readiness placement_readiness NOT NULL DEFAULT 'Not Yet Assessed',
    cv_file_path VARCHAR(500),
    cv_version SMALLINT NOT NULL DEFAULT 0,
    cv_review_status cv_review_status NOT NULL DEFAULT 'No CV',
    skills TEXT,
    projects TEXT,
    qualification VARCHAR(150),
    career_gap_notes TEXT,                          -- optional
    expected_salary VARCHAR(100),                   -- optional
    preferred_location VARCHAR(150),
    preferred_mode work_mode,
    preferred_role VARCHAR(150),
    consent_status consent_status NOT NULL DEFAULT 'Not Recorded',
    consent_recorded_by INT REFERENCES users(user_id),
    consent_recorded_at TIMESTAMP WITH TIME ZONE,
    evidence_status evidence_status NOT NULL DEFAULT 'Student Reported',
    placement_owner_id INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT placement_profiles_consent_recorded
        CHECK (consent_status = 'Not Recorded' OR (consent_recorded_by IS NOT NULL AND consent_recorded_at IS NOT NULL)),
    CONSTRAINT placement_profiles_cv_file
        CHECK (cv_review_status = 'No CV' OR cv_file_path IS NOT NULL)
);

CREATE TRIGGER trg_placement_profiles_updated_at
    BEFORE UPDATE ON placement_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE job_applications (
    application_id SERIAL PRIMARY KEY,
    profile_id INT NOT NULL REFERENCES placement_profiles(profile_id),
    job_opening_id INT NOT NULL REFERENCES job_openings(job_opening_id),
    stage application_stage NOT NULL DEFAULT 'Applied',
    stage_changed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    interview_at TIMESTAMP WITH TIME ZONE,
    offer_ctc VARCHAR(100),
    joined_date DATE,
    evidence_status evidence_status NOT NULL DEFAULT 'Verification Pending',
    evidence_file_path VARCHAR(500),                -- offer letter / joining proof
    notes TEXT,
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (profile_id, job_opening_id),
    CONSTRAINT job_applications_joined_date
        CHECK (stage <> 'Joined' OR joined_date IS NOT NULL)
);

CREATE INDEX job_applications_job_stage_idx ON job_applications (job_opening_id, stage);

CREATE TABLE application_events (
    event_id BIGSERIAL PRIMARY KEY,
    application_id INT NOT NULL REFERENCES job_applications(application_id),
    event_type application_event_type NOT NULL,
    from_stage application_stage,
    to_stage application_stage,
    notes TEXT,
    evidence_file_path VARCHAR(500),
    recorded_by INT REFERENCES users(user_id),
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX application_events_application_idx ON application_events (application_id, occurred_at DESC);

-- Referral needs explicit consent; the job must be open
CREATE OR REPLACE FUNCTION before_application_insert() RETURNS trigger AS $$
BEGIN
    IF (SELECT consent_status FROM placement_profiles WHERE profile_id = NEW.profile_id) <> 'Explicit Consent' THEN
        RAISE EXCEPTION 'Explicit referral consent is required before applying on a student''s behalf';
    END IF;
    IF (SELECT status FROM job_openings WHERE job_opening_id = NEW.job_opening_id) <> 'Open' THEN
        RAISE EXCEPTION 'Job opening is not Open';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_job_applications_before_insert
    BEFORE INSERT ON job_applications
    FOR EACH ROW EXECUTE FUNCTION before_application_insert();

-- Every stage change is written to the application timeline
CREATE OR REPLACE FUNCTION log_application_stage_change() RETURNS trigger AS $$
BEGIN
    NEW.stage_changed_at = CURRENT_TIMESTAMP;
    INSERT INTO application_events (application_id, event_type, from_stage, to_stage, recorded_by)
    VALUES (NEW.application_id, 'Stage Change', OLD.stage, NEW.stage,
            NULLIF(current_setting('app.current_user_id', TRUE), '')::INT);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_job_applications_stage_change
    BEFORE UPDATE OF stage ON job_applications
    FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage)
    EXECUTE FUNCTION log_application_stage_change();

CREATE TRIGGER trg_job_applications_updated_at
    BEFORE UPDATE ON job_applications
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Admin: integration status, incident register, scheduled reports
-- ---------------------------------------------------------------------------
CREATE TABLE integration_status (
    service_code VARCHAR(50) PRIMARY KEY,
    service_name VARCHAR(100) NOT NULL,
    state integration_state NOT NULL DEFAULT 'Planned',
    verification verification_state NOT NULL DEFAULT 'Pending Verification',
    last_successful_test_at TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    updated_by INT REFERENCES users(user_id),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_integration_status_updated_at
    BEFORE UPDATE ON integration_status
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO integration_status (service_code, service_name, state, notes) VALUES
    ('WHATSAPP', 'WhatsApp branch numbers', 'Manual', 'API planned'),
    ('EMAIL', 'Branch email delivery', 'Planned', 'No successful test date'),
    ('TELEPHONY', 'Telephony', 'Planned', NULL),
    ('HDFC', 'HDFC', 'Planned', NULL),
    ('REPORT_EMAIL', 'Scheduled report email', 'Configured', 'Sending / delivery not yet verified'),
    ('LMS', 'LMS (nipunalms.com)', 'Planned', 'Last successful update unavailable');

CREATE TABLE incidents (
    incident_id SERIAL PRIMARY KEY,
    incident_code VARCHAR(20) UNIQUE NOT NULL,      -- e.g., 'IR-00001' (auto-generated)
    title VARCHAR(255) NOT NULL,
    description TEXT,
    severity incident_severity NOT NULL DEFAULT 'Not Set',
    status incident_status NOT NULL DEFAULT 'Open',
    owner_user_id INT REFERENCES users(user_id),
    detected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP WITH TIME ZONE,
    root_cause TEXT,
    backup_reference VARCHAR(255),
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT incidents_resolution_recorded
        CHECK (status NOT IN ('Resolved', 'Closed') OR resolved_at IS NOT NULL)
);

CREATE OR REPLACE FUNCTION before_incident_write() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.incident_code IS NULL THEN
        NEW.incident_code = 'IR-' || LPAD(next_number('INCIDENT')::TEXT, 5, '0');
    END IF;
    IF NEW.status IN ('Resolved', 'Closed') THEN
        NEW.resolved_at = COALESCE(NEW.resolved_at, CURRENT_TIMESTAMP);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_incidents_before_write
    BEFORE INSERT OR UPDATE ON incidents
    FOR EACH ROW EXECUTE FUNCTION before_incident_write();

CREATE TRIGGER trg_incidents_updated_at
    BEFORE UPDATE ON incidents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE scheduled_reports (
    scheduled_report_id SERIAL PRIMARY KEY,
    report_name VARCHAR(150) NOT NULL,              -- e.g., 'Management report'
    frequency report_frequency NOT NULL,
    send_time TIME NOT NULL,                        -- e.g., 08:30 IST
    period VARCHAR(50) NOT NULL,                    -- e.g., 'Previous day'
    branch_id INT REFERENCES branches(branch_id),   -- NULL = company
    recipients TEXT[] NOT NULL CHECK (cardinality(recipients) > 0),
    format report_format NOT NULL DEFAULT 'Excel',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_sent_at TIMESTAMP WITH TIME ZONE,
    last_delivery_status external_delivery_status NOT NULL DEFAULT 'Not Sent',
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_scheduled_reports_updated_at
    BEFORE UPDATE ON scheduled_reports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- Approved targets vs actuals. Collections by collecting branch and payment date
-- (net of reversals); paid admissions by original branch and first verified payment date.
CREATE VIEW target_achievement AS
SELECT
    v.version_code,
    v.period_start,
    v.period_end,
    l.branch_id,
    COALESCE(b.branch_code, 'Company') AS scope,
    l.verified_collections_target,
    c.verified_collections,
    ROUND(100.0 * c.verified_collections / NULLIF(l.verified_collections_target, 0), 1) AS collections_pct,
    l.paid_admissions_target,
    a.paid_admissions,
    ROUND(100.0 * a.paid_admissions / NULLIF(l.paid_admissions_target, 0), 1) AS admissions_pct
FROM target_versions v
JOIN target_lines l USING (target_version_id)
LEFT JOIN branches b ON b.branch_id = l.branch_id
CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(p.amount), 0) AS verified_collections
    FROM payments p
    WHERE p.verification_status = 'Verified'
      AND p.payment_date BETWEEN v.period_start AND v.period_end
      AND (l.branch_id IS NULL OR p.collecting_branch_id = l.branch_id)
) c
CROSS JOIN LATERAL (
    SELECT COUNT(*) AS paid_admissions
    FROM admissions ad
    WHERE (ad.first_verified_payment_at AT TIME ZONE 'Asia/Kolkata')::DATE BETWEEN v.period_start AND v.period_end
      AND (l.branch_id IS NULL OR ad.original_branch_id = l.branch_id)
) a
WHERE v.status = 'Approved';

-- Alumni: at least one authorised completion. Alumni + Active can coexist.
CREATE VIEW alumni AS
SELECT
    p.person_id,
    p.person_code,
    p.full_name,
    MIN(a.academic_completed_at) FILTER (WHERE a.enrolment_status = 'Completed') AS alumni_since,
    COUNT(*) FILTER (WHERE a.enrolment_status = 'Completed') AS completed_admissions,
    BOOL_OR(a.enrolment_status IN ('Awaiting Batch Allocation', 'Scheduled', 'In Progress', 'Deferred', 'Paused')) AS is_also_active,
    MAX(a.support_until) AS support_until,
    COALESCE(MAX(a.support_until) >= CURRENT_DATE, FALSE) AS support_active
FROM persons p
JOIN admissions a ON a.person_id = p.person_id
GROUP BY p.person_id
HAVING COUNT(*) FILTER (WHERE a.enrolment_status = 'Completed') > 0;
