-- 026 — Outbox for the Nipuna LMS: admission, course and finance events, written in the same transaction as the change.
--
-- The CRM stays the owner of admissions and money; the LMS keeps a read-only projection that it builds from these
-- events (LMS docs/CRM_INTEGRATION.md §2.1). A row is written in the transaction that makes the change, so the LMS never
-- sees a change the CRM rolled back and never misses one that committed. A worker (`flask jobs run lms-sync`) posts
-- Pending rows in order and records the LMS's answer.
--
--   lms_sync_versions  one counter per record ('course:<id>', 'admission:<id>', 'finance:<id>'), incremented with every
--                      event about it: the event's source_version. The LMS ignores anything older than what it applied.
--   lms_outbox         one row per event. event_id and the payload never change once written, so a retry sends exactly
--                      the same event (the LMS answers 409 for an event_id reused with a different payload).
--
-- Depends on: 025_refund_admin_payout.sql

CREATE TYPE lms_outbox_status AS ENUM ('Pending', 'Delivered', 'Failed');

CREATE TABLE lms_sync_versions (
    version_key VARCHAR(60) PRIMARY KEY,
    version INT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT lms_sync_versions_positive CHECK (version >= 1)
);

CREATE TRIGGER trg_lms_sync_versions_updated_at BEFORE UPDATE ON lms_sync_versions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE lms_outbox (
    outbox_id BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL,
    event_type VARCHAR(40) NOT NULL,
    record_key VARCHAR(60) NOT NULL,          -- delivery order: rows with the same key go one at a time, oldest first
    source_version INT NOT NULL,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
    payload JSONB NOT NULL,                   -- the event's `data`, exactly as sent
    status lms_outbox_status NOT NULL DEFAULT 'Pending',
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_until TIMESTAMP WITH TIME ZONE,    -- claimed by a worker until then
    last_http_status SMALLINT,
    last_error TEXT,
    response_status VARCHAR(40),              -- the LMS's status: Applied / Ignored — stale / Failed
    response_result JSONB,                    -- the LMS's result (never the activation token)
    activation_token_issued BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT lms_outbox_event_id_unique UNIQUE (event_id),
    CONSTRAINT lms_outbox_event_type_valid CHECK (event_type IN (
        'CourseUpserted', 'AdmissionQualified', 'AdmissionUpdated', 'AdmissionCancelled', 'FinanceSummaryUpdated')),
    CONSTRAINT lms_outbox_source_version_positive CHECK (source_version >= 1),
    CONSTRAINT lms_outbox_attempts_positive CHECK (attempts >= 0),
    CONSTRAINT lms_outbox_delivered_needs_time CHECK (status <> 'Delivered' OR delivered_at IS NOT NULL)
);

-- The worker's queue: the oldest pending row of each record, due now
CREATE INDEX lms_outbox_pending_idx ON lms_outbox (record_key, outbox_id) WHERE status = 'Pending';
CREATE INDEX lms_outbox_status_type_idx ON lms_outbox (status, event_type);

CREATE TRIGGER trg_lms_outbox_updated_at BEFORE UPDATE ON lms_outbox
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A retry must send the same event: the envelope is fixed once written
CREATE OR REPLACE FUNCTION guard_lms_outbox_envelope() RETURNS trigger AS $$
BEGIN
    IF (NEW.event_id, NEW.event_type, NEW.record_key, NEW.source_version, NEW.occurred_at, NEW.payload)
       IS DISTINCT FROM (OLD.event_id, OLD.event_type, OLD.record_key, OLD.source_version, OLD.occurred_at, OLD.payload) THEN
        RAISE EXCEPTION 'An LMS outbox event can''t be changed once written; write a new event instead'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_lms_outbox_guard_envelope BEFORE UPDATE ON lms_outbox
    FOR EACH ROW EXECUTE FUNCTION guard_lms_outbox_envelope();
