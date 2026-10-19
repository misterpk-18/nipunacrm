-- 046: "Forgot password?" — a staff member types their mobile and gets a one-time code on WhatsApp.
--
--   password_reset_codes        one row per code sent. Only a hash of the code is stored (HMAC with the app's
--                               secret key), never the code itself. A code is usable once, for code_valid_minutes,
--                               and dies after max_attempts wrong tries; asking for a new one retires the earlier ones.
--                               The API keeps the request limits (one code a minute, five an hour per account).
--
--   whatsapp_outbox             the code is sent through the same outbox, switch, test-number list and sender as every
--                               other message, as source_type 'password_reset' (source_id = reset_id). A staff
--                               member has no CRM person, so like an LMS message it needs no person_id / branch_id,
--                               and the code rides in secret_params, which the database clears once the row is Sent,
--                               Failed or Skipped (db 045); params and body_text only ever hold "[hidden]".
--
-- Depends on: 045_lms_whatsapp.sql

CREATE TABLE password_reset_codes (
    reset_id        SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    phone           VARCHAR(20) NOT NULL,                 -- the number the code went to (+91XXXXXXXXXX)
    code_hash       VARCHAR(128) NOT NULL,
    expires_at      TIMESTAMP WITH TIME ZONE NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 5,
    used_at         TIMESTAMP WITH TIME ZONE,             -- the password was reset with it
    retired_at      TIMESTAMP WITH TIME ZONE,             -- a newer code was sent, or too many wrong tries
    requested_ip    INET,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT password_reset_codes_expiry_after_creation CHECK (expires_at > created_at),
    CONSTRAINT password_reset_codes_attempts_range CHECK (attempts >= 0 AND attempts <= max_attempts),
    CONSTRAINT password_reset_codes_max_attempts_positive CHECK (max_attempts > 0),
    CONSTRAINT password_reset_codes_used_or_retired CHECK (used_at IS NULL OR retired_at IS NULL)
);

CREATE INDEX password_reset_codes_user_idx ON password_reset_codes (user_id, created_at DESC);

CREATE TRIGGER trg_password_reset_codes_updated_at BEFORE UPDATE ON password_reset_codes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A code is spent once: a used or retired code never comes back, and the hash / number never change
CREATE OR REPLACE FUNCTION guard_password_reset_code() RETURNS trigger AS $$
BEGIN
    IF (NEW.user_id, NEW.phone, NEW.code_hash, NEW.expires_at, NEW.max_attempts, NEW.created_at)
       IS DISTINCT FROM (OLD.user_id, OLD.phone, OLD.code_hash, OLD.expires_at, OLD.max_attempts, OLD.created_at) THEN
        RAISE EXCEPTION 'A password reset code can''t be changed once it is sent; ask for a new one'
            USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD.used_at IS NOT NULL OR OLD.retired_at IS NOT NULL)
       AND (NEW.used_at IS DISTINCT FROM OLD.used_at OR NEW.retired_at IS DISTINCT FROM OLD.retired_at
            OR NEW.attempts IS DISTINCT FROM OLD.attempts) THEN
        RAISE EXCEPTION 'This password reset code is no longer valid; ask for a new one'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_password_reset_codes_guard BEFORE UPDATE ON password_reset_codes
    FOR EACH ROW EXECUTE FUNCTION guard_password_reset_code();

-- The outbox: a password reset message has no person and may carry a secret, like an LMS message
ALTER TABLE whatsapp_outbox DROP CONSTRAINT whatsapp_outbox_crm_needs_person;
ALTER TABLE whatsapp_outbox ADD CONSTRAINT whatsapp_outbox_crm_needs_person
    CHECK (source_type IN ('lms', 'password_reset')
           OR (person_id IS NOT NULL AND branch_id IS NOT NULL AND source_id IS NOT NULL));

ALTER TABLE whatsapp_outbox DROP CONSTRAINT whatsapp_outbox_secret_only_lms;
ALTER TABLE whatsapp_outbox ADD CONSTRAINT whatsapp_outbox_secret_only_lms_or_reset
    CHECK (secret_params IS NULL OR source_type IN ('lms', 'password_reset'));

-- Admin-editable limits (Settings → Sessions and login)
INSERT INTO app_settings (setting_key, setting_value, description)
SELECT v.k, v.val::JSONB, v.d
FROM (VALUES
    ('password_reset_code_minutes', '10', 'Minutes a WhatsApp password reset code stays valid'),
    ('password_reset_max_attempts', '5', 'Wrong tries before a password reset code stops working'),
    ('password_reset_resend_seconds', '60', 'Seconds before another reset code can be sent to the same account'),
    ('password_reset_max_per_hour', '5', 'Reset codes one account can be sent in an hour')
) AS v(k, val, d)
WHERE NOT EXISTS (SELECT 1 FROM app_settings s WHERE s.setting_key = v.k);
