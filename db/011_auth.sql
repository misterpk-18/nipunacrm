-- Auth support: forced password change after admin-issued passwords, failed-login lockout
-- Depends on: 010_prototype_alignment.sql

ALTER TABLE users
    ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE,   -- set when an admin issues a temporary password
    ADD COLUMN password_changed_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN failed_login_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
    ADD COLUMN locked_until TIMESTAMP WITH TIME ZONE;

INSERT INTO app_settings (setting_key, setting_value, description) VALUES
    ('login_max_attempts', '5', 'Failed logins before the account is locked'),
    ('login_lock_minutes', '15', 'How long a locked account stays locked'),
    ('password_min_length', '10', 'Minimum password length');
