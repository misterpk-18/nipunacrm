-- Phase 5: operations (communications inbox, tasks, notifications)
-- Depends on: 006_phase4_academics.sql

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE integration_mode AS ENUM ('Manual', 'API');

CREATE TYPE comm_delivery_status AS ENUM ('Received', 'Sent', 'Delivered', 'Read', 'Failed', 'Missed');

CREATE TYPE comm_match_status AS ENUM ('Matched', 'Match Review', 'Unmatched');

CREATE TYPE task_status AS ENUM ('Open', 'In Progress', 'Waiting/Blocked', 'Completed', 'Cancelled');

CREATE TYPE task_source AS ENUM ('Manual', 'System');

CREATE TYPE notification_category AS ENUM ('Action Required', 'Escalation', 'Information', 'System Issue');

CREATE TYPE external_delivery_status AS ENUM ('Not Sent', 'Pending Verification', 'Sent', 'Delivered', 'Failed');

-- ---------------------------------------------------------------------------
-- Branch channels: each branch's WhatsApp number, email inbox, phone line
-- ---------------------------------------------------------------------------
CREATE TABLE branch_channels (
    branch_channel_id SERIAL PRIMARY KEY,
    branch_id INT NOT NULL REFERENCES branches(branch_id),
    contact_channel_id INT NOT NULL REFERENCES contact_channels(contact_channel_id),
    address VARCHAR(255) NOT NULL,                  -- phone number or email address
    mode integration_mode NOT NULL DEFAULT 'Manual',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (contact_channel_id, address)
);

CREATE TRIGGER trg_branch_channels_updated_at
    BEFORE UPDATE ON branch_channels
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Communications: unified inbox of every message / call, matched or not.
-- Matching to a person is suggested, never auto-merged.
-- ---------------------------------------------------------------------------
CREATE TABLE communications (
    communication_id BIGSERIAL PRIMARY KEY,
    branch_id INT NOT NULL REFERENCES branches(branch_id),
    contact_channel_id INT NOT NULL REFERENCES contact_channels(contact_channel_id),
    direction activity_direction NOT NULL,
    from_address VARCHAR(255),                      -- phone / email as received
    to_address VARCHAR(255),
    subject VARCHAR(255),
    body TEXT,
    call_duration_seconds INT CHECK (call_duration_seconds >= 0),

    delivery_status comm_delivery_status NOT NULL,
    failure_reason TEXT,
    retry_of_id BIGINT REFERENCES communications(communication_id),
    is_manual BOOLEAN NOT NULL DEFAULT TRUE,        -- recorded by staff (no live integration yet)
    external_message_id VARCHAR(255) UNIQUE,        -- provider id once APIs are connected

    -- Identity matching
    match_status comm_match_status NOT NULL DEFAULT 'Unmatched',
    person_id INT REFERENCES persons(person_id),
    lead_id INT REFERENCES leads(lead_id),
    matched_by INT REFERENCES users(user_id),

    -- Response SLA (inbound items that need a reply)
    needs_response BOOLEAN NOT NULL DEFAULT FALSE,
    response_due_at TIMESTAMP WITH TIME ZONE,
    responded_at TIMESTAMP WITH TIME ZONE,
    handled_by INT REFERENCES users(user_id),

    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT communications_matched_has_person
        CHECK (match_status <> 'Matched' OR person_id IS NOT NULL),
    CONSTRAINT communications_failure_reason
        CHECK (delivery_status <> 'Failed' OR failure_reason IS NOT NULL),
    CONSTRAINT communications_response_due
        CHECK (NOT needs_response OR response_due_at IS NOT NULL)
);

CREATE INDEX communications_branch_occurred_idx ON communications (branch_id, occurred_at DESC);
CREATE INDEX communications_person_idx ON communications (person_id);
CREATE INDEX communications_lead_idx ON communications (lead_id);
CREATE INDEX communications_awaiting_reply_idx ON communications (response_due_at)
    WHERE needs_response AND responded_at IS NULL;
CREATE INDEX communications_match_review_idx ON communications (match_status)
    WHERE match_status = 'Match Review';

CREATE TRIGGER trg_communications_updated_at
    BEFORE UPDATE ON communications
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Lead timeline entries can point at the inbox item they came from
ALTER TABLE lead_activities
    ADD COLUMN communication_id BIGINT REFERENCES communications(communication_id);

-- ---------------------------------------------------------------------------
-- Tasks: the linked work queue. Overdue and Unassigned are derived, not statuses.
-- Reassigning a task never changes the lead owner or admission.
-- ---------------------------------------------------------------------------
CREATE TABLE task_types (
    task_type_id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    label VARCHAR(100) NOT NULL,
    sort_order SMALLINT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO task_types (code, label, sort_order) VALUES
    ('CALL', 'Call', 1),
    ('FOLLOW_UP', 'Follow-up', 2),
    ('DEMO', 'Demo', 3),
    ('FEE_DISCUSSION', 'Fee Discussion', 4),
    ('APPROVAL', 'Approval', 5),
    ('PAYMENT_VERIFICATION', 'Payment Verification', 6),
    ('COLLECTIONS', 'Collections', 7),
    ('DOCUMENT_REVIEW', 'Document Review', 8),
    ('ACADEMIC', 'Academic', 9),
    ('REFUND_CASE', 'Refund Case', 10),
    ('GENERAL', 'General', 99);

CREATE TABLE tasks (
    task_id SERIAL PRIMARY KEY,
    task_type_id INT NOT NULL REFERENCES task_types(task_type_id),
    title VARCHAR(255) NOT NULL,                    -- e.g., 'Demo outcome · Ananya Rao'
    description TEXT,
    branch_id INT NOT NULL REFERENCES branches(branch_id),
    owner_user_id INT REFERENCES users(user_id),    -- NULL = Unassigned / Needs Cover
    team_role_id INT REFERENCES roles(role_id),     -- team queue, e.g., Academic Coordinator
    status task_status NOT NULL DEFAULT 'Open',
    source task_source NOT NULL DEFAULT 'Manual',
    dedupe_key VARCHAR(200) UNIQUE,                 -- system tasks: stops the same task being created twice

    original_due_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revised_due_at TIMESTAMP WITH TIME ZONE,
    revision_reason TEXT,
    blocked_reason TEXT,

    -- Linked record (at most one)
    lead_id INT REFERENCES leads(lead_id),
    demo_id INT REFERENCES demos(demo_id),
    fee_discussion_id INT REFERENCES fee_discussions(fee_discussion_id),
    scr_id INT REFERENCES special_closing_requests(scr_id),
    admission_id INT REFERENCES admissions(admission_id),
    payment_id INT REFERENCES payments(payment_id),
    refund_case_id INT REFERENCES refund_cases(refund_case_id),
    document_id INT REFERENCES documents(document_id),
    communication_id BIGINT REFERENCES communications(communication_id),

    completed_by INT REFERENCES users(user_id),
    completed_at TIMESTAMP WITH TIME ZONE,
    cancel_reason TEXT,
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT tasks_one_linked_record
        CHECK (num_nonnulls(lead_id, demo_id, fee_discussion_id, scr_id, admission_id,
                            payment_id, refund_case_id, document_id, communication_id) <= 1),
    CONSTRAINT tasks_revision_reason
        CHECK (revised_due_at IS NULL OR revision_reason IS NOT NULL),
    CONSTRAINT tasks_blocked_reason
        CHECK (status <> 'Waiting/Blocked' OR blocked_reason IS NOT NULL),
    CONSTRAINT tasks_completion_recorded
        CHECK (status <> 'Completed' OR completed_at IS NOT NULL),
    CONSTRAINT tasks_cancel_reason
        CHECK (status <> 'Cancelled' OR cancel_reason IS NOT NULL)
);

CREATE INDEX tasks_owner_status_idx ON tasks (owner_user_id, status);
CREATE INDEX tasks_branch_status_idx ON tasks (branch_id, status);
CREATE INDEX tasks_unassigned_idx ON tasks (branch_id) WHERE owner_user_id IS NULL AND status NOT IN ('Completed', 'Cancelled');
CREATE INDEX tasks_lead_idx ON tasks (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX tasks_admission_idx ON tasks (admission_id) WHERE admission_id IS NOT NULL;

CREATE OR REPLACE FUNCTION before_task_update() RETURNS trigger AS $$
BEGIN
    IF OLD.status IN ('Completed', 'Cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Task % is already %; create a new task instead', OLD.task_id, OLD.status;
    END IF;

    IF NEW.original_due_at IS DISTINCT FROM OLD.original_due_at THEN
        RAISE EXCEPTION 'original_due_at is fixed; set revised_due_at with a reason instead';
    END IF;

    IF NEW.status = 'Completed' AND OLD.status IS DISTINCT FROM 'Completed' THEN
        NEW.completed_at = COALESCE(NEW.completed_at, CURRENT_TIMESTAMP);
        NEW.completed_by = COALESCE(NEW.completed_by, NULLIF(current_setting('app.current_user_id', TRUE), '')::INT);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tasks_before_update
    BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION before_task_update();

CREATE TRIGGER trg_tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Notification rules (Admin → Notification Rules)
-- ---------------------------------------------------------------------------
CREATE TABLE notification_rules (
    rule_id SERIAL PRIMARY KEY,
    rule_code VARCHAR(50) UNIQUE NOT NULL,          -- e.g., 'SCR_PENDING'
    event_type VARCHAR(50) NOT NULL,                -- e.g., 'scr.created'
    description TEXT,
    recipient_role_id INT NOT NULL REFERENCES roles(role_id),
    category notification_category NOT NULL DEFAULT 'Action Required',
    warn_after_minutes INT CHECK (warn_after_minutes > 0),
    escalate_after_minutes INT CHECK (escalate_after_minutes > 0),
    escalate_to_role_id INT REFERENCES roles(role_id),
    send_whatsapp BOOLEAN NOT NULL DEFAULT FALSE,
    send_email BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT notification_rules_escalate_after_warn
        CHECK (escalate_after_minutes IS NULL OR warn_after_minutes IS NULL OR escalate_after_minutes > warn_after_minutes),
    CONSTRAINT notification_rules_escalation_target
        CHECK (escalate_after_minutes IS NULL OR escalate_to_role_id IS NOT NULL)
);

CREATE TRIGGER trg_notification_rules_updated_at
    BEFORE UPDATE ON notification_rules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO notification_rules (rule_code, event_type, description, recipient_role_id, warn_after_minutes, escalate_after_minutes, escalate_to_role_id)
SELECT v.code, v.evt, v.descr, r.role_id, v.warn, v.esc, e.role_id
FROM (VALUES
    ('SCR_PENDING', 'scr.created', 'Special closing request awaiting decision', 'BRANCH_MANAGER', 4, 5, 'FOUNDER_CEO'),
    ('PAYMENT_PENDING_VERIFICATION', 'payment.recorded', 'Payment awaiting Accounts verification', 'ACCOUNTS', 25, 30, 'BRANCH_MANAGER')
) v(code, evt, descr, role, warn, esc, esc_role)
JOIN roles r ON r.role_code = v.role
JOIN roles e ON e.role_code = v.esc_role;

-- ---------------------------------------------------------------------------
-- Notifications: delivery, read, acknowledgement and action completion are separate
-- Deduplicated by event occurrence + linked record + recipient + purpose.
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
    notification_id BIGSERIAL PRIMARY KEY,
    rule_id INT REFERENCES notification_rules(rule_id),
    category notification_category NOT NULL DEFAULT 'Information',
    event_key VARCHAR(200) NOT NULL,                -- the event occurrence, e.g., 'scr.created:SCR-00001'
    purpose VARCHAR(50) NOT NULL DEFAULT 'notify',  -- e.g., 'notify', 'warn', 'escalate'
    entity_type VARCHAR(50) NOT NULL,               -- linked record, e.g., 'special_closing_request'
    entity_id VARCHAR(50) NOT NULL,
    recipient_user_id INT NOT NULL REFERENCES users(user_id),
    branch_id INT REFERENCES branches(branch_id),
    title VARCHAR(255) NOT NULL,
    body TEXT,

    is_action_required BOOLEAN NOT NULL DEFAULT FALSE,
    delivered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP, -- in-app
    read_at TIMESTAMP WITH TIME ZONE,
    acknowledged_at TIMESTAMP WITH TIME ZONE,
    action_completed_at TIMESTAMP WITH TIME ZONE,

    warn_at TIMESTAMP WITH TIME ZONE,
    escalate_at TIMESTAMP WITH TIME ZONE,
    escalated_at TIMESTAMP WITH TIME ZONE,
    escalated_from_id BIGINT REFERENCES notifications(notification_id),

    external_channel VARCHAR(20),                   -- 'WhatsApp' / 'Email'
    external_status external_delivery_status NOT NULL DEFAULT 'Not Sent',
    external_sent_at TIMESTAMP WITH TIME ZONE,
    external_failure_reason TEXT,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT notifications_ack_after_read
        CHECK (acknowledged_at IS NULL OR read_at IS NOT NULL),
    CONSTRAINT notifications_action_only_if_required
        CHECK (action_completed_at IS NULL OR is_action_required),
    CONSTRAINT notifications_external_failure_reason
        CHECK (external_status <> 'Failed' OR external_failure_reason IS NOT NULL)
);

CREATE UNIQUE INDEX notifications_dedupe
    ON notifications (event_key, entity_type, entity_id, recipient_user_id, purpose);
CREATE INDEX notifications_recipient_unread_idx ON notifications (recipient_user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX notifications_escalation_due_idx ON notifications (escalate_at)
    WHERE is_action_required AND action_completed_at IS NULL AND escalated_at IS NULL;

-- Acknowledging implies it was read; fill thresholds from the rule
CREATE OR REPLACE FUNCTION before_notification_write() RETURNS trigger AS $$
DECLARE
    v_rule notification_rules%ROWTYPE;
BEGIN
    IF NEW.acknowledged_at IS NOT NULL AND NEW.read_at IS NULL THEN
        NEW.read_at = NEW.acknowledged_at;
    END IF;

    IF TG_OP = 'INSERT' AND NEW.escalated_from_id IS NOT NULL THEN
        -- An escalation is the end of the chain: no further timers
        NEW.category = 'Escalation';
        NEW.is_action_required = TRUE;
    ELSIF TG_OP = 'INSERT' AND NEW.rule_id IS NOT NULL THEN
        SELECT * INTO v_rule FROM notification_rules WHERE rule_id = NEW.rule_id;
        NEW.category = v_rule.category;
        NEW.is_action_required = NEW.is_action_required OR v_rule.category = 'Action Required';
        NEW.warn_at = COALESCE(NEW.warn_at, NEW.delivered_at + make_interval(mins => v_rule.warn_after_minutes));
        NEW.escalate_at = COALESCE(NEW.escalate_at, NEW.delivered_at + make_interval(mins => v_rule.escalate_after_minutes));
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notifications_before_write
    BEFORE INSERT OR UPDATE ON notifications
    FOR EACH ROW EXECUTE FUNCTION before_notification_write();

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- Task board with derived due date, conditions and linked record code
CREATE VIEW task_board AS
SELECT
    t.task_id,
    tt.label AS task_type,
    t.title,
    t.branch_id,
    t.owner_user_id,
    t.team_role_id,
    t.status,
    t.original_due_at,
    t.revised_due_at,
    COALESCE(t.revised_due_at, t.original_due_at) AS due_at,
    t.status NOT IN ('Completed', 'Cancelled')
        AND COALESCE(t.revised_due_at, t.original_due_at) < CURRENT_TIMESTAMP AS is_overdue,
    t.status NOT IN ('Completed', 'Cancelled')
        AND COALESCE(t.revised_due_at, t.original_due_at)::DATE = CURRENT_DATE AS is_due_today,
    t.owner_user_id IS NULL AND t.status NOT IN ('Completed', 'Cancelled') AS is_unassigned,
    COALESCE(l.lead_code, fd.discussion_code, s.scr_code, a.admission_code, p.receipt_number, r.case_code,
             'DEMO-' || t.demo_id, 'DOC-' || t.document_id, 'COMM-' || t.communication_id) AS linked_record
FROM tasks t
JOIN task_types tt USING (task_type_id)
LEFT JOIN leads l ON l.lead_id = t.lead_id
LEFT JOIN fee_discussions fd ON fd.fee_discussion_id = t.fee_discussion_id
LEFT JOIN special_closing_requests s ON s.scr_id = t.scr_id
LEFT JOIN admissions a ON a.admission_id = t.admission_id
LEFT JOIN payments p ON p.payment_id = t.payment_id
LEFT JOIN refund_cases r ON r.refund_case_id = t.refund_case_id;

-- Inbox with queue and SLA state
CREATE VIEW communication_inbox AS
SELECT
    c.*,
    CASE
        WHEN c.match_status = 'Match Review' THEN 'Match Review'
        WHEN c.delivery_status = 'Failed' THEN 'Failed Communications'
        WHEN c.delivery_status = 'Missed' THEN 'Missed Calls'
        WHEN c.needs_response AND c.responded_at IS NULL THEN 'Awaiting Reply'
        WHEN c.is_manual THEN 'Manual Activity'
        ELSE 'Other'
    END AS queue,
    CASE
        WHEN NOT c.needs_response THEN NULL
        WHEN c.responded_at IS NOT NULL AND c.responded_at <= c.response_due_at THEN 'Met'
        WHEN c.responded_at IS NOT NULL THEN 'Met Late'
        WHEN CURRENT_TIMESTAMP > c.response_due_at THEN 'Breached'
        WHEN CURRENT_TIMESTAMP > c.response_due_at - INTERVAL '30 minutes' THEN 'At Risk'
        ELSE 'Within SLA'
    END AS sla_state
FROM communications c;

-- Action-required notifications past their escalation time, not yet escalated
CREATE VIEW notifications_due_for_escalation AS
SELECT n.*, r.escalate_to_role_id
FROM notifications n
JOIN notification_rules r USING (rule_id)
WHERE n.is_action_required
  AND n.action_completed_at IS NULL
  AND n.escalated_at IS NULL
  AND n.escalate_at <= CURRENT_TIMESTAMP;
