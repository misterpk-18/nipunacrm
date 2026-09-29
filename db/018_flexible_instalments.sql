-- 018 — Flexible instalments, ₹1,000 admission token, due-soon and payment-gap alerts.
--
-- 1. The fee version holds the payment schedule. The counsellor picks 1, 2 or 3 instalments (the Full / Two /
--    Three plans still say how many) and enters a due date and an amount for each. Amounts add up to the final
--    payable and dates run in order. The plan's percentages and due-day windows are no longer enforced (the API uses the
--    split only when a request sends no schedule). Existing versions get their plan's split of the final payable, on their invoice's due dates
--    if one was issued, else the plan's default days.
-- 2. Issuing an invoice copies that schedule into `installments`. Agreed due days are no longer used.
-- 3. An instalment's due date can move to any date (the plan-window check is gone). Amounts still change only
--    through an approved fee change, which now rescales the instalments in proportion to their current amounts.
-- 4. An admission needs verified payments on the invoice adding up to the admission token (setting
--    `admission_token_amount`, ₹1,000; the whole fee if it is smaller), instead of any one verified payment.
--    `first_qualifying_payment_id` is the payment that reached the token.
-- 5. `payment_gaps` (view): open invoices whose next unpaid instalment is due more than `payment_gap_alert_days`
--    (30) after the last verified payment. The API alerts on it when a payment is verified; the dashboard counts it.
-- 6. Settings `installment_due_soon_days` (2) and two notification rules, INSTALMENT_DUE_SOON and
--    PAYMENT_GAP_LONG, used by the API and the daily job.
--
-- Payments of any amount up to the invoice balance were already allowed (verified money is applied to the oldest
-- instalment first); money beyond the whole invoice still becomes an unallocated advance.
--
-- Depends on: 017_pipeline_entries.sql

INSERT INTO app_settings (setting_key, setting_value, description) VALUES
    ('admission_token_amount', '1000', 'Verified payments needed on an invoice before the admission can be created (₹)'),
    ('installment_due_soon_days', '2', 'Alert the owner, Accounts and the Branch Manager this many days before an instalment is due'),
    ('payment_gap_alert_days', '30', 'Alert when the next instalment is due more than this many days after a verified payment');

INSERT INTO notification_rules (rule_code, event_type, description, recipient_role_id, category)
SELECT v.code, v.evt, v.descr, r.role_id, v.category::notification_category
FROM (VALUES
    ('INSTALMENT_DUE_SOON', 'installment.due_soon', 'Instalment due within the next few days', 'ACCOUNTS', 'Action Required'),
    ('PAYMENT_GAP_LONG', 'payment.gap_long', 'Next instalment is due long after the last payment', 'ACCOUNTS', 'Information')
) v(code, evt, descr, role, category)
JOIN roles r ON r.role_code = v.role;

-- ---------------------------------------------------------------------------
-- Payment schedule on the fee version
-- ---------------------------------------------------------------------------
CREATE TABLE fee_version_installments (
    version_id INT NOT NULL REFERENCES fee_discussion_versions(version_id),
    installment_no SMALLINT NOT NULL,
    due_date DATE NOT NULL,
    amount NUMERIC(10, 2) NOT NULL,
    PRIMARY KEY (version_id, installment_no),
    CONSTRAINT fee_version_installments_no_range CHECK (installment_no BETWEEN 1 AND 3),
    CONSTRAINT fee_version_installments_amount_positive CHECK (amount > 0)
);

-- Backfill (before the rules below exist): the plan's split of the final payable (rounding into the last
-- instalment), on the version's invoice dates if one was issued, else the plan's default days from the version date
INSERT INTO fee_version_installments (version_id, installment_no, due_date, amount)
SELECT version_id, installment_no, COALESCE(invoice_due, version_date + due_days_after_admission),
       CASE WHEN installment_no = MAX(installment_no) OVER (PARTITION BY version_id)
            THEN final_payable - (SUM(amount) OVER (PARTITION BY version_id) - amount) ELSE amount END
FROM (
    SELECT v.version_id, v.final_payable, (v.created_at AT TIME ZONE business_tz())::DATE AS version_date,
           pi.installment_no, pi.due_days_after_admission, ROUND(v.final_payable * pi.percent_of_fee / 100, 2) AS amount,
           (SELECT inst.due_date FROM invoices i JOIN installments inst USING (invoice_id)
            WHERE i.fee_version_id = v.version_id AND inst.installment_no = pi.installment_no
            ORDER BY i.invoice_id DESC LIMIT 1) AS invoice_due
    FROM fee_discussion_versions v
    JOIN payment_plan_installments pi USING (payment_plan_id)
    WHERE v.final_payable > 0
) s;

-- A schedule is saved with its version and never edited (a change means a new version)
CREATE OR REPLACE FUNCTION guard_fee_version_installments() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF EXISTS (SELECT 1 FROM invoices WHERE fee_version_id = NEW.version_id) THEN
            RAISE EXCEPTION 'This fee version already has an invoice; its schedule can''t change';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'A fee version''s payment schedule is frozen; create a new version instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fee_version_installments_guard
    BEFORE INSERT OR UPDATE OR DELETE ON fee_version_installments
    FOR EACH ROW EXECUTE FUNCTION guard_fee_version_installments();

-- Checked at commit, once the version and all its instalments are in: count matches the plan, numbered 1..n,
-- dates in order, amounts add up to the final payable.
CREATE OR REPLACE FUNCTION check_fee_version_schedule() RETURNS trigger AS $$
DECLARE
    v_version fee_discussion_versions%ROWTYPE;
    v_expected INT;
    v_count INT;
    v_max INT;
    v_total NUMERIC;
BEGIN
    SELECT * INTO v_version FROM fee_discussion_versions WHERE version_id = NEW.version_id;
    SELECT COUNT(*) INTO v_expected FROM payment_plan_installments WHERE payment_plan_id = v_version.payment_plan_id;
    SELECT COUNT(*), MAX(installment_no), SUM(amount) INTO v_count, v_max, v_total
    FROM fee_version_installments WHERE version_id = NEW.version_id;

    IF v_count <> v_expected OR v_max <> v_count THEN
        RAISE EXCEPTION 'Fee version % needs % instalment(s), numbered 1 to %', v_version.version_no, v_expected, v_expected;
    END IF;
    IF v_total <> v_version.final_payable THEN
        RAISE EXCEPTION 'Instalments add up to ₹% but the final payable is ₹%', v_total, v_version.final_payable;
    END IF;
    IF EXISTS (SELECT 1 FROM fee_version_installments a JOIN fee_version_installments b
                 ON b.version_id = a.version_id AND b.installment_no = a.installment_no + 1
               WHERE a.version_id = NEW.version_id AND b.due_date <= a.due_date) THEN
        RAISE EXCEPTION 'Instalment due dates must be in order, each after the previous one';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_fee_version_installments_check
    AFTER INSERT ON fee_version_installments
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_fee_version_schedule();

-- Every new version must come with its schedule (checked at commit)
CREATE OR REPLACE FUNCTION check_fee_version_has_schedule() RETURNS trigger AS $$
BEGIN
    IF NEW.final_payable > 0 AND NOT EXISTS (SELECT 1 FROM fee_version_installments WHERE version_id = NEW.version_id) THEN
        RAISE EXCEPTION 'Fee version % has no payment schedule (a due date and amount per instalment)', NEW.version_no;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_fee_versions_schedule_required
    AFTER INSERT ON fee_discussion_versions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_fee_version_has_schedule();

-- ---------------------------------------------------------------------------
-- Invoices: the schedule comes from the fee version
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_invoice_insert() RETURNS trigger AS $$
DECLARE
    v RECORD;
    v_prefix VARCHAR;
    v_fy TEXT;
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
    NEW.agreed_due_days = NULL;                     -- 018: dates come from the fee version's schedule
    NEW.terms = COALESCE(NEW.terms, format('Standard ₹%s · offer discount ₹%s · extra concession ₹%s · final ₹%s',
                                           v.standard_fee, v.offer_discount, v.extra_concession, v.final_payable));

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

CREATE OR REPLACE FUNCTION after_invoice_insert() RETURNS trigger AS $$
BEGIN
    IF NEW.billed_amount > 0 THEN
        IF NOT EXISTS (SELECT 1 FROM fee_version_installments WHERE version_id = NEW.fee_version_id) THEN
            RAISE EXCEPTION 'The fee version has no payment schedule';
        END IF;
        INSERT INTO installments (invoice_id, installment_no, amount_due, due_date)
        SELECT NEW.invoice_id, installment_no, amount, due_date
        FROM fee_version_installments WHERE version_id = NEW.fee_version_id;
    END IF;

    UPDATE invoices SET superseded_by_invoice_id = NEW.invoice_id
    WHERE fee_discussion_id = NEW.fee_discussion_id AND status = 'Superseded' AND superseded_by_invoice_id IS NULL
      AND invoice_id <> NEW.invoice_id;
    UPDATE fee_discussions SET milestone = 'Invoice Issued'
    WHERE fee_discussion_id = NEW.fee_discussion_id AND milestone NOT IN ('Invoice Issued', 'Converted');
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Due dates can move to any date; amounts change only via fee changes
CREATE OR REPLACE FUNCTION guard_installment_update() RETURNS trigger AS $$
BEGIN
    IF NEW.amount_due IS DISTINCT FROM OLD.amount_due
       AND COALESCE(current_setting('app.applying_fee_change', TRUE), '') <> 'on' THEN
        RAISE EXCEPTION 'Installment amounts change only through an approved fee change';
    END IF;
    IF (NEW.invoice_id, NEW.installment_no) IS DISTINCT FROM (OLD.invoice_id, OLD.installment_no) THEN
        RAISE EXCEPTION 'Installment identity cannot change';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Applied fee change: instalments rescale in proportion to their current amounts (due dates kept)
CREATE OR REPLACE FUNCTION before_fee_change_write() RETURNS trigger AS $$
DECLARE
    v_admission admissions%ROWTYPE;
    v_verified NUMERIC;
    v_old_billed NUMERIC;
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
            SELECT billed_amount INTO v_old_billed FROM invoices WHERE invoice_id = v_admission.invoice_id;
            UPDATE invoices
            SET original_billed_amount = COALESCE(original_billed_amount, billed_amount),
                billed_amount = NEW.new_fee, revised_at = CURRENT_TIMESTAMP
            WHERE invoice_id = v_admission.invoice_id;
            UPDATE installments i SET amount_due = x.amount
            FROM (
                SELECT installment_no,
                       CASE WHEN installment_no = MAX(installment_no) OVER ()
                            THEN NEW.new_fee - (SUM(amount) OVER () - amount) ELSE amount END AS amount
                FROM (SELECT installment_no,
                             ROUND(CASE WHEN v_old_billed > 0 THEN NEW.new_fee * amount_due / v_old_billed ELSE 0 END, 2) AS amount
                      FROM installments WHERE invoice_id = v_admission.invoice_id) p
            ) x
            WHERE i.invoice_id = v_admission.invoice_id AND i.installment_no = x.installment_no;
        END IF;
        PERFORM set_config('app.applying_fee_change', 'off', TRUE);
        NEW.applied_at = COALESCE(NEW.applied_at, CURRENT_TIMESTAMP);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Admission: verified payments must reach the admission token
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admission_token_amount() RETURNS NUMERIC AS $$
    SELECT COALESCE((SELECT (setting_value #>> '{}')::NUMERIC FROM app_settings WHERE setting_key = 'admission_token_amount'), 1000)
$$ LANGUAGE sql STABLE;

-- The verified, un-reversed payment on the invoice at which verified money first reaches the token
-- (the whole bill if it is below the token). NULL while the token isn't reached.
CREATE OR REPLACE FUNCTION invoice_token_payment(p_invoice_id INT)
RETURNS TABLE (payment_id INT, verified_at TIMESTAMP WITH TIME ZONE, verified_total NUMERIC, token NUMERIC) AS $$
    WITH paid AS (
        SELECT p.payment_id, p.verified_at,
               SUM(p.amount) OVER (ORDER BY p.verified_at, p.payment_id) AS running
        FROM payments p
        WHERE p.invoice_id = p_invoice_id AND p.entry_type = 'Payment' AND p.verification_status = 'Verified'
          AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.payment_id)
    ), target AS (
        SELECT LEAST(admission_token_amount(), billed_amount) AS token FROM invoices WHERE invoice_id = p_invoice_id
    )
    SELECT (SELECT paid.payment_id FROM paid, target WHERE paid.running >= target.token ORDER BY paid.running LIMIT 1),
           (SELECT paid.verified_at FROM paid, target WHERE paid.running >= target.token ORDER BY paid.running LIMIT 1),
           COALESCE((SELECT MAX(running) FROM paid), 0),
           (SELECT token FROM target)
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION before_admission_insert() RETURNS trigger AS $$
DECLARE
    v_prefix VARCHAR;
    v_year TEXT;
    v RECORD;
    v_token RECORD;
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

-- ---------------------------------------------------------------------------
-- Payment gaps: next unpaid instalment due long after the last verified payment
-- ---------------------------------------------------------------------------
CREATE VIEW payment_gaps AS
WITH last_paid AS (
    SELECT p.invoice_id, MAX(p.payment_date) AS last_payment_date
    FROM payments p
    WHERE p.invoice_id IS NOT NULL AND p.entry_type = 'Payment' AND p.verification_status = 'Verified'
      AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.payment_id)
    GROUP BY p.invoice_id
), next_due AS (
    SELECT DISTINCT ON (invoice_id) invoice_id, installment_no, due_date, balance
    FROM installment_dues
    WHERE balance > 0 AND due_position <> 'Cancelled'
    ORDER BY invoice_id, installment_no
)
SELECT
    b.invoice_id,
    b.invoice_number,
    b.person_id,
    b.lead_id,
    b.admission_id,
    b.course_id,
    b.collecting_branch_id,
    lp.last_payment_date,
    n.installment_no AS next_installment_no,
    n.due_date AS next_due_date,
    n.balance AS next_due_balance,
    n.due_date - lp.last_payment_date AS gap_days,
    b.outstanding
FROM invoice_balances b
JOIN last_paid lp ON lp.invoice_id = b.invoice_id
JOIN next_due n ON n.invoice_id = b.invoice_id
WHERE b.status = 'Issued' AND b.outstanding > 0
  AND n.due_date - lp.last_payment_date >
      COALESCE((SELECT (setting_value #>> '{}')::INT FROM app_settings WHERE setting_key = 'payment_gap_alert_days'), 30);
