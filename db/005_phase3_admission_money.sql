-- Phase 3: admission & money (admissions, installments, payments, promises, refunds)
-- Depends on: 004_phase2_commercials.sql

-- ---------------------------------------------------------------------------
-- Founder / CEO approves financial refunds and waivers alongside Super Admin
-- ---------------------------------------------------------------------------
INSERT INTO roles (role_code, role_name, is_company_wide) VALUES ('FOUNDER_CEO', 'Founder / CEO', TRUE);
INSERT INTO concession_limits (role_id, max_percent, max_amount)
    SELECT role_id, NULL, NULL FROM roles WHERE role_code = 'FOUNDER_CEO';

-- ---------------------------------------------------------------------------
-- Financial year code for receipt numbers: 2026-09-26 -> '2627' (Apr–Mar)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fy_code(d DATE) RETURNS TEXT AS $$
    SELECT CASE WHEN EXTRACT(MONTH FROM d) >= 4
        THEN TO_CHAR(d, 'YY') || TO_CHAR(d + INTERVAL '1 year', 'YY')
        ELSE TO_CHAR(d - INTERVAL '1 year', 'YY') || TO_CHAR(d, 'YY')
    END;
$$ LANGUAGE sql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE delivery_mode AS ENUM ('Classroom', 'Online', 'Hybrid');

CREATE TYPE enrolment_status AS ENUM (
    'Awaiting Batch Allocation', 'Scheduled', 'In Progress', 'Deferred', 'Paused', 'Completed', 'Cancelled'
);

CREATE TYPE curriculum_status AS ENUM ('Mapping Pending', 'Mapped');

CREATE TYPE handover_status AS ENUM ('Pending', 'Completed');

CREATE TYPE lms_status AS ENUM ('Not Created', 'Invited', 'Active', 'Inactive', 'Completed');

CREATE TYPE payment_entry_type AS ENUM ('Payment', 'Reversal');

CREATE TYPE payment_verification AS ENUM ('Pending Verification', 'Verified', 'Failed');

CREATE TYPE promise_status AS ENUM ('Pending', 'Kept', 'Broken', 'Cancelled');

CREATE TYPE refund_case_status AS ENUM ('Registered', 'Under Assessment', 'Decided', 'Completed', 'Withdrawn');

CREATE TYPE refund_evidence_status AS ENUM ('Evidence Pending', 'Evidence Complete');

CREATE TYPE refund_decision AS ENUM ('Pending', 'Refund Approved', 'Waiver Approved', 'Rejected');

CREATE TYPE payout_status AS ENUM ('Not Started', 'Approved', 'Processing', 'Completed', 'Failed');

-- ---------------------------------------------------------------------------
-- Admissions
-- ---------------------------------------------------------------------------
CREATE TABLE admissions (
    admission_id SERIAL PRIMARY KEY,
    admission_code VARCHAR(30) UNIQUE NOT NULL,     -- e.g., 'NIT-GNT-2026-000001' (auto-generated)
    person_id INT NOT NULL REFERENCES persons(person_id),
    lead_id INT REFERENCES leads(lead_id),
    fee_version_id INT REFERENCES fee_discussion_versions(version_id), -- the accepted commercial
    course_id INT NOT NULL REFERENCES courses(course_id),
    original_branch_id INT NOT NULL REFERENCES branches(branch_id),   -- where the student joined
    service_branch_id INT NOT NULL REFERENCES branches(branch_id),    -- where they study now (transfers)
    delivery_mode delivery_mode NOT NULL DEFAULT 'Classroom',

    -- Fee and plan are frozen once the admission exists; installments are built from them
    final_fee NUMERIC(10, 2) NOT NULL CHECK (final_fee >= 0),
    payment_plan_id INT NOT NULL REFERENCES payment_plans(payment_plan_id),
    admission_date DATE NOT NULL DEFAULT CURRENT_DATE,
    counsellor_id INT REFERENCES users(user_id),
    first_verified_payment_at TIMESTAMP WITH TIME ZONE, -- counts as a "New Paid Admission" from this date

    -- Academic handover
    enrolment_status enrolment_status NOT NULL DEFAULT 'Awaiting Batch Allocation',
    curriculum_status curriculum_status NOT NULL DEFAULT 'Mapping Pending',
    handover_status handover_status NOT NULL DEFAULT 'Pending',
    lms_status lms_status NOT NULL DEFAULT 'Not Created',

    -- Operational cancellation (Branch Manager); any refund is a separate refund case
    cancelled_by INT REFERENCES users(user_id),
    cancelled_at TIMESTAMP WITH TIME ZONE,
    cancellation_reason TEXT,

    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT admissions_cancellation_recorded
        CHECK (enrolment_status <> 'Cancelled'
               OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL))
);

CREATE UNIQUE INDEX admissions_one_per_lead ON admissions (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX admissions_person_idx ON admissions (person_id);
CREATE INDEX admissions_service_branch_status_idx ON admissions (service_branch_id, enrolment_status);
CREATE INDEX admissions_first_verified_idx ON admissions (first_verified_payment_at);

CREATE OR REPLACE FUNCTION before_admission_insert() RETURNS trigger AS $$
DECLARE
    v_prefix VARCHAR;
    v_year TEXT;
    v_version_fee NUMERIC;
BEGIN
    IF NEW.fee_version_id IS NOT NULL THEN
        SELECT final_payable INTO v_version_fee
        FROM fee_discussion_versions WHERE version_id = NEW.fee_version_id;
        IF NEW.final_fee <> v_version_fee THEN
            RAISE EXCEPTION 'Admission final_fee % does not match fee version final_payable %',
                NEW.final_fee, v_version_fee;
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

CREATE TRIGGER trg_admissions_before_insert
    BEFORE INSERT ON admissions
    FOR EACH ROW EXECUTE FUNCTION before_admission_insert();

CREATE OR REPLACE FUNCTION prevent_admission_fee_change() RETURNS trigger AS $$
BEGIN
    IF (NEW.final_fee, NEW.payment_plan_id, NEW.admission_date)
       IS DISTINCT FROM (OLD.final_fee, OLD.payment_plan_id, OLD.admission_date) THEN
        RAISE EXCEPTION 'Admission fee, plan and date are frozen; installments were built from them';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_admissions_fee_frozen
    BEFORE UPDATE ON admissions
    FOR EACH ROW EXECUTE FUNCTION prevent_admission_fee_change();

CREATE TRIGGER trg_admissions_updated_at
    BEFORE UPDATE ON admissions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Installments: the due schedule, generated from the payment plan
-- ---------------------------------------------------------------------------
CREATE TABLE installments (
    installment_id SERIAL PRIMARY KEY,
    admission_id INT NOT NULL REFERENCES admissions(admission_id),
    installment_no SMALLINT NOT NULL CHECK (installment_no > 0),
    amount_due NUMERIC(10, 2) NOT NULL CHECK (amount_due >= 0),
    due_date DATE NOT NULL,
    UNIQUE (admission_id, installment_no)
);

CREATE INDEX installments_due_date_idx ON installments (due_date);

-- After an admission is created: build installments (rounding goes to the last
-- one so they always sum to final_fee) and mark the fee discussion Converted
CREATE OR REPLACE FUNCTION after_admission_insert() RETURNS trigger AS $$
DECLARE
    v_percent_total NUMERIC;
BEGIN
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

    IF NEW.fee_version_id IS NOT NULL THEN
        UPDATE fee_discussions SET milestone = 'Converted'
        WHERE fee_discussion_id = (SELECT fee_discussion_id FROM fee_discussion_versions
                                   WHERE version_id = NEW.fee_version_id);
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_admissions_after_insert
    AFTER INSERT ON admissions
    FOR EACH ROW EXECUTE FUNCTION after_admission_insert();

-- ---------------------------------------------------------------------------
-- Payments: immutable ledger. Corrections are Reversal rows, never edits.
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
    payment_id SERIAL PRIMARY KEY,
    receipt_number VARCHAR(30) UNIQUE NOT NULL,     -- e.g., 'GNT-R-2627-00001' (auto-generated)
    admission_id INT NOT NULL REFERENCES admissions(admission_id),
    entry_type payment_entry_type NOT NULL DEFAULT 'Payment',
    amount NUMERIC(10, 2) NOT NULL,                 -- positive for Payment, negative for Reversal
    payment_mode_id INT REFERENCES payment_modes(payment_mode_id),
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    reference VARCHAR(100),                         -- UTR / cheque no.
    collected_by INT REFERENCES users(user_id),
    collecting_branch_id INT NOT NULL REFERENCES branches(branch_id),

    verification_status payment_verification NOT NULL DEFAULT 'Pending Verification',
    verified_by INT REFERENCES users(user_id),
    verified_at TIMESTAMP WITH TIME ZONE,
    failure_reason TEXT,

    reverses_payment_id INT UNIQUE REFERENCES payments(payment_id), -- one reversal per payment
    reversal_reason TEXT,
    notes TEXT,

    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT payments_payment_shape
        CHECK (entry_type <> 'Payment'
               OR (amount > 0 AND payment_mode_id IS NOT NULL AND reverses_payment_id IS NULL)),
    CONSTRAINT payments_reversal_shape
        CHECK (entry_type <> 'Reversal'
               OR (amount < 0 AND reverses_payment_id IS NOT NULL AND reversal_reason IS NOT NULL
                   AND verification_status = 'Verified')),
    CONSTRAINT payments_verified_by
        CHECK (verification_status <> 'Verified' OR verified_by IS NOT NULL),
    CONSTRAINT payments_failure_reason
        CHECK (verification_status <> 'Failed' OR failure_reason IS NOT NULL)
);

CREATE INDEX payments_admission_idx ON payments (admission_id);
CREATE INDEX payments_branch_date_idx ON payments (collecting_branch_id, payment_date);
CREATE INDEX payments_pending_idx ON payments (verification_status) WHERE verification_status = 'Pending Verification';

CREATE OR REPLACE FUNCTION before_payment_insert() RETURNS trigger AS $$
DECLARE
    v_prefix VARCHAR;
    v_final_fee NUMERIC;
    v_waived NUMERIC;
    v_already NUMERIC;
    v_original payments%ROWTYPE;
    v_needs_reference BOOLEAN;
BEGIN
    -- Lock the admission so two cashiers can't overpay it at the same moment
    SELECT final_fee INTO v_final_fee FROM admissions WHERE admission_id = NEW.admission_id FOR UPDATE;

    IF NEW.entry_type = 'Payment' THEN
        SELECT requires_reference INTO v_needs_reference
        FROM payment_modes WHERE payment_mode_id = NEW.payment_mode_id;
        IF v_needs_reference AND NULLIF(TRIM(NEW.reference), '') IS NULL THEN
            RAISE EXCEPTION 'This payment mode requires a reference (UTR / cheque no.)';
        END IF;

        SELECT COALESCE(SUM(amount), 0) INTO v_already
        FROM payments WHERE admission_id = NEW.admission_id AND verification_status <> 'Failed';
        SELECT COALESCE(SUM(approved_waiver_amount), 0) INTO v_waived
        FROM refund_cases WHERE admission_id = NEW.admission_id AND refund_decision = 'Waiver Approved';

        IF v_already + NEW.amount > v_final_fee - v_waived THEN
            RAISE EXCEPTION 'Payment of % exceeds outstanding % for this admission',
                NEW.amount, v_final_fee - v_waived - v_already;
        END IF;
    ELSE
        SELECT * INTO v_original FROM payments WHERE payment_id = NEW.reverses_payment_id;
        IF v_original.entry_type <> 'Payment' OR v_original.verification_status <> 'Verified'
           OR v_original.admission_id <> NEW.admission_id THEN
            RAISE EXCEPTION 'A reversal must point to a Verified payment on the same admission';
        END IF;
        IF NEW.amount <> -v_original.amount THEN
            RAISE EXCEPTION 'Reversal amount must be % (the negative of the original)', -v_original.amount;
        END IF;
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

CREATE TRIGGER trg_payments_before_insert
    BEFORE INSERT ON payments
    FOR EACH ROW EXECUTE FUNCTION before_payment_insert();

-- Only verification can change, and only once: Pending Verification -> Verified / Failed
CREATE OR REPLACE FUNCTION before_payment_update() RETURNS trigger AS $$
BEGIN
    IF (NEW.receipt_number, NEW.admission_id, NEW.entry_type, NEW.amount, NEW.payment_mode_id,
        NEW.payment_date, NEW.reference, NEW.collected_by, NEW.collecting_branch_id,
        NEW.reverses_payment_id, NEW.reversal_reason, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.receipt_number, OLD.admission_id, OLD.entry_type, OLD.amount, OLD.payment_mode_id,
        OLD.payment_date, OLD.reference, OLD.collected_by, OLD.collecting_branch_id,
        OLD.reverses_payment_id, OLD.reversal_reason, OLD.created_by, OLD.created_at) THEN
        RAISE EXCEPTION 'Payments are immutable; record a Reversal instead';
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

CREATE TRIGGER trg_payments_before_update
    BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION before_payment_update();

CREATE OR REPLACE FUNCTION prevent_payment_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Payments cannot be deleted; record a Reversal instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payments_no_delete
    BEFORE DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION prevent_payment_delete();

-- First verified payment: admission becomes a "New Paid Admission" and the lead moves to Admitted
CREATE OR REPLACE FUNCTION after_payment_verified() RETURNS trigger AS $$
DECLARE
    v_lead_id INT;
BEGIN
    UPDATE admissions SET first_verified_payment_at = NEW.verified_at
    WHERE admission_id = NEW.admission_id AND first_verified_payment_at IS NULL
    RETURNING lead_id INTO v_lead_id;

    IF v_lead_id IS NOT NULL THEN
        UPDATE leads SET stage = 'Admitted' WHERE lead_id = v_lead_id AND stage <> 'Admitted';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payments_after_verified_insert
    AFTER INSERT ON payments
    FOR EACH ROW WHEN (NEW.entry_type = 'Payment' AND NEW.verification_status = 'Verified')
    EXECUTE FUNCTION after_payment_verified();

CREATE TRIGGER trg_payments_after_verified_update
    AFTER UPDATE OF verification_status ON payments
    FOR EACH ROW WHEN (NEW.entry_type = 'Payment' AND NEW.verification_status = 'Verified'
                       AND OLD.verification_status <> 'Verified')
    EXECUTE FUNCTION after_payment_verified();

-- ---------------------------------------------------------------------------
-- Payment promises (collections): "will pay ₹X by date"
-- ---------------------------------------------------------------------------
CREATE TABLE payment_promises (
    promise_id SERIAL PRIMARY KEY,
    admission_id INT NOT NULL REFERENCES admissions(admission_id),
    promised_amount NUMERIC(10, 2) NOT NULL CHECK (promised_amount > 0),
    promised_date DATE NOT NULL,
    status promise_status NOT NULL DEFAULT 'Pending',
    notes TEXT,
    recorded_by INT REFERENCES users(user_id),
    recorded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX payment_promises_admission_idx ON payment_promises (admission_id, status);

-- ---------------------------------------------------------------------------
-- Refund cases: registration, financial decision and payout are separate steps
--   Financial refund / waiver decision: Founder / CEO or Super Admin
--   Payout execution & reconciliation: Accounts (never the same person as the decider)
-- ---------------------------------------------------------------------------
CREATE TABLE refund_cases (
    refund_case_id SERIAL PRIMARY KEY,
    case_code VARCHAR(20) UNIQUE NOT NULL,          -- e.g., 'NIT-RF-26019' (auto-generated)
    admission_id INT NOT NULL REFERENCES admissions(admission_id),
    status refund_case_status NOT NULL DEFAULT 'Registered',

    -- Registration (always allowed, even with incomplete evidence)
    requested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    request_reason TEXT NOT NULL,
    request_timing VARCHAR(100),                    -- e.g., 'Within 3 calendar days'
    evidence_status refund_evidence_status NOT NULL DEFAULT 'Evidence Pending',
    assessment_date DATE,
    assessment_notes TEXT,

    -- Financial decision
    refund_decision refund_decision NOT NULL DEFAULT 'Pending',
    approved_refund_amount NUMERIC(10, 2) CHECK (approved_refund_amount > 0),
    approved_waiver_amount NUMERIC(10, 2) CHECK (approved_waiver_amount > 0),
    decision_reason TEXT,
    decision_due_at TIMESTAMP WITH TIME ZONE,       -- normally 3–7 working days
    decided_by INT REFERENCES users(user_id),
    decided_at TIMESTAMP WITH TIME ZONE,

    -- Payout execution
    payout_status payout_status NOT NULL DEFAULT 'Not Started',
    payout_due_at TIMESTAMP WITH TIME ZONE,         -- up to 18 working days after approval
    payout_amount NUMERIC(10, 2) CHECK (payout_amount > 0),
    payout_mode_id INT REFERENCES payment_modes(payment_mode_id),
    payout_reference VARCHAR(100),
    payout_executed_by INT REFERENCES users(user_id),
    payout_completed_at TIMESTAMP WITH TIME ZONE,
    payout_failure_reason TEXT,
    reconciled_by INT REFERENCES users(user_id),
    reconciled_at TIMESTAMP WITH TIME ZONE,

    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT refund_decision_recorded
        CHECK (refund_decision = 'Pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
    CONSTRAINT refund_approved_amount
        CHECK (refund_decision <> 'Refund Approved' OR approved_refund_amount IS NOT NULL),
    CONSTRAINT refund_waiver_amount
        CHECK (refund_decision <> 'Waiver Approved' OR approved_waiver_amount IS NOT NULL),
    CONSTRAINT refund_rejection_reason
        CHECK (refund_decision <> 'Rejected' OR decision_reason IS NOT NULL),
    CONSTRAINT refund_payout_needs_approval
        CHECK (payout_status = 'Not Started' OR refund_decision = 'Refund Approved'),
    CONSTRAINT refund_payout_within_approved
        CHECK (payout_amount IS NULL OR payout_amount <= approved_refund_amount),
    CONSTRAINT refund_payout_completed
        CHECK (payout_status <> 'Completed'
               OR (payout_amount IS NOT NULL AND payout_reference IS NOT NULL
                   AND payout_executed_by IS NOT NULL AND payout_completed_at IS NOT NULL
                   AND reconciled_by IS NOT NULL AND reconciled_at IS NOT NULL)),
    CONSTRAINT refund_payout_failure_reason
        CHECK (payout_status <> 'Failed' OR payout_failure_reason IS NOT NULL),
    CONSTRAINT refund_separation_of_duties
        CHECK (payout_executed_by IS NULL OR decided_by IS NULL OR payout_executed_by <> decided_by)
);

CREATE INDEX refund_cases_admission_idx ON refund_cases (admission_id);
CREATE INDEX refund_cases_status_idx ON refund_cases (status);

CREATE TABLE refund_case_receipts (
    refund_case_id INT REFERENCES refund_cases(refund_case_id) ON DELETE CASCADE,
    payment_id INT REFERENCES payments(payment_id),
    PRIMARY KEY (refund_case_id, payment_id)
);

CREATE OR REPLACE FUNCTION set_refund_case_code() RETURNS trigger AS $$
BEGIN
    NEW.case_code = 'NIT-RF-' || LPAD(next_number('REFUND_CASE')::TEXT, 5, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_refund_cases_code
    BEFORE INSERT ON refund_cases
    FOR EACH ROW WHEN (NEW.case_code IS NULL)
    EXECUTE FUNCTION set_refund_case_code();

-- Financial decisions: only Founder / CEO or Super Admin, and a refund can't exceed verified money received
CREATE OR REPLACE FUNCTION check_refund_decision() RETURNS trigger AS $$
DECLARE
    v_role VARCHAR;
    v_verified NUMERIC;
BEGIN
    SELECT r.role_code INTO v_role FROM users u JOIN roles r USING (role_id) WHERE u.user_id = NEW.decided_by;
    IF v_role IS NULL OR v_role NOT IN ('FOUNDER_CEO', 'SUPER_ADMIN') THEN
        RAISE EXCEPTION 'Refund / waiver decisions need Founder / CEO or Super Admin';
    END IF;

    IF NEW.refund_decision = 'Refund Approved' THEN
        SELECT COALESCE(SUM(amount), 0) INTO v_verified
        FROM payments WHERE admission_id = NEW.admission_id AND verification_status = 'Verified';
        IF NEW.approved_refund_amount > v_verified THEN
            RAISE EXCEPTION 'Approved refund % exceeds verified payments %', NEW.approved_refund_amount, v_verified;
        END IF;
    END IF;

    NEW.decided_at = COALESCE(NEW.decided_at, CURRENT_TIMESTAMP);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_refund_cases_decision
    BEFORE UPDATE OF refund_decision ON refund_cases
    FOR EACH ROW WHEN (NEW.refund_decision <> 'Pending' AND OLD.refund_decision IS DISTINCT FROM NEW.refund_decision)
    EXECUTE FUNCTION check_refund_decision();

CREATE TRIGGER trg_refund_cases_updated_at
    BEFORE UPDATE ON refund_cases
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Views: balances and collections (always computed, never stored)
-- ---------------------------------------------------------------------------
CREATE VIEW admission_balances AS
SELECT
    a.admission_id,
    a.admission_code,
    a.person_id,
    a.service_branch_id,
    a.enrolment_status,
    a.final_fee,
    COALESCE(p.verified_paid, 0) AS verified_paid,
    COALESCE(p.pending_verification, 0) AS pending_verification,  -- excluded from verified totals
    COALESCE(r.waived, 0) AS waived,
    COALESCE(r.refunded, 0) AS refunded,
    CASE WHEN a.enrolment_status = 'Cancelled' THEN 0
         ELSE a.final_fee - COALESCE(p.verified_paid, 0) - COALESCE(r.waived, 0)
    END AS outstanding
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

-- Verified money (plus waivers) is applied to installments oldest-first
CREATE VIEW installment_dues AS
WITH running AS (
    SELECT i.*,
           SUM(i.amount_due) OVER (PARTITION BY i.admission_id ORDER BY i.installment_no) AS cumulative_due
    FROM installments i
),
applied AS (
    SELECT r.*,
           b.admission_code,
           b.service_branch_id,
           b.enrolment_status,
           b.pending_verification,
           LEAST(r.amount_due,
                 GREATEST(0, b.verified_paid + b.waived - (r.cumulative_due - r.amount_due))) AS amount_covered
    FROM running r JOIN admission_balances b USING (admission_id)
)
SELECT
    installment_id,
    admission_id,
    admission_code,
    service_branch_id,
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
    CASE WHEN amount_due - amount_covered > 0 AND due_date < CURRENT_DATE
         THEN CURRENT_DATE - due_date END AS days_overdue,
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
    pending_verification > 0 AS contact_hold      -- pause chasing while a payment awaits verification
FROM applied;
