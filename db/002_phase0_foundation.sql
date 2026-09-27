-- Phase 0: foundation tables (branches, roles, users, combos, lookups, audit log)
-- Depends on: 001_courses.sql

-- ---------------------------------------------------------------------------
-- Shared trigger: keep updated_at current on every UPDATE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Tighten courses: defaults existed but NULL was still allowed
ALTER TABLE courses
    ALTER COLUMN is_combo SET NOT NULL,
    ALTER COLUMN status SET NOT NULL,
    ALTER COLUMN created_at SET NOT NULL,
    ALTER COLUMN updated_at SET NOT NULL;

CREATE TRIGGER trg_courses_updated_at
    BEFORE UPDATE ON courses
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Branches
-- ---------------------------------------------------------------------------
CREATE TABLE branches (
    branch_id SERIAL PRIMARY KEY,
    branch_code VARCHAR(20) UNIQUE NOT NULL,        -- e.g., 'NIT-GNT'
    branch_name VARCHAR(100) NOT NULL,              -- e.g., 'Guntur'
    city VARCHAR(100) NOT NULL,
    receipt_prefix VARCHAR(10) UNIQUE NOT NULL,     -- e.g., 'GNT' -> GNT-R-2627-00001
    address TEXT,
    phone VARCHAR(20),
    email VARCHAR(255),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_branches_updated_at
    BEFORE UPDATE ON branches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO branches (branch_code, branch_name, city, receipt_prefix) VALUES
    ('NIT-GNT', 'Guntur', 'Guntur', 'GNT'),
    ('NIT-VIJ', 'Vijayawada', 'Vijayawada', 'VIJ');

-- course_branches.branch_code now must be a real branch
ALTER TABLE course_branches
    ADD CONSTRAINT course_branches_branch_code_fkey
    FOREIGN KEY (branch_code) REFERENCES branches(branch_code) ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Roles & users
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
    role_id SERIAL PRIMARY KEY,
    role_code VARCHAR(50) UNIQUE NOT NULL,          -- e.g., 'BRANCH_MANAGER'
    role_name VARCHAR(100) NOT NULL,                -- e.g., 'Branch Manager'
    description TEXT,
    is_company_wide BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE = sees all branches
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_roles_updated_at
    BEFORE UPDATE ON roles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO roles (role_code, role_name, is_company_wide) VALUES
    ('SUPER_ADMIN', 'Super Admin', TRUE),
    ('BRANCH_MANAGER', 'Branch Manager', FALSE),
    ('COUNSELLOR', 'Counsellor', FALSE),
    ('ADMISSIONS', 'Admissions', FALSE),
    ('ACCOUNTS', 'Accounts', FALSE),
    ('ACADEMIC_COORDINATOR', 'Academic Coordinator', FALSE),
    ('PLACEMENT', 'Placement Team', FALSE),
    ('TRAINER', 'Trainer', FALSE);

CREATE TABLE users (
    user_id SERIAL PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    password_hash VARCHAR(255),                     -- NULL until the user sets a password
    role_id INT NOT NULL REFERENCES roles(role_id),
    home_branch_id INT REFERENCES branches(branch_id), -- NULL for company-wide users
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Case-insensitive unique email
CREATE UNIQUE INDEX users_email_lower_key ON users (LOWER(email));
CREATE INDEX users_role_id_idx ON users (role_id);
CREATE INDEX users_home_branch_id_idx ON users (home_branch_id);

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Extra branches a user may work in besides their home branch (e.g., cover staff)
CREATE TABLE user_branches (
    user_id INT REFERENCES users(user_id) ON DELETE CASCADE,
    branch_id INT REFERENCES branches(branch_id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, branch_id)
);

-- ---------------------------------------------------------------------------
-- Combo courses: which standalone courses make up a combo package
-- ---------------------------------------------------------------------------
CREATE TABLE combo_courses (
    combo_course_id INT REFERENCES courses(course_id) ON DELETE CASCADE,     -- the combo (is_combo = TRUE)
    component_course_id INT REFERENCES courses(course_id) ON DELETE RESTRICT, -- a course inside it
    is_bonus BOOLEAN NOT NULL DEFAULT FALSE,        -- TRUE for the "+1" in a 3+1 combo
    sort_order SMALLINT NOT NULL DEFAULT 0,
    PRIMARY KEY (combo_course_id, component_course_id),
    CHECK (combo_course_id <> component_course_id)
);

CREATE INDEX combo_courses_component_idx ON combo_courses (component_course_id);

-- ---------------------------------------------------------------------------
-- Lookup tables (admin-editable dropdowns)
-- ---------------------------------------------------------------------------
CREATE TABLE lead_sources (          -- "Original Source"
    lead_source_id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    label VARCHAR(100) NOT NULL,
    sort_order SMALLINT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE contact_channels (      -- "Contact Channel"
    contact_channel_id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    label VARCHAR(100) NOT NULL,
    sort_order SMALLINT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE entry_methods (         -- "Entry Method"
    entry_method_id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    label VARCHAR(100) NOT NULL,
    sort_order SMALLINT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE payment_modes (
    payment_mode_id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    label VARCHAR(100) NOT NULL,
    requires_reference BOOLEAN NOT NULL DEFAULT TRUE, -- UTR / cheque no. required
    sort_order SMALLINT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE lost_reasons (
    lost_reason_id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    label VARCHAR(100) NOT NULL,
    sort_order SMALLINT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Starter values; edit freely
INSERT INTO lead_sources (code, label, sort_order) VALUES
    ('ORGANIC_SOCIAL', 'Organic Social Media', 1),
    ('PAID_SOCIAL', 'Paid Social Media', 2),
    ('GOOGLE_SEARCH', 'Google Search', 3),
    ('WEBSITE', 'Website', 4),
    ('WALK_IN', 'Walk-in', 5),
    ('REFERRAL', 'Referral', 6),
    ('COLLEGE_EVENT', 'College / Event', 7),
    ('OTHER', 'Other', 99);

INSERT INTO contact_channels (code, label, sort_order) VALUES
    ('WHATSAPP', 'WhatsApp', 1),
    ('PHONE_INBOUND', 'Inbound call', 2),
    ('PHONE_OUTBOUND', 'Outbound call', 3),
    ('WALK_IN', 'Walk-in', 4),
    ('WEB_FORM', 'Web form', 5),
    ('EMAIL', 'Email', 6);

INSERT INTO entry_methods (code, label, sort_order) VALUES
    ('STAFF_ENTERED', 'Staff entered', 1),
    ('WEB_FORM', 'Web form', 2),
    ('BULK_IMPORT', 'Bulk import', 3);

INSERT INTO payment_modes (code, label, requires_reference, sort_order) VALUES
    ('UPI_BANK', 'UPI / Bank Transfer', TRUE, 1),
    ('CASH', 'Cash', FALSE, 2),
    ('CARD', 'Card', TRUE, 3),
    ('CHEQUE', 'Cheque', TRUE, 4);

INSERT INTO lost_reasons (code, label, sort_order) VALUES
    ('FEE_TOO_HIGH', 'Fee too high', 1),
    ('JOINED_COMPETITOR', 'Joined competitor', 2),
    ('NOT_INTERESTED', 'Not interested', 3),
    ('TIMING', 'Batch timing not suitable', 4),
    ('LOCATION', 'Location / distance', 5),
    ('UNREACHABLE', 'Unreachable', 6),
    ('OTHER', 'Other', 99);

-- ---------------------------------------------------------------------------
-- Audit log: append-only
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
    audit_id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actor_user_id INT REFERENCES users(user_id),    -- NULL for system actions
    action VARCHAR(50) NOT NULL,                    -- e.g., 'CREATE', 'UPDATE', 'APPROVE', 'VERIFY_PAYMENT'
    entity_type VARCHAR(50) NOT NULL,               -- e.g., 'admission', 'payment'
    entity_id VARCHAR(50) NOT NULL,                 -- PK or business code of the record
    branch_id INT REFERENCES branches(branch_id),
    old_values JSONB,
    new_values JSONB,
    reason TEXT,
    ip_address INET
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id);
CREATE INDEX audit_log_occurred_at_idx ON audit_log (occurred_at);

CREATE OR REPLACE FUNCTION prevent_audit_log_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_immutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_change();
