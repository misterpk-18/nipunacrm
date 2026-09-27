-- Prototype alignment, part 2: fixes and missing features found in the full prototype review
-- Depends on: 009_prototype_alignment_enums.sql

-- ===========================================================================
-- 1. Shared helpers: business timezone, working days
-- ===========================================================================
CREATE OR REPLACE FUNCTION business_tz() RETURNS TEXT AS $$
    SELECT COALESCE((SELECT setting_value #>> '{}' FROM app_settings WHERE setting_key = 'business_timezone'), 'Asia/Kolkata');
$$ LANGUAGE sql STABLE;

-- p_days staffed days after p_date (skips days without a shift and holidays)
CREATE OR REPLACE FUNCTION add_working_days(p_branch_id INT, p_date DATE, p_days INT) RETURNS DATE AS $$
DECLARE
    v_day DATE := p_date;
    v_count INT := 0;
BEGIN
    FOR i IN 1..1000 LOOP
        EXIT WHEN v_count >= p_days;
        v_day := v_day + 1;
        IF EXISTS (SELECT 1 FROM branch_shifts WHERE branch_id = p_branch_id AND day_of_week = EXTRACT(ISODOW FROM v_day))
           AND NOT EXISTS (SELECT 1 FROM holidays WHERE holiday_date = v_day AND (branch_id IS NULL OR branch_id = p_branch_id)) THEN
            v_count := v_count + 1;
        END IF;
    END LOOP;
    RETURN v_day;
END;
$$ LANGUAGE plpgsql STABLE;

-- Closing time of a branch on a given day (end of that working day)
CREATE OR REPLACE FUNCTION working_day_end(p_branch_id INT, p_date DATE) RETURNS TIMESTAMPTZ AS $$
    SELECT (p_date + COALESCE(
        (SELECT closes_at FROM branch_shifts WHERE branch_id = p_branch_id AND day_of_week = EXTRACT(ISODOW FROM p_date)),
        TIME '23:59')) AT TIME ZONE business_tz();
$$ LANGUAGE sql STABLE;

INSERT INTO app_settings (setting_key, setting_value, description) VALUES
    ('session_idle_minutes', '30', 'Inactivity timeout'),
    ('session_max_hours', '12', 'Maximum staff session length'),
    ('fresh_auth_minutes', '15', 'Sensitive actions need a login within this many minutes'),
    ('report_cutoff_time', '"20:00"', 'Daily report cutoff (IST)'),
    ('demo_max_attended', '2', 'Attended demos allowed before an approval is needed'),
    ('commercial_follow_up_staffed_minutes', '120', 'Commercial follow-up after an attended demo');

-- ===========================================================================
-- 2. Roles and access: prototype roles, multiple role+branch scopes per user
-- ===========================================================================
UPDATE roles SET role_code = 'SALES', role_name = 'Sales' WHERE role_code = 'COUNSELLOR';
UPDATE roles SET role_code = 'FRONT_OFFICE', role_name = 'Front Office' WHERE role_code = 'ADMISSIONS';
INSERT INTO roles (role_code, role_name, is_company_wide) VALUES
    ('HR', 'HR', FALSE),
    ('STUDENT', 'Student', FALSE);

CREATE TABLE user_role_scopes (
    scope_id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role_id INT NOT NULL REFERENCES roles(role_id),
    branch_id INT REFERENCES branches(branch_id),   -- NULL = all branches (company-wide roles only)
    granted_by INT REFERENCES users(user_id),
    granted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE,            -- temporary access
    revoked_by INT REFERENCES users(user_id),
    revoked_at TIMESTAMP WITH TIME ZONE
);

CREATE UNIQUE INDEX user_role_scopes_one_live
    ON user_role_scopes (user_id, role_id, COALESCE(branch_id, 0)) WHERE revoked_at IS NULL;
CREATE INDEX user_role_scopes_user_idx ON user_role_scopes (user_id);

-- Company-wide roles (Founder / CEO, Super Admin) cover all branches; the rest are per branch
CREATE OR REPLACE FUNCTION check_role_scope_branch() RETURNS trigger AS $$
DECLARE
    v_company_wide BOOLEAN;
BEGIN
    SELECT is_company_wide INTO v_company_wide FROM roles WHERE role_id = NEW.role_id;
    IF v_company_wide AND NEW.branch_id IS NOT NULL THEN
        RAISE EXCEPTION 'Company-wide roles apply to all branches; leave branch_id empty';
    ELSIF NOT v_company_wide AND NEW.branch_id IS NULL THEN
        RAISE EXCEPTION 'This role is per branch; set branch_id (add one scope per branch)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_user_role_scopes_branch
    BEFORE INSERT OR UPDATE OF role_id, branch_id ON user_role_scopes
    FOR EACH ROW EXECUTE FUNCTION check_role_scope_branch();

CREATE VIEW active_user_role_scopes AS
SELECT s.*
FROM user_role_scopes s
JOIN users u USING (user_id)
WHERE u.is_active
  AND s.revoked_at IS NULL
  AND (s.expires_at IS NULL OR s.expires_at > CURRENT_TIMESTAMP);

-- Does the user hold any of these roles for this branch (or company-wide)?
-- Scopes never combine into a different role: each check is per role.
CREATE OR REPLACE FUNCTION user_has_role(p_user_id INT, p_roles TEXT[], p_branch_id INT DEFAULT NULL) RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM active_user_role_scopes s JOIN roles r USING (role_id)
        WHERE s.user_id = p_user_id
          AND r.role_code = ANY (p_roles)
          AND (s.branch_id IS NULL OR p_branch_id IS NULL OR s.branch_id = p_branch_id)
    );
$$ LANGUAGE sql STABLE;

DROP TABLE user_branches;
ALTER TABLE users
    DROP COLUMN role_id,
    DROP COLUMN home_branch_id,
    ADD COLUMN person_id INT UNIQUE REFERENCES persons(person_id),   -- student logins
    ADD COLUMN is_recovery_account BOOLEAN NOT NULL DEFAULT FALSE;    -- controlled emergency access

-- Sessions: 30-minute inactivity timeout, 12-hour maximum, fresh auth for sensitive actions
CREATE TABLE user_sessions (
    session_id VARCHAR(128) PRIMARY KEY,            -- hash of the session token
    user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    reauthenticated_at TIMESTAMP WITH TIME ZONE,
    ip_address INET,
    user_agent TEXT,
    revoked_at TIMESTAMP WITH TIME ZONE,
    revoke_reason VARCHAR(100)
);

CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);

CREATE OR REPLACE FUNCTION set_session_expiry() RETURNS trigger AS $$
BEGIN
    NEW.expires_at = COALESCE(NEW.expires_at, NEW.created_at + make_interval(hours =>
        COALESCE((SELECT (setting_value #>> '{}')::INT FROM app_settings WHERE setting_key = 'session_max_hours'), 12)));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_user_sessions_expiry
    BEFORE INSERT ON user_sessions
    FOR EACH ROW EXECUTE FUNCTION set_session_expiry();

CREATE VIEW active_sessions AS
SELECT s.*,
       s.reauthenticated_at IS NOT NULL AND s.reauthenticated_at > CURRENT_TIMESTAMP - make_interval(mins =>
           COALESCE((SELECT (setting_value #>> '{}')::INT FROM app_settings WHERE setting_key = 'fresh_auth_minutes'), 15))
           AS has_fresh_auth
FROM user_sessions s
WHERE s.revoked_at IS NULL
  AND s.expires_at > CURRENT_TIMESTAMP
  AND s.last_seen_at > CURRENT_TIMESTAMP - make_interval(mins =>
        COALESCE((SELECT (setting_value #>> '{}')::INT FROM app_settings WHERE setting_key = 'session_idle_minutes'), 30));

-- Sensitive deletions need an independent approver
CREATE TYPE deletion_request_status AS ENUM ('Pending', 'Approved', 'Rejected', 'Executed');

CREATE TABLE deletion_requests (
    request_id SERIAL PRIMARY KEY,
    entity_type VARCHAR(50) NOT NULL,
    entity_id VARCHAR(50) NOT NULL,
    reason TEXT NOT NULL,
    status deletion_request_status NOT NULL DEFAULT 'Pending',
    requested_by INT NOT NULL REFERENCES users(user_id),
    requested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_by INT REFERENCES users(user_id),
    decided_at TIMESTAMP WITH TIME ZONE,
    executed_at TIMESTAMP WITH TIME ZONE,

    CONSTRAINT deletion_requests_independent CHECK (decided_by IS NULL OR decided_by <> requested_by),
    CONSTRAINT deletion_requests_decision_recorded
        CHECK (status = 'Pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
    CONSTRAINT deletion_requests_executed_after_approval
        CHECK (status <> 'Executed' OR executed_at IS NOT NULL)
);

-- ===========================================================================
-- 3. Lookup values from the prototype
-- ===========================================================================
DELETE FROM lead_sources;
INSERT INTO lead_sources (code, label, sort_order) VALUES
    ('ORGANIC_SOCIAL', 'Organic Social Media', 1),
    ('GOOGLE_ADS', 'Google Ads', 2),
    ('WALK_IN', 'Walk-in', 3),
    ('REFERRAL', 'Referral', 4),
    ('WEBSITE', 'Website', 5),
    ('COLLEGE_DATA', 'College Data', 6);

UPDATE contact_channels SET code = 'PHONE_CALL', label = 'Phone call' WHERE code = 'PHONE_INBOUND';
UPDATE contact_channels SET code = 'OUTBOUND_CALL', label = 'Outbound call' WHERE code = 'PHONE_OUTBOUND';
UPDATE contact_channels SET code = 'IN_PERSON', label = 'In person' WHERE code = 'WALK_IN';

UPDATE entry_methods SET code = 'WEBSITE', label = 'Website', sort_order = 4 WHERE code = 'WEB_FORM';
UPDATE entry_methods SET code = 'BULK_OUTREACH_IMPORT', label = 'Bulk outreach import', sort_order = 5 WHERE code = 'BULK_IMPORT';
INSERT INTO entry_methods (code, label, sort_order) VALUES
    ('GOOGLE_ADS_FORM', 'Google Ads form', 2),
    ('WALK_IN_DESK', 'Walk-in desk', 3);

ALTER TABLE payment_modes ADD COLUMN requires_approval BOOLEAN NOT NULL DEFAULT FALSE;  -- exception-only modes
UPDATE payment_modes SET code = 'UPI_BANK', label = 'UPI / Bank Transfer' WHERE code = 'UPI_BANK';
UPDATE payment_modes SET code = 'PAYMENT_LINK', label = 'Payment Link / Gateway / Card' WHERE code = 'CARD';
UPDATE payment_modes SET label = 'Cheque (exception)', requires_approval = TRUE WHERE code = 'CHEQUE';
UPDATE payment_modes SET sort_order = CASE code WHEN 'CASH' THEN 1 WHEN 'UPI_BANK' THEN 2 WHEN 'PAYMENT_LINK' THEN 3 ELSE 4 END;

-- ===========================================================================
-- 4. People, enquiries and leads
-- ===========================================================================
CREATE TYPE app_language AS ENUM ('English', 'Telugu');

ALTER TABLE persons ADD COLUMN preferred_language app_language NOT NULL DEFAULT 'English';

-- A lead keeps its ORIGINAL source; every enquiry (including repeats) is its own record
ALTER TABLE leads RENAME COLUMN lead_source_id TO original_source_id;
ALTER TABLE leads RENAME COLUMN contact_channel_id TO original_channel_id;
ALTER TABLE leads RENAME COLUMN entry_method_id TO original_entry_method_id;
ALTER TABLE leads ADD COLUMN ai_score SMALLINT CHECK (ai_score BETWEEN 0 AND 100);

CREATE TABLE enquiries (
    enquiry_id SERIAL PRIMARY KEY,
    enquiry_code VARCHAR(20) UNIQUE NOT NULL,       -- e.g., 'ENQ-26091' (auto-generated)
    lead_id INT REFERENCES leads(lead_id),          -- NULL while in Duplicate Review / unlinked
    person_id INT REFERENCES persons(person_id),
    branch_id INT NOT NULL REFERENCES branches(branch_id),
    course_id INT REFERENCES courses(course_id),
    lead_source_id INT NOT NULL REFERENCES lead_sources(lead_source_id),
    contact_channel_id INT NOT NULL REFERENCES contact_channels(contact_channel_id),
    entry_method_id INT NOT NULL REFERENCES entry_methods(entry_method_id),
    intake_status lead_intake_status NOT NULL DEFAULT 'New',
    is_genuine BOOLEAN,                             -- NULL = not yet classified ("Genuine Enquiries")
    owner_user_id INT REFERENCES users(user_id),
    raw_name VARCHAR(150),                          -- as received, before matching
    raw_phone VARCHAR(20),
    raw_email VARCHAR(255),
    message TEXT,
    communication_id BIGINT REFERENCES communications(communication_id),
    received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX enquiries_lead_idx ON enquiries (lead_id);
CREATE INDEX enquiries_branch_received_idx ON enquiries (branch_id, received_at DESC);
CREATE INDEX enquiries_duplicate_review_idx ON enquiries (intake_status) WHERE intake_status = 'Duplicate Review';

CREATE OR REPLACE FUNCTION set_enquiry_code() RETURNS trigger AS $$
BEGIN
    NEW.enquiry_code = 'ENQ-' || LPAD(next_number('ENQUIRY')::TEXT, 5, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enquiries_code
    BEFORE INSERT ON enquiries
    FOR EACH ROW WHEN (NEW.enquiry_code IS NULL)
    EXECUTE FUNCTION set_enquiry_code();

CREATE TRIGGER trg_enquiries_updated_at
    BEFORE UPDATE ON enquiries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE leads ADD COLUMN original_enquiry_id INT REFERENCES enquiries(enquiry_id);

-- "Payment Pending Verification or Admitted records never move backward"
CREATE OR REPLACE FUNCTION guard_lead_stage() RETURNS trigger AS $$
BEGIN
    IF OLD.stage = 'Admitted' THEN
        RAISE EXCEPTION 'Lead % is Admitted; its stage can no longer change', OLD.lead_code;
    ELSIF OLD.stage = 'Payment Pending Verification' AND NEW.stage NOT IN ('Admitted', 'Lost - closed') THEN
        RAISE EXCEPTION 'Lead % is in Payment Pending Verification and cannot move back to %', OLD.lead_code, NEW.stage;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_leads_a_stage_guard     -- "a_" so it runs before the stage-change logger
    BEFORE UPDATE OF stage ON leads
    FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage)
    EXECUTE FUNCTION guard_lead_stage();

-- ===========================================================================
-- 5. Demos: type, duration, 2-attended limit, commercial follow-up
-- ===========================================================================
CREATE TYPE demo_type AS ENUM ('Standard', 'Practical');

ALTER TABLE demos
    ADD COLUMN demo_type demo_type NOT NULL DEFAULT 'Standard',
    ADD COLUMN extra_demo_approved_by INT REFERENCES users(user_id),
    ADD COLUMN commercial_follow_up_due_at TIMESTAMP WITH TIME ZONE,
    ADD CONSTRAINT demos_duration_by_type
        CHECK (duration_minutes <= CASE demo_type WHEN 'Practical' THEN 60 ELSE 45 END);

ALTER TABLE demos ALTER COLUMN duration_minutes SET DEFAULT 45;

CREATE OR REPLACE FUNCTION check_demo_rules() RETURNS trigger AS $$
DECLARE
    v_max INT := COALESCE((SELECT (setting_value #>> '{}')::INT FROM app_settings WHERE setting_key = 'demo_max_attended'), 2);
    v_attended INT;
BEGIN
    -- Booking or confirming another demo after the limit needs Academic Coordinator / Branch Manager approval
    IF NEW.status IN ('Scheduled', 'Confirmed') AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
        SELECT COUNT(*) INTO v_attended FROM demos
        WHERE lead_id = NEW.lead_id AND status = 'Attended' AND demo_id IS DISTINCT FROM NEW.demo_id;
        IF v_attended >= v_max AND (NEW.extra_demo_approved_by IS NULL OR NOT user_has_role(
                NEW.extra_demo_approved_by, ARRAY['ACADEMIC_COORDINATOR', 'BRANCH_MANAGER'], NEW.branch_id)) THEN
            RAISE EXCEPTION 'Lead already attended % demos; another needs Academic Coordinator or Branch Manager approval', v_attended;
        END IF;
    END IF;

    -- Attended: commercial follow-up due within 2 staffed hours
    IF NEW.status = 'Attended' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'Attended') THEN
        NEW.commercial_follow_up_due_at = COALESCE(NEW.commercial_follow_up_due_at,
            add_staffed_minutes(NEW.branch_id, CURRENT_TIMESTAMP,
                COALESCE((SELECT (setting_value #>> '{}')::INT FROM app_settings
                          WHERE setting_key = 'commercial_follow_up_staffed_minutes'), 120)));
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_demos_rules
    BEFORE INSERT OR UPDATE OF status ON demos
    FOR EACH ROW EXECUTE FUNCTION check_demo_rules();

-- ===========================================================================
-- 6. Commercials: accepted delivery plan, fee shared, advisory floor,
--    counteroffers, below-floor dual approval, plan date windows
-- ===========================================================================
CREATE TYPE seat_type AS ENUM ('Confirmed Seat', 'Future Plan');

ALTER TABLE fee_discussions
    ADD COLUMN fee_shared_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN delivery_mode delivery_mode,
    ADD COLUMN seat_type seat_type,
    ADD COLUMN planned_start_date DATE,
    ADD COLUMN accepted_version_id INT REFERENCES fee_discussion_versions(version_id),
    ADD COLUMN plan_accepted_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN plan_accepted_recorded_by INT REFERENCES users(user_id),
    ADD CONSTRAINT fee_discussions_accepted_plan_complete
        CHECK (plan_accepted_at IS NULL
               OR (accepted_version_id IS NOT NULL AND delivery_mode IS NOT NULL AND seat_type IS NOT NULL
                   AND plan_accepted_recorded_by IS NOT NULL)),
    ADD CONSTRAINT fee_discussions_future_plan_start
        CHECK (seat_type IS DISTINCT FROM 'Future Plan' OR planned_start_date IS NOT NULL);

CREATE OR REPLACE FUNCTION before_fee_discussion_update() RETURNS trigger AS $$
DECLARE
    v_version fee_discussion_versions%ROWTYPE;
BEGIN
    IF NEW.milestone::TEXT = 'Fee Shared' AND OLD.milestone::TEXT IS DISTINCT FROM 'Fee Shared' THEN
        NEW.fee_shared_at = COALESCE(NEW.fee_shared_at, CURRENT_TIMESTAMP);
    END IF;

    IF NEW.accepted_version_id IS DISTINCT FROM OLD.accepted_version_id AND NEW.accepted_version_id IS NOT NULL THEN
        SELECT * INTO v_version FROM fee_discussion_versions WHERE version_id = NEW.accepted_version_id;
        IF v_version.fee_discussion_id <> NEW.fee_discussion_id OR v_version.status <> 'Approved' THEN
            RAISE EXCEPTION 'The accepted version must be an Approved version of this discussion';
        END IF;
        NEW.plan_accepted_at = COALESCE(NEW.plan_accepted_at, CURRENT_TIMESTAMP);
    END IF;

    IF OLD.plan_accepted_at IS NOT NULL AND NEW.accepted_version_id IS DISTINCT FROM OLD.accepted_version_id THEN
        RAISE EXCEPTION 'The delivery plan is already accepted; it cannot move to another version';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fee_discussions_before_update
    BEFORE UPDATE ON fee_discussions
    FOR EACH ROW EXECUTE FUNCTION before_fee_discussion_update();

-- The 70% floor is advisory: below-floor versions are allowed, but approving one
-- needs Founder / CEO or Super Admin plus an independent approval (via special closing)
ALTER TABLE fee_discussion_versions DROP CONSTRAINT fee_versions_above_floor;

ALTER TABLE special_closing_requests
    DROP CONSTRAINT special_closing_requests_requested_extra_check,
    ADD CONSTRAINT scr_requested_extra_not_negative CHECK (requested_extra >= 0), -- 0 = floor exception only
    ADD COLUMN counter_extra NUMERIC(10, 2) CHECK (counter_extra >= 0),
    ADD COLUMN independent_approved_by INT REFERENCES users(user_id),
    ADD COLUMN independent_approved_at TIMESTAMP WITH TIME ZONE,
    DROP CONSTRAINT scr_decision_recorded,
    ADD CONSTRAINT scr_decision_recorded
        CHECK (status NOT IN ('Approved', 'Rejected', 'Counteroffered') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
    ADD CONSTRAINT scr_counter_amount
        CHECK (status <> 'Counteroffered' OR counter_extra IS NOT NULL),
    ADD CONSTRAINT scr_independent_approver
        CHECK (independent_approved_by IS NULL
               OR (independent_approved_by <> requested_by AND independent_approved_by IS DISTINCT FROM decided_by));

-- Decision target = 5 staffed minutes (was 5 clock minutes)
ALTER TABLE special_closing_requests ALTER COLUMN decision_due_at DROP DEFAULT;

CREATE OR REPLACE FUNCTION set_scr_decision_due() RETURNS trigger AS $$
BEGIN
    NEW.decision_due_at = COALESCE(NEW.decision_due_at, add_staffed_minutes(
        (SELECT d.branch_id FROM fee_discussion_versions v JOIN fee_discussions d USING (fee_discussion_id)
         WHERE v.version_id = NEW.version_id),
        NEW.requested_at, 5));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_scr_decision_due
    BEFORE INSERT ON special_closing_requests
    FOR EACH ROW EXECUTE FUNCTION set_scr_decision_due();

-- Approvals: within the approver's highest limit across their role scopes, or a
-- below-floor exception (Founder / CEO or Super Admin + independent approval)
CREATE OR REPLACE FUNCTION check_scr_decision() RETURNS trigger AS $$
DECLARE
    v_ver RECORD;
    v_amount NUMERIC;
    v_unlimited BOOLEAN;
    v_allowed NUMERIC;
BEGIN
    NEW.decided_at = COALESCE(NEW.decided_at, CURRENT_TIMESTAMP);
    IF NEW.status = 'Rejected' THEN
        RETURN NEW;
    END IF;

    SELECT v.standard_fee, v.final_payable, v.minimum_floor, d.branch_id INTO v_ver
    FROM fee_discussion_versions v JOIN fee_discussions d USING (fee_discussion_id)
    WHERE v.version_id = NEW.version_id;

    IF NEW.status = 'Approved' AND v_ver.final_payable < v_ver.minimum_floor THEN
        IF NOT user_has_role(NEW.decided_by, ARRAY['FOUNDER_CEO', 'SUPER_ADMIN'], v_ver.branch_id) THEN
            RAISE EXCEPTION 'Below-floor exceptions need Founder / CEO or Super Admin';
        END IF;
        IF NEW.independent_approved_by IS NULL OR NOT user_has_role(
               NEW.independent_approved_by, ARRAY['FOUNDER_CEO', 'SUPER_ADMIN', 'BRANCH_MANAGER'], v_ver.branch_id) THEN
            RAISE EXCEPTION 'Below-floor exceptions also need an independent approval';
        END IF;
        NEW.independent_approved_at = COALESCE(NEW.independent_approved_at, CURRENT_TIMESTAMP);
        RETURN NEW;
    END IF;

    v_amount = CASE WHEN NEW.status = 'Counteroffered' THEN NEW.counter_extra ELSE NEW.requested_extra END;

    SELECT BOOL_OR(cl.max_amount IS NULL AND cl.max_percent IS NULL),
           MAX(LEAST(COALESCE(cl.max_amount, 'Infinity'::NUMERIC),
                     COALESCE(ROUND(v_ver.standard_fee * cl.max_percent / 100, 2), 'Infinity'::NUMERIC)))
    INTO v_unlimited, v_allowed
    FROM active_user_role_scopes s JOIN concession_limits cl USING (role_id)
    WHERE s.user_id = NEW.decided_by AND (s.branch_id IS NULL OR s.branch_id = v_ver.branch_id);

    IF v_allowed IS NULL THEN
        RAISE EXCEPTION 'User % has no concession approval authority for this branch', NEW.decided_by;
    END IF;
    IF NOT v_unlimited AND v_amount > v_allowed THEN
        RAISE EXCEPTION 'Extra % exceeds approver limit % — needs higher approval', v_amount, v_allowed;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER trg_scr_decision ON special_closing_requests;
CREATE TRIGGER trg_scr_decision
    BEFORE UPDATE OF status ON special_closing_requests
    FOR EACH ROW WHEN (NEW.status IN ('Approved', 'Rejected', 'Counteroffered') AND OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION check_scr_decision();

-- A version with an extra concession, or below the floor, is Approved only
-- after a matching special closing request is Approved
CREATE OR REPLACE FUNCTION check_fee_version_approval() RETURNS trigger AS $$
BEGIN
    IF NEW.extra_concession > 0 OR NEW.final_payable < NEW.minimum_floor THEN
        IF TG_OP = 'INSERT' OR NOT EXISTS (
            SELECT 1 FROM special_closing_requests s
            WHERE s.version_id = NEW.version_id
              AND s.status = 'Approved'
              AND s.requested_extra >= NEW.extra_concession
              AND (NEW.final_payable >= NEW.minimum_floor OR s.independent_approved_by IS NOT NULL)
        ) THEN
            RAISE EXCEPTION 'Version % needs an approved special closing request before it can be Approved', NEW.version_no;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fee_versions_z_approval   -- "z_" so it runs after the defaults (floor, version no)
    BEFORE INSERT OR UPDATE OF status ON fee_discussion_versions
    FOR EACH ROW WHEN (NEW.status = 'Approved')
    EXECUTE FUNCTION check_fee_version_approval();

-- Installment due-date windows ("50% + 50% on exact agreed date within Day 10–15")
ALTER TABLE payment_plan_installments
    ADD COLUMN due_days_min SMALLINT,
    ADD COLUMN due_days_max SMALLINT;
UPDATE payment_plan_installments SET due_days_min = due_days_after_admission, due_days_max = due_days_after_admission;
ALTER TABLE payment_plan_installments
    ALTER COLUMN due_days_min SET NOT NULL,
    ALTER COLUMN due_days_max SET NOT NULL,
    ADD CONSTRAINT payment_plan_installments_window
        CHECK (due_days_min <= due_days_after_admission AND due_days_after_admission <= due_days_max);

INSERT INTO payment_plans (plan_code, plan_name, description) VALUES
    ('TWO_INSTALMENTS', 'Two Instalments', '50% + 50% on exact agreed date within Day 10–15'),
    ('THREE_INSTALMENTS', 'Three Instalments', '50% / 25% / 25% on Day 0 / 10 / 15');
INSERT INTO payment_plan_installments (payment_plan_id, installment_no, percent_of_fee, due_days_after_admission, due_days_min, due_days_max)
SELECT p.payment_plan_id, x.n, x.pct, x.d, x.dmin, x.dmax
FROM payment_plans p
JOIN (VALUES
    ('TWO_INSTALMENTS', 1, 50, 0, 0, 0),
    ('TWO_INSTALMENTS', 2, 50, 12, 10, 15),
    ('THREE_INSTALMENTS', 1, 50, 0, 0, 0),
    ('THREE_INSTALMENTS', 2, 25, 10, 10, 10),
    ('THREE_INSTALMENTS', 3, 25, 15, 15, 15)
) x(code, n, pct, d, dmin, dmax) ON x.code = p.plan_code;

-- Complimentary course access period ("redemption / access period ... from the active version")
ALTER TABLE offer_complimentary_courses ADD COLUMN access_period_days INT CHECK (access_period_days > 0);

-- ===========================================================================
-- 7. Payments before admission: advances, allocation, exception modes
-- ===========================================================================
ALTER TABLE payments
    ALTER COLUMN admission_id DROP NOT NULL,
    ADD COLUMN person_id INT NOT NULL REFERENCES persons(person_id),
    ADD COLUMN lead_id INT REFERENCES leads(lead_id),
    ADD COLUMN fee_discussion_id INT REFERENCES fee_discussions(fee_discussion_id),  -- allocation before admission
    ADD COLUMN exception_approved_by INT REFERENCES users(user_id),
    ADD CONSTRAINT payments_exception_approver_independent
        CHECK (exception_approved_by IS NULL OR collected_by IS NULL OR exception_approved_by <> collected_by);

CREATE INDEX payments_person_idx ON payments (person_id);
CREATE INDEX payments_fee_discussion_idx ON payments (fee_discussion_id);
CREATE INDEX payments_unallocated_idx ON payments (person_id) WHERE admission_id IS NULL AND fee_discussion_id IS NULL;

-- Allocation cap: payments can't exceed what's payable on the admission (or the
-- accepted fee version before the admission exists)
CREATE OR REPLACE FUNCTION check_payment_allocation(p payments) RETURNS VOID AS $$
DECLARE
    v_cap NUMERIC;
    v_already NUMERIC;
    v_person INT;
    v_disc RECORD;
BEGIN
    IF p.admission_id IS NOT NULL THEN
        SELECT a.person_id, a.final_fee - COALESCE((SELECT SUM(approved_waiver_amount) FROM refund_cases
                                                    WHERE admission_id = a.admission_id AND refund_decision = 'Waiver Approved'), 0)
        INTO v_person, v_cap
        FROM admissions a WHERE a.admission_id = p.admission_id FOR UPDATE;
        SELECT COALESCE(SUM(amount), 0) INTO v_already FROM payments
        WHERE admission_id = p.admission_id AND verification_status <> 'Failed' AND payment_id IS DISTINCT FROM p.payment_id;
    ELSIF p.fee_discussion_id IS NOT NULL THEN
        SELECT d.milestone, d.accepted_version_id, l.person_id, v.final_payable INTO v_disc
        FROM fee_discussions d JOIN leads l USING (lead_id)
        LEFT JOIN fee_discussion_versions v ON v.version_id = d.accepted_version_id
        WHERE d.fee_discussion_id = p.fee_discussion_id FOR UPDATE OF d;
        IF v_disc.accepted_version_id IS NULL THEN
            RAISE EXCEPTION 'Allocate to a fee discussion only after its delivery plan is accepted';
        END IF;
        IF v_disc.milestone = 'Converted' THEN
            RAISE EXCEPTION 'This discussion is already an admission; allocate to the admission instead';
        END IF;
        v_person = v_disc.person_id;
        v_cap = v_disc.final_payable;
        SELECT COALESCE(SUM(amount), 0) INTO v_already FROM payments
        WHERE fee_discussion_id = p.fee_discussion_id AND verification_status <> 'Failed' AND payment_id IS DISTINCT FROM p.payment_id;
    ELSE
        RETURN;  -- unallocated advance: no cap
    END IF;

    IF v_person <> p.person_id THEN
        RAISE EXCEPTION 'Payment belongs to a different person than the record it is allocated to';
    END IF;
    IF p.entry_type = 'Payment' AND v_already + p.amount > v_cap THEN
        RAISE EXCEPTION 'Payment of % exceeds outstanding % for this allocation', p.amount, v_cap - v_already;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION before_payment_insert() RETURNS trigger AS $$
DECLARE
    v_prefix VARCHAR;
    v_original payments%ROWTYPE;
    v_mode payment_modes%ROWTYPE;
BEGIN
    IF NEW.entry_type = 'Payment' THEN
        SELECT * INTO v_mode FROM payment_modes WHERE payment_mode_id = NEW.payment_mode_id;
        IF v_mode.requires_reference AND NULLIF(TRIM(NEW.reference), '') IS NULL THEN
            RAISE EXCEPTION 'This payment mode requires a reference (UTR / cheque no.)';
        END IF;
        IF v_mode.requires_approval AND NEW.exception_approved_by IS NULL THEN
            RAISE EXCEPTION '% is an exception mode and needs an approver', v_mode.label;
        END IF;

        -- Fill person / lead from what the payment is allocated to
        IF NEW.admission_id IS NOT NULL THEN
            SELECT COALESCE(NEW.person_id, person_id), COALESCE(NEW.lead_id, lead_id) INTO NEW.person_id, NEW.lead_id
            FROM admissions WHERE admission_id = NEW.admission_id;
        ELSIF NEW.fee_discussion_id IS NOT NULL THEN
            SELECT COALESCE(NEW.person_id, l.person_id), COALESCE(NEW.lead_id, l.lead_id) INTO NEW.person_id, NEW.lead_id
            FROM fee_discussions d JOIN leads l USING (lead_id) WHERE d.fee_discussion_id = NEW.fee_discussion_id;
        ELSIF NEW.lead_id IS NOT NULL AND NEW.person_id IS NULL THEN
            SELECT person_id INTO NEW.person_id FROM leads WHERE lead_id = NEW.lead_id;
        END IF;

        PERFORM check_payment_allocation(NEW);
    ELSE
        SELECT * INTO v_original FROM payments WHERE payment_id = NEW.reverses_payment_id;
        IF v_original.entry_type <> 'Payment' OR v_original.verification_status <> 'Verified' THEN
            RAISE EXCEPTION 'A reversal must point to a Verified payment';
        END IF;
        IF NEW.amount <> -v_original.amount THEN
            RAISE EXCEPTION 'Reversal amount must be % (the negative of the original)', -v_original.amount;
        END IF;
        -- A reversal sits exactly where the original payment sits
        NEW.person_id = v_original.person_id;
        NEW.lead_id = v_original.lead_id;
        NEW.fee_discussion_id = v_original.fee_discussion_id;
        NEW.admission_id = v_original.admission_id;
    END IF;

    IF NEW.verification_status = 'Verified' THEN
        NEW.verified_at = COALESCE(NEW.verified_at, CURRENT_TIMESTAMP);
    END IF;

    IF NEW.receipt_number IS NULL THEN
        SELECT receipt_prefix INTO v_prefix FROM branches WHERE branch_id = NEW.collecting_branch_id;
        NEW.receipt_number = v_prefix
            || CASE NEW.entry_type WHEN 'Payment' THEN '-R-' ELSE '-RV-' END
            || fy_code(NEW.payment_date) || '-'
            || LPAD(next_number(NEW.entry_type::TEXT || '-' || v_prefix || '-' || fy_code(NEW.payment_date))::TEXT, 5, '0');
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Immutable except: verification (once), and allocation (each link set once, from empty)
CREATE OR REPLACE FUNCTION before_payment_update() RETURNS trigger AS $$
BEGIN
    IF (NEW.receipt_number, NEW.person_id, NEW.lead_id, NEW.entry_type, NEW.amount, NEW.payment_mode_id,
        NEW.payment_date, NEW.reference, NEW.collected_by, NEW.collecting_branch_id, NEW.exception_approved_by,
        NEW.reverses_payment_id, NEW.reversal_reason, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.receipt_number, OLD.person_id, OLD.lead_id, OLD.entry_type, OLD.amount, OLD.payment_mode_id,
        OLD.payment_date, OLD.reference, OLD.collected_by, OLD.collecting_branch_id, OLD.exception_approved_by,
        OLD.reverses_payment_id, OLD.reversal_reason, OLD.created_by, OLD.created_at) THEN
        RAISE EXCEPTION 'Payments are immutable; record a Reversal instead';
    END IF;

    IF (OLD.admission_id IS NOT NULL AND NEW.admission_id IS DISTINCT FROM OLD.admission_id)
       OR (OLD.fee_discussion_id IS NOT NULL AND NEW.fee_discussion_id IS DISTINCT FROM OLD.fee_discussion_id) THEN
        RAISE EXCEPTION 'Payment % is already allocated; record a Reversal to re-allocate', OLD.receipt_number;
    END IF;

    IF (NEW.admission_id, NEW.fee_discussion_id) IS DISTINCT FROM (OLD.admission_id, OLD.fee_discussion_id) THEN
        IF EXISTS (SELECT 1 FROM payments WHERE reverses_payment_id = OLD.payment_id) THEN
            RAISE EXCEPTION 'Payment % has been reversed and cannot be allocated', OLD.receipt_number;
        END IF;
        PERFORM check_payment_allocation(NEW);
    END IF;

    IF NEW.verification_status IS DISTINCT FROM OLD.verification_status THEN
        IF OLD.verification_status <> 'Pending Verification' THEN
            RAISE EXCEPTION 'Payment % is already %', OLD.receipt_number, OLD.verification_status;
        END IF;
        NEW.verified_at = COALESCE(NEW.verified_at, CURRENT_TIMESTAMP);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- 8. Admissions: prerequisites, seat type, complimentary courses, owners,
--    curriculum versions, fee changes after first verified payment
-- ===========================================================================
ALTER TABLE admissions
    ADD COLUMN seat_type seat_type,
    ADD COLUMN planned_start_date DATE,
    ADD COLUMN complimentary_of_admission_id INT REFERENCES admissions(admission_id),
    ADD COLUMN offer_id INT REFERENCES offers(offer_id),
    ADD COLUMN access_until DATE,
    ADD COLUMN record_owner_id INT REFERENCES users(user_id),
    ADD COLUMN finance_owner_id INT REFERENCES users(user_id),
    ADD COLUMN academic_owner_id INT REFERENCES users(user_id),
    ADD CONSTRAINT admissions_commercial_basis
        CHECK (fee_version_id IS NOT NULL OR complimentary_of_admission_id IS NOT NULL),
    ADD CONSTRAINT admissions_complimentary_shape
        CHECK (complimentary_of_admission_id IS NULL OR (offer_id IS NOT NULL AND final_fee = 0));

UPDATE admissions SET seat_type = 'Confirmed Seat' WHERE seat_type IS NULL;
ALTER TABLE admissions ALTER COLUMN seat_type SET NOT NULL;

CREATE UNIQUE INDEX admissions_one_complimentary_per_course
    ON admissions (complimentary_of_admission_id, course_id) WHERE complimentary_of_admission_id IS NOT NULL;

-- Prerequisites: (1) accepted confirmed delivery plan, (2) first qualifying allocated
-- payment Verified. Payment proof or an unallocated advance alone is not enough.
CREATE OR REPLACE FUNCTION before_admission_insert() RETURNS trigger AS $$
DECLARE
    v_prefix VARCHAR;
    v_year TEXT;
    v_disc RECORD;
    v_first TIMESTAMPTZ;
    v_parent admissions%ROWTYPE;
    v_rule offer_complimentary_courses%ROWTYPE;
BEGIN
    IF NEW.complimentary_of_admission_id IS NULL THEN
        SELECT d.*, v.final_payable, l.person_id AS lead_person_id INTO v_disc
        FROM fee_discussion_versions v
        JOIN fee_discussions d USING (fee_discussion_id)
        JOIN leads l ON l.lead_id = d.lead_id
        WHERE v.version_id = NEW.fee_version_id;

        IF v_disc.plan_accepted_at IS NULL OR v_disc.accepted_version_id IS DISTINCT FROM NEW.fee_version_id THEN
            RAISE EXCEPTION 'Prerequisite missing: accepted confirmed delivery plan on this fee version';
        END IF;
        IF NEW.final_fee <> v_disc.final_payable THEN
            RAISE EXCEPTION 'Admission final_fee % does not match fee version final_payable %', NEW.final_fee, v_disc.final_payable;
        END IF;
        IF NEW.person_id <> v_disc.lead_person_id OR NEW.course_id <> v_disc.course_id THEN
            RAISE EXCEPTION 'Admission person / course must match the fee discussion';
        END IF;

        SELECT MIN(p.verified_at) INTO v_first
        FROM payments p
        WHERE p.fee_discussion_id = v_disc.fee_discussion_id
          AND p.entry_type = 'Payment' AND p.verification_status = 'Verified' AND p.admission_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.payment_id);
        IF v_first IS NULL THEN
            RAISE EXCEPTION 'Prerequisite missing: first qualifying allocated payment must be Verified by Accounts';
        END IF;

        NEW.first_verified_payment_at = v_first;
        NEW.lead_id = COALESCE(NEW.lead_id, v_disc.lead_id);
        NEW.delivery_mode = COALESCE(v_disc.delivery_mode, NEW.delivery_mode);
        NEW.seat_type = COALESCE(NEW.seat_type, v_disc.seat_type, 'Confirmed Seat');
        NEW.planned_start_date = COALESCE(NEW.planned_start_date, v_disc.planned_start_date);
    ELSE
        -- Complimentary course from an active Offer Master version
        SELECT * INTO v_parent FROM admissions WHERE admission_id = NEW.complimentary_of_admission_id;
        SELECT oc.* INTO v_rule
        FROM offer_complimentary_courses oc JOIN offers o USING (offer_id)
        WHERE oc.offer_id = NEW.offer_id AND oc.course_id = NEW.course_id
          AND o.status = 'Active' AND NEW.admission_date BETWEEN o.valid_from AND o.valid_to;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'No active offer grants this complimentary course';
        END IF;
        IF v_parent.final_fee < v_rule.min_final_fee THEN
            RAISE EXCEPTION 'Final agreed fee % is below the % threshold for this complimentary course',
                v_parent.final_fee, v_rule.min_final_fee;
        END IF;
        IF v_parent.first_verified_payment_at IS NULL THEN
            RAISE EXCEPTION 'Qualifying payment on the main admission is not yet Verified';
        END IF;
        NEW.person_id = v_parent.person_id;
        NEW.payment_plan_id = COALESCE(NEW.payment_plan_id, (SELECT payment_plan_id FROM payment_plans WHERE plan_code = 'FULL'));
        NEW.seat_type = COALESCE(NEW.seat_type, 'Confirmed Seat');
        NEW.first_verified_payment_at = NULL;  -- not a new paid admission
        IF v_rule.access_period_days IS NOT NULL THEN
            NEW.access_until = NEW.admission_date + v_rule.access_period_days;
        END IF;
    END IF;

    IF NEW.admission_code IS NULL THEN
        SELECT receipt_prefix INTO v_prefix FROM branches WHERE branch_id = NEW.original_branch_id;
        v_year = EXTRACT(YEAR FROM NEW.admission_date)::TEXT;
        NEW.admission_code = 'NIT-' || v_prefix || '-' || v_year || '-'
            || LPAD(next_number('ADMISSION-' || v_prefix || '-' || v_year)::TEXT, 6, '0');
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- After insert: installments, link the discussion's payments, lead -> Admitted, discussion -> Converted
CREATE OR REPLACE FUNCTION after_admission_insert() RETURNS trigger AS $$
DECLARE
    v_percent_total NUMERIC;
    v_disc_id INT;
BEGIN
    IF NEW.final_fee > 0 THEN
        SELECT SUM(percent_of_fee) INTO v_percent_total
        FROM payment_plan_installments WHERE payment_plan_id = NEW.payment_plan_id;
        IF v_percent_total IS DISTINCT FROM 100 THEN
            RAISE EXCEPTION 'Payment plan % installments add up to % percent, expected 100',
                NEW.payment_plan_id, COALESCE(v_percent_total, 0);
        END IF;

        INSERT INTO installments (admission_id, installment_no, amount_due, due_date)
        SELECT NEW.admission_id,
               installment_no,
               CASE WHEN installment_no = MAX(installment_no) OVER ()
                    THEN NEW.final_fee - (SUM(amount) OVER () - amount)
                    ELSE amount END,
               NEW.admission_date + due_days_after_admission
        FROM (
            SELECT installment_no, due_days_after_admission,
                   ROUND(NEW.final_fee * percent_of_fee / 100, 2) AS amount
            FROM payment_plan_installments WHERE payment_plan_id = NEW.payment_plan_id
        ) plan;
    END IF;

    IF NEW.fee_version_id IS NOT NULL THEN
        SELECT fee_discussion_id INTO v_disc_id FROM fee_discussion_versions WHERE version_id = NEW.fee_version_id;
        UPDATE payments SET admission_id = NEW.admission_id
        WHERE fee_discussion_id = v_disc_id AND admission_id IS NULL;
        UPDATE fee_discussions SET milestone = 'Converted' WHERE fee_discussion_id = v_disc_id;
    END IF;

    IF NEW.lead_id IS NOT NULL THEN
        UPDATE leads SET stage = 'Admitted' WHERE lead_id = NEW.lead_id AND stage <> 'Admitted';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Fee / amounts change only through an applied admission_fee_changes row
CREATE OR REPLACE FUNCTION prevent_admission_fee_change() RETURNS trigger AS $$
BEGIN
    IF (NEW.payment_plan_id, NEW.admission_date) IS DISTINCT FROM (OLD.payment_plan_id, OLD.admission_date)
       OR (NEW.final_fee IS DISTINCT FROM OLD.final_fee
           AND COALESCE(current_setting('app.applying_fee_change', TRUE), '') <> 'on') THEN
        RAISE EXCEPTION 'Admission fee, plan and date are frozen; fee changes go through admission_fee_changes';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Installments: agreed due date must stay inside the plan window; amounts change only via fee changes
CREATE OR REPLACE FUNCTION guard_installment_update() RETURNS trigger AS $$
DECLARE
    v_admission admissions%ROWTYPE;
    v_rule payment_plan_installments%ROWTYPE;
BEGIN
    IF NEW.amount_due IS DISTINCT FROM OLD.amount_due
       AND COALESCE(current_setting('app.applying_fee_change', TRUE), '') <> 'on' THEN
        RAISE EXCEPTION 'Installment amounts change only through an approved fee change';
    END IF;
    IF (NEW.admission_id, NEW.installment_no) IS DISTINCT FROM (OLD.admission_id, OLD.installment_no) THEN
        RAISE EXCEPTION 'Installment identity cannot change';
    END IF;

    IF NEW.due_date IS DISTINCT FROM OLD.due_date THEN
        SELECT * INTO v_admission FROM admissions WHERE admission_id = NEW.admission_id;
        SELECT * INTO v_rule FROM payment_plan_installments
        WHERE payment_plan_id = v_admission.payment_plan_id AND installment_no = NEW.installment_no;
        IF NEW.due_date NOT BETWEEN v_admission.admission_date + v_rule.due_days_min
                                AND v_admission.admission_date + v_rule.due_days_max THEN
            RAISE EXCEPTION 'Due date must be between Day % and Day % of the plan', v_rule.due_days_min, v_rule.due_days_max;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_installments_guard
    BEFORE UPDATE ON installments
    FOR EACH ROW EXECUTE FUNCTION guard_installment_update();

-- "After the first verified payment, fee changes require Founder / CEO or Super Admin
--  approval plus an Accounts correction. No self-approval."
CREATE TYPE fee_change_status AS ENUM ('Pending', 'Approved', 'Rejected', 'Applied');

CREATE TABLE admission_fee_changes (
    fee_change_id SERIAL PRIMARY KEY,
    admission_id INT NOT NULL REFERENCES admissions(admission_id),
    old_fee NUMERIC(10, 2) NOT NULL,
    new_fee NUMERIC(10, 2) NOT NULL CHECK (new_fee >= 0),
    reason TEXT NOT NULL,
    status fee_change_status NOT NULL DEFAULT 'Pending',
    requested_by INT NOT NULL REFERENCES users(user_id),
    requested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    approved_by INT REFERENCES users(user_id),
    approved_at TIMESTAMP WITH TIME ZONE,
    rejection_reason TEXT,
    accounts_corrected_by INT REFERENCES users(user_id),
    applied_at TIMESTAMP WITH TIME ZONE,

    CONSTRAINT fee_changes_differs CHECK (new_fee <> old_fee),
    CONSTRAINT fee_changes_no_self_approval CHECK (approved_by IS NULL OR approved_by <> requested_by),
    CONSTRAINT fee_changes_approval_recorded
        CHECK (status NOT IN ('Approved', 'Applied', 'Rejected') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
    CONSTRAINT fee_changes_rejection_reason CHECK (status <> 'Rejected' OR rejection_reason IS NOT NULL),
    CONSTRAINT fee_changes_accounts_correction
        CHECK (status <> 'Applied' OR (accounts_corrected_by IS NOT NULL AND applied_at IS NOT NULL))
);

CREATE UNIQUE INDEX admission_fee_changes_one_open
    ON admission_fee_changes (admission_id) WHERE status IN ('Pending', 'Approved');

CREATE OR REPLACE FUNCTION before_fee_change_write() RETURNS trigger AS $$
DECLARE
    v_admission admissions%ROWTYPE;
    v_verified NUMERIC;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT final_fee INTO NEW.old_fee FROM admissions WHERE admission_id = NEW.admission_id;
        RETURN NEW;
    END IF;

    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;
    SELECT * INTO v_admission FROM admissions WHERE admission_id = NEW.admission_id FOR UPDATE;

    IF NEW.status IN ('Approved', 'Rejected') THEN
        IF OLD.status <> 'Pending' THEN
            RAISE EXCEPTION 'Fee change is already %', OLD.status;
        END IF;
        IF NOT user_has_role(NEW.approved_by, ARRAY['FOUNDER_CEO', 'SUPER_ADMIN'], v_admission.service_branch_id) THEN
            RAISE EXCEPTION 'Fee changes need Founder / CEO or Super Admin approval';
        END IF;
        NEW.approved_at = COALESCE(NEW.approved_at, CURRENT_TIMESTAMP);

    ELSIF NEW.status = 'Applied' THEN
        IF OLD.status <> 'Approved' THEN
            RAISE EXCEPTION 'Only an Approved fee change can be applied';
        END IF;
        IF NOT user_has_role(NEW.accounts_corrected_by, ARRAY['ACCOUNTS'], v_admission.service_branch_id) THEN
            RAISE EXCEPTION 'The correction must be made by Accounts';
        END IF;
        SELECT verified_paid INTO v_verified FROM admission_balances WHERE admission_id = NEW.admission_id;
        IF NEW.new_fee < v_verified THEN
            RAISE EXCEPTION 'New fee % is below verified payments %; raise a refund case for the difference', NEW.new_fee, v_verified;
        END IF;

        PERFORM set_config('app.applying_fee_change', 'on', TRUE);
        UPDATE admissions SET final_fee = NEW.new_fee WHERE admission_id = NEW.admission_id;
        UPDATE installments i SET amount_due = x.amount
        FROM (
            SELECT installment_no,
                   CASE WHEN installment_no = MAX(installment_no) OVER ()
                        THEN NEW.new_fee - (SUM(amount) OVER () - amount) ELSE amount END AS amount
            FROM (SELECT installment_no, ROUND(NEW.new_fee * percent_of_fee / 100, 2) AS amount
                  FROM payment_plan_installments WHERE payment_plan_id = v_admission.payment_plan_id) p
        ) x
        WHERE i.admission_id = NEW.admission_id AND i.installment_no = x.installment_no;
        PERFORM set_config('app.applying_fee_change', 'off', TRUE);
        NEW.applied_at = COALESCE(NEW.applied_at, CURRENT_TIMESTAMP);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_admission_fee_changes_write
    BEFORE INSERT OR UPDATE ON admission_fee_changes
    FOR EACH ROW EXECUTE FUNCTION before_fee_change_write();

-- Curriculum versions ("Published v2026.1") and per-admission mapping
CREATE TYPE curriculum_version_status AS ENUM ('Draft', 'Published', 'Retired');

CREATE TABLE curriculum_versions (
    curriculum_version_id SERIAL PRIMARY KEY,
    course_id INT NOT NULL REFERENCES courses(course_id),
    version_label VARCHAR(30) NOT NULL,             -- e.g., 'v2026.1'
    status curriculum_version_status NOT NULL DEFAULT 'Draft',
    notes TEXT,
    published_by INT REFERENCES users(user_id),
    published_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (course_id, version_label),
    CONSTRAINT curriculum_versions_published_recorded
        CHECK (status <> 'Published' OR (published_by IS NOT NULL AND published_at IS NOT NULL))
);

CREATE UNIQUE INDEX curriculum_versions_one_published
    ON curriculum_versions (course_id) WHERE status = 'Published';

CREATE TABLE admission_curricula (
    admission_id INT REFERENCES admissions(admission_id),
    curriculum_version_id INT REFERENCES curriculum_versions(curriculum_version_id),
    mapped_by INT REFERENCES users(user_id),
    mapped_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (admission_id, curriculum_version_id)
);

-- Curriculum must be for the admission's course or one of its combo components
CREATE OR REPLACE FUNCTION check_admission_curriculum() RETURNS trigger AS $$
DECLARE
    v_course INT;
    v_admission_course INT;
BEGIN
    SELECT course_id INTO v_course FROM curriculum_versions WHERE curriculum_version_id = NEW.curriculum_version_id;
    SELECT course_id INTO v_admission_course FROM admissions WHERE admission_id = NEW.admission_id;
    IF v_course <> v_admission_course AND NOT EXISTS (
        SELECT 1 FROM combo_courses WHERE combo_course_id = v_admission_course AND component_course_id = v_course
    ) THEN
        RAISE EXCEPTION 'Curriculum is for a course that is not part of this admission';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_admission_curricula_check
    BEFORE INSERT ON admission_curricula
    FOR EACH ROW EXECUTE FUNCTION check_admission_curriculum();

CREATE OR REPLACE FUNCTION check_curriculum_mapped() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM admission_curricula WHERE admission_id = NEW.admission_id) THEN
        RAISE EXCEPTION 'Map a curriculum version before marking curriculum as Mapped';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_admissions_curriculum_mapped
    BEFORE UPDATE OF curriculum_status ON admissions
    FOR EACH ROW WHEN (NEW.curriculum_status = 'Mapped' AND OLD.curriculum_status IS DISTINCT FROM 'Mapped')
    EXECUTE FUNCTION check_curriculum_mapped();

-- Batch allocation deadlines: confirmed seat within 1 working day and before the first class;
-- future plan 48h before start; unresolved 24h before start escalates to Founder / CEO or Super Admin
CREATE VIEW batch_allocation_queue AS
SELECT
    a.admission_id,
    a.admission_code,
    a.service_branch_id,
    a.seat_type,
    a.planned_start_date,
    a.created_at,
    CASE
        WHEN a.seat_type = 'Future Plan' AND a.planned_start_date IS NOT NULL
            THEN (a.planned_start_date::TIMESTAMP - INTERVAL '48 hours') AT TIME ZONE business_tz()
        ELSE LEAST(
            working_day_end(a.service_branch_id,
                add_working_days(a.service_branch_id, (a.created_at AT TIME ZONE business_tz())::DATE, 1)),
            a.planned_start_date::TIMESTAMP AT TIME ZONE business_tz())
    END AS allocate_by,
    (a.planned_start_date::TIMESTAMP - INTERVAL '24 hours') AT TIME ZONE business_tz() AS escalate_at
FROM admissions a
WHERE a.enrolment_status = 'Awaiting Batch Allocation';

-- Payment completion label on balances (Unpaid / Part Paid / Paid)
CREATE OR REPLACE VIEW admission_balances AS
SELECT
    a.admission_id,
    a.admission_code,
    a.person_id,
    a.service_branch_id,
    a.enrolment_status,
    a.final_fee,
    COALESCE(p.verified_paid, 0) AS verified_paid,
    COALESCE(p.pending_verification, 0) AS pending_verification,
    COALESCE(r.waived, 0) AS waived,
    COALESCE(r.refunded, 0) AS refunded,
    CASE WHEN a.enrolment_status = 'Cancelled' THEN 0
         ELSE a.final_fee - COALESCE(p.verified_paid, 0) - COALESCE(r.waived, 0)
    END AS outstanding,
    CASE
        WHEN a.final_fee - COALESCE(p.verified_paid, 0) - COALESCE(r.waived, 0) <= 0 THEN 'Paid'
        WHEN COALESCE(p.verified_paid, 0) > 0 THEN 'Part Paid'
        ELSE 'Unpaid'
    END AS payment_completion
FROM admissions a
LEFT JOIN (
    SELECT admission_id,
           SUM(amount) FILTER (WHERE verification_status = 'Verified') AS verified_paid,
           SUM(amount) FILTER (WHERE verification_status = 'Pending Verification') AS pending_verification
    FROM payments GROUP BY admission_id
) p USING (admission_id)
LEFT JOIN (
    SELECT admission_id,
           SUM(approved_waiver_amount) FILTER (WHERE refund_decision = 'Waiver Approved') AS waived,
           SUM(payout_amount) FILTER (WHERE payout_status = 'Completed') AS refunded
    FROM refund_cases GROUP BY admission_id
) r USING (admission_id);

-- Unallocated advances waiting to be allocated
CREATE VIEW unallocated_advances AS
SELECT p.payment_id, p.receipt_number, p.person_id, p.lead_id, p.amount, p.payment_date,
       p.collecting_branch_id, p.verification_status
FROM payments p
WHERE p.entry_type = 'Payment' AND p.admission_id IS NULL AND p.fee_discussion_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.payment_id);

-- ===========================================================================
-- 9. Refunds and support: role checks via scopes, working-day targets, support cases
-- ===========================================================================
CREATE OR REPLACE FUNCTION check_refund_decision() RETURNS trigger AS $$
DECLARE
    v_branch INT;
    v_verified NUMERIC;
BEGIN
    SELECT service_branch_id INTO v_branch FROM admissions WHERE admission_id = NEW.admission_id;
    IF NOT user_has_role(NEW.decided_by, ARRAY['FOUNDER_CEO', 'SUPER_ADMIN'], v_branch) THEN
        RAISE EXCEPTION 'Refund / waiver decisions need Founder / CEO or Super Admin';
    END IF;

    IF NEW.refund_decision = 'Refund Approved' THEN
        SELECT COALESCE(SUM(amount), 0) INTO v_verified
        FROM payments WHERE admission_id = NEW.admission_id AND verification_status = 'Verified';
        IF NEW.approved_refund_amount > v_verified THEN
            RAISE EXCEPTION 'Approved refund % exceeds verified payments %', NEW.approved_refund_amount, v_verified;
        END IF;
        -- Payout target: up to 18 working days after approval
        NEW.payout_due_at = COALESCE(NEW.payout_due_at, working_day_end(v_branch,
            add_working_days(v_branch, CURRENT_DATE,
                COALESCE((SELECT (setting_value #>> '{}')::INT FROM app_settings
                          WHERE setting_key = 'refund_payout_target_working_days'), 18))));
    END IF;

    NEW.decided_at = COALESCE(NEW.decided_at, CURRENT_TIMESTAMP);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Decision target: normally 3–7 working days from registration
CREATE OR REPLACE FUNCTION set_refund_decision_due() RETURNS trigger AS $$
DECLARE
    v_branch INT;
BEGIN
    SELECT service_branch_id INTO v_branch FROM admissions WHERE admission_id = NEW.admission_id;
    NEW.decision_due_at = COALESCE(NEW.decision_due_at, working_day_end(v_branch,
        add_working_days(v_branch, (NEW.requested_at AT TIME ZONE business_tz())::DATE,
            COALESCE((SELECT (setting_value #>> '{}')::INT FROM app_settings
                      WHERE setting_key = 'refund_decision_target_working_days'), 7))));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_refund_cases_decision_due
    BEFORE INSERT ON refund_cases
    FOR EACH ROW EXECUTE FUNCTION set_refund_decision_due();

CREATE OR REPLACE FUNCTION before_support_extension() RETURNS trigger AS $$
DECLARE
    v_branch INT;
BEGIN
    SELECT support_until, service_branch_id INTO NEW.previous_until, v_branch
    FROM admissions WHERE admission_id = NEW.admission_id FOR UPDATE;
    IF NOT user_has_role(NEW.approved_by, ARRAY['FOUNDER_CEO', 'SUPER_ADMIN'], v_branch) THEN
        RAISE EXCEPTION 'Support extensions need Founder / CEO or Super Admin';
    END IF;
    IF NEW.previous_until IS NULL THEN
        RAISE EXCEPTION 'Admission % has no support period yet (not completed)', NEW.admission_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE support_case_types (
    support_case_type_id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    label VARCHAR(100) NOT NULL,
    sort_order SMALLINT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO support_case_types (code, label, sort_order) VALUES
    ('REFUND_CANCELLATION', 'Refund / Cancellation', 1),
    ('ACADEMIC', 'Academic', 2),
    ('LMS_TECHNICAL', 'LMS / Technical', 3),
    ('PAYMENT_QUERY', 'Payment query', 4),
    ('CERTIFICATE', 'Certificate', 5),
    ('COMPLAINT', 'Complaint', 6),
    ('OTHER', 'Other', 99);

CREATE TYPE support_case_status AS ENUM ('Open', 'In Progress', 'Waiting on Student', 'Resolved', 'Closed');

CREATE TABLE support_cases (
    support_case_id SERIAL PRIMARY KEY,
    case_code VARCHAR(20) UNIQUE NOT NULL,          -- e.g., 'SUP-00001' (auto-generated)
    person_id INT NOT NULL REFERENCES persons(person_id),
    admission_id INT REFERENCES admissions(admission_id),
    branch_id INT NOT NULL REFERENCES branches(branch_id),
    support_case_type_id INT NOT NULL REFERENCES support_case_types(support_case_type_id),
    subject VARCHAR(255) NOT NULL,
    description TEXT,
    status support_case_status NOT NULL DEFAULT 'Open',
    owner_user_id INT REFERENCES users(user_id),
    refund_case_id INT REFERENCES refund_cases(refund_case_id),
    resolution_notes TEXT,
    opened_by INT REFERENCES users(user_id),
    opened_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT support_cases_resolution_recorded
        CHECK (status NOT IN ('Resolved', 'Closed') OR (resolved_at IS NOT NULL AND resolution_notes IS NOT NULL))
);

CREATE INDEX support_cases_person_idx ON support_cases (person_id);
CREATE INDEX support_cases_branch_status_idx ON support_cases (branch_id, status);

CREATE OR REPLACE FUNCTION before_support_case_write() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.case_code IS NULL THEN
        NEW.case_code = 'SUP-' || LPAD(next_number('SUPPORT_CASE')::TEXT, 5, '0');
    END IF;
    IF NEW.status IN ('Resolved', 'Closed') THEN
        NEW.resolved_at = COALESCE(NEW.resolved_at, CURRENT_TIMESTAMP);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_support_cases_write
    BEFORE INSERT OR UPDATE ON support_cases
    FOR EACH ROW EXECUTE FUNCTION before_support_case_write();

CREATE TRIGGER trg_support_cases_updated_at
    BEFORE UPDATE ON support_cases
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Tasks can link to support cases and enquiries too
ALTER TABLE tasks
    ADD COLUMN support_case_id INT REFERENCES support_cases(support_case_id),
    ADD COLUMN enquiry_id INT REFERENCES enquiries(enquiry_id),
    DROP CONSTRAINT tasks_one_linked_record,
    ADD CONSTRAINT tasks_one_linked_record
        CHECK (num_nonnulls(lead_id, demo_id, fee_discussion_id, scr_id, admission_id, payment_id,
                            refund_case_id, document_id, communication_id, support_case_id, enquiry_id) <= 1);

CREATE OR REPLACE VIEW task_board AS
SELECT
    t.task_id,
    tt.label AS task_type,
    t.title,
    t.branch_id,
    t.owner_user_id,
    t.team_role_id,
    t.status,
    t.original_due_at,
    t.revised_due_at,
    COALESCE(t.revised_due_at, t.original_due_at) AS due_at,
    t.status NOT IN ('Completed', 'Cancelled')
        AND COALESCE(t.revised_due_at, t.original_due_at) < CURRENT_TIMESTAMP AS is_overdue,
    t.status NOT IN ('Completed', 'Cancelled')
        AND COALESCE(t.revised_due_at, t.original_due_at)::DATE = CURRENT_DATE AS is_due_today,
    t.owner_user_id IS NULL AND t.status NOT IN ('Completed', 'Cancelled') AS is_unassigned,
    COALESCE(l.lead_code, fd.discussion_code, s.scr_code, a.admission_code, p.receipt_number, r.case_code,
             sc.case_code, e.enquiry_code,
             'DEMO-' || t.demo_id, 'DOC-' || t.document_id, 'COMM-' || t.communication_id) AS linked_record
FROM tasks t
JOIN task_types tt USING (task_type_id)
LEFT JOIN leads l ON l.lead_id = t.lead_id
LEFT JOIN fee_discussions fd ON fd.fee_discussion_id = t.fee_discussion_id
LEFT JOIN special_closing_requests s ON s.scr_id = t.scr_id
LEFT JOIN admissions a ON a.admission_id = t.admission_id
LEFT JOIN payments p ON p.payment_id = t.payment_id
LEFT JOIN refund_cases r ON r.refund_case_id = t.refund_case_id
LEFT JOIN support_cases sc ON sc.support_case_id = t.support_case_id
LEFT JOIN enquiries e ON e.enquiry_id = t.enquiry_id;

-- ===========================================================================
-- 10. AI: insights, Ask Nipuna queries, feedback (advisory only, human review)
-- ===========================================================================
CREATE TYPE ai_insight_type AS ENUM (
    'Before-Call Brief', 'Priority Explanation', 'Next Best Action', 'Suggested Message', 'Management Brief', 'Lead Insight'
);

CREATE TYPE ai_feedback_rating AS ENUM ('Helpful', 'Incorrect', 'Not Useful', 'Missing Context');

CREATE TABLE ai_insights (
    insight_id BIGSERIAL PRIMARY KEY,
    insight_type ai_insight_type NOT NULL,
    lead_id INT REFERENCES leads(lead_id),
    person_id INT REFERENCES persons(person_id),
    branch_id INT REFERENCES branches(branch_id),
    for_user_id INT REFERENCES users(user_id),
    content TEXT NOT NULL,
    suggested_message TEXT,
    score SMALLINT CHECK (score BETWEEN 0 AND 100),
    priority lead_priority,
    language app_language NOT NULL DEFAULT 'English',
    evidence_as_of TIMESTAMP WITH TIME ZONE,        -- "evidence 24 Sep 2026"
    sources JSONB,                                  -- facts the inference used
    model VARCHAR(100),
    requires_human_review BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ai_insights_lead_idx ON ai_insights (lead_id, created_at DESC);

CREATE TABLE ai_queries (
    query_id BIGSERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(user_id),
    question TEXT NOT NULL,
    language app_language NOT NULL DEFAULT 'English',
    branch_id INT REFERENCES branches(branch_id),   -- NULL = all branches in the user's scope
    period_start DATE,
    period_end DATE,
    report_cutoff_at TIMESTAMP WITH TIME ZONE,
    answer TEXT,
    recorded_facts TEXT,
    possible_explanation TEXT,
    missing_evidence TEXT,
    data_freshness TEXT,
    sources JSONB,
    supporting_table JSONB,
    model VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ai_queries_user_idx ON ai_queries (user_id, created_at DESC);

CREATE TABLE ai_feedback (
    feedback_id BIGSERIAL PRIMARY KEY,
    insight_id BIGINT REFERENCES ai_insights(insight_id),
    query_id BIGINT REFERENCES ai_queries(query_id),
    user_id INT NOT NULL REFERENCES users(user_id),
    rating ai_feedback_rating NOT NULL,
    comment TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ai_feedback_one_target CHECK (num_nonnulls(insight_id, query_id) = 1)
);

CREATE UNIQUE INDEX ai_feedback_one_per_user_insight ON ai_feedback (insight_id, user_id) WHERE insight_id IS NOT NULL;
CREATE UNIQUE INDEX ai_feedback_one_per_user_query ON ai_feedback (query_id, user_id) WHERE query_id IS NOT NULL;

-- ===========================================================================
-- 11. Reports: weekly / monthly schedule day, report run log
-- ===========================================================================
ALTER TABLE scheduled_reports
    ADD COLUMN schedule_day SMALLINT,               -- Weekly: ISO weekday 1–7; Monthly: day 1–28
    ADD CONSTRAINT scheduled_reports_schedule_day CHECK (
        (frequency = 'Daily' AND schedule_day IS NULL)
        OR (frequency = 'Weekly' AND schedule_day BETWEEN 1 AND 7)
        OR (frequency = 'Monthly' AND schedule_day BETWEEN 1 AND 28));

CREATE TYPE report_completeness AS ENUM ('Complete', 'Partial');

CREATE TABLE report_runs (
    report_run_id BIGSERIAL PRIMARY KEY,
    scheduled_report_id INT REFERENCES scheduled_reports(scheduled_report_id),
    report_name VARCHAR(150) NOT NULL,
    branch_id INT REFERENCES branches(branch_id),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    cutoff_at TIMESTAMP WITH TIME ZONE NOT NULL,    -- e.g., 24 Sep 2026 20:00 IST
    refreshed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completeness report_completeness NOT NULL,
    completeness_notes TEXT,
    format report_format,
    file_path VARCHAR(500),
    generated_by INT REFERENCES users(user_id),
    delivery_status external_delivery_status NOT NULL DEFAULT 'Not Sent',
    CHECK (period_end >= period_start)
);

CREATE INDEX report_runs_name_period_idx ON report_runs (report_name, period_end DESC);
