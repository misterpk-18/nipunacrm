-- 021 — Multi-course invoices with per-course payment allocation (UI V4).
--
-- 1. Branch details. branches gets legal_name and invoice_accent (Guntur violet #6251DA, Vijayawada teal #137E89);
--    address / phone / email are seeded with the issuing addresses from the V4 handoff (admin-editable). Every
--    invoice keeps a snapshot of its issuer (issuer_* columns), so later branch edits never change an issued invoice.
-- 2. Invoice lines. An invoice holds the person, collecting branch, totals and the instalment schedule; each course
--    is a line (invoice_lines: lead, fee discussion, approved version, course, delivery plan, amount;
--    INV-GNT-2627-0001-L1). A line can be added only while its invoice is being issued, and only for an eligible
--    course deal: same person and branch as the invoice, converted and still open, an Approved current fee version
--    (its final payable is the line amount), an accepted delivery plan, and not already on an Issued invoice.
--    The invoice's billed / standard totals are the sum of its lines.
-- 3. Schedule. The flexible 1–3 instalments are given with the invoice (no longer copied from the fee version) and
--    apply to the invoice total: counted per the plan (Full 1 / Two 2 / Three 3), numbered 1..n, dates in order,
--    amounts adding up to the total — checked at commit. Fee versions no longer need a schedule.
-- 4. Payments. A payment against an invoice is split across its course lines (payment_allocations); the allocations
--    must add up to the payment (checked at commit) and no line can be paid beyond what is left on it (pending
--    included, waivers excluded). A reversal gets the negated allocations of the payment it reverses.
--    payments.admission_id is kept as "the admission, when the whole payment went to one admitted course line".
-- 5. Balances. invoice_line_balances (per course line) and invoice_balances (per invoice) come from allocations.
--    Instalment dues stay at invoice level; verified money covers the oldest instalment first.
-- 6. Admission per line. admissions.invoice_line_id (one admission per line); it needs the line's accepted
--    delivery plan and verified money on that line reaching the admission token (₹1,000, or the whole line if
--    smaller). admissions.invoice_id is kept (no longer unique).
-- 7. Fee changes revise the admission's line; the invoice total follows and its instalments are rescaled.
--    Refund approval is capped by the verified money on the admission's line. Promises to pay move to the invoice
--    (payment_promises.invoice_id; admission_id optional).
-- 8. Cancelling an unpaid invoice puts its courses' fee discussions back to Fee Shared / Approved, so they can be
--    invoiced again. Re-issuing no longer supersedes automatically: a course already on an Issued invoice is refused.
--
-- Existing invoices become one-line invoices; their payments are allocated to that line.
--
-- Depends on: 020_delivery_plans.sql

-- ---------------------------------------------------------------------------
-- 1. Branch details
-- ---------------------------------------------------------------------------
ALTER TABLE branches
    ADD COLUMN legal_name VARCHAR(150) NOT NULL DEFAULT 'Nipuna Technologies',
    ADD COLUMN invoice_accent VARCHAR(7),
    ADD CONSTRAINT branches_invoice_accent_hex CHECK (invoice_accent IS NULL OR invoice_accent ~ '^#[0-9A-Fa-f]{6}$');

UPDATE branches SET
    address = E'Door No. 6-4-35, 1st Floor, 4/1 Arundelpet\nOpposite Aditya Grand Hotel\nGuntur, Andhra Pradesh 522002, India',
    phone = '+91 79979 27111', email = 'guntur@nipunacareers.com', invoice_accent = '#6251DA'
WHERE branch_code = 'NIT-GNT';
UPDATE branches SET
    address = E'Door No. 40-27-88/1, 3rd Floor, Lohia Towers\nKP Nagar, Opposite Nirmala Convent\nVijayawada, Andhra Pradesh 520010, India',
    phone = '+91 99858 58639', email = 'vijayawada@nipunacareers.com', invoice_accent = '#137E89'
WHERE branch_code = 'NIT-VIJ';

-- ---------------------------------------------------------------------------
-- 2. Invoice issuer snapshot, lines, allocations
-- ---------------------------------------------------------------------------
ALTER TABLE invoices
    ADD COLUMN issuer_legal_name VARCHAR(150),
    ADD COLUMN issuer_branch_code VARCHAR(20),
    ADD COLUMN issuer_branch_name VARCHAR(100),
    ADD COLUMN issuer_address TEXT,
    ADD COLUMN issuer_phone VARCHAR(20),
    ADD COLUMN issuer_email VARCHAR(255),
    ADD COLUMN issuer_accent VARCHAR(7);

CREATE TABLE invoice_lines (
    invoice_line_id SERIAL PRIMARY KEY,
    invoice_id INT NOT NULL REFERENCES invoices(invoice_id),
    line_no SMALLINT NOT NULL,
    line_code VARCHAR(40) NOT NULL UNIQUE,                  -- INV-GNT-2627-0001-L1
    lead_id INT NOT NULL REFERENCES leads(lead_id),
    fee_discussion_id INT NOT NULL REFERENCES fee_discussions(fee_discussion_id),
    fee_version_id INT NOT NULL REFERENCES fee_discussion_versions(version_id),
    course_id INT NOT NULL REFERENCES courses(course_id),
    delivery_plan_id INT REFERENCES delivery_plans(delivery_plan_id),
    standard_fee NUMERIC(10, 2) NOT NULL,
    billed_amount NUMERIC(10, 2) NOT NULL,
    original_billed_amount NUMERIC(10, 2),
    revised_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT invoice_lines_no_unique UNIQUE (invoice_id, line_no),
    CONSTRAINT invoice_lines_billed_amount_check CHECK (billed_amount >= 0),
    CONSTRAINT invoice_lines_standard_fee_check CHECK (standard_fee >= 0)
);
CREATE INDEX invoice_lines_lead_idx ON invoice_lines (lead_id);

CREATE TABLE payment_allocations (
    payment_allocation_id SERIAL PRIMARY KEY,
    payment_id INT NOT NULL REFERENCES payments(payment_id),
    invoice_line_id INT NOT NULL REFERENCES invoice_lines(invoice_line_id),
    amount NUMERIC(10, 2) NOT NULL,                         -- negative on a reversal
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT payment_allocations_one_per_line UNIQUE (payment_id, invoice_line_id),
    CONSTRAINT payment_allocations_amount_nonzero CHECK (amount <> 0)
);
CREATE INDEX payment_allocations_line_idx ON payment_allocations (invoice_line_id);

ALTER TABLE admissions ADD COLUMN invoice_line_id INT UNIQUE REFERENCES invoice_lines(invoice_line_id);
ALTER TABLE payment_promises ADD COLUMN invoice_id INT REFERENCES invoices(invoice_id);

-- ---------------------------------------------------------------------------
-- Backfill: every existing invoice becomes a one-line invoice
-- ---------------------------------------------------------------------------
INSERT INTO invoice_lines (invoice_id, line_no, line_code, lead_id, fee_discussion_id, fee_version_id, course_id,
                           delivery_plan_id, standard_fee, billed_amount, original_billed_amount, revised_at, created_at)
SELECT i.invoice_id, 1, i.invoice_number || '-L1', i.lead_id, i.fee_discussion_id, i.fee_version_id, i.course_id,
       dp.delivery_plan_id, i.standard_fee, i.billed_amount, i.original_billed_amount, i.revised_at, i.created_at
FROM invoices i
LEFT JOIN delivery_plans dp ON dp.lead_id = i.lead_id;

UPDATE invoices i SET issuer_legal_name = b.legal_name, issuer_branch_code = b.branch_code,
       issuer_branch_name = b.branch_name, issuer_address = b.address, issuer_phone = b.phone,
       issuer_email = b.email, issuer_accent = b.invoice_accent
FROM branches b WHERE b.branch_id = i.collecting_branch_id;

UPDATE admissions a SET invoice_line_id = l.invoice_line_id
FROM invoice_lines l WHERE l.invoice_id = a.invoice_id;

INSERT INTO payment_allocations (payment_id, invoice_line_id, amount, created_at)
SELECT p.payment_id, l.invoice_line_id, p.amount, p.created_at
FROM payments p JOIN invoice_lines l ON l.invoice_id = p.invoice_id;

UPDATE payment_promises pp SET invoice_id = COALESCE(a.invoice_id, parent.invoice_id)
FROM admissions a LEFT JOIN admissions parent ON parent.admission_id = a.complimentary_of_admission_id
WHERE a.admission_id = pp.admission_id;

ALTER TABLE payment_promises
    ALTER COLUMN invoice_id SET NOT NULL,
    ALTER COLUMN admission_id DROP NOT NULL;
CREATE INDEX payment_promises_invoice_idx ON payment_promises (invoice_id, status);

-- ---------------------------------------------------------------------------
-- Old single-course invoice shape goes
-- ---------------------------------------------------------------------------
DROP VIEW payment_gaps;
DROP VIEW installment_dues;
DROP VIEW invoice_balances;
DROP VIEW admission_balances;

DROP TRIGGER trg_invoices_after_insert ON invoices;
DROP FUNCTION after_invoice_insert();
DROP TRIGGER trg_payments_after_verified_insert ON payments;
DROP TRIGGER trg_payments_after_verified_update ON payments;
DROP FUNCTION after_payment_verified();
DROP TRIGGER trg_fee_versions_schedule_required ON fee_discussion_versions;
DROP FUNCTION check_fee_version_has_schedule();
DROP FUNCTION invoice_token_payment(INT);

DROP INDEX invoices_one_issued_per_discussion;
ALTER TABLE invoices
    DROP COLUMN fee_discussion_id,
    DROP COLUMN fee_version_id,
    DROP COLUMN lead_id,
    DROP COLUMN course_id,
    DROP COLUMN agreed_due_days;

ALTER TABLE admissions
    DROP CONSTRAINT admissions_invoice_id_key,
    ADD CONSTRAINT admissions_paid_needs_line CHECK (complimentary_of_admission_id IS NOT NULL OR invoice_line_id IS NOT NULL);
CREATE INDEX admissions_invoice_idx ON admissions (invoice_id);

-- ---------------------------------------------------------------------------
-- Balance views
-- ---------------------------------------------------------------------------
CREATE VIEW invoice_line_balances AS
SELECT
    l.invoice_line_id,
    l.line_code,
    l.line_no,
    l.invoice_id,
    i.invoice_number,
    i.person_id,
    l.lead_id,
    l.course_id,
    i.collecting_branch_id,
    i.status,
    a.admission_id,
    l.billed_amount,
    COALESCE(p.verified_paid, 0) AS verified_paid,
    COALESCE(p.pending_verification, 0) AS pending_verification,
    COALESCE(w.waived, 0) AS waived,
    COALESCE(p.taken, 0) AS taken,                           -- verified + pending: counts against the line's cap
    GREATEST(l.billed_amount - COALESCE(p.verified_paid, 0) - COALESCE(w.waived, 0), 0) AS outstanding,
    GREATEST(l.billed_amount - COALESCE(w.waived, 0) - COALESCE(p.taken, 0), 0) AS open_to_allocate,
    CASE
        WHEN COALESCE(p.verified_paid, 0) <= 0 THEN 'Unpaid'
        WHEN l.billed_amount - COALESCE(p.verified_paid, 0) - COALESCE(w.waived, 0) <= 0 THEN 'Paid'
        ELSE 'Part Paid'
    END AS payment_completion
FROM invoice_lines l
JOIN invoices i ON i.invoice_id = l.invoice_id
LEFT JOIN admissions a ON a.invoice_line_id = l.invoice_line_id
LEFT JOIN (
    SELECT pa.invoice_line_id,
           SUM(pa.amount) FILTER (WHERE p.verification_status = 'Verified') AS verified_paid,
           SUM(pa.amount) FILTER (WHERE p.verification_status = 'Pending Verification' AND pa.amount > 0) AS pending_verification,
           SUM(pa.amount) FILTER (WHERE p.verification_status <> 'Failed') AS taken
    FROM payment_allocations pa JOIN payments p ON p.payment_id = pa.payment_id
    GROUP BY pa.invoice_line_id
) p ON p.invoice_line_id = l.invoice_line_id
LEFT JOIN (
    SELECT admission_id, SUM(approved_waiver_amount) AS waived
    FROM refund_cases WHERE refund_decision = 'Waiver Approved'
    GROUP BY admission_id
) w ON w.admission_id = a.admission_id;

CREATE VIEW invoice_balances AS
SELECT
    i.invoice_id,
    i.invoice_number,
    i.person_id,
    i.collecting_branch_id,
    i.issued_on,
    i.status,
    i.billed_amount,
    COALESCE(s.verified_paid, 0) AS verified_paid,
    COALESCE(s.pending_verification, 0) AS pending_verification,
    COALESCE(s.waived, 0) AS waived,
    GREATEST(i.billed_amount - COALESCE(s.verified_paid, 0) - COALESCE(s.waived, 0), 0) AS outstanding,
    CASE
        WHEN COALESCE(s.verified_paid, 0) <= 0 THEN 'Unpaid'
        WHEN i.billed_amount - COALESCE(s.verified_paid, 0) - COALESCE(s.waived, 0) <= 0 THEN 'Paid'
        ELSE 'Part Paid'
    END AS payment_completion,
    CASE
        WHEN i.status <> 'Issued' THEN i.status::TEXT
        WHEN i.billed_amount - COALESCE(s.verified_paid, 0) - COALESCE(s.waived, 0) <= 0 THEN 'Paid'
        WHEN COALESCE(s.verified_paid, 0) > 0 THEN 'Part Paid'
        ELSE 'Issued'
    END AS invoice_state,
    COALESCE(s.line_count, 0) AS line_count,
    COALESCE(s.admitted_lines, 0) AS admitted_lines,
    COALESCE(s.line_count, 0) > 0 AND COALESCE(s.cancelled_lines, 0) = COALESCE(s.line_count, 0) AS all_admissions_cancelled
FROM invoices i
LEFT JOIN (
    SELECT lb.invoice_id,
           SUM(lb.verified_paid) AS verified_paid,
           SUM(lb.pending_verification) AS pending_verification,
           SUM(lb.waived) AS waived,
           COUNT(*) AS line_count,
           COUNT(lb.admission_id) AS admitted_lines,
           COUNT(*) FILTER (WHERE a.enrolment_status = 'Cancelled') AS cancelled_lines
    FROM invoice_line_balances lb
    LEFT JOIN admissions a ON a.admission_id = lb.admission_id
    GROUP BY lb.invoice_id
) s ON s.invoice_id = i.invoice_id;

CREATE VIEW admission_balances AS
SELECT
    a.admission_id,
    a.admission_code,
    a.person_id,
    a.service_branch_id,
    a.enrolment_status,
    a.final_fee,
    COALESCE(lb.verified_paid, 0) AS verified_paid,
    COALESCE(lb.pending_verification, 0) AS pending_verification,
    COALESCE(r.waived, 0) AS waived,
    COALESCE(r.refunded, 0) AS refunded,
    CASE WHEN a.enrolment_status = 'Cancelled' THEN 0
         ELSE a.final_fee - COALESCE(lb.verified_paid, 0) - COALESCE(r.waived, 0)
    END AS outstanding,
    CASE
        WHEN a.final_fee - COALESCE(lb.verified_paid, 0) - COALESCE(r.waived, 0) <= 0 THEN 'Paid'
        WHEN COALESCE(lb.verified_paid, 0) > 0 THEN 'Part Paid'
        ELSE 'Unpaid'
    END AS payment_completion,
    a.invoice_id,
    a.invoice_line_id
FROM admissions a
LEFT JOIN invoice_line_balances lb ON lb.invoice_line_id = a.invoice_line_id
LEFT JOIN (
    SELECT admission_id,
           SUM(approved_waiver_amount) FILTER (WHERE refund_decision = 'Waiver Approved') AS waived,
           SUM(payout_amount) FILTER (WHERE payout_status = 'Completed') AS refunded
    FROM refund_cases GROUP BY admission_id
) r ON r.admission_id = a.admission_id;

CREATE VIEW installment_dues AS
WITH running AS (
    SELECT inst.installment_id, inst.installment_no, inst.amount_due, inst.due_date, inst.invoice_id,
           SUM(inst.amount_due) OVER (PARTITION BY inst.invoice_id ORDER BY inst.installment_no) AS cumulative_due
    FROM installments inst
), applied AS (
    SELECT r.*, b.invoice_number, b.person_id, b.collecting_branch_id, b.pending_verification,
           b.all_admissions_cancelled,
           LEAST(r.amount_due, GREATEST(0, b.verified_paid + b.waived - (r.cumulative_due - r.amount_due))) AS amount_covered
    FROM running r
    JOIN invoice_balances b ON b.invoice_id = r.invoice_id
    WHERE b.status = 'Issued'
)
SELECT
    installment_id,
    invoice_id,
    invoice_number,
    person_id,
    collecting_branch_id,
    installment_no,
    due_date,
    amount_due,
    amount_covered,
    amount_due - amount_covered AS balance,
    CASE
        WHEN all_admissions_cancelled THEN 'Cancelled'
        WHEN amount_due - amount_covered = 0 THEN 'Paid'
        WHEN due_date < CURRENT_DATE THEN 'Overdue'
        WHEN due_date = CURRENT_DATE THEN 'Due Today'
        ELSE 'Upcoming'
    END AS due_position,
    CASE WHEN amount_due - amount_covered > 0 AND due_date < CURRENT_DATE THEN CURRENT_DATE - due_date END AS days_overdue,
    CASE
        WHEN amount_due - amount_covered = 0 OR due_date >= CURRENT_DATE OR all_admissions_cancelled THEN NULL
        WHEN CURRENT_DATE - due_date <= 3 THEN '1–3'
        WHEN CURRENT_DATE - due_date <= 7 THEN '4–7'
        WHEN CURRENT_DATE - due_date <= 15 THEN '8–15'
        WHEN CURRENT_DATE - due_date <= 30 THEN '16–30'
        WHEN CURRENT_DATE - due_date <= 60 THEN '31–60'
        WHEN CURRENT_DATE - due_date <= 90 THEN '61–90'
        ELSE '91+'
    END AS age_band,
    pending_verification > 0 AS contact_hold
FROM applied;

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
    (SELECT l.lead_id FROM invoice_lines l WHERE l.invoice_id = b.invoice_id ORDER BY l.line_no LIMIT 1) AS lead_id,
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

-- ---------------------------------------------------------------------------
-- Invoices: header (number, issuer snapshot), completeness at commit, immutability, cancellation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_invoice_insert() RETURNS trigger AS $$
DECLARE
    v_branch branches%ROWTYPE;
    v_fy TEXT;
BEGIN
    SELECT * INTO v_branch FROM branches WHERE branch_id = NEW.collecting_branch_id;
    IF NOT FOUND OR NOT v_branch.is_active THEN
        RAISE EXCEPTION 'Unknown or inactive issuing branch';
    END IF;
    IF NEW.status <> 'Issued' THEN
        RAISE EXCEPTION 'A new invoice starts as Issued';
    END IF;
    -- Totals come from the lines (added in the same transaction)
    NEW.billed_amount = 0;
    NEW.standard_fee = 0;
    NEW.original_billed_amount = NULL;
    NEW.revised_at = NULL;
    NEW.issuer_legal_name = v_branch.legal_name;
    NEW.issuer_branch_code = v_branch.branch_code;
    NEW.issuer_branch_name = v_branch.branch_name;
    NEW.issuer_address = v_branch.address;
    NEW.issuer_phone = v_branch.phone;
    NEW.issuer_email = v_branch.email;
    NEW.issuer_accent = v_branch.invoice_accent;
    IF NEW.invoice_number IS NULL THEN
        v_fy = fy_code(NEW.issued_on);
        NEW.invoice_number = 'INV-' || v_branch.receipt_prefix || '-' || v_fy || '-'
            || LPAD(next_number('INVOICE-' || v_branch.receipt_prefix || '-' || v_fy)::TEXT, 4, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- At commit: at least one line; the schedule matches the plan and adds up to the total, dates in order
CREATE OR REPLACE FUNCTION check_invoice_complete() RETURNS trigger AS $$
DECLARE
    v_invoice invoices%ROWTYPE;
    v_expected INT;
    v_count INT;
    v_max INT;
    v_total NUMERIC;
BEGIN
    SELECT * INTO v_invoice FROM invoices WHERE invoice_id = NEW.invoice_id;
    IF NOT EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = NEW.invoice_id) THEN
        RAISE EXCEPTION 'Invoice % needs at least one course', v_invoice.invoice_number;
    END IF;
    SELECT COUNT(*) INTO v_expected FROM payment_plan_installments WHERE payment_plan_id = v_invoice.payment_plan_id;
    SELECT COUNT(*), MAX(installment_no), COALESCE(SUM(amount_due), 0) INTO v_count, v_max, v_total
    FROM installments WHERE invoice_id = NEW.invoice_id;
    IF v_invoice.billed_amount = 0 THEN
        IF v_count > 0 THEN
            RAISE EXCEPTION 'Invoice % totals ₹0 and has nothing to schedule', v_invoice.invoice_number;
        END IF;
        RETURN NULL;
    END IF;
    IF v_count <> v_expected OR v_max <> v_count THEN
        RAISE EXCEPTION 'Invoice % needs % instalment(s), numbered 1 to %', v_invoice.invoice_number, v_expected, v_expected;
    END IF;
    IF v_total <> v_invoice.billed_amount THEN
        RAISE EXCEPTION 'Instalments add up to ₹% but the invoice total is ₹%', v_total, v_invoice.billed_amount;
    END IF;
    IF EXISTS (SELECT 1 FROM installments a JOIN installments b
                 ON b.invoice_id = a.invoice_id AND b.installment_no = a.installment_no + 1
               WHERE a.invoice_id = NEW.invoice_id AND b.due_date <= a.due_date) THEN
        RAISE EXCEPTION 'Instalment due dates must be in order, each after the previous one';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_invoices_complete
    AFTER INSERT ON invoices
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_invoice_complete();

CREATE OR REPLACE FUNCTION guard_invoice_update() RETURNS trigger AS $$
BEGIN
    IF (NEW.invoice_number, NEW.person_id, NEW.collecting_branch_id, NEW.payment_plan_id, NEW.terms, NEW.issued_on,
        NEW.day0_date, NEW.issued_by, NEW.created_at, NEW.issuer_legal_name, NEW.issuer_branch_code,
        NEW.issuer_branch_name, NEW.issuer_address, NEW.issuer_phone, NEW.issuer_email, NEW.issuer_accent)
       IS DISTINCT FROM
       (OLD.invoice_number, OLD.person_id, OLD.collecting_branch_id, OLD.payment_plan_id, OLD.terms, OLD.issued_on,
        OLD.day0_date, OLD.issued_by, OLD.created_at, OLD.issuer_legal_name, OLD.issuer_branch_code,
        OLD.issuer_branch_name, OLD.issuer_address, OLD.issuer_phone, OLD.issuer_email, OLD.issuer_accent) THEN
        RAISE EXCEPTION 'Invoices are immutable; cancel it and issue a new invoice instead';
    END IF;
    IF (NEW.billed_amount, NEW.standard_fee) IS DISTINCT FROM (OLD.billed_amount, OLD.standard_fee)
       AND COALESCE(current_setting('app.applying_fee_change', TRUE), '') <> 'on'
       AND COALESCE(current_setting('app.building_invoice', TRUE), '') <> 'on' THEN
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

-- A cancelled (or superseded) invoice releases its courses: they can be invoiced again
CREATE OR REPLACE FUNCTION after_invoice_status_change() RETURNS trigger AS $$
BEGIN
    IF NEW.status IN ('Cancelled', 'Superseded') THEN
        UPDATE fee_discussions d
        SET milestone = CASE WHEN d.fee_shared_at IS NOT NULL THEN 'Fee Shared' ELSE 'Approved' END::fee_discussion_milestone
        FROM invoice_lines l
        WHERE l.invoice_id = NEW.invoice_id AND d.fee_discussion_id = l.fee_discussion_id
          AND d.milestone = 'Invoice Issued';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoices_after_status
    AFTER UPDATE OF status ON invoices
    FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION after_invoice_status_change();

-- ---------------------------------------------------------------------------
-- Invoice lines: only eligible course deals, only while the invoice is being issued
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_invoice_line_insert() RETURNS trigger AS $$
DECLARE
    v_invoice invoices%ROWTYPE;
    v_lead leads%ROWTYPE;
    v_course TEXT;
    v_discussion fee_discussions%ROWTYPE;
    v_version fee_discussion_versions%ROWTYPE;
    v_plan delivery_plans%ROWTYPE;
    v_other TEXT;
BEGIN
    SELECT * INTO v_invoice FROM invoices WHERE invoice_id = NEW.invoice_id FOR UPDATE;
    IF v_invoice.status <> 'Issued' OR v_invoice.created_at <> CURRENT_TIMESTAMP THEN
        RAISE EXCEPTION 'Courses are added to an invoice only when it is issued; issue a new invoice instead';
    END IF;
    SELECT * INTO v_lead FROM leads WHERE lead_id = NEW.lead_id FOR UPDATE;
    SELECT course_title INTO v_course FROM courses WHERE course_id = v_lead.course_id;
    v_course = COALESCE(v_course, v_lead.lead_code);

    IF v_lead.person_id <> v_invoice.person_id THEN
        RAISE EXCEPTION '% belongs to a different person; one invoice bills one learner', v_course;
    END IF;
    IF v_lead.branch_id <> v_invoice.collecting_branch_id THEN
        RAISE EXCEPTION '% is a deal at another branch; combine only courses of the same branch', v_course;
    END IF;
    IF v_lead.converted_at IS NULL THEN
        RAISE EXCEPTION '% is not a deal yet; convert the lead first', v_course;
    END IF;
    IF v_lead.stage IN ('Admitted', 'Lost - closed') THEN
        RAISE EXCEPTION '% is % and can''t be invoiced', v_course, v_lead.stage;
    END IF;
    SELECT i.invoice_number INTO v_other
    FROM invoice_lines l JOIN invoices i ON i.invoice_id = l.invoice_id
    WHERE l.lead_id = NEW.lead_id AND i.status = 'Issued' AND i.invoice_id <> NEW.invoice_id;
    IF v_other IS NOT NULL THEN
        RAISE EXCEPTION '% is already invoiced on %', v_course, v_other;
    END IF;
    IF EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = NEW.invoice_id AND lead_id = NEW.lead_id) THEN
        RAISE EXCEPTION '% is already on this invoice', v_course;
    END IF;

    SELECT * INTO v_discussion FROM fee_discussions
    WHERE lead_id = NEW.lead_id AND milestone NOT IN ('Converted', 'Expired', 'Cancelled')
    ORDER BY fee_discussion_id DESC LIMIT 1;
    SELECT * INTO v_version FROM fee_discussion_versions
    WHERE fee_discussion_id = v_discussion.fee_discussion_id ORDER BY version_no DESC LIMIT 1;
    IF v_version.version_id IS NULL OR v_version.status <> 'Approved' THEN
        RAISE EXCEPTION '% has no approved fee version; approve the fee first', v_course;
    END IF;
    SELECT * INTO v_plan FROM delivery_plans WHERE lead_id = NEW.lead_id;
    IF v_plan.accepted_at IS NULL THEN
        RAISE EXCEPTION '% needs an accepted delivery plan before invoicing', v_course;
    END IF;

    NEW.fee_discussion_id = v_discussion.fee_discussion_id;
    NEW.fee_version_id = v_version.version_id;
    NEW.course_id = v_discussion.course_id;
    NEW.delivery_plan_id = v_plan.delivery_plan_id;
    NEW.standard_fee = v_version.standard_fee;
    NEW.billed_amount = v_version.final_payable;
    NEW.original_billed_amount = NULL;
    NEW.revised_at = NULL;
    NEW.line_no = COALESCE((SELECT MAX(line_no) FROM invoice_lines WHERE invoice_id = NEW.invoice_id), 0) + 1;
    NEW.line_code = v_invoice.invoice_number || '-L' || NEW.line_no;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_lines_before_insert
    BEFORE INSERT ON invoice_lines
    FOR EACH ROW EXECUTE FUNCTION before_invoice_line_insert();

CREATE OR REPLACE FUNCTION after_invoice_line_insert() RETURNS trigger AS $$
BEGIN
    PERFORM set_config('app.building_invoice', 'on', TRUE);
    UPDATE invoices SET billed_amount = billed_amount + NEW.billed_amount, standard_fee = standard_fee + NEW.standard_fee
    WHERE invoice_id = NEW.invoice_id;
    PERFORM set_config('app.building_invoice', 'off', TRUE);
    UPDATE fee_discussions SET milestone = 'Invoice Issued'
    WHERE fee_discussion_id = NEW.fee_discussion_id AND milestone NOT IN ('Invoice Issued', 'Converted');
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_lines_after_insert
    AFTER INSERT ON invoice_lines
    FOR EACH ROW EXECUTE FUNCTION after_invoice_line_insert();

CREATE OR REPLACE FUNCTION guard_invoice_line_update() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Invoice lines can''t be deleted; cancel the invoice instead';
    END IF;
    IF (NEW.invoice_id, NEW.line_no, NEW.line_code, NEW.lead_id, NEW.fee_discussion_id, NEW.fee_version_id,
        NEW.course_id, NEW.delivery_plan_id, NEW.standard_fee, NEW.created_at)
       IS DISTINCT FROM
       (OLD.invoice_id, OLD.line_no, OLD.line_code, OLD.lead_id, OLD.fee_discussion_id, OLD.fee_version_id,
        OLD.course_id, OLD.delivery_plan_id, OLD.standard_fee, OLD.created_at) THEN
        RAISE EXCEPTION 'Invoice lines are immutable';
    END IF;
    IF NEW.billed_amount IS DISTINCT FROM OLD.billed_amount
       AND COALESCE(current_setting('app.applying_fee_change', TRUE), '') <> 'on' THEN
        RAISE EXCEPTION 'A course line amount changes only through an approved fee change';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_lines_guard
    BEFORE UPDATE OR DELETE ON invoice_lines
    FOR EACH ROW EXECUTE FUNCTION guard_invoice_line_update();

-- Instalments are written with the invoice; afterwards only due dates move (and fee changes rescale amounts)
CREATE OR REPLACE FUNCTION guard_installment_insert() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE invoice_id = NEW.invoice_id AND status = 'Issued'
                     AND created_at = CURRENT_TIMESTAMP) THEN
        RAISE EXCEPTION 'The instalment schedule is set when the invoice is issued';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_installments_insert_guard
    BEFORE INSERT ON installments
    FOR EACH ROW EXECUTE FUNCTION guard_installment_insert();

-- A fee version's own schedule is history now; it's frozen once any invoice line uses the version
CREATE OR REPLACE FUNCTION guard_fee_version_installments() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF EXISTS (SELECT 1 FROM invoice_lines WHERE fee_version_id = NEW.version_id) THEN
            RAISE EXCEPTION 'This fee version already has an invoice; its schedule can''t change';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'A fee version''s payment schedule is frozen; create a new version instead';
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Payments: header checks, allocations per course line, totals at commit, reversals
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_payment_allocation(p payments) RETURNS void AS $$
DECLARE
    v_invoice invoices%ROWTYPE;
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
    IF v_invoice.collecting_branch_id <> p.collecting_branch_id THEN
        RAISE EXCEPTION 'Payments on invoice % are collected by its issuing branch', v_invoice.invoice_number;
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

        NEW.admission_id = NULL;              -- linked from the allocations
        IF NEW.invoice_id IS NOT NULL THEN
            SELECT COALESCE(NEW.person_id, person_id) INTO NEW.person_id FROM invoices WHERE invoice_id = NEW.invoice_id;
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
       OR (NEW.admission_id IS DISTINCT FROM OLD.admission_id
           AND COALESCE(current_setting('app.linking_payments', TRUE), '') <> 'on')
       OR (OLD.proof_file_path IS NOT NULL AND NEW.proof_file_path IS DISTINCT FROM OLD.proof_file_path) THEN
        RAISE EXCEPTION 'Payment % is already allocated / documented; request a correction to change it', OLD.receipt_number;
    END IF;

    IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
        IF EXISTS (SELECT 1 FROM payments WHERE reverses_payment_id = OLD.payment_id) THEN
            RAISE EXCEPTION 'Payment % has been reversed and cannot be allocated', OLD.receipt_number;
        END IF;
        PERFORM check_payment_allocation(NEW);   -- the course-line allocations follow (checked at commit)
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

-- A reversal takes back exactly what the original put on each course line
CREATE OR REPLACE FUNCTION after_reversal_insert() RETURNS trigger AS $$
BEGIN
    INSERT INTO payment_allocations (payment_id, invoice_line_id, amount)
    SELECT NEW.payment_id, invoice_line_id, -amount FROM payment_allocations WHERE payment_id = NEW.reverses_payment_id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payments_after_reversal_insert
    AFTER INSERT ON payments
    FOR EACH ROW WHEN (NEW.entry_type = 'Reversal')
    EXECUTE FUNCTION after_reversal_insert();

-- At commit: an invoice payment is fully split across its course lines; an advance has no split
CREATE OR REPLACE FUNCTION check_payment_allocations_total() RETURNS trigger AS $$
DECLARE
    v_payment payments%ROWTYPE;
    v_total NUMERIC;
BEGIN
    SELECT * INTO v_payment FROM payments WHERE payment_id = NEW.payment_id;
    SELECT COALESCE(SUM(amount), 0) INTO v_total FROM payment_allocations WHERE payment_id = NEW.payment_id;
    IF v_payment.invoice_id IS NULL THEN
        IF v_total <> 0 OR EXISTS (SELECT 1 FROM payment_allocations WHERE payment_id = NEW.payment_id) THEN
            RAISE EXCEPTION 'An unallocated advance has no course allocation';
        END IF;
    ELSIF v_total <> v_payment.amount THEN
        RAISE EXCEPTION 'Payment % is ₹% but ₹% is allocated to its courses', v_payment.receipt_number, v_payment.amount, v_total;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_payments_allocations_total
    AFTER INSERT OR UPDATE OF invoice_id ON payments
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_payment_allocations_total();

CREATE OR REPLACE FUNCTION before_payment_allocation_insert() RETURNS trigger AS $$
DECLARE
    v_payment payments%ROWTYPE;
    v_line RECORD;
    v_taken NUMERIC;
    v_waived NUMERIC;
BEGIN
    SELECT * INTO v_payment FROM payments WHERE payment_id = NEW.payment_id;
    SELECT l.*, c.course_title INTO v_line
    FROM invoice_lines l JOIN courses c ON c.course_id = l.course_id
    WHERE l.invoice_line_id = NEW.invoice_line_id FOR UPDATE OF l;
    IF v_payment.invoice_id IS DISTINCT FROM v_line.invoice_id THEN
        RAISE EXCEPTION 'A payment is allocated only to courses on its own invoice';
    END IF;
    IF v_payment.entry_type = 'Reversal' THEN
        IF NEW.amount >= 0 THEN
            RAISE EXCEPTION 'A reversal takes money back from a course (negative allocation)';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.amount <= 0 THEN
        RAISE EXCEPTION 'Allocate a positive amount to %', v_line.course_title;
    END IF;
    IF v_payment.verification_status = 'Failed' THEN
        RAISE EXCEPTION 'Payment % failed verification and can''t be allocated', v_payment.receipt_number;
    END IF;

    SELECT COALESCE(SUM(pa.amount), 0) INTO v_taken
    FROM payment_allocations pa JOIN payments p ON p.payment_id = pa.payment_id
    WHERE pa.invoice_line_id = NEW.invoice_line_id AND p.verification_status <> 'Failed';
    SELECT COALESCE(SUM(r.approved_waiver_amount), 0) INTO v_waived
    FROM refund_cases r JOIN admissions a ON a.admission_id = r.admission_id
    WHERE a.invoice_line_id = NEW.invoice_line_id AND r.refund_decision = 'Waiver Approved';
    IF v_taken + NEW.amount > v_line.billed_amount - v_waived THEN
        RAISE EXCEPTION '₹% is more than the ₹% left on % (%); record the excess as an unallocated advance',
            NEW.amount, GREATEST(v_line.billed_amount - v_waived - v_taken, 0), v_line.course_title, v_line.line_code;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payment_allocations_before_insert
    BEFORE INSERT ON payment_allocations
    FOR EACH ROW EXECUTE FUNCTION before_payment_allocation_insert();

-- payments.admission_id: the admission, when the whole payment went to one admitted course line
CREATE OR REPLACE FUNCTION after_payment_allocation_insert() RETURNS trigger AS $$
DECLARE
    v_admission INT;
BEGIN
    IF (SELECT COUNT(DISTINCT invoice_line_id) FROM payment_allocations WHERE payment_id = NEW.payment_id) = 1 THEN
        SELECT admission_id INTO v_admission FROM admissions WHERE invoice_line_id = NEW.invoice_line_id;
    END IF;
    PERFORM set_config('app.linking_payments', 'on', TRUE);
    UPDATE payments SET admission_id = v_admission
    WHERE payment_id = NEW.payment_id AND admission_id IS DISTINCT FROM v_admission;
    PERFORM set_config('app.linking_payments', 'off', TRUE);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payment_allocations_after_insert
    AFTER INSERT ON payment_allocations
    FOR EACH ROW EXECUTE FUNCTION after_payment_allocation_insert();

CREATE OR REPLACE FUNCTION prevent_payment_allocation_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Payment allocations are part of the ledger; request a correction instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payment_allocations_immutable
    BEFORE UPDATE OR DELETE ON payment_allocations
    FOR EACH ROW EXECUTE FUNCTION prevent_payment_allocation_change();

-- ---------------------------------------------------------------------------
-- Admission per course line: accepted delivery plan + verified money on the line reaching the token
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION invoice_line_token_payment(p_line_id INT)
RETURNS TABLE (payment_id INT, verified_at TIMESTAMP WITH TIME ZONE, verified_total NUMERIC, token NUMERIC) AS $$
    WITH paid AS (
        SELECT p.payment_id, p.verified_at,
               SUM(pa.amount) OVER (ORDER BY p.verified_at, p.payment_id) AS running
        FROM payment_allocations pa
        JOIN payments p ON p.payment_id = pa.payment_id
        WHERE pa.invoice_line_id = p_line_id AND p.entry_type = 'Payment' AND p.verification_status = 'Verified'
          AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.payment_id)
    ), target AS (
        SELECT LEAST(admission_token_amount(), billed_amount) AS token FROM invoice_lines WHERE invoice_line_id = p_line_id
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
    v_plan delivery_plans%ROWTYPE;
    v_token RECORD;
    v_parent admissions%ROWTYPE;
    v_rule offer_complimentary_courses%ROWTYPE;
BEGIN
    IF NEW.complimentary_of_admission_id IS NULL THEN
        IF NEW.invoice_line_id IS NULL AND NEW.invoice_id IS NOT NULL
           AND (SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = NEW.invoice_id) = 1 THEN
            SELECT invoice_line_id INTO NEW.invoice_line_id FROM invoice_lines WHERE invoice_id = NEW.invoice_id;
        END IF;
        IF NEW.invoice_line_id IS NULL THEN
            RAISE EXCEPTION 'An admission is created from an invoiced course (invoice_line_id is required)';
        END IF;
        SELECT l.*, i.status AS invoice_status, i.invoice_number, i.person_id, i.payment_plan_id, ld.branch_id AS lead_branch,
               c.course_title
        INTO v
        FROM invoice_lines l
        JOIN invoices i ON i.invoice_id = l.invoice_id
        JOIN leads ld ON ld.lead_id = l.lead_id
        JOIN courses c ON c.course_id = l.course_id
        WHERE l.invoice_line_id = NEW.invoice_line_id;

        IF v.invoice_status <> 'Issued' THEN
            RAISE EXCEPTION 'Invoice % is %', v.invoice_number, v.invoice_status;
        END IF;
        IF NEW.invoice_id IS NOT NULL AND NEW.invoice_id <> v.invoice_id THEN
            RAISE EXCEPTION 'The course line is not on invoice %', NEW.invoice_id;
        END IF;
        SELECT * INTO v_plan FROM delivery_plans WHERE lead_id = v.lead_id;
        IF v_plan.accepted_at IS NULL THEN
            RAISE EXCEPTION 'Prerequisite missing: an accepted delivery plan for %', v.course_title;
        END IF;
        IF NEW.final_fee IS NOT NULL AND NEW.final_fee <> v.billed_amount THEN
            RAISE EXCEPTION 'Admission final_fee % does not match the invoiced amount %', NEW.final_fee, v.billed_amount;
        END IF;
        IF NEW.person_id IS NOT NULL AND NEW.person_id <> v.person_id THEN
            RAISE EXCEPTION 'Admission person must match the invoice';
        END IF;

        SELECT * INTO v_token FROM invoice_line_token_payment(NEW.invoice_line_id);
        IF v_token.token > 0 AND v_token.payment_id IS NULL THEN
            RAISE EXCEPTION 'Prerequisite missing: verified payments of at least ₹% on % (the admission token) — ₹% verified so far',
                v_token.token, v.course_title, v_token.verified_total;
        END IF;

        NEW.invoice_id = v.invoice_id;
        NEW.first_qualifying_payment_id = v_token.payment_id;
        NEW.first_verified_payment_at = COALESCE(v_token.verified_at, CURRENT_TIMESTAMP);
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
        NEW.invoice_id = NULL;
        NEW.invoice_line_id = NULL;
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

CREATE OR REPLACE FUNCTION after_admission_insert() RETURNS trigger AS $$
BEGIN
    IF NEW.invoice_line_id IS NOT NULL THEN
        -- Payments wholly on this course line now belong to the admission
        PERFORM set_config('app.linking_payments', 'on', TRUE);
        UPDATE payments p SET admission_id = NEW.admission_id
        WHERE p.invoice_id = NEW.invoice_id AND p.admission_id IS NULL
          AND EXISTS (SELECT 1 FROM payment_allocations pa WHERE pa.payment_id = p.payment_id)
          AND NOT EXISTS (SELECT 1 FROM payment_allocations pa
                          WHERE pa.payment_id = p.payment_id AND pa.invoice_line_id <> NEW.invoice_line_id);
        PERFORM set_config('app.linking_payments', 'off', TRUE);
        UPDATE fee_discussions SET milestone = 'Converted'
        WHERE fee_discussion_id = (SELECT fee_discussion_id FROM invoice_lines WHERE invoice_line_id = NEW.invoice_line_id);
    END IF;
    IF NEW.lead_id IS NOT NULL THEN
        UPDATE leads SET stage = 'Admitted' WHERE lead_id = NEW.lead_id AND stage <> 'Admitted';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Fee change: revises the admission's course line; the invoice total follows, instalments rescale
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_fee_change_write() RETURNS trigger AS $$
DECLARE
    v_admission admissions%ROWTYPE;
    v_line invoice_line_balances%ROWTYPE;
    v_old_total NUMERIC;
    v_new_total NUMERIC;
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
        SELECT * INTO v_line FROM invoice_line_balances WHERE invoice_line_id = v_admission.invoice_line_id;
        IF NEW.new_fee < COALESCE(v_line.verified_paid, 0) THEN
            RAISE EXCEPTION 'New fee % is below verified payments %; raise a refund case for the difference',
                NEW.new_fee, v_line.verified_paid;
        END IF;
        IF NEW.new_fee < COALESCE(v_line.taken, 0) THEN
            RAISE EXCEPTION 'New fee % is below the payments recorded on this course (% incl. pending verification)',
                NEW.new_fee, v_line.taken;
        END IF;

        PERFORM set_config('app.applying_fee_change', 'on', TRUE);
        UPDATE admissions SET final_fee = NEW.new_fee WHERE admission_id = NEW.admission_id;
        IF v_admission.invoice_line_id IS NOT NULL THEN
            UPDATE invoice_lines
            SET original_billed_amount = COALESCE(original_billed_amount, billed_amount),
                billed_amount = NEW.new_fee, revised_at = CURRENT_TIMESTAMP
            WHERE invoice_line_id = v_admission.invoice_line_id;
            SELECT billed_amount INTO v_old_total FROM invoices WHERE invoice_id = v_admission.invoice_id;
            v_new_total = v_old_total - v_admission.final_fee + NEW.new_fee;
            UPDATE invoices
            SET original_billed_amount = COALESCE(original_billed_amount, billed_amount),
                billed_amount = v_new_total, revised_at = CURRENT_TIMESTAMP
            WHERE invoice_id = v_admission.invoice_id;
            UPDATE installments i SET amount_due = x.amount
            FROM (
                SELECT installment_no,
                       CASE WHEN installment_no = MAX(installment_no) OVER ()
                            THEN v_new_total - (SUM(amount) OVER () - amount) ELSE amount END AS amount
                FROM (SELECT installment_no,
                             ROUND(CASE WHEN v_old_total > 0 THEN v_new_total * amount_due / v_old_total ELSE 0 END, 2) AS amount
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
-- Refund approval: capped by the verified money on the admission's course line
-- ---------------------------------------------------------------------------
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
        SELECT COALESCE(verified_paid, 0) INTO v_verified FROM admission_balances WHERE admission_id = NEW.admission_id;
        IF NEW.approved_refund_amount > COALESCE(v_verified, 0) THEN
            RAISE EXCEPTION 'Approved refund % exceeds verified payments %', NEW.approved_refund_amount, COALESCE(v_verified, 0);
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
