-- 020 — Delivery plan per course (UI V4).
--
-- Each deal (lead = one course) gets its own delivery plan: DP-00001 code, service branch, delivery mode, seat type
-- (Confirmed Seat / Future Plan), planned start date, capacity review (Checked / Waiting), "student acceptance
-- captured" and who accepted it and when. The plan is edited as a draft, then accepted; an accepted plan is frozen
-- (reopening it clears the acceptance). It replaces the accepted plan on the fee discussion (accepted version,
-- mode, seat type, start, accepted at / by), whose data is migrated here and whose columns are dropped: the price
-- lives on the fee discussion's approved version, the delivery on this plan.
--
-- An admission now needs an accepted delivery plan on its course (the invoice's lead) and takes its service
-- branch, mode, seat type and planned start from it.
--
-- Depends on: 019_qualify_convert.sql

CREATE TYPE capacity_review AS ENUM ('Checked', 'Waiting');

CREATE TABLE delivery_plans (
    delivery_plan_id SERIAL PRIMARY KEY,
    plan_code VARCHAR(20) NOT NULL UNIQUE,                 -- DP-00001
    lead_id INT NOT NULL UNIQUE REFERENCES leads(lead_id), -- one plan per course deal
    service_branch_id INT NOT NULL REFERENCES branches(branch_id),
    delivery_mode delivery_mode NOT NULL,
    seat_type seat_type NOT NULL DEFAULT 'Confirmed Seat',
    planned_start_date DATE,
    capacity_review capacity_review NOT NULL DEFAULT 'Waiting',
    student_accepted BOOLEAN NOT NULL DEFAULT FALSE,
    accepted_by INT REFERENCES users(user_id),
    accepted_at TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT delivery_plans_future_plan_start CHECK (seat_type <> 'Future Plan' OR planned_start_date IS NOT NULL),
    CONSTRAINT delivery_plans_acceptance_recorded
        CHECK (accepted_at IS NULL OR (student_accepted AND accepted_by IS NOT NULL))
);

CREATE INDEX delivery_plans_branch_idx ON delivery_plans (service_branch_id);

CREATE TRIGGER trg_delivery_plans_updated_at
    BEFORE UPDATE ON delivery_plans
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION set_delivery_plan_code() RETURNS trigger AS $$
BEGIN
    NEW.plan_code = 'DP-' || LPAD(next_number('DELIVERY_PLAN')::TEXT, 5, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_delivery_plans_code
    BEFORE INSERT ON delivery_plans
    FOR EACH ROW WHEN (NEW.plan_code IS NULL)
    EXECUTE FUNCTION set_delivery_plan_code();

-- Draft plans are editable; accepting stamps the time; an accepted plan changes only by reopening it
-- (accepted_at back to NULL). Closed deals can't get or change a plan.
CREATE OR REPLACE FUNCTION guard_delivery_plan() RETURNS trigger AS $$
DECLARE
    v_lead leads%ROWTYPE;
BEGIN
    SELECT * INTO v_lead FROM leads WHERE lead_id = NEW.lead_id;
    IF TG_OP = 'UPDATE' AND NEW.lead_id <> OLD.lead_id THEN
        RAISE EXCEPTION 'A delivery plan belongs to one course deal';
    END IF;
    IF v_lead.converted_at IS NULL THEN
        RAISE EXCEPTION 'Lead % is not a deal yet; convert it before planning delivery', v_lead.lead_code;
    END IF;
    IF v_lead.stage IN ('Admitted', 'Lost - closed') THEN
        RAISE EXCEPTION 'Deal % is %; its delivery plan can no longer change', v_lead.lead_code, v_lead.stage;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS NOT NULL
       AND (NEW.service_branch_id, NEW.delivery_mode, NEW.seat_type, NEW.planned_start_date, NEW.capacity_review,
            NEW.student_accepted, NEW.accepted_by, NEW.accepted_at)
           IS DISTINCT FROM
           (OLD.service_branch_id, OLD.delivery_mode, OLD.seat_type, OLD.planned_start_date, OLD.capacity_review,
            OLD.student_accepted, OLD.accepted_by, OLD.accepted_at) THEN
        RAISE EXCEPTION 'Delivery plan % is accepted; reopen it to change it', OLD.plan_code;
    END IF;
    IF NEW.accepted_at IS NULL THEN
        NEW.accepted_by = NULL;
        IF TG_OP = 'UPDATE' AND OLD.accepted_at IS NOT NULL THEN
            NEW.student_accepted = FALSE;       -- reopened: acceptance must be captured again
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_delivery_plans_guard
    BEFORE INSERT OR UPDATE ON delivery_plans
    FOR EACH ROW EXECUTE FUNCTION guard_delivery_plan();

CREATE OR REPLACE FUNCTION prevent_delivery_plan_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Delivery plans are kept; reopen the plan instead of deleting it';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_delivery_plans_no_delete
    BEFORE DELETE ON delivery_plans
    FOR EACH ROW EXECUTE FUNCTION prevent_delivery_plan_delete();

-- ---------------------------------------------------------------------------
-- Migrate accepted plans from fee discussions (latest per lead), before the guard sees them
-- ---------------------------------------------------------------------------
ALTER TABLE delivery_plans DISABLE TRIGGER trg_delivery_plans_guard;
INSERT INTO delivery_plans (lead_id, service_branch_id, delivery_mode, seat_type, planned_start_date, capacity_review,
                            student_accepted, accepted_by, accepted_at, created_by, created_at)
SELECT DISTINCT ON (d.lead_id)
       d.lead_id, COALESCE(a.service_branch_id, d.branch_id), d.delivery_mode, d.seat_type, d.planned_start_date,
       'Checked', TRUE, d.plan_accepted_recorded_by, d.plan_accepted_at, d.plan_accepted_recorded_by, d.plan_accepted_at
FROM fee_discussions d
LEFT JOIN admissions a ON a.lead_id = d.lead_id AND a.complimentary_of_admission_id IS NULL
WHERE d.plan_accepted_at IS NOT NULL
ORDER BY d.lead_id, d.plan_accepted_at DESC;
ALTER TABLE delivery_plans ENABLE TRIGGER trg_delivery_plans_guard;

-- ---------------------------------------------------------------------------
-- Fee discussions no longer hold the delivery plan
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_fee_discussion_update() RETURNS trigger AS $$
BEGIN
    IF NEW.milestone::TEXT = 'Fee Shared' AND OLD.milestone::TEXT IS DISTINCT FROM 'Fee Shared' THEN
        NEW.fee_shared_at = COALESCE(NEW.fee_shared_at, CURRENT_TIMESTAMP);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE fee_discussions
    DROP CONSTRAINT fee_discussions_accepted_plan_complete,
    DROP CONSTRAINT fee_discussions_future_plan_start,
    DROP COLUMN delivery_mode,
    DROP COLUMN seat_type,
    DROP COLUMN planned_start_date,
    DROP COLUMN accepted_version_id,
    DROP COLUMN plan_accepted_at,
    DROP COLUMN plan_accepted_recorded_by;

-- ---------------------------------------------------------------------------
-- Admission: the course's accepted delivery plan (replaces the fee discussion's accepted plan)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_admission_insert() RETURNS trigger AS $$
DECLARE
    v_prefix VARCHAR;
    v_year TEXT;
    v RECORD;
    v_plan delivery_plans%ROWTYPE;
    v_token RECORD;
    v_parent admissions%ROWTYPE;
    v_rule offer_complimentary_courses%ROWTYPE;
BEGIN
    IF NEW.complimentary_of_admission_id IS NULL THEN
        IF NEW.invoice_id IS NULL THEN
            RAISE EXCEPTION 'An admission is created from its invoice (invoice_id is required)';
        END IF;
        SELECT i.*, d.branch_id AS lead_branch INTO v
        FROM invoices i JOIN fee_discussions d USING (fee_discussion_id)
        WHERE i.invoice_id = NEW.invoice_id;

        IF v.status <> 'Issued' THEN
            RAISE EXCEPTION 'Invoice % is %', v.invoice_number, v.status;
        END IF;
        SELECT * INTO v_plan FROM delivery_plans WHERE lead_id = v.lead_id;
        IF v_plan.accepted_at IS NULL THEN
            RAISE EXCEPTION 'Prerequisite missing: an accepted delivery plan for this course';
        END IF;
        IF NEW.final_fee IS NOT NULL AND NEW.final_fee <> v.billed_amount THEN
            RAISE EXCEPTION 'Admission final_fee % does not match invoice amount %', NEW.final_fee, v.billed_amount;
        END IF;
        IF NEW.person_id IS NOT NULL AND NEW.person_id <> v.person_id THEN
            RAISE EXCEPTION 'Admission person must match the invoice';
        END IF;

        SELECT * INTO v_token FROM invoice_token_payment(NEW.invoice_id);
        IF v_token.payment_id IS NULL THEN
            RAISE EXCEPTION 'Prerequisite missing: verified payments of at least ₹% (the admission token) — ₹% verified so far',
                v_token.token, v_token.verified_total;
        END IF;

        NEW.first_qualifying_payment_id = v_token.payment_id;
        NEW.first_verified_payment_at = v_token.verified_at;
        NEW.person_id = v.person_id;
        NEW.lead_id = v.lead_id;
        NEW.course_id = v.course_id;
        NEW.fee_version_id = v.fee_version_id;
        NEW.final_fee = v.billed_amount;
        NEW.payment_plan_id = v.payment_plan_id;
        NEW.original_branch_id = COALESCE(NEW.original_branch_id, v.lead_branch);
        NEW.service_branch_id = COALESCE(NEW.service_branch_id, v_plan.service_branch_id, NEW.original_branch_id);
        NEW.delivery_mode = v_plan.delivery_mode;
        NEW.seat_type = COALESCE(NEW.seat_type, v_plan.seat_type);
        NEW.planned_start_date = COALESCE(NEW.planned_start_date, v_plan.planned_start_date);
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
