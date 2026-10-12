-- 045: the LMS sends its WhatsApp messages through the CRM (round 6, POST /api/v1/lms/whatsapp).
--
--   One Pinbot number serves both systems, so the CRM stays the only sender: an LMS message is a whatsapp_outbox row
--   with source_type 'lms', sent by the same whatsapp-send job, switch, test-number list and backoff as the CRM's own.
--
--   whatsapp_outbox
--     person_id, branch_id, source_id   may be NULL for an LMS message only: a staff invite or a student the CRM
--                                       can't match has no CRM person, and the LMS record has no CRM id. Every CRM
--                                       message still needs all three (whatsapp_outbox_crm_needs_person).
--     secret_params                     the values that must not stay in the CRM (a password reset code, an activation
--                                       token). Kept only while the row is Queued, so a retry can still send it; the
--                                       moment the row is Sent, Failed or Skipped it is cleared (trigger), and params /
--                                       body_text hold a mask instead. It can only ever change to NULL.
--     category                          adds 'Authentication' (Meta's one-time-code category, LMS template 1).
--
--   lms_outbox.event_type adds 'WhatsappStatusUpdated': the CRM tells the LMS when one of its messages is Sent,
--   Delivered, Read, Failed or Skipped (W3 option a).
--
-- Depends on: 044_whatsapp_notifications_switch.sql

ALTER TABLE whatsapp_outbox
    ALTER COLUMN person_id DROP NOT NULL,
    ALTER COLUMN branch_id DROP NOT NULL,
    ALTER COLUMN source_id DROP NOT NULL,
    ADD COLUMN secret_params JSONB;

ALTER TABLE whatsapp_outbox
    ADD CONSTRAINT whatsapp_outbox_crm_needs_person
        CHECK (source_type = 'lms' OR (person_id IS NOT NULL AND branch_id IS NOT NULL AND source_id IS NOT NULL)),
    ADD CONSTRAINT whatsapp_outbox_secret_only_lms CHECK (secret_params IS NULL OR source_type = 'lms');

ALTER TABLE whatsapp_outbox DROP CONSTRAINT whatsapp_outbox_category_valid;
ALTER TABLE whatsapp_outbox ADD CONSTRAINT whatsapp_outbox_category_valid
    CHECK (category IN ('Utility', 'Marketing', 'Authentication'));

-- The message can't change once written; a secret can only be forgotten
CREATE OR REPLACE FUNCTION guard_whatsapp_outbox() RETURNS trigger AS $$
DECLARE
    v_rank CONSTANT TEXT[] := ARRAY['Sent', 'Delivered', 'Read'];
BEGIN
    IF (NEW.event_key, NEW.template_name, NEW.language, NEW.category, NEW.person_id, NEW.branch_id, NEW.params,
        NEW.body_text, NEW.source_type, NEW.source_id, NEW.recipient_user_id)
       IS DISTINCT FROM
       (OLD.event_key, OLD.template_name, OLD.language, OLD.category, OLD.person_id, OLD.branch_id, OLD.params,
        OLD.body_text, OLD.source_type, OLD.source_id, OLD.recipient_user_id) THEN
        RAISE EXCEPTION 'A WhatsApp message can''t be changed once it is written; queue a new one instead'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.secret_params IS DISTINCT FROM OLD.secret_params AND NEW.secret_params IS NOT NULL THEN
        RAISE EXCEPTION 'The hidden values of a WhatsApp message can only be cleared'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.to_phone IS NOT NULL AND NEW.to_phone IS DISTINCT FROM OLD.to_phone THEN
        RAISE EXCEPTION 'The number of a WhatsApp message can''t be changed once it is set'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status::TEXT = ANY (v_rank)
       AND NEW.status::TEXT <> 'Failed'
       AND (NEW.status::TEXT <> ALL (v_rank)
            OR array_position(v_rank, NEW.status::TEXT) < array_position(v_rank, OLD.status::TEXT)) THEN
        RAISE EXCEPTION 'A WhatsApp message that was already % can''t go back to %', OLD.status, NEW.status
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Runs after the guard (z_): a message that is no longer waiting to be sent forgets its secret values
CREATE OR REPLACE FUNCTION forget_whatsapp_secrets() RETURNS trigger AS $$
BEGIN
    IF NEW.status <> 'Queued' THEN
        NEW.secret_params := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_whatsapp_outbox_z_forget_secrets BEFORE INSERT OR UPDATE ON whatsapp_outbox
    FOR EACH ROW EXECUTE FUNCTION forget_whatsapp_secrets();

ALTER TABLE lms_outbox DROP CONSTRAINT lms_outbox_event_type_valid;
ALTER TABLE lms_outbox ADD CONSTRAINT lms_outbox_event_type_valid CHECK (event_type IN (
    'CourseUpserted', 'AdmissionQualified', 'AdmissionUpdated', 'AdmissionCancelled', 'FinanceSummaryUpdated',
    'BranchUpserted', 'BranchFinanceSnapshot', 'WhatsappStatusUpdated'));
