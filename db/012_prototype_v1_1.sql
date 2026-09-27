-- Prototype v1.1 ("Workflow Review") alignment
--   invoices as the anchor for payments and instalment schedules (dues exist before admission),
--   payment correction requests with independent approval, demo reminders and outcomes,
--   lead campaign / remarks / WhatsApp, saved views, lead CSV imports, batch workspace fields.
-- Depends on: 011_auth.sql

-- ===========================================================================
-- 1. Lookup values and intake statuses from v1.1
-- ===========================================================================
-- New enum values are only stored by the app, never used in this migration
ALTER TYPE lead_intake_status ADD VALUE 'Invalid-Spam';
ALTER TYPE lead_intake_status ADD VALUE 'Test';

INSERT INTO lead_sources (code, label, sort_order) VALUES ('META_ADS', 'Meta Ads', 7);
INSERT INTO entry_methods (code, label, sort_order) VALUES ('CSV_IMPORT', 'CSV import', 6);

-- ===========================================================================
-- 2. People and leads
-- ===========================================================================
ALTER TABLE persons ADD COLUMN whatsapp_number VARCHAR(20);        -- NULL = same as primary mobile

ALTER TABLE leads
    ADD COLUMN campaign VARCHAR(150),                              -- campaign / referral, e.g. 'Existing student referral'
    ADD COLUMN remarks TEXT;                                        -- counsellor remarks

ALTER TABLE lead_activities
    ADD COLUMN purpose VARCHAR(100),                               -- follow-up purpose, e.g. 'Fee follow-up' (outcome = response)
    ADD COLUMN demo_id INT REFERENCES demos(demo_id);              -- timeline entries about a demo

-- Saved views (lead list filters). user_id NULL = shared view for everyone.
CREATE TABLE saved_views (
    saved_view_id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(user_id) ON DELETE CASCADE,
    module VARCHAR(50) NOT NULL,                                    -- e.g. 'leads'
    name VARCHAR(100) NOT NULL,
    filters JSONB NOT NULL DEFAULT '{}',                            -- same keys as the list endpoint's query params
    sort_order SMALLINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE NULLS NOT DISTINCT (user_id, module, name)
);

CREATE TRIGGER trg_saved_views_updated_at
    BEFORE UPDATE ON saved_views
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO saved_views (user_id, module, name, filters, sort_order) VALUES
    (NULL, 'leads', 'All open', '{}', 1),
    (NULL, 'leads', 'Hot fee discussions', '{"stage": "Fee Discussion / Payment Awaited"}', 2),
    (NULL, 'leads', 'Duplicate Review queue', '{"intake_status": "Duplicate Review"}', 3),
    (NULL, 'leads', 'Website enquiries',
        jsonb_build_object('source_id', (SELECT lead_source_id FROM lead_sources WHERE code = 'WEBSITE')), 4),
    (NULL, 'leads', 'Admitted (reference)', '{"stage": "Admitted"}', 5);

-- Lead CSV imports: upload -> row validation (format, Course Master, branch scope, duplicates) -> import
CREATE TYPE lead_import_status AS ENUM ('Uploaded', 'Validated', 'Imported', 'Cancelled');
CREATE TYPE lead_import_row_result AS ENUM ('Ready', 'Duplicate Review', 'Invalid', 'Imported');

CREATE TABLE lead_imports (
    import_id SERIAL PRIMARY KEY,
    import_code VARCHAR(20) UNIQUE NOT NULL,                        -- IMP-00001 (auto)
    file_name VARCHAR(255) NOT NULL,
    status lead_import_status NOT NULL DEFAULT 'Uploaded',
    total_rows INT NOT NULL DEFAULT 0,
    ready_rows INT NOT NULL DEFAULT 0,
    duplicate_rows INT NOT NULL DEFAULT 0,
    invalid_rows INT NOT NULL DEFAULT 0,
    uploaded_by INT NOT NULL REFERENCES users(user_id),
    uploaded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    imported_by INT REFERENCES users(user_id),
    imported_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT lead_imports_imported_recorded
        CHECK (status <> 'Imported' OR (imported_by IS NOT NULL AND imported_at IS NOT NULL))
);

CREATE TABLE lead_import_rows (
    import_row_id BIGSERIAL PRIMARY KEY,
    import_id INT NOT NULL REFERENCES lead_imports(import_id) ON DELETE CASCADE,
    row_no INT NOT NULL CHECK (row_no > 0),
    raw_data JSONB NOT NULL,                                        -- the CSV row as uploaded
    full_name VARCHAR(150),
    phone VARCHAR(20),                                              -- normalised
    email VARCHAR(255),
    course_id INT REFERENCES courses(course_id),
    branch_id INT REFERENCES branches(branch_id),
    lead_source_id INT REFERENCES lead_sources(lead_source_id),
    issues TEXT[] NOT NULL DEFAULT '{}',
    result lead_import_row_result NOT NULL,
    matched_lead_id INT REFERENCES leads(lead_id),                  -- possible duplicate (never merged)
    lead_id INT REFERENCES leads(lead_id),                          -- lead created by the import
    enquiry_id INT REFERENCES enquiries(enquiry_id),
    UNIQUE (import_id, row_no),
    CONSTRAINT lead_import_rows_invalid_has_issues CHECK (result <> 'Invalid' OR cardinality(issues) > 0)
);

CREATE OR REPLACE FUNCTION set_import_code() RETURNS trigger AS $$
BEGIN
    NEW.import_code = 'IMP-' || LPAD(next_number('LEAD_IMPORT')::TEXT, 5, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_lead_imports_code
    BEFORE INSERT ON lead_imports
    FOR EACH ROW WHEN (NEW.import_code IS NULL)
    EXECUTE FUNCTION set_import_code();

-- ===========================================================================
-- 3. Demos: code, outcome fields, reasons, reminder records
-- ===========================================================================
ALTER TABLE demos RENAME COLUMN feedback TO student_feedback;
ALTER TABLE demos RENAME COLUMN next_step TO next_action;
ALTER TABLE demos
    DROP COLUMN confirmation_sent_at,                                -- replaced by demo_reminders
    DROP COLUMN reminder_24h_sent_at,
    DROP COLUMN reminder_1h_sent_at,
    ADD COLUMN demo_code VARCHAR(20) UNIQUE,                         -- DM-GNT-0001 (auto)
    ADD COLUMN trainer_feedback TEXT,
    ADD COLUMN outcome VARCHAR(100),                                 -- e.g. 'Interested — fee discussion'
    ADD COLUMN recommended_course_id INT REFERENCES courses(course_id),
    ADD COLUMN commercial_owner_id INT REFERENCES users(user_id),
    ADD COLUMN next_follow_up_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN reschedule_reason VARCHAR(100),
    ADD COLUMN cancel_reason VARCHAR(100),
    ADD CONSTRAINT demos_cancel_reason CHECK (status <> 'Cancelled' OR cancel_reason IS NOT NULL),
    ADD CONSTRAINT demos_reschedule_reason CHECK (status <> 'Rescheduled' OR reschedule_reason IS NOT NULL);

ALTER TABLE demos ALTER COLUMN demo_code SET NOT NULL;

CREATE OR REPLACE FUNCTION set_demo_code() RETURNS trigger AS $$
DECLARE
    v_prefix VARCHAR;
BEGIN
    SELECT receipt_prefix INTO v_prefix FROM branches WHERE branch_id = NEW.branch_id;
    NEW.demo_code = 'DM-' || v_prefix || '-' || LPAD(next_number('DEMO-' || v_prefix)::TEXT, 4, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_demos_code
    BEFORE INSERT ON demos
    FOR EACH ROW WHEN (NEW.demo_code IS NULL)
    EXECUTE FUNCTION set_demo_code();

-- A confirmed no-show also starts the 2-staffed-hour commercial follow-up
CREATE OR REPLACE FUNCTION check_demo_rules() RETURNS trigger AS $$
DECLARE
    v_max INT := COALESCE((SELECT (setting_value #>> '{}')::INT FROM app_settings WHERE setting_key = 'demo_max_attended'), 2);
    v_attended INT;
BEGIN
    IF NEW.status IN ('Scheduled', 'Confirmed') AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
        SELECT COUNT(*) INTO v_attended FROM demos
        WHERE lead_id = NEW.lead_id AND status = 'Attended' AND demo_id IS DISTINCT FROM NEW.demo_id;
        IF v_attended >= v_max AND (NEW.extra_demo_approved_by IS NULL OR NOT user_has_role(
                NEW.extra_demo_approved_by, ARRAY['ACADEMIC_COORDINATOR', 'BRANCH_MANAGER'], NEW.branch_id)) THEN
            RAISE EXCEPTION 'Lead already attended % demos; another needs Academic Coordinator or Branch Manager approval', v_attended;
        END IF;
    END IF;

    IF NEW.status IN ('Attended', 'No Show') AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
        NEW.commercial_follow_up_due_at = COALESCE(NEW.commercial_follow_up_due_at,
            add_staffed_minutes(NEW.branch_id, CURRENT_TIMESTAMP,
                COALESCE((SELECT (setting_value #>> '{}')::INT FROM app_settings
                          WHERE setting_key = 'commercial_follow_up_staffed_minutes'), 120)));
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TYPE demo_reminder_type AS ENUM ('Booking confirmation', '24h student reminder', '1h student + trainer reminder');
CREATE TYPE demo_reminder_state AS ENUM ('Pending', 'Sent', 'Failed', 'Skipped', 'Superseded', 'Cleared', 'Not needed');

CREATE TABLE demo_reminders (
    reminder_id BIGSERIAL PRIMARY KEY,
    demo_id INT NOT NULL REFERENCES demos(demo_id) ON DELETE CASCADE,
    reminder_type demo_reminder_type NOT NULL,
    due_at TIMESTAMP WITH TIME ZONE NOT NULL,
    state demo_reminder_state NOT NULL DEFAULT 'Pending',
    sent_at TIMESTAMP WITH TIME ZONE,
    failure_reason TEXT,
    note VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (demo_id, reminder_type),
    CONSTRAINT demo_reminders_sent_recorded CHECK (state <> 'Sent' OR sent_at IS NOT NULL),
    CONSTRAINT demo_reminders_failure_reason CHECK (state <> 'Failed' OR failure_reason IS NOT NULL)
);

CREATE INDEX demo_reminders_pending_idx ON demo_reminders (due_at) WHERE state = 'Pending';

-- New booking: confirmation now, 24h and 1h reminders (skipped if already past)
CREATE OR REPLACE FUNCTION create_demo_reminders() RETURNS trigger AS $$
BEGIN
    INSERT INTO demo_reminders (demo_id, reminder_type, due_at, state, note)
    SELECT NEW.demo_id, r.kind::demo_reminder_type, r.due_at,
           CASE WHEN r.due_at < CURRENT_TIMESTAMP AND r.kind <> 'Booking confirmation'
                THEN 'Skipped'::demo_reminder_state ELSE 'Pending'::demo_reminder_state END,
           CASE WHEN r.due_at < CURRENT_TIMESTAMP AND r.kind <> 'Booking confirmation'
                THEN 'Booked too close to the demo' END
    FROM (VALUES ('Booking confirmation', CURRENT_TIMESTAMP),
                 ('24h student reminder', NEW.scheduled_at - INTERVAL '24 hours'),
                 ('1h student + trainer reminder', NEW.scheduled_at - INTERVAL '1 hour')) r(kind, due_at);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_demos_create_reminders
    AFTER INSERT ON demos
    FOR EACH ROW WHEN (NEW.status IN ('Scheduled', 'Confirmed'))
    EXECUTE FUNCTION create_demo_reminders();

-- Reschedule supersedes, cancellation clears, attendance / no-show makes pending reminders unnecessary
CREATE OR REPLACE FUNCTION settle_demo_reminders() RETURNS trigger AS $$
BEGIN
    UPDATE demo_reminders
    SET state = CASE NEW.status WHEN 'Rescheduled' THEN 'Superseded'::demo_reminder_state
                                WHEN 'Cancelled' THEN 'Cleared'::demo_reminder_state
                                ELSE 'Not needed'::demo_reminder_state END,
        note = 'Demo ' || LOWER(NEW.status::TEXT)
    WHERE demo_id = NEW.demo_id AND state = 'Pending';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_demos_settle_reminders
    AFTER UPDATE OF status ON demos
    FOR EACH ROW WHEN (NEW.status IN ('Rescheduled', 'Cancelled', 'Attended', 'No Show') AND OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION settle_demo_reminders();

-- ===========================================================================
-- 4. Invoices: issued from an approved fee version; they own the instalment schedule
-- ===========================================================================
CREATE TYPE invoice_status AS ENUM ('Issued', 'Superseded', 'Cancelled');

CREATE TABLE invoices (
    invoice_id SERIAL PRIMARY KEY,
    invoice_number VARCHAR(30) UNIQUE NOT NULL,                     -- INV-GNT-2627-0001 (auto, per collecting branch + FY)
    fee_discussion_id INT NOT NULL REFERENCES fee_discussions(fee_discussion_id),
    fee_version_id INT NOT NULL REFERENCES fee_discussion_versions(version_id),
    person_id INT NOT NULL REFERENCES persons(person_id),
    lead_id INT NOT NULL REFERENCES leads(lead_id),
    course_id INT NOT NULL REFERENCES courses(course_id),
    collecting_branch_id INT NOT NULL REFERENCES branches(branch_id),
    payment_plan_id INT NOT NULL REFERENCES payment_plans(payment_plan_id),
    standard_fee NUMERIC(10, 2) NOT NULL,
    billed_amount NUMERIC(10, 2) NOT NULL CHECK (billed_amount >= 0),
    terms TEXT,                                                     -- approved commercial terms, as printed
    issued_on DATE NOT NULL DEFAULT CURRENT_DATE,
    day0_date DATE NOT NULL,                                        -- Day 0 of the plan (first payment due)
    agreed_due_days SMALLINT[],                                     -- agreed day per instalment, inside the plan windows
    status invoice_status NOT NULL DEFAULT 'Issued',
    superseded_by_invoice_id INT REFERENCES invoices(invoice_id),
    cancel_reason TEXT,
    original_billed_amount NUMERIC(10, 2),                          -- set when an approved fee change revises the amount
    revised_at TIMESTAMP WITH TIME ZONE,
    issued_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT invoices_cancel_reason CHECK (status <> 'Cancelled' OR cancel_reason IS NOT NULL)
);

-- One current invoice per fee discussion
CREATE UNIQUE INDEX invoices_one_issued_per_discussion ON invoices (fee_discussion_id) WHERE status = 'Issued';
CREATE INDEX invoices_person_idx ON invoices (person_id);
CREATE INDEX invoices_branch_issued_idx ON invoices (collecting_branch_id, issued_on);

-- Amounts, plan and parties come from the approved fee version; a re-issue before any payment supersedes the old invoice
CREATE OR REPLACE FUNCTION before_invoice_insert() RETURNS trigger AS $$
DECLARE
    v RECORD;
    v_prefix VARCHAR;
    v_fy TEXT;
    v_count INT;
BEGIN
    SELECT fv.*, d.branch_id AS disc_branch, d.course_id AS disc_course, d.lead_id AS disc_lead, d.milestone,
           l.person_id AS lead_person
    INTO v
    FROM fee_discussion_versions fv
    JOIN fee_discussions d USING (fee_discussion_id)
    JOIN leads l ON l.lead_id = d.lead_id
    WHERE fv.version_id = NEW.fee_version_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown fee version %', NEW.fee_version_id;
    END IF;
    IF v.status <> 'Approved' THEN
        RAISE EXCEPTION 'Invoices are issued only from an Approved fee version (version % is %)', v.version_no, v.status;
    END IF;
    IF v.milestone = 'Converted' THEN
        RAISE EXCEPTION 'This fee discussion is already an admission; fee changes go through admission_fee_changes';
    END IF;
    IF NEW.billed_amount IS NOT NULL AND NEW.billed_amount <> v.final_payable THEN
        RAISE EXCEPTION 'Billed amount % must equal the approved final payable %', NEW.billed_amount, v.final_payable;
    END IF;

    NEW.fee_discussion_id = v.fee_discussion_id;
    NEW.person_id = v.lead_person;
    NEW.lead_id = v.disc_lead;
    NEW.course_id = v.disc_course;
    NEW.collecting_branch_id = v.disc_branch;
    NEW.payment_plan_id = v.payment_plan_id;
    NEW.standard_fee = v.standard_fee;
    NEW.billed_amount = v.final_payable;
    NEW.terms = COALESCE(NEW.terms, format('Standard ₹%s · offer discount ₹%s · extra concession ₹%s · final ₹%s',
                                           v.standard_fee, v.offer_discount, v.extra_concession, v.final_payable));

    IF NEW.agreed_due_days IS NOT NULL THEN
        SELECT COUNT(*) INTO v_count FROM payment_plan_installments WHERE payment_plan_id = NEW.payment_plan_id;
        IF COALESCE(array_length(NEW.agreed_due_days, 1), 0) <> v_count THEN
            RAISE EXCEPTION 'Give one agreed due day per instalment (% expected)', v_count;
        END IF;
        IF EXISTS (SELECT 1 FROM payment_plan_installments pi
                   WHERE pi.payment_plan_id = NEW.payment_plan_id
                     AND NEW.agreed_due_days[pi.installment_no] NOT BETWEEN pi.due_days_min AND pi.due_days_max) THEN
            RAISE EXCEPTION 'Agreed due days must sit inside the plan''s windows';
        END IF;
    END IF;

    -- Re-issue: an unpaid current invoice is superseded by this one; a paid one can't be replaced
    UPDATE invoices i SET status = 'Superseded'
    WHERE i.fee_discussion_id = NEW.fee_discussion_id AND i.status = 'Issued'
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.invoice_id AND p.verification_status <> 'Failed');
    IF EXISTS (SELECT 1 FROM invoices WHERE fee_discussion_id = NEW.fee_discussion_id AND status = 'Issued') THEN
        RAISE EXCEPTION 'The current invoice already has payments; change the fee through an approved fee change';
    END IF;

    IF NEW.invoice_number IS NULL THEN
        SELECT receipt_prefix INTO v_prefix FROM branches WHERE branch_id = NEW.collecting_branch_id;
        v_fy = fy_code(NEW.issued_on);
        NEW.invoice_number = 'INV-' || v_prefix || '-' || v_fy || '-'
            || LPAD(next_number('INVOICE-' || v_prefix || '-' || v_fy)::TEXT, 4, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoices_before_insert
    BEFORE INSERT ON invoices
    FOR EACH ROW EXECUTE FUNCTION before_invoice_insert();

-- Invoices are documents: only status (supersede / cancel) changes, plus the amount through an applied fee change
CREATE OR REPLACE FUNCTION guard_invoice_update() RETURNS trigger AS $$
BEGIN
    IF (NEW.invoice_number, NEW.fee_discussion_id, NEW.fee_version_id, NEW.person_id, NEW.lead_id, NEW.course_id,
        NEW.collecting_branch_id, NEW.payment_plan_id, NEW.standard_fee, NEW.terms, NEW.issued_on, NEW.day0_date,
        NEW.agreed_due_days, NEW.issued_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.invoice_number, OLD.fee_discussion_id, OLD.fee_version_id, OLD.person_id, OLD.lead_id, OLD.course_id,
        OLD.collecting_branch_id, OLD.payment_plan_id, OLD.standard_fee, OLD.terms, OLD.issued_on, OLD.day0_date,
        OLD.agreed_due_days, OLD.issued_by, OLD.created_at) THEN
        RAISE EXCEPTION 'Invoices are immutable; issue a new invoice instead';
    END IF;
    IF NEW.billed_amount IS DISTINCT FROM OLD.billed_amount
       AND COALESCE(current_setting('app.applying_fee_change', TRUE), '') <> 'on' THEN
        RAISE EXCEPTION 'The billed amount changes only through an approved fee change';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF OLD.status <> 'Issued' THEN
            RAISE EXCEPTION 'Invoice % is already %', OLD.invoice_number, OLD.status;
        END IF;
        IF NEW.status = 'Cancelled' AND EXISTS (
            SELECT 1 FROM payments WHERE invoice_id = OLD.invoice_id AND verification_status <> 'Failed') THEN
            RAISE EXCEPTION 'Invoice % has payments and can''t be cancelled', OLD.invoice_number;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoices_guard
    BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION guard_invoice_update();

CREATE TRIGGER trg_invoices_updated_at
    BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- 5. Instalments move from the admission to the invoice
-- ===========================================================================
DROP VIEW installment_dues;                                         -- rebuilt below at invoice level
DROP VIEW unallocated_advances;                                     -- rebuilt below without fee_discussion_id

ALTER TABLE installments
    DROP COLUMN admission_id,
    ADD COLUMN invoice_id INT NOT NULL REFERENCES invoices(invoice_id),
    ADD CONSTRAINT installments_invoice_no_key UNIQUE (invoice_id, installment_no);

-- After an invoice is issued: build its schedule from Day 0 (agreed days or plan defaults), rounding into the last instalment
CREATE OR REPLACE FUNCTION after_invoice_insert() RETURNS trigger AS $$
DECLARE
    v_percent_total NUMERIC;
BEGIN
    IF NEW.billed_amount > 0 THEN
        SELECT SUM(percent_of_fee) INTO v_percent_total FROM payment_plan_installments WHERE payment_plan_id = NEW.payment_plan_id;
        IF v_percent_total IS DISTINCT FROM 100 THEN
            RAISE EXCEPTION 'Payment plan % installments add up to % percent, expected 100',
                NEW.payment_plan_id, COALESCE(v_percent_total, 0);
        END IF;

        INSERT INTO installments (invoice_id, installment_no, amount_due, due_date)
        SELECT NEW.invoice_id,
               installment_no,
               CASE WHEN installment_no = MAX(installment_no) OVER ()
                    THEN NEW.billed_amount - (SUM(amount) OVER () - amount) ELSE amount END,
               NEW.day0_date + COALESCE(NEW.agreed_due_days[installment_no], due_days_after_admission)
        FROM (SELECT installment_no, due_days_after_admission, ROUND(NEW.billed_amount * percent_of_fee / 100, 2) AS amount
              FROM payment_plan_installments WHERE payment_plan_id = NEW.payment_plan_id) plan;
    END IF;

    UPDATE invoices SET superseded_by_invoice_id = NEW.invoice_id
    WHERE fee_discussion_id = NEW.fee_discussion_id AND status = 'Superseded' AND superseded_by_invoice_id IS NULL
      AND invoice_id <> NEW.invoice_id;
    UPDATE fee_discussions SET milestone = 'Invoice Issued'
    WHERE fee_discussion_id = NEW.fee_discussion_id AND milestone NOT IN ('Invoice Issued', 'Converted');
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoices_after_insert
    AFTER INSERT ON invoices
    FOR EACH ROW EXECUTE FUNCTION after_invoice_insert();

-- Due dates stay inside the plan window (relative to the invoice's Day 0); amounts change only via fee changes
CREATE OR REPLACE FUNCTION guard_installment_update() RETURNS trigger AS $$
DECLARE
    v_invoice invoices%ROWTYPE;
    v_rule payment_plan_installments%ROWTYPE;
BEGIN
    IF NEW.amount_due IS DISTINCT FROM OLD.amount_due
       AND COALESCE(current_setting('app.applying_fee_change', TRUE), '') <> 'on' THEN
        RAISE EXCEPTION 'Installment amounts change only through an approved fee change';
    END IF;
    IF (NEW.invoice_id, NEW.installment_no) IS DISTINCT FROM (OLD.invoice_id, OLD.installment_no) THEN
        RAISE EXCEPTION 'Installment identity cannot change';
    END IF;
    IF NEW.due_date IS DISTINCT FROM OLD.due_date THEN
        SELECT * INTO v_invoice FROM invoices WHERE invoice_id = NEW.invoice_id;
        SELECT * INTO v_rule FROM payment_plan_installments
        WHERE payment_plan_id = v_invoice.payment_plan_id AND installment_no = NEW.installment_no;
        IF NEW.due_date NOT BETWEEN v_invoice.day0_date + v_rule.due_days_min AND v_invoice.day0_date + v_rule.due_days_max THEN
            RAISE EXCEPTION 'Due date must be between Day % and Day % of the plan', v_rule.due_days_min, v_rule.due_days_max;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- 6. Payments are allocated to invoices; corrections need an approved request
-- ===========================================================================
ALTER TABLE payments
    DROP COLUMN fee_discussion_id,
    ADD COLUMN invoice_id INT REFERENCES invoices(invoice_id),      -- NULL = unallocated advance
    ADD COLUMN correction_request_id INT,                           -- FK added below
    ADD COLUMN proof_file_path VARCHAR(500),
    ADD CONSTRAINT payments_advance_has_no_admission CHECK (invoice_id IS NOT NULL OR admission_id IS NULL);

CREATE INDEX payments_invoice_idx ON payments (invoice_id);
CREATE INDEX payments_unallocated_idx ON payments (person_id) WHERE invoice_id IS NULL;

CREATE TYPE correction_request_status AS ENUM ('Pending Approval', 'Approved', 'Rejected');

CREATE TABLE payment_correction_requests (
    correction_request_id SERIAL PRIMARY KEY,
    request_code VARCHAR(20) UNIQUE NOT NULL,                       -- CR-GNT-0001 (auto, per collecting branch)
    payment_id INT NOT NULL REFERENCES payments(payment_id),
    amount NUMERIC(10, 2) NOT NULL,                                 -- the receipt amount being reversed
    reason TEXT NOT NULL,
    status correction_request_status NOT NULL DEFAULT 'Pending Approval',
    requested_by INT NOT NULL REFERENCES users(user_id),
    requested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_by INT REFERENCES users(user_id),
    decided_at TIMESTAMP WITH TIME ZONE,
    decision_note TEXT,
    reversal_payment_id INT REFERENCES payments(payment_id),

    CONSTRAINT correction_requests_no_self_approval CHECK (decided_by IS NULL OR decided_by <> requested_by),
    CONSTRAINT correction_requests_decision_recorded
        CHECK (status = 'Pending Approval' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);

CREATE UNIQUE INDEX correction_requests_one_pending ON payment_correction_requests (payment_id) WHERE status = 'Pending Approval';

ALTER TABLE payments
    ADD CONSTRAINT payments_correction_request_fkey
        FOREIGN KEY (correction_request_id) REFERENCES payment_correction_requests(correction_request_id),
    ADD CONSTRAINT payments_reversal_needs_request CHECK (entry_type <> 'Reversal' OR correction_request_id IS NOT NULL);

-- Allocation cap: never more than the invoice's billed amount (less approved waivers)
CREATE OR REPLACE FUNCTION check_payment_allocation(p payments) RETURNS VOID AS $$
DECLARE
    v_invoice invoices%ROWTYPE;
    v_already NUMERIC;
    v_waived NUMERIC;
BEGIN
    IF p.invoice_id IS NULL THEN
        RETURN;  -- unallocated advance: no cap
    END IF;
    SELECT * INTO v_invoice FROM invoices WHERE invoice_id = p.invoice_id FOR UPDATE;
    IF v_invoice.status <> 'Issued' THEN
        RAISE EXCEPTION 'Invoice % is %; record payments against the current invoice', v_invoice.invoice_number, v_invoice.status;
    END IF;
    IF v_invoice.person_id <> p.person_id THEN
        RAISE EXCEPTION 'Payment belongs to a different person than invoice %', v_invoice.invoice_number;
    END IF;

    SELECT COALESCE(SUM(amount), 0) INTO v_already FROM payments
    WHERE invoice_id = p.invoice_id AND verification_status <> 'Failed' AND payment_id IS DISTINCT FROM p.payment_id;
    SELECT COALESCE(SUM(r.approved_waiver_amount), 0) INTO v_waived
    FROM refund_cases r JOIN admissions a ON a.admission_id = r.admission_id
    WHERE a.invoice_id = p.invoice_id AND r.refund_decision = 'Waiver Approved';

    IF p.entry_type = 'Payment' AND v_already + p.amount > v_invoice.billed_amount - v_waived THEN
        RAISE EXCEPTION 'Payment of % exceeds outstanding % on invoice %; record the excess as an unallocated advance',
            p.amount, v_invoice.billed_amount - v_waived - v_already, v_invoice.invoice_number;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION before_payment_insert() RETURNS trigger AS $$
DECLARE
    v_prefix VARCHAR;
    v_fy TEXT;
    v_original payments%ROWTYPE;
    v_request payment_correction_requests%ROWTYPE;
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

        IF NEW.invoice_id IS NOT NULL THEN
            SELECT COALESCE(NEW.person_id, person_id), COALESCE(NEW.lead_id, lead_id) INTO NEW.person_id, NEW.lead_id
            FROM invoices WHERE invoice_id = NEW.invoice_id;
            NEW.admission_id = (SELECT admission_id FROM admissions WHERE invoice_id = NEW.invoice_id);
        ELSIF NEW.lead_id IS NOT NULL AND NEW.person_id IS NULL THEN
            SELECT person_id INTO NEW.person_id FROM leads WHERE lead_id = NEW.lead_id;
        END IF;
        PERFORM check_payment_allocation(NEW);
    ELSE
        -- A reversal exists only because a correction request was approved (the approval inserts it)
        SELECT * INTO v_request FROM payment_correction_requests WHERE correction_request_id = NEW.correction_request_id;
        IF v_request.correction_request_id IS NULL OR v_request.status <> 'Approved'
           OR v_request.payment_id IS DISTINCT FROM NEW.reverses_payment_id THEN
            RAISE EXCEPTION 'A reversal needs an approved correction request for that payment';
        END IF;
        SELECT * INTO v_original FROM payments WHERE payment_id = NEW.reverses_payment_id;
        IF v_original.entry_type <> 'Payment' OR v_original.verification_status <> 'Verified' THEN
            RAISE EXCEPTION 'A reversal must point to a Verified payment';
        END IF;
        IF NEW.amount <> -v_original.amount THEN
            RAISE EXCEPTION 'Reversal amount must be % (the negative of the original)', -v_original.amount;
        END IF;
        NEW.person_id = v_original.person_id;
        NEW.lead_id = v_original.lead_id;
        NEW.invoice_id = v_original.invoice_id;
        NEW.admission_id = v_original.admission_id;
        NEW.reversal_reason = COALESCE(NEW.reversal_reason, v_request.reason);
    END IF;

    IF NEW.verification_status = 'Verified' THEN
        NEW.verified_at = COALESCE(NEW.verified_at, CURRENT_TIMESTAMP);
    END IF;

    IF NEW.receipt_number IS NULL THEN
        SELECT receipt_prefix INTO v_prefix FROM branches WHERE branch_id = NEW.collecting_branch_id;
        v_fy = fy_code(NEW.payment_date);
        NEW.receipt_number = CASE NEW.entry_type
            WHEN 'Payment' THEN v_prefix || '-R-' || v_fy || '-' || LPAD(next_number('RECEIPT-' || v_prefix || '-' || v_fy)::TEXT, 5, '0')
            ELSE 'REV-' || v_prefix || '-' || v_fy || '-' || LPAD(next_number('REVERSAL-' || v_prefix || '-' || v_fy)::TEXT, 5, '0')
        END;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Immutable except: verification (once), allocation to an invoice (once, from empty),
-- the admission link (set when the admission is created) and a proof file (once)
CREATE OR REPLACE FUNCTION before_payment_update() RETURNS trigger AS $$
BEGIN
    IF (NEW.receipt_number, NEW.person_id, NEW.lead_id, NEW.entry_type, NEW.amount, NEW.payment_mode_id,
        NEW.payment_date, NEW.reference, NEW.collected_by, NEW.collecting_branch_id, NEW.exception_approved_by,
        NEW.reverses_payment_id, NEW.reversal_reason, NEW.correction_request_id, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.receipt_number, OLD.person_id, OLD.lead_id, OLD.entry_type, OLD.amount, OLD.payment_mode_id,
        OLD.payment_date, OLD.reference, OLD.collected_by, OLD.collecting_branch_id, OLD.exception_approved_by,
        OLD.reverses_payment_id, OLD.reversal_reason, OLD.correction_request_id, OLD.created_by, OLD.created_at) THEN
        RAISE EXCEPTION 'Payments are immutable; request a correction instead';
    END IF;

    IF (OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id)
       OR (OLD.admission_id IS NOT NULL AND NEW.admission_id IS DISTINCT FROM OLD.admission_id)
       OR (OLD.proof_file_path IS NOT NULL AND NEW.proof_file_path IS DISTINCT FROM OLD.proof_file_path) THEN
        RAISE EXCEPTION 'Payment % is already allocated / documented; request a correction to change it', OLD.receipt_number;
    END IF;

    IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
        IF EXISTS (SELECT 1 FROM payments WHERE reverses_payment_id = OLD.payment_id) THEN
            RAISE EXCEPTION 'Payment % has been reversed and cannot be allocated', OLD.receipt_number;
        END IF;
        NEW.admission_id = (SELECT admission_id FROM admissions WHERE invoice_id = NEW.invoice_id);
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

-- Correction requests: only a Verified, un-reversed receipt; requested by Accounts / Founder / Super Admin
CREATE OR REPLACE FUNCTION before_correction_request_insert() RETURNS trigger AS $$
DECLARE
    v_payment payments%ROWTYPE;
    v_prefix VARCHAR;
BEGIN
    SELECT * INTO v_payment FROM payments WHERE payment_id = NEW.payment_id;
    IF v_payment.entry_type IS DISTINCT FROM 'Payment' THEN
        RAISE EXCEPTION 'Only payment receipts can be corrected';
    END IF;
    IF v_payment.verification_status = 'Pending Verification' THEN
        RAISE EXCEPTION 'Receipt % is Pending Verification; Accounts should mark it Failed instead — unverified money is never reversed',
            v_payment.receipt_number;
    END IF;
    IF v_payment.verification_status = 'Failed' THEN
        RAISE EXCEPTION 'Receipt % failed verification and was never counted; no reversal is needed', v_payment.receipt_number;
    END IF;
    IF EXISTS (SELECT 1 FROM payments WHERE reverses_payment_id = NEW.payment_id) THEN
        RAISE EXCEPTION 'Receipt % already has a linked reversal', v_payment.receipt_number;
    END IF;
    IF NOT user_has_role(NEW.requested_by, ARRAY['ACCOUNTS', 'FOUNDER_CEO', 'SUPER_ADMIN'], v_payment.collecting_branch_id) THEN
        RAISE EXCEPTION 'Only Accounts, Founder / CEO or Super Admin can request corrections';
    END IF;

    NEW.amount = v_payment.amount;
    IF NEW.request_code IS NULL THEN
        SELECT receipt_prefix INTO v_prefix FROM branches WHERE branch_id = v_payment.collecting_branch_id;
        NEW.request_code = 'CR-' || v_prefix || '-' || LPAD(next_number('CORRECTION-' || v_prefix)::TEXT, 4, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_correction_requests_before_insert
    BEFORE INSERT ON payment_correction_requests
    FOR EACH ROW EXECUTE FUNCTION before_correction_request_insert();

-- Decision: a distinct Founder / CEO or Super Admin; the original must still be a verified, un-reversed receipt
CREATE OR REPLACE FUNCTION before_correction_decision() RETURNS trigger AS $$
DECLARE
    v_payment payments%ROWTYPE;
BEGIN
    IF OLD.status <> 'Pending Approval' THEN
        RAISE EXCEPTION 'Correction request % is already %', OLD.request_code, OLD.status;
    END IF;
    SELECT * INTO v_payment FROM payments WHERE payment_id = NEW.payment_id;
    IF NOT user_has_role(NEW.decided_by, ARRAY['FOUNDER_CEO', 'SUPER_ADMIN'], v_payment.collecting_branch_id) THEN
        RAISE EXCEPTION 'Only Founder / CEO or Super Admin can decide corrections';
    END IF;
    IF NEW.status = 'Approved' AND (v_payment.verification_status <> 'Verified'
        OR EXISTS (SELECT 1 FROM payments WHERE reverses_payment_id = NEW.payment_id)) THEN
        RAISE EXCEPTION 'Receipt % is no longer a verified, un-reversed payment', v_payment.receipt_number;
    END IF;
    NEW.decided_at = COALESCE(NEW.decided_at, CURRENT_TIMESTAMP);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_correction_requests_decision
    BEFORE UPDATE OF status ON payment_correction_requests
    FOR EACH ROW WHEN (NEW.status <> 'Pending Approval' AND OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION before_correction_decision();

-- Approval appends the linked reversal (verified by the approver); the original receipt is kept
CREATE OR REPLACE FUNCTION after_correction_approved() RETURNS trigger AS $$
DECLARE
    v_payment payments%ROWTYPE;
    v_reversal_id INT;
BEGIN
    SELECT * INTO v_payment FROM payments WHERE payment_id = NEW.payment_id;
    INSERT INTO payments (entry_type, amount, reverses_payment_id, correction_request_id, reversal_reason,
                          collecting_branch_id, person_id, verification_status, verified_by, created_by)
    VALUES ('Reversal', -v_payment.amount, v_payment.payment_id, NEW.correction_request_id, NEW.reason,
            v_payment.collecting_branch_id, v_payment.person_id, 'Verified', NEW.decided_by, NEW.decided_by)
    RETURNING payment_id INTO v_reversal_id;

    UPDATE payment_correction_requests SET reversal_payment_id = v_reversal_id
    WHERE correction_request_id = NEW.correction_request_id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_correction_requests_approved
    AFTER UPDATE OF status ON payment_correction_requests
    FOR EACH ROW WHEN (NEW.status = 'Approved' AND OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION after_correction_approved();

-- ===========================================================================
-- 7. Admissions are created from an invoice
-- ===========================================================================
ALTER TABLE admissions
    ADD COLUMN invoice_id INT UNIQUE REFERENCES invoices(invoice_id),
    ADD COLUMN first_qualifying_payment_id INT REFERENCES payments(payment_id),
    DROP CONSTRAINT admissions_commercial_basis,
    ADD CONSTRAINT admissions_commercial_basis CHECK (invoice_id IS NOT NULL OR complimentary_of_admission_id IS NOT NULL);

-- The invoice no longer lives on the fee discussion
ALTER TABLE fee_discussions
    DROP CONSTRAINT fee_discussions_check,
    DROP COLUMN invoice_number,
    DROP COLUMN invoice_issued_at;

-- Prerequisites: (1) accepted confirmed delivery plan on the invoice's fee version,
-- (2) first qualifying payment on the invoice Verified. Parties, fee and plan come from the invoice.
CREATE OR REPLACE FUNCTION before_admission_insert() RETURNS trigger AS $$
DECLARE
    v_prefix VARCHAR;
    v_year TEXT;
    v RECORD;
    v_first RECORD;
    v_parent admissions%ROWTYPE;
    v_rule offer_complimentary_courses%ROWTYPE;
BEGIN
    IF NEW.complimentary_of_admission_id IS NULL THEN
        IF NEW.invoice_id IS NULL THEN
            RAISE EXCEPTION 'An admission is created from its invoice (invoice_id is required)';
        END IF;
        SELECT i.*, d.accepted_version_id, d.plan_accepted_at, d.delivery_mode AS plan_mode, d.seat_type AS plan_seat,
               d.planned_start_date AS plan_start, d.branch_id AS lead_branch
        INTO v
        FROM invoices i JOIN fee_discussions d USING (fee_discussion_id)
        WHERE i.invoice_id = NEW.invoice_id;

        IF v.status <> 'Issued' THEN
            RAISE EXCEPTION 'Invoice % is %', v.invoice_number, v.status;
        END IF;
        IF v.plan_accepted_at IS NULL OR v.accepted_version_id IS DISTINCT FROM v.fee_version_id THEN
            RAISE EXCEPTION 'Prerequisite missing: accepted confirmed delivery plan on this invoice''s fee version';
        END IF;
        IF NEW.final_fee IS NOT NULL AND NEW.final_fee <> v.billed_amount THEN
            RAISE EXCEPTION 'Admission final_fee % does not match invoice amount %', NEW.final_fee, v.billed_amount;
        END IF;
        IF NEW.person_id IS NOT NULL AND NEW.person_id <> v.person_id THEN
            RAISE EXCEPTION 'Admission person must match the invoice';
        END IF;

        SELECT p.payment_id, p.verified_at INTO v_first
        FROM payments p
        WHERE p.invoice_id = NEW.invoice_id AND p.entry_type = 'Payment' AND p.verification_status = 'Verified'
          AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.payment_id)
        ORDER BY p.verified_at, p.payment_id
        LIMIT 1;
        IF v_first.payment_id IS NULL THEN
            RAISE EXCEPTION 'Prerequisite missing: first qualifying allocated payment must be Verified by Accounts';
        END IF;

        NEW.first_qualifying_payment_id = v_first.payment_id;
        NEW.first_verified_payment_at = v_first.verified_at;
        NEW.person_id = v.person_id;
        NEW.lead_id = v.lead_id;
        NEW.course_id = v.course_id;
        NEW.fee_version_id = v.fee_version_id;
        NEW.final_fee = v.billed_amount;
        NEW.payment_plan_id = v.payment_plan_id;
        NEW.original_branch_id = COALESCE(NEW.original_branch_id, v.lead_branch);
        NEW.service_branch_id = COALESCE(NEW.service_branch_id, NEW.original_branch_id);
        NEW.delivery_mode = COALESCE(v.plan_mode, NEW.delivery_mode);
        NEW.seat_type = COALESCE(NEW.seat_type, v.plan_seat, 'Confirmed Seat');
        NEW.planned_start_date = COALESCE(NEW.planned_start_date, v.plan_start);
    ELSE
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
        NEW.first_verified_payment_at = NULL;
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

-- After insert: link the invoice's payments, discussion -> Converted, lead -> Admitted (the schedule already exists on the invoice)
CREATE OR REPLACE FUNCTION after_admission_insert() RETURNS trigger AS $$
BEGIN
    IF NEW.invoice_id IS NOT NULL THEN
        UPDATE payments SET admission_id = NEW.admission_id WHERE invoice_id = NEW.invoice_id AND admission_id IS NULL;
        UPDATE fee_discussions SET milestone = 'Converted'
        WHERE fee_discussion_id = (SELECT fee_discussion_id FROM invoices WHERE invoice_id = NEW.invoice_id);
    END IF;
    IF NEW.lead_id IS NOT NULL THEN
        UPDATE leads SET stage = 'Admitted' WHERE lead_id = NEW.lead_id AND stage <> 'Admitted';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Applied fee change revises the invoice amount and its instalments (due dates kept)
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
        IF v_admission.invoice_id IS NOT NULL THEN
            UPDATE invoices
            SET original_billed_amount = COALESCE(original_billed_amount, billed_amount),
                billed_amount = NEW.new_fee, revised_at = CURRENT_TIMESTAMP
            WHERE invoice_id = v_admission.invoice_id;
            UPDATE installments i SET amount_due = x.amount
            FROM (
                SELECT installment_no,
                       CASE WHEN installment_no = MAX(installment_no) OVER ()
                            THEN NEW.new_fee - (SUM(amount) OVER () - amount) ELSE amount END AS amount
                FROM (SELECT installment_no, ROUND(NEW.new_fee * percent_of_fee / 100, 2) AS amount
                      FROM payment_plan_installments WHERE payment_plan_id = v_admission.payment_plan_id) p
            ) x
            WHERE i.invoice_id = v_admission.invoice_id AND i.installment_no = x.installment_no;
        END IF;
        PERFORM set_config('app.applying_fee_change', 'off', TRUE);
        NEW.applied_at = COALESCE(NEW.applied_at, CURRENT_TIMESTAMP);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- 8. Balance and dues views at invoice level
-- ===========================================================================
CREATE VIEW invoice_balances AS
SELECT
    i.invoice_id,
    i.invoice_number,
    i.person_id,
    i.lead_id,
    a.admission_id,
    i.course_id,
    i.collecting_branch_id,
    i.issued_on,
    i.status,
    i.billed_amount,
    COALESCE(p.verified_paid, 0) AS verified_paid,
    COALESCE(p.pending_verification, 0) AS pending_verification,   -- never counted
    COALESCE(w.waived, 0) AS waived,
    GREATEST(i.billed_amount - COALESCE(p.verified_paid, 0) - COALESCE(w.waived, 0), 0) AS outstanding,
    CASE
        WHEN COALESCE(p.verified_paid, 0) <= 0 THEN 'Unpaid'
        WHEN i.billed_amount - COALESCE(p.verified_paid, 0) - COALESCE(w.waived, 0) <= 0 THEN 'Paid'
        ELSE 'Part Paid'
    END AS payment_completion,
    CASE
        WHEN i.status <> 'Issued' THEN i.status::TEXT
        WHEN i.billed_amount - COALESCE(p.verified_paid, 0) - COALESCE(w.waived, 0) <= 0 THEN 'Paid'
        WHEN COALESCE(p.verified_paid, 0) > 0 THEN 'Part Paid'
        ELSE 'Issued'
    END AS invoice_state
FROM invoices i
LEFT JOIN admissions a ON a.invoice_id = i.invoice_id
LEFT JOIN (
    SELECT invoice_id,
           SUM(amount) FILTER (WHERE verification_status = 'Verified') AS verified_paid,
           SUM(amount) FILTER (WHERE verification_status = 'Pending Verification' AND amount > 0) AS pending_verification
    FROM payments WHERE invoice_id IS NOT NULL GROUP BY invoice_id
) p ON p.invoice_id = i.invoice_id
LEFT JOIN (
    SELECT admission_id, SUM(approved_waiver_amount) AS waived
    FROM refund_cases WHERE refund_decision = 'Waiver Approved' GROUP BY admission_id
) w ON w.admission_id = a.admission_id;

-- Verified money (plus waivers) is applied to the current invoice's instalments oldest-first.
-- Pre-admission invoices appear too; superseded / cancelled invoices don't.
CREATE VIEW installment_dues AS
WITH running AS (
    SELECT inst.*,
           SUM(inst.amount_due) OVER (PARTITION BY inst.invoice_id ORDER BY inst.installment_no) AS cumulative_due
    FROM installments inst
),
applied AS (
    SELECT r.*,
           b.invoice_number,
           b.admission_id,
           b.person_id,
           b.collecting_branch_id,
           b.pending_verification,
           a.enrolment_status,
           LEAST(r.amount_due, GREATEST(0, b.verified_paid + b.waived - (r.cumulative_due - r.amount_due))) AS amount_covered
    FROM running r
    JOIN invoice_balances b ON b.invoice_id = r.invoice_id
    LEFT JOIN admissions a ON a.admission_id = b.admission_id
    WHERE b.status = 'Issued'
)
SELECT
    installment_id,
    invoice_id,
    invoice_number,
    admission_id,
    person_id,
    collecting_branch_id,
    installment_no,
    due_date,
    amount_due,
    amount_covered,
    amount_due - amount_covered AS balance,
    CASE
        WHEN enrolment_status = 'Cancelled' THEN 'Cancelled'
        WHEN amount_due - amount_covered = 0 THEN 'Paid'
        WHEN due_date < CURRENT_DATE THEN 'Overdue'
        WHEN due_date = CURRENT_DATE THEN 'Due Today'
        ELSE 'Upcoming'
    END AS due_position,
    CASE WHEN amount_due - amount_covered > 0 AND due_date < CURRENT_DATE THEN CURRENT_DATE - due_date END AS days_overdue,
    CASE
        WHEN amount_due - amount_covered = 0 OR due_date >= CURRENT_DATE OR enrolment_status = 'Cancelled' THEN NULL
        WHEN CURRENT_DATE - due_date <= 3 THEN '1–3'
        WHEN CURRENT_DATE - due_date <= 7 THEN '4–7'
        WHEN CURRENT_DATE - due_date <= 15 THEN '8–15'
        WHEN CURRENT_DATE - due_date <= 30 THEN '16–30'
        WHEN CURRENT_DATE - due_date <= 60 THEN '31–60'
        WHEN CURRENT_DATE - due_date <= 90 THEN '61–90'
        ELSE '91+'
    END AS age_band,
    pending_verification > 0 AS contact_hold                           -- pause chasing; ageing stays visible
FROM applied;

CREATE VIEW unallocated_advances AS
SELECT p.payment_id, p.receipt_number, p.person_id, p.lead_id, p.amount, p.payment_date,
       p.collecting_branch_id, p.verification_status
FROM payments p
WHERE p.entry_type = 'Payment' AND p.invoice_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.payment_id);

-- ===========================================================================
-- 9. Batch workspace: curriculum version, room / link, minimum students; stricter allocation
-- ===========================================================================
ALTER TABLE batches
    ADD COLUMN curriculum_version_id INT REFERENCES curriculum_versions(curriculum_version_id),
    ADD COLUMN location VARCHAR(255),                                -- room or class link
    ADD COLUMN min_students SMALLINT CHECK (min_students > 0),
    ADD CONSTRAINT batches_min_within_capacity CHECK (min_students IS NULL OR min_students <= capacity);

CREATE OR REPLACE FUNCTION before_allocation_insert() RETURNS trigger AS $$
DECLARE
    v_batch batches%ROWTYPE;
    v_admission admissions%ROWTYPE;
    v_taken INT;
BEGIN
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

CREATE OR REPLACE VIEW batch_occupancy AS
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
    b.capacity - COUNT(a.allocation_id) AS seats_left,
    b.min_students,
    COUNT(a.allocation_id) >= b.capacity AS is_full
FROM batches b
LEFT JOIN batch_allocations a ON a.batch_id = b.batch_id AND a.status = 'Active'
GROUP BY b.batch_id;

-- ===========================================================================
-- 10. Tasks can link to invoices and correction requests
-- ===========================================================================
ALTER TABLE tasks
    ADD COLUMN invoice_id INT REFERENCES invoices(invoice_id),
    ADD COLUMN correction_request_id INT REFERENCES payment_correction_requests(correction_request_id),
    DROP CONSTRAINT tasks_one_linked_record,
    ADD CONSTRAINT tasks_one_linked_record
        CHECK (num_nonnulls(lead_id, demo_id, fee_discussion_id, scr_id, admission_id, payment_id, refund_case_id,
                            document_id, communication_id, support_case_id, enquiry_id, invoice_id, correction_request_id) <= 1);

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
             sc.case_code, e.enquiry_code, i.invoice_number, cr.request_code, d.demo_code,
             'DOC-' || t.document_id, 'COMM-' || t.communication_id) AS linked_record
FROM tasks t
JOIN task_types tt USING (task_type_id)
LEFT JOIN leads l ON l.lead_id = t.lead_id
LEFT JOIN fee_discussions fd ON fd.fee_discussion_id = t.fee_discussion_id
LEFT JOIN special_closing_requests s ON s.scr_id = t.scr_id
LEFT JOIN admissions a ON a.admission_id = t.admission_id
LEFT JOIN payments p ON p.payment_id = t.payment_id
LEFT JOIN refund_cases r ON r.refund_case_id = t.refund_case_id
LEFT JOIN support_cases sc ON sc.support_case_id = t.support_case_id
LEFT JOIN enquiries e ON e.enquiry_id = t.enquiry_id
LEFT JOIN invoices i ON i.invoice_id = t.invoice_id
LEFT JOIN payment_correction_requests cr ON cr.correction_request_id = t.correction_request_id
LEFT JOIN demos d ON d.demo_id = t.demo_id;
