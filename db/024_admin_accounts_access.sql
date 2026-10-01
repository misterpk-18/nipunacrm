-- 024 — Founder / CEO and Super Admin have full Accounts access.
--
-- Applying an approved fee change was Accounts-only in the database. Admins may now apply it too (the API and UI
-- also open refund payout / reconcile to admins; those have no role check in the database). The refund
-- separation of duties (the person who decided a refund can't pay it out) stays.
--
-- Depends on: 023_fee_change_self_approval.sql

CREATE OR REPLACE FUNCTION before_fee_change_write()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
        IF NOT user_has_role(NEW.accounts_corrected_by, ARRAY['ACCOUNTS', 'FOUNDER_CEO', 'SUPER_ADMIN'], v_admission.service_branch_id) THEN
            RAISE EXCEPTION 'The correction must be made by Accounts, Founder / CEO or Super Admin';
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
$function$

;
