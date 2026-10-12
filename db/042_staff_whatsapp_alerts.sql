-- Staff WhatsApp alerts (new lead assigned, approval waiting, payment to verify, payment verified / failed) go to the
-- staff member's own phone (users.phone). The outbox row still names the learner it is about (person_id, for the
-- manager's /whatsapp screen) but now also records WHO it was sent to: recipient_user_id. A row with a recipient_user_id
-- is a staff message: it never appears in the learner's WhatsApp conversation, and the /whatsapp list labels it "Staff".
-- The staff-alert switch (app setting whatsapp_staff_alerts_enabled, db 038) now defaults to ON. Messages still only
-- reach numbers on WHATSAPP_TEST_NUMBERS while that list is set, and nothing is sent while WHATSAPP_ENABLED is off.
--
-- Depends on: 038_payment_outcome_alerts.sql

ALTER TABLE whatsapp_outbox ADD COLUMN recipient_user_id INT REFERENCES users(user_id);
CREATE INDEX whatsapp_outbox_recipient_idx ON whatsapp_outbox (recipient_user_id) WHERE recipient_user_id IS NOT NULL;

-- Whoever a message is for can't change once it is written (same rule as the number and the text)
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

-- Messages already written by db 038's payment alert were stored against the learner: mark them as staff messages
UPDATE whatsapp_outbox o SET recipient_user_id = u.user_id
FROM users u
WHERE o.template_name = 'nipuna_staff_payment_status_v1'
  AND o.recipient_user_id IS NULL
  AND o.event_key ~ ':[0-9]+$' AND u.user_id = substring(o.event_key from ':([0-9]+)$')::INT;

UPDATE app_settings SET setting_value = 'true',
    description = 'Send staff WhatsApp alerts to their own phone (users.phone): new lead assigned, approval waiting, payment to verify, payment verified / failed, demo to take'
WHERE setting_key = 'whatsapp_staff_alerts_enabled';
