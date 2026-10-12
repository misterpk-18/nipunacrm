-- 034 — WhatsApp phases 2–4: a code for placement applications, WhatsApp marketing consent, and a log of what the
-- provider's callbacks send.
--
--   job_applications.application_code   PL-00001, derived from the id (so the learner can quote it and staff can find it)
--   persons.whatsapp_consent            Marketing templates (db 033's category 'Marketing') are sent only to someone with
--                                       Explicit Consent. Nobody has a recorded consent yet: every person starts at
--                                       Not Recorded and is changed by staff or the learner's own reply (STOP = Withdrawn).
--                                       Utility messages about the learner's own money, admission or enquiry don't need it.
--   whatsapp_webhook_log                the raw callback bodies (delivery status, inbound replies) for 30 days, so the
--                                       provider's real format can be checked against what the CRM understood
--
-- Depends on: 033_whatsapp_outbox.sql

ALTER TABLE job_applications
    ADD COLUMN application_code VARCHAR(12) GENERATED ALWAYS AS ('PL-' || lpad(application_id::TEXT, 5, '0')) STORED,
    ADD CONSTRAINT job_applications_code_unique UNIQUE (application_code);

ALTER TABLE persons
    ADD COLUMN whatsapp_consent consent_status NOT NULL DEFAULT 'Not Recorded',
    ADD COLUMN whatsapp_consent_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN whatsapp_consent_by INT REFERENCES users(user_id),          -- NULL when the learner replied themselves
    ADD COLUMN whatsapp_consent_source VARCHAR(100),                       -- 'Web form', 'Counsellor call', 'Reply STOP' …
    ADD CONSTRAINT persons_whatsapp_consent_recorded
        CHECK (whatsapp_consent = 'Not Recorded' OR whatsapp_consent_at IS NOT NULL);

CREATE TABLE whatsapp_webhook_log (
    log_id BIGSERIAL PRIMARY KEY,
    received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    kind VARCHAR(20) NOT NULL,
    payload JSONB NOT NULL,
    result VARCHAR(300),                        -- what the CRM did with it
    CONSTRAINT whatsapp_webhook_log_kind_valid CHECK (kind IN ('status', 'message', 'verification', 'unknown'))
);

CREATE INDEX whatsapp_webhook_log_received_idx ON whatsapp_webhook_log (received_at);
