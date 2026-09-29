-- 022 — Transaction numbers, receipts only at verification (UI V4).
--
-- 1. Every payment gets a transaction number when it is recorded (TXN-GNT-00001, per collecting branch). A recorded
--    payment is a "payment claim": it has no receipt number and never counts as collected.
-- 2. The receipt number (GNT-R-2627-00001, per collecting branch and financial year) is issued only when Accounts
--    verifies the payment. Failed claims never get one. Reversals keep their REV- number (they are verified when the
--    correction is approved).
-- 3. Verifying needs two confirmations, recorded on the payment: the evidence was reviewed (every payment) and an
--    independent cash check was completed (cash payments).
--
-- Existing payments get transaction numbers in the order they were recorded; pending and failed ones lose the
-- receipt number they were given at recording (they were never receipts). Verified ones are marked as checked.
--
-- Depends on: 021_multi_course_invoices.sql

ALTER TABLE payments
    ADD COLUMN transaction_number VARCHAR(30),
    ADD COLUMN evidence_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN cash_checked BOOLEAN NOT NULL DEFAULT FALSE,
    ALTER COLUMN receipt_number DROP NOT NULL;

-- Backfill (the ledger guard is bypassed for this one-off numbering)
ALTER TABLE payments DISABLE TRIGGER trg_payments_before_update;
UPDATE payments p SET transaction_number = 'TXN-' || b.receipt_prefix || '-' || LPAD(n.rn::TEXT, 5, '0')
FROM (SELECT payment_id, ROW_NUMBER() OVER (PARTITION BY collecting_branch_id ORDER BY created_at, payment_id) AS rn
      FROM payments) n, branches b
WHERE n.payment_id = p.payment_id AND b.branch_id = p.collecting_branch_id;
UPDATE payments SET receipt_number = NULL WHERE entry_type = 'Payment' AND verification_status <> 'Verified';
UPDATE payments SET evidence_reviewed = TRUE, cash_checked = TRUE WHERE verification_status = 'Verified';
ALTER TABLE payments ENABLE TRIGGER trg_payments_before_update;

INSERT INTO number_sequences (seq_key, last_value)
SELECT 'TRANSACTION-' || b.receipt_prefix, COUNT(p.payment_id)
FROM branches b LEFT JOIN payments p ON p.collecting_branch_id = b.branch_id
GROUP BY b.receipt_prefix
ON CONFLICT (seq_key) DO UPDATE SET last_value = GREATEST(number_sequences.last_value, EXCLUDED.last_value);

ALTER TABLE payments
    ALTER COLUMN transaction_number SET NOT NULL,
    ADD CONSTRAINT payments_transaction_number_key UNIQUE (transaction_number),
    ADD CONSTRAINT payments_receipt_only_when_verified
        CHECK (receipt_number IS NULL OR verification_status = 'Verified'),
    ADD CONSTRAINT payments_verified_has_receipt
        CHECK (verification_status <> 'Verified' OR receipt_number IS NOT NULL),
    ADD CONSTRAINT payments_verified_evidence_reviewed
        CHECK (entry_type <> 'Payment' OR verification_status <> 'Verified' OR evidence_reviewed);

CREATE OR REPLACE FUNCTION next_receipt_number(p_branch_id INT, p_date DATE) RETURNS VARCHAR AS $$
DECLARE
    v_prefix VARCHAR;
    v_fy TEXT;
BEGIN
    SELECT receipt_prefix INTO v_prefix FROM branches WHERE branch_id = p_branch_id;
    v_fy = fy_code(p_date);
    RETURN v_prefix || '-R-' || v_fy || '-' || LPAD(next_number('RECEIPT-' || v_prefix || '-' || v_fy)::TEXT, 5, '0');
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

    SELECT receipt_prefix INTO v_prefix FROM branches WHERE branch_id = NEW.collecting_branch_id;
    IF NEW.transaction_number IS NULL THEN
        NEW.transaction_number = 'TXN-' || v_prefix || '-' || LPAD(next_number('TRANSACTION-' || v_prefix)::TEXT, 5, '0');
    END IF;
    -- The receipt exists only once money is verified: reversals (verified on approval) get theirs now,
    -- a payment claim gets its receipt when Accounts verifies it
    NEW.receipt_number = NULL;
    IF NEW.entry_type = 'Reversal' THEN
        v_fy = fy_code(NEW.payment_date);
        NEW.receipt_number = 'REV-' || v_prefix || '-' || v_fy || '-'
            || LPAD(next_number('REVERSAL-' || v_prefix || '-' || v_fy)::TEXT, 5, '0');
    ELSIF NEW.verification_status = 'Verified' THEN
        NEW.receipt_number = next_receipt_number(NEW.collecting_branch_id, NEW.payment_date);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION before_payment_update() RETURNS trigger AS $$
BEGIN
    IF (NEW.transaction_number, NEW.person_id, NEW.lead_id, NEW.entry_type, NEW.amount, NEW.payment_mode_id,
        NEW.payment_date, NEW.reference, NEW.collected_by, NEW.collecting_branch_id, NEW.exception_approved_by,
        NEW.reverses_payment_id, NEW.reversal_reason, NEW.correction_request_id, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.transaction_number, OLD.person_id, OLD.lead_id, OLD.entry_type, OLD.amount, OLD.payment_mode_id,
        OLD.payment_date, OLD.reference, OLD.collected_by, OLD.collecting_branch_id, OLD.exception_approved_by,
        OLD.reverses_payment_id, OLD.reversal_reason, OLD.correction_request_id, OLD.created_by, OLD.created_at) THEN
        RAISE EXCEPTION 'Payments are immutable; request a correction instead';
    END IF;
    IF NEW.receipt_number IS DISTINCT FROM OLD.receipt_number THEN
        RAISE EXCEPTION 'Receipt numbers are issued only when a payment is verified';
    END IF;
    IF (NEW.evidence_reviewed, NEW.cash_checked) IS DISTINCT FROM (OLD.evidence_reviewed, OLD.cash_checked)
       AND NEW.verification_status IS NOT DISTINCT FROM OLD.verification_status THEN
        RAISE EXCEPTION 'The evidence checks are recorded with the verification decision';
    END IF;

    IF (OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id)
       OR (NEW.admission_id IS DISTINCT FROM OLD.admission_id
           AND COALESCE(current_setting('app.linking_payments', TRUE), '') <> 'on')
       OR (OLD.proof_file_path IS NOT NULL AND NEW.proof_file_path IS DISTINCT FROM OLD.proof_file_path) THEN
        RAISE EXCEPTION 'Payment % is already allocated / documented; request a correction to change it', OLD.transaction_number;
    END IF;

    IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
        IF EXISTS (SELECT 1 FROM payments WHERE reverses_payment_id = OLD.payment_id) THEN
            RAISE EXCEPTION 'Payment % has been reversed and cannot be allocated', OLD.transaction_number;
        END IF;
        PERFORM check_payment_allocation(NEW);   -- the course-line allocations follow (checked at commit)
    END IF;

    IF NEW.verification_status IS DISTINCT FROM OLD.verification_status THEN
        IF OLD.verification_status <> 'Pending Verification' THEN
            RAISE EXCEPTION 'Payment % is already %', OLD.transaction_number, OLD.verification_status;
        END IF;
        NEW.verified_at = COALESCE(NEW.verified_at, CURRENT_TIMESTAMP);
        IF NEW.verification_status = 'Verified' THEN
            IF NOT NEW.evidence_reviewed THEN
                RAISE EXCEPTION 'Confirm the payment evidence was reviewed before verifying %', OLD.transaction_number;
            END IF;
            IF EXISTS (SELECT 1 FROM payment_modes WHERE payment_mode_id = NEW.payment_mode_id AND code = 'CASH')
               AND NOT NEW.cash_checked THEN
                RAISE EXCEPTION 'Cash payment % needs the independent cash check before it is verified', OLD.transaction_number;
            END IF;
            NEW.receipt_number = next_receipt_number(NEW.collecting_branch_id, NEW.payment_date);
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
        RAISE EXCEPTION 'Payment % is ₹% but ₹% is allocated to its courses', v_payment.transaction_number, v_payment.amount, v_total;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

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
        RAISE EXCEPTION 'Payment % failed verification and can''t be allocated', v_payment.transaction_number;
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

CREATE OR REPLACE VIEW unallocated_advances AS
SELECT payment_id, receipt_number, person_id, lead_id, amount, payment_date, collecting_branch_id, verification_status,
       transaction_number
FROM payments p
WHERE entry_type = 'Payment' AND invoice_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.payment_id);

CREATE OR REPLACE VIEW task_board AS
SELECT t.task_id,
    tt.label AS task_type,
    t.title,
    t.branch_id,
    t.owner_user_id,
    t.team_role_id,
    t.status,
    t.original_due_at,
    t.revised_due_at,
    COALESCE(t.revised_due_at, t.original_due_at) AS due_at,
    (t.status <> ALL (ARRAY['Completed'::task_status, 'Cancelled'::task_status])) AND COALESCE(t.revised_due_at, t.original_due_at) < CURRENT_TIMESTAMP AS is_overdue,
    (t.status <> ALL (ARRAY['Completed'::task_status, 'Cancelled'::task_status])) AND COALESCE(t.revised_due_at, t.original_due_at)::date = CURRENT_DATE AS is_due_today,
    t.owner_user_id IS NULL AND (t.status <> ALL (ARRAY['Completed'::task_status, 'Cancelled'::task_status])) AS is_unassigned,
    COALESCE(l.lead_code, fd.discussion_code, s.scr_code, a.admission_code, COALESCE(p.receipt_number, p.transaction_number), r.case_code, sc.case_code, e.enquiry_code, i.invoice_number, cr.request_code, d.demo_code, ('DOC-'::text || t.document_id)::character varying, ('COMM-'::text || t.communication_id)::character varying) AS linked_record
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
