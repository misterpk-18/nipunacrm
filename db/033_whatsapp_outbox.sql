-- 033 — Outbox for WhatsApp template messages (Pinbot / A2Z): one row per message to a learner.
--
-- A service writes the row in the same transaction as the change it reports (a verified payment, a refund decision, an
-- invoice), so a learner is never told about something the CRM rolled back and never missed for something that
-- committed. A sender (`flask jobs run whatsapp-send`, and right after the request commits) posts Queued rows to the
-- provider and records its answer.
--
--   event_key        'payment-verified:123', 'refund-approved:7' … unique: the same event never makes two messages,
--                    however often the code runs
--   params           the template's named values (see backend/services/whatsapp_templates.py); body_text is the
--                    message as the template renders it, kept so the CRM can show exactly what the learner received
--   status           Queued -> Sent -> Delivered -> Read, or Failed (provider refused / gave up) or Skipped (never sent,
--                    with the reason: no phone, switched off, not on the test list, too old). Delivered / Read come
--                    from the provider's status callbacks and never go back to Sent.
--
-- The message itself never changes once written (a retry sends the same message to the same number).
--
-- Depends on: 032_lms_batch_offerability.sql

CREATE TYPE whatsapp_status AS ENUM ('Queued', 'Sent', 'Delivered', 'Read', 'Failed', 'Skipped');

CREATE TABLE whatsapp_outbox (
    outbox_id BIGSERIAL PRIMARY KEY,
    event_key VARCHAR(120) NOT NULL,
    template_name VARCHAR(80) NOT NULL,
    language VARCHAR(10) NOT NULL DEFAULT 'en',
    category VARCHAR(20) NOT NULL DEFAULT 'Utility',
    person_id INT NOT NULL REFERENCES persons(person_id),
    branch_id INT NOT NULL REFERENCES branches(branch_id),
    to_phone VARCHAR(20),                       -- digits with country code, no '+': 919876543210. NULL = no phone on file
    params JSONB NOT NULL,                      -- {"customer_name": "Raja", "branch_name": "Guntur", ...}
    body_text TEXT NOT NULL,                    -- the rendered message
    source_type VARCHAR(30) NOT NULL,           -- 'payment', 'refund_case', 'invoice'
    source_id INT NOT NULL,
    status whatsapp_status NOT NULL DEFAULT 'Queued',
    skip_reason TEXT,
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_until TIMESTAMP WITH TIME ZONE,      -- claimed by a sender until then
    provider_message_id VARCHAR(200),           -- the provider's wamid, once it accepted the message
    last_http_status SMALLINT,
    last_error TEXT,
    queued_by INT REFERENCES users(user_id),    -- who made the change; NULL for a job
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    read_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT whatsapp_outbox_event_key_unique UNIQUE (event_key),
    CONSTRAINT whatsapp_outbox_category_valid CHECK (category IN ('Utility', 'Marketing')),
    CONSTRAINT whatsapp_outbox_source_id_positive CHECK (source_id > 0),
    CONSTRAINT whatsapp_outbox_attempts_positive CHECK (attempts >= 0),
    CONSTRAINT whatsapp_outbox_phone_format CHECK (to_phone IS NULL OR to_phone ~ '^[1-9][0-9]{9,14}$'),
    CONSTRAINT whatsapp_outbox_queued_needs_phone CHECK (status <> 'Queued' OR to_phone IS NOT NULL),
    CONSTRAINT whatsapp_outbox_skipped_needs_reason CHECK (status <> 'Skipped' OR skip_reason IS NOT NULL),
    CONSTRAINT whatsapp_outbox_sent_needs_provider_id CHECK (
        status NOT IN ('Sent', 'Delivered', 'Read') OR (provider_message_id IS NOT NULL AND sent_at IS NOT NULL))
);

-- The sender's queue
CREATE INDEX whatsapp_outbox_queue_idx ON whatsapp_outbox (next_attempt_at, outbox_id) WHERE status = 'Queued';
CREATE INDEX whatsapp_outbox_person_idx ON whatsapp_outbox (person_id, created_at DESC);
CREATE INDEX whatsapp_outbox_source_idx ON whatsapp_outbox (source_type, source_id);
CREATE INDEX whatsapp_outbox_provider_idx ON whatsapp_outbox (provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TRIGGER trg_whatsapp_outbox_updated_at BEFORE UPDATE ON whatsapp_outbox
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A retry must send the same message to the same number; delivery state only moves forward
CREATE OR REPLACE FUNCTION guard_whatsapp_outbox() RETURNS trigger AS $$
DECLARE
    v_rank CONSTANT TEXT[] := ARRAY['Sent', 'Delivered', 'Read'];
BEGIN
    IF (NEW.event_key, NEW.template_name, NEW.language, NEW.category, NEW.person_id, NEW.branch_id, NEW.params,
        NEW.body_text, NEW.source_type, NEW.source_id)
       IS DISTINCT FROM
       (OLD.event_key, OLD.template_name, OLD.language, OLD.category, OLD.person_id, OLD.branch_id, OLD.params,
        OLD.body_text, OLD.source_type, OLD.source_id) THEN
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

CREATE TRIGGER trg_whatsapp_outbox_guard BEFORE UPDATE ON whatsapp_outbox
    FOR EACH ROW EXECUTE FUNCTION guard_whatsapp_outbox();

CREATE OR REPLACE FUNCTION forbid_whatsapp_outbox_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'WhatsApp messages are a record of what the learner was told and can''t be deleted'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_whatsapp_outbox_no_delete BEFORE DELETE ON whatsapp_outbox
    FOR EACH ROW EXECUTE FUNCTION forbid_whatsapp_outbox_delete();
