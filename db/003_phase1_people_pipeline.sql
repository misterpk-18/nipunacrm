-- Phase 1: people & sales pipeline (persons, leads, lead activities, demos)
-- Depends on: 002_phase0_foundation.sql

-- ---------------------------------------------------------------------------
-- Human-readable number generator (PER-GNT-00001, LD-00001, later receipts)
-- Row-locked counter: concurrent inserts never get the same number, and a
-- rolled-back transaction gives its number back (no gaps).
-- ---------------------------------------------------------------------------
CREATE TABLE number_sequences (
    seq_key VARCHAR(50) PRIMARY KEY,                -- e.g., 'PERSON-GNT', 'LEAD'
    last_value INT NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION next_number(p_key VARCHAR) RETURNS INT AS $$
    INSERT INTO number_sequences (seq_key, last_value) VALUES (p_key, 1)
    ON CONFLICT (seq_key) DO UPDATE SET last_value = number_sequences.last_value + 1
    RETURNING last_value;
$$ LANGUAGE sql;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE lead_stage AS ENUM (
    'New Enquiry',
    'Counselling',
    'Demo Scheduled',
    'Demo Attended',
    'Fee Discussion / Payment Awaited',
    'Payment Pending Verification',
    'Admitted',
    'Lost - closed'
);

CREATE TYPE lead_intake_status AS ENUM ('New', 'Match Review', 'Accepted', 'Merged', 'Rejected');

CREATE TYPE lead_priority AS ENUM ('Hot', 'Warm', 'Cold');

CREATE TYPE activity_type AS ENUM (
    'Call', 'WhatsApp', 'Email', 'SMS', 'Meeting', 'Note',
    'Stage Change', 'Assignment Change', 'Follow-up Scheduled'
);

CREATE TYPE activity_direction AS ENUM ('Inbound', 'Outbound');

CREATE TYPE demo_mode AS ENUM ('In-person', 'Online');

CREATE TYPE demo_status AS ENUM ('Scheduled', 'Confirmed', 'Attended', 'No Show', 'Rescheduled', 'Cancelled');

-- ---------------------------------------------------------------------------
-- Persons: one canonical record per human, shared by leads and admissions
-- ---------------------------------------------------------------------------
CREATE TABLE persons (
    person_id SERIAL PRIMARY KEY,
    person_code VARCHAR(20) UNIQUE NOT NULL,        -- e.g., 'PER-GNT-00148' (auto-generated)
    full_name VARCHAR(150) NOT NULL,
    phone VARCHAR(20) NOT NULL,                     -- store as +91XXXXXXXXXX
    alternate_phone VARCHAR(20),
    email VARCHAR(255),
    city VARCHAR(100),
    highest_qualification VARCHAR(100),
    registered_branch_id INT NOT NULL REFERENCES branches(branch_id),
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Not unique: siblings can share a parent's phone. Duplicates go to Match Review.
CREATE INDEX persons_phone_idx ON persons (phone);
CREATE INDEX persons_email_lower_idx ON persons (LOWER(email));
CREATE INDEX persons_registered_branch_idx ON persons (registered_branch_id);

CREATE OR REPLACE FUNCTION set_person_code() RETURNS trigger AS $$
DECLARE
    v_prefix VARCHAR;
BEGIN
    SELECT receipt_prefix INTO v_prefix FROM branches WHERE branch_id = NEW.registered_branch_id;
    NEW.person_code = 'PER-' || v_prefix || '-' || LPAD(next_number('PERSON-' || v_prefix)::TEXT, 5, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_persons_code
    BEFORE INSERT ON persons
    FOR EACH ROW WHEN (NEW.person_code IS NULL)
    EXECUTE FUNCTION set_person_code();

CREATE TRIGGER trg_persons_updated_at
    BEFORE UPDATE ON persons
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Leads: one enquiry by a person for a course at a branch
-- ---------------------------------------------------------------------------
CREATE TABLE leads (
    lead_id SERIAL PRIMARY KEY,
    lead_code VARCHAR(20) UNIQUE NOT NULL,          -- e.g., 'LD-24091' (auto-generated)
    person_id INT NOT NULL REFERENCES persons(person_id),
    course_id INT REFERENCES courses(course_id),    -- NULL if undecided at enquiry
    branch_id INT NOT NULL REFERENCES branches(branch_id),

    -- Where the enquiry came from
    lead_source_id INT NOT NULL REFERENCES lead_sources(lead_source_id),
    contact_channel_id INT NOT NULL REFERENCES contact_channels(contact_channel_id),
    entry_method_id INT NOT NULL REFERENCES entry_methods(entry_method_id),
    intake_status lead_intake_status NOT NULL DEFAULT 'New',

    -- Pipeline
    assigned_to INT REFERENCES users(user_id),      -- NULL = unassigned
    stage lead_stage NOT NULL DEFAULT 'New Enquiry',
    stage_changed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    next_follow_up_at TIMESTAMP WITH TIME ZONE,
    last_contacted_at TIMESTAMP WITH TIME ZONE,

    -- AI (advisory only)
    ai_priority lead_priority,
    ai_priority_updated_at TIMESTAMP WITH TIME ZONE,

    -- Lost details (required when stage = 'Lost - closed')
    lost_reason_id INT REFERENCES lost_reasons(lost_reason_id),
    lost_competitor VARCHAR(150),
    lost_notes TEXT,
    reactivation_date DATE,

    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT leads_lost_reason_required
        CHECK (stage <> 'Lost - closed' OR lost_reason_id IS NOT NULL)
);

CREATE INDEX leads_person_idx ON leads (person_id);
CREATE INDEX leads_course_idx ON leads (course_id);
CREATE INDEX leads_branch_stage_idx ON leads (branch_id, stage);
CREATE INDEX leads_assigned_follow_up_idx ON leads (assigned_to, next_follow_up_at);

-- A person can't have two open leads for the same course at the same branch
CREATE UNIQUE INDEX leads_one_open_per_person_course_branch
    ON leads (person_id, course_id, branch_id)
    WHERE stage NOT IN ('Admitted', 'Lost - closed');

CREATE OR REPLACE FUNCTION set_lead_code() RETURNS trigger AS $$
BEGIN
    NEW.lead_code = 'LD-' || LPAD(next_number('LEAD')::TEXT, 5, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_leads_code
    BEFORE INSERT ON leads
    FOR EACH ROW WHEN (NEW.lead_code IS NULL)
    EXECUTE FUNCTION set_lead_code();

CREATE TRIGGER trg_leads_updated_at
    BEFORE UPDATE ON leads
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Lead activities: the lead timeline (calls, WhatsApp, notes, stage changes)
-- ---------------------------------------------------------------------------
CREATE TABLE lead_activities (
    activity_id BIGSERIAL PRIMARY KEY,
    lead_id INT NOT NULL REFERENCES leads(lead_id),
    activity_type activity_type NOT NULL,
    direction activity_direction,                   -- calls / messages only
    contact_channel_id INT REFERENCES contact_channels(contact_channel_id),
    outcome VARCHAR(100),                           -- e.g., 'Replied', 'No answer'
    summary TEXT,                                   -- e.g., 'Requested weekend batch schedule'
    call_duration_seconds INT CHECK (call_duration_seconds >= 0),
    from_stage lead_stage,                          -- Stage Change only
    to_stage lead_stage,
    performed_by INT REFERENCES users(user_id),     -- NULL = system
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX lead_activities_lead_idx ON lead_activities (lead_id, occurred_at DESC);

-- Stage changes are recorded automatically so the timeline is never missing one.
-- The Flask app should run `SET LOCAL app.current_user_id = '<id>'` in each
-- transaction so the change is attributed to the logged-in user.
CREATE OR REPLACE FUNCTION log_lead_stage_change() RETURNS trigger AS $$
BEGIN
    NEW.stage_changed_at = CURRENT_TIMESTAMP;
    INSERT INTO lead_activities (lead_id, activity_type, from_stage, to_stage, performed_by)
    VALUES (NEW.lead_id, 'Stage Change', OLD.stage, NEW.stage,
            NULLIF(current_setting('app.current_user_id', TRUE), '')::INT);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_leads_stage_change
    BEFORE UPDATE OF stage ON leads
    FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage)
    EXECUTE FUNCTION log_lead_stage_change();

-- ---------------------------------------------------------------------------
-- Demos
-- ---------------------------------------------------------------------------
CREATE TABLE demos (
    demo_id SERIAL PRIMARY KEY,
    lead_id INT NOT NULL REFERENCES leads(lead_id),
    course_id INT NOT NULL REFERENCES courses(course_id),
    branch_id INT NOT NULL REFERENCES branches(branch_id),
    scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
    duration_minutes SMALLINT NOT NULL DEFAULT 45 CHECK (duration_minutes > 0),
    mode demo_mode NOT NULL DEFAULT 'In-person',
    meeting_link VARCHAR(500),
    trainer_user_id INT REFERENCES users(user_id),  -- trainer / meet organiser
    status demo_status NOT NULL DEFAULT 'Scheduled',
    rescheduled_from_demo_id INT REFERENCES demos(demo_id),

    -- Reminders: immediate confirmation, 24h student, 1h student + trainer
    confirmation_sent_at TIMESTAMP WITH TIME ZONE,
    reminder_24h_sent_at TIMESTAMP WITH TIME ZONE,
    reminder_1h_sent_at TIMESTAMP WITH TIME ZONE,

    -- Outcome
    feedback TEXT,
    rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
    next_step TEXT,

    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX demos_lead_idx ON demos (lead_id);
CREATE INDEX demos_branch_scheduled_idx ON demos (branch_id, scheduled_at);
CREATE INDEX demos_trainer_scheduled_idx ON demos (trainer_user_id, scheduled_at);

CREATE TRIGGER trg_demos_updated_at
    BEFORE UPDATE ON demos
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
