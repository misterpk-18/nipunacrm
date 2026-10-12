-- 037 — Delivery plan UX: preferred LMS batch, how the learner accepted, and the WhatsApp confirmation request.
--
-- * preferred_lms_batch_code / preferred_lms_batch_label: the upcoming LMS batch the counsellor picked as a hint when
--   fixing the planned start date (the LMS batch_code, plus a label such as "Mon-Fri 10:00-11:00, from 12 Oct 2026").
--   It is a preference only: the batch is still allocated separately (academic coordinator / LMS).
-- * acceptance_method: how the learner's acceptance was captured: in_person / call (ticked by staff) or whatsapp (the
--   learner replied YES to the confirmation message). NULL on plans accepted before this migration.
-- * confirmation_requested_at: when the confirmation message ("Reply YES to confirm") was queued. A YES reply is matched
--   to the person's latest plan that is still awaiting confirmation; editing the plan clears it (the learner confirmed
--   an older version) and so does accepting or reopening it.
-- * A WhatsApp acceptance has no staff member behind it, so accepted_by may be NULL when acceptance_method is whatsapp.
-- * Reopening a plan clears the acceptance method and the confirmation request together with the acceptance.
--
-- Depends on: 034_whatsapp_phase2_4.sql

ALTER TABLE delivery_plans
    ADD COLUMN preferred_lms_batch_code TEXT,
    ADD COLUMN preferred_lms_batch_label TEXT,
    ADD COLUMN acceptance_method TEXT,
    ADD COLUMN confirmation_requested_at TIMESTAMP WITH TIME ZONE,
    ADD CONSTRAINT delivery_plans_acceptance_method_valid
        CHECK (acceptance_method IS NULL OR acceptance_method IN ('in_person', 'call', 'whatsapp')),
    ADD CONSTRAINT delivery_plans_acceptance_method_needs_acceptance
        CHECK (acceptance_method IS NULL OR accepted_at IS NOT NULL),
    ADD CONSTRAINT delivery_plans_preferred_batch_label_needs_code
        CHECK (preferred_lms_batch_label IS NULL OR preferred_lms_batch_code IS NOT NULL);

ALTER TABLE delivery_plans DROP CONSTRAINT delivery_plans_acceptance_recorded;
ALTER TABLE delivery_plans ADD CONSTRAINT delivery_plans_acceptance_recorded
    CHECK (accepted_at IS NULL
           OR (student_accepted AND (accepted_by IS NOT NULL OR acceptance_method = 'whatsapp')));

-- Same guard as 020; a reopened (or never accepted) plan also forgets how it was accepted and any pending request
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
        NEW.acceptance_method = NULL;
        IF TG_OP = 'UPDATE' AND OLD.accepted_at IS NOT NULL THEN
            NEW.student_accepted = FALSE;       -- reopened: acceptance must be captured again
            NEW.confirmation_requested_at = NULL;
        END IF;
    ELSE
        NEW.confirmation_requested_at = NULL;   -- accepted: nothing is awaiting confirmation any more
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
