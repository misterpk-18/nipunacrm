-- Phase 2: commercials (offers, payment plans, fee discussions, special closing requests)
-- Depends on: 003_phase1_people_pipeline.sql

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE offer_status AS ENUM ('Draft', 'Configured', 'Active', 'Inactive', 'Expired');

CREATE TYPE offer_benefit_type AS ENUM ('Discount Amount', 'Discount Percent', 'Complimentary Course');

CREATE TYPE fee_discussion_milestone AS ENUM (
    'In Discussion', 'Approved', 'Invoice Issued', 'Converted', 'Expired', 'Cancelled'
);

CREATE TYPE fee_version_status AS ENUM (
    'Discussion Saved', 'Counteroffered', 'Pending Approval', 'Approved', 'Rejected', 'Superseded', 'Expired'
);

CREATE TYPE scr_status AS ENUM ('Pending', 'Approved', 'Rejected', 'Withdrawn', 'Expired');

-- ---------------------------------------------------------------------------
-- Offer Master: versioned campaigns. Editing an Active offer = insert a new version.
-- ---------------------------------------------------------------------------
CREATE TABLE offers (
    offer_id SERIAL PRIMARY KEY,
    offer_code VARCHAR(30) NOT NULL,                -- e.g., 'OM-2026-DRAFT-01'
    version SMALLINT NOT NULL DEFAULT 1,
    offer_name VARCHAR(150) NOT NULL,
    description TEXT,
    status offer_status NOT NULL DEFAULT 'Draft',

    benefit_type offer_benefit_type NOT NULL,
    discount_amount NUMERIC(10, 2) CHECK (discount_amount > 0),
    discount_percent NUMERIC(5, 2) CHECK (discount_percent > 0 AND discount_percent <= 100),

    applies_to_all_branches BOOLEAN NOT NULL DEFAULT TRUE,  -- FALSE = see offer_branches
    applies_to_all_courses BOOLEAN NOT NULL DEFAULT FALSE,  -- FALSE = see offer_courses
    allows_stacking BOOLEAN NOT NULL DEFAULT FALSE,         -- "No stacking unless approved"
    qualifying_payment_rule VARCHAR(255),                   -- e.g., 'First allocated payment Verified'

    valid_from DATE,
    valid_to DATE,

    approved_by INT REFERENCES users(user_id),
    approved_at TIMESTAMP WITH TIME ZONE,
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (offer_code, version),
    CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
    CHECK (benefit_type <> 'Discount Amount' OR discount_amount IS NOT NULL),
    CHECK (benefit_type <> 'Discount Percent' OR discount_percent IS NOT NULL),
    CONSTRAINT offers_active_requires_approval
        CHECK (status <> 'Active' OR (approved_by IS NOT NULL AND valid_from IS NOT NULL AND valid_to IS NOT NULL))
);

CREATE INDEX offers_status_dates_idx ON offers (status, valid_from, valid_to);

CREATE TRIGGER trg_offers_updated_at
    BEFORE UPDATE ON offers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE offer_branches (
    offer_id INT REFERENCES offers(offer_id) ON DELETE CASCADE,
    branch_id INT REFERENCES branches(branch_id),
    PRIMARY KEY (offer_id, branch_id)
);

CREATE TABLE offer_courses (
    offer_id INT REFERENCES offers(offer_id) ON DELETE CASCADE,
    course_id INT REFERENCES courses(course_id),
    PRIMARY KEY (offer_id, course_id)
);

-- Complimentary course eligibility, e.g., Advanced Excel free when final fee >= 15,000
CREATE TABLE offer_complimentary_courses (
    offer_id INT REFERENCES offers(offer_id) ON DELETE CASCADE,
    course_id INT REFERENCES courses(course_id),
    min_final_fee NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (min_final_fee >= 0),
    PRIMARY KEY (offer_id, course_id)
);

-- ---------------------------------------------------------------------------
-- Payment plans: templates split into installments
-- ---------------------------------------------------------------------------
CREATE TABLE payment_plans (
    payment_plan_id SERIAL PRIMARY KEY,
    plan_code VARCHAR(30) UNIQUE NOT NULL,          -- e.g., 'FULL'
    plan_name VARCHAR(100) NOT NULL,                -- e.g., 'Full Payment'
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_payment_plans_updated_at
    BEFORE UPDATE ON payment_plans
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payment_plan_installments (
    payment_plan_id INT REFERENCES payment_plans(payment_plan_id) ON DELETE CASCADE,
    installment_no SMALLINT NOT NULL CHECK (installment_no > 0),
    percent_of_fee NUMERIC(5, 2) NOT NULL CHECK (percent_of_fee > 0 AND percent_of_fee <= 100),
    due_days_after_admission SMALLINT NOT NULL DEFAULT 0 CHECK (due_days_after_admission >= 0),
    PRIMARY KEY (payment_plan_id, installment_no)
);

INSERT INTO payment_plans (plan_code, plan_name) VALUES ('FULL', 'Full Payment');
INSERT INTO payment_plan_installments (payment_plan_id, installment_no, percent_of_fee, due_days_after_admission)
    SELECT payment_plan_id, 1, 100, 0 FROM payment_plans WHERE plan_code = 'FULL';

-- ---------------------------------------------------------------------------
-- Concession approval limits per role ("BM limit: lower of 5% or ₹1,000")
-- A role with no row cannot approve. NULL limits = unlimited.
-- ---------------------------------------------------------------------------
CREATE TABLE concession_limits (
    role_id INT PRIMARY KEY REFERENCES roles(role_id),
    max_percent NUMERIC(5, 2) CHECK (max_percent >= 0 AND max_percent <= 100),
    max_amount NUMERIC(10, 2) CHECK (max_amount >= 0),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_concession_limits_updated_at
    BEFORE UPDATE ON concession_limits
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO concession_limits (role_id, max_percent, max_amount)
    SELECT role_id, 5, 1000 FROM roles WHERE role_code = 'BRANCH_MANAGER';
INSERT INTO concession_limits (role_id, max_percent, max_amount)
    SELECT role_id, NULL, NULL FROM roles WHERE role_code = 'SUPER_ADMIN';

-- ---------------------------------------------------------------------------
-- Fee discussions: one negotiation per lead + course, with numbered versions
-- ---------------------------------------------------------------------------
CREATE TABLE fee_discussions (
    fee_discussion_id SERIAL PRIMARY KEY,
    discussion_code VARCHAR(20) UNIQUE NOT NULL,    -- e.g., 'FD-26091' (auto-generated)
    lead_id INT NOT NULL REFERENCES leads(lead_id),
    course_id INT NOT NULL REFERENCES courses(course_id),
    branch_id INT NOT NULL REFERENCES branches(branch_id),
    counsellor_id INT REFERENCES users(user_id),
    milestone fee_discussion_milestone NOT NULL DEFAULT 'In Discussion',
    invoice_number VARCHAR(30) UNIQUE,
    invoice_issued_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CHECK (milestone <> 'Invoice Issued' OR invoice_number IS NOT NULL)
);

CREATE INDEX fee_discussions_lead_idx ON fee_discussions (lead_id);
CREATE INDEX fee_discussions_branch_milestone_idx ON fee_discussions (branch_id, milestone);

CREATE OR REPLACE FUNCTION set_discussion_code() RETURNS trigger AS $$
BEGIN
    NEW.discussion_code = 'FD-' || LPAD(next_number('FEE_DISCUSSION')::TEXT, 5, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fee_discussions_code
    BEFORE INSERT ON fee_discussions
    FOR EACH ROW WHEN (NEW.discussion_code IS NULL)
    EXECUTE FUNCTION set_discussion_code();

CREATE TRIGGER trg_fee_discussions_updated_at
    BEFORE UPDATE ON fee_discussions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE fee_discussion_versions (
    version_id SERIAL PRIMARY KEY,
    fee_discussion_id INT NOT NULL REFERENCES fee_discussions(fee_discussion_id),
    version_no SMALLINT NOT NULL CHECK (version_no > 0),
    status fee_version_status NOT NULL DEFAULT 'Discussion Saved',

    -- Amounts are frozen once saved; a change means a new version
    standard_fee NUMERIC(10, 2) NOT NULL CHECK (standard_fee >= 0),
    offer_id INT REFERENCES offers(offer_id),
    offer_discount NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (offer_discount >= 0),
    extra_concession NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (extra_concession >= 0),
    final_payable NUMERIC(10, 2) NOT NULL,
    minimum_floor NUMERIC(10, 2) NOT NULL CHECK (minimum_floor >= 0),  -- 70% of standard fee
    payment_plan_id INT NOT NULL REFERENCES payment_plans(payment_plan_id),
    valid_until DATE NOT NULL,                      -- defaults to 7 days or offer expiry, whichever is first

    notes TEXT,
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (fee_discussion_id, version_no),
    CONSTRAINT fee_versions_final_payable_math
        CHECK (final_payable = standard_fee - offer_discount - extra_concession),
    CONSTRAINT fee_versions_above_floor
        CHECK (final_payable >= minimum_floor)
);

CREATE INDEX fee_discussion_versions_offer_idx ON fee_discussion_versions (offer_id);

CREATE OR REPLACE FUNCTION set_fee_version_defaults() RETURNS trigger AS $$
DECLARE
    v_offer_end DATE;
BEGIN
    IF NEW.version_no IS NULL THEN
        SELECT COALESCE(MAX(version_no), 0) + 1 INTO NEW.version_no
        FROM fee_discussion_versions WHERE fee_discussion_id = NEW.fee_discussion_id;
    END IF;

    IF NEW.minimum_floor IS NULL THEN
        NEW.minimum_floor = ROUND(NEW.standard_fee * 0.70, 2);
    END IF;

    IF NEW.final_payable IS NULL THEN
        NEW.final_payable = NEW.standard_fee - NEW.offer_discount - NEW.extra_concession;
    END IF;

    IF NEW.valid_until IS NULL THEN
        SELECT valid_to INTO v_offer_end FROM offers WHERE offer_id = NEW.offer_id;
        NEW.valid_until = LEAST(CURRENT_DATE + 7, COALESCE(v_offer_end, CURRENT_DATE + 7));
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fee_versions_defaults
    BEFORE INSERT ON fee_discussion_versions
    FOR EACH ROW EXECUTE FUNCTION set_fee_version_defaults();

CREATE OR REPLACE FUNCTION prevent_fee_amount_change() RETURNS trigger AS $$
BEGIN
    IF (NEW.standard_fee, NEW.offer_id, NEW.offer_discount, NEW.extra_concession,
        NEW.final_payable, NEW.minimum_floor, NEW.payment_plan_id)
       IS DISTINCT FROM
       (OLD.standard_fee, OLD.offer_id, OLD.offer_discount, OLD.extra_concession,
        OLD.final_payable, OLD.minimum_floor, OLD.payment_plan_id) THEN
        RAISE EXCEPTION 'Fee version amounts are frozen; create a new version instead';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fee_versions_frozen
    BEFORE UPDATE ON fee_discussion_versions
    FOR EACH ROW EXECUTE FUNCTION prevent_fee_amount_change();

CREATE TRIGGER trg_fee_versions_updated_at
    BEFORE UPDATE ON fee_discussion_versions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Special closing requests: extra concession beyond the offer, needs approval
-- ---------------------------------------------------------------------------
CREATE TABLE special_closing_requests (
    scr_id SERIAL PRIMARY KEY,
    scr_code VARCHAR(20) UNIQUE NOT NULL,           -- e.g., 'SCR-26091' (auto-generated)
    version_id INT NOT NULL REFERENCES fee_discussion_versions(version_id),
    requested_extra NUMERIC(10, 2) NOT NULL CHECK (requested_extra > 0),
    request_reason TEXT NOT NULL,
    requested_by INT NOT NULL REFERENCES users(user_id),
    requested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decision_due_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT CURRENT_TIMESTAMP + INTERVAL '5 minutes',   -- 5 staffed-minute target
    escalated_at TIMESTAMP WITH TIME ZONE,

    status scr_status NOT NULL DEFAULT 'Pending',
    decided_by INT REFERENCES users(user_id),
    decided_at TIMESTAMP WITH TIME ZONE,
    decision_reason TEXT,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT scr_no_self_approval
        CHECK (decided_by IS NULL OR decided_by <> requested_by),
    CONSTRAINT scr_decision_recorded
        CHECK (status NOT IN ('Approved', 'Rejected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
    CONSTRAINT scr_rejection_reason
        CHECK (status <> 'Rejected' OR decision_reason IS NOT NULL)
);

-- Only one open request per fee version
CREATE UNIQUE INDEX scr_one_pending_per_version
    ON special_closing_requests (version_id) WHERE status = 'Pending';
CREATE INDEX scr_status_due_idx ON special_closing_requests (status, decision_due_at);

CREATE OR REPLACE FUNCTION set_scr_code() RETURNS trigger AS $$
BEGIN
    NEW.scr_code = 'SCR-' || LPAD(next_number('SCR')::TEXT, 5, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_scr_code
    BEFORE INSERT ON special_closing_requests
    FOR EACH ROW WHEN (NEW.scr_code IS NULL)
    EXECUTE FUNCTION set_scr_code();

-- On a decision: stamp decided_at, and for approvals check the approver's
-- role limit covers the requested extra
CREATE OR REPLACE FUNCTION check_scr_decision() RETURNS trigger AS $$
DECLARE
    v_standard_fee NUMERIC;
    v_limit concession_limits%ROWTYPE;
BEGIN
    NEW.decided_at = COALESCE(NEW.decided_at, CURRENT_TIMESTAMP);

    IF NEW.status = 'Approved' THEN
        SELECT standard_fee INTO v_standard_fee
        FROM fee_discussion_versions WHERE version_id = NEW.version_id;

        SELECT cl.* INTO v_limit
        FROM users u JOIN concession_limits cl ON cl.role_id = u.role_id
        WHERE u.user_id = NEW.decided_by;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'User % has no concession approval authority', NEW.decided_by;
        END IF;

        IF NEW.requested_extra > LEAST(
            COALESCE(v_limit.max_amount, NEW.requested_extra),
            COALESCE(ROUND(v_standard_fee * v_limit.max_percent / 100, 2), NEW.requested_extra)
        ) THEN
            RAISE EXCEPTION 'Requested extra % exceeds approver limit (lower of % percent or %)',
                NEW.requested_extra, v_limit.max_percent, v_limit.max_amount;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_scr_decision
    BEFORE UPDATE OF status ON special_closing_requests
    FOR EACH ROW WHEN (NEW.status IN ('Approved', 'Rejected') AND OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION check_scr_decision();

CREATE TRIGGER trg_scr_updated_at
    BEFORE UPDATE ON special_closing_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
