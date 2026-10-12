-- CRM AI sales playbook v2.0 (2 Oct 2026), releases 1 and 3: the Front Office work queue, contact rules, objections,
-- approved sales knowledge, optional course paths and a record of every AI suggestion and what staff did with it.
--
--   persons              stop contact (suppresses all outreach until a manager clears it) and preferred contact time.
--   leads                what the learner needs (goal, starting point, timing, joining window, open question), the
--                        agreed next action, a contact state when there is no dated next action, and the first-response
--                        clock: due 10 staffed minutes after the original capture, stamped by the first real staff
--                        contact (bot / system rows have no performer and never count).
--   lead_objections      the learner's own words, an optional category, the action taken and whether it was resolved.
--   sales_knowledge      approved syllabus / brochure links, fee rules, FAQ answers and reply templates. Staff and AI
--                        only use Approved rows; editing an approved row sends it back to Draft (new version).
--   course_paths         reviewed "next course" relationships (Excel → Power BI …); Academic Coordinator or admin approves.
--   ai_branch_controls   execution profile per branch (Observe / Assist) and a pause switch. Approved automatic is
--                        refused until a live channel passes the acceptance tests.
--   ai_actions           every AI / rule suggestion staff acted on: evidence, record version, policy / prompt version,
--                        disposition (Used / Edited / Ignored / Snoozed), result or failure. Original evidence is frozen.
--   lead_response_clock  view: first-attempt SLA state and the 2 / 10 / 30 staffed-minute escalation times.
--   lead_contact_counters view: outbound calls / WhatsApp while the learner has never been reached (shared ceilings).
--
-- Source: Nipuna-CRM-AI-Use-Cases-and-Workflows-Developer-Specification-2026-10-02 (pages 2-4, 7, 9, 13-17).
-- Depends on: 030_lms_curriculum_mapping.sql

CREATE TYPE contact_outcome AS ENUM (
    'Connected', 'No answer', 'Callback requested', 'Demo booked', 'Interested', 'Later', 'Not interested',
    'Wrong number', 'Stop contact');
CREATE TYPE contact_state AS ENUM (
    'Awaiting reply', 'Later', 'Not interested', 'Invalid contact', 'Stop contact', 'Next action missing');
CREATE TYPE objection_category AS ENUM (
    'Fee is high', 'Another institute is cheaper', 'Need to ask parents', 'Cannot attend timings', 'Job guarantee',
    'Weak in basics', 'Will decide later', 'Bad experience / refund concern', 'Other');
CREATE TYPE objection_status AS ENUM ('Open', 'Resolved', 'Closed unresolved');
CREATE TYPE knowledge_kind AS ENUM (
    'Syllabus', 'Brochure', 'Course comparison', 'Branch location', 'Fee and instalment rule', 'Batch availability',
    'Placement support', 'FAQ answer', 'Policy', 'Reply template');
CREATE TYPE reply_situation AS ENUM (
    'New enquiry', 'Missed call', 'Syllabus request', 'Agreed callback', 'Demo reminder', 'Post-demo discussion',
    'Fee follow-up', 'Future joining');
CREATE TYPE playbook_review_status AS ENUM ('Draft', 'Approved', 'Retired');
CREATE TYPE ai_action_type AS ENUM (
    'Next action', 'Reply draft', 'Counselling brief', 'Course suggestion', 'Recovery', 'Objection response');
CREATE TYPE ai_action_status AS ENUM ('Suggested', 'Used', 'Edited', 'Ignored', 'Snoozed', 'Expired', 'Failed');
CREATE TYPE ai_execution_profile AS ENUM ('Observe', 'Assist', 'Approved automatic');

-- ---------------------------------------------------------------------------
-- Persons: stop contact
-- ---------------------------------------------------------------------------
ALTER TABLE persons
    ADD COLUMN stop_contact_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN stop_contact_by INT REFERENCES users(user_id),
    ADD COLUMN stop_contact_reason TEXT,
    ADD COLUMN preferred_contact_time VARCHAR(100),
    ADD CONSTRAINT persons_stop_contact_reason CHECK (stop_contact_at IS NULL OR stop_contact_reason IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Leads: learner need, next action, contact state, first-response clock
-- ---------------------------------------------------------------------------
ALTER TABLE leads
    ADD COLUMN learner_goal TEXT,
    ADD COLUMN prior_experience TEXT,
    ADD COLUMN preferred_timing VARCHAR(150),
    ADD COLUMN joining_window VARCHAR(150),
    ADD COLUMN open_question TEXT,
    ADD COLUMN next_action TEXT,
    ADD COLUMN contact_state contact_state,
    ADD COLUMN contact_state_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN first_attempt_due_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN first_staff_attempt_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN first_staff_attempt_by INT REFERENCES users(user_id);

INSERT INTO app_settings (setting_key, setting_value, description) VALUES
    ('first_attempt_staffed_minutes', '10', 'First staff attempt due this many staffed minutes after the original capture'),
    ('first_attempt_cover_minutes', '2', 'Alert Front Office cover when no staff attempt after this many staffed minutes'),
    ('first_attempt_manager_minutes', '10', 'Alert the Branch Manager after this many staffed minutes'),
    ('first_attempt_founder_minutes', '30', 'Escalate to the Founder / CEO after this many staffed minutes'),
    ('unanswered_call_limit', '5', 'Most outbound calls to a learner who has never been reached'),
    ('unanswered_whatsapp_limit', '3', 'Most outbound WhatsApp messages to a learner who has never been reached'),
    ('unanswered_window_days', '7', 'After this many days without reaching the learner, the lead is reviewed for closure'),
    ('outreach_attempt_limit', '2', 'College outreach: one call plus one follow-up until interest is confirmed'),
    ('outreach_follow_up_gap_days', '3', 'College outreach: days between the call and the follow-up (3-5)');

CREATE OR REPLACE FUNCTION setting_int(p_key TEXT, p_default INT) RETURNS INT
LANGUAGE sql STABLE AS $$
    SELECT COALESCE((SELECT (setting_value #>> '{}')::INT FROM app_settings WHERE setting_key = p_key), p_default);
$$;

-- The clock starts at the original capture (the enquiry's received time), never at a retry or import time
CREATE OR REPLACE FUNCTION lead_capture_at(p_enquiry_id INT, p_created_at TIMESTAMP WITH TIME ZONE)
RETURNS TIMESTAMP WITH TIME ZONE LANGUAGE sql STABLE AS $$
    SELECT COALESCE((SELECT received_at FROM enquiries WHERE enquiry_id = p_enquiry_id), p_created_at, CURRENT_TIMESTAMP);
$$;

CREATE OR REPLACE FUNCTION set_lead_first_attempt_due() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR (NEW.original_enquiry_id IS DISTINCT FROM OLD.original_enquiry_id
                            AND NEW.first_staff_attempt_at IS NULL) THEN
        NEW.first_attempt_due_at := add_staffed_minutes(
            NEW.branch_id, lead_capture_at(NEW.original_enquiry_id, COALESCE(NEW.created_at, CURRENT_TIMESTAMP)),
            setting_int('first_attempt_staffed_minutes', 10));
    END IF;
    IF NEW.contact_state IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.contact_state END) THEN
        NEW.contact_state_at := CASE WHEN NEW.contact_state IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_leads_first_attempt_due
    BEFORE INSERT OR UPDATE OF original_enquiry_id, contact_state ON leads
    FOR EACH ROW EXECUTE FUNCTION set_lead_first_attempt_due();

-- A staff contact = an activity with a performer that is outbound, or a call / meeting in either direction.
-- Inbound messages (the learner wrote) and rows without a performer (bot, system, import) never stop the clock.
CREATE OR REPLACE FUNCTION is_staff_contact(p_type activity_type, p_direction activity_direction, p_performer INT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT p_performer IS NOT NULL AND p_type IN ('Call', 'WhatsApp', 'Email', 'SMS', 'Meeting')
       AND (p_direction IS DISTINCT FROM 'Inbound' OR p_type IN ('Call', 'Meeting'));
$$;

CREATE OR REPLACE FUNCTION stamp_lead_first_attempt() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF is_staff_contact(NEW.activity_type, NEW.direction, NEW.performed_by) THEN
        UPDATE leads SET first_staff_attempt_at = NEW.occurred_at, first_staff_attempt_by = NEW.performed_by
        WHERE lead_id = NEW.lead_id AND (first_staff_attempt_at IS NULL OR first_staff_attempt_at > NEW.occurred_at);
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_lead_activities_first_attempt
    AFTER INSERT ON lead_activities
    FOR EACH ROW EXECUTE FUNCTION stamp_lead_first_attempt();

-- Backfill: due from the original capture; attempted at the earliest staff contact already on the timeline
UPDATE leads l SET first_attempt_due_at = add_staffed_minutes(
    l.branch_id, lead_capture_at(l.original_enquiry_id, l.created_at), setting_int('first_attempt_staffed_minutes', 10));
UPDATE leads l SET first_staff_attempt_at = a.occurred_at, first_staff_attempt_by = a.performed_by
FROM (SELECT DISTINCT ON (lead_id) lead_id, occurred_at, performed_by FROM lead_activities
      WHERE is_staff_contact(activity_type, direction, performed_by) ORDER BY lead_id, occurred_at) a
WHERE a.lead_id = l.lead_id;

ALTER TABLE leads ALTER COLUMN first_attempt_due_at SET NOT NULL;
CREATE INDEX leads_first_attempt_pending_idx ON leads (first_attempt_due_at) WHERE first_staff_attempt_at IS NULL;

-- ---------------------------------------------------------------------------
-- Objections
-- ---------------------------------------------------------------------------
CREATE TABLE lead_objections (
    objection_id SERIAL PRIMARY KEY,
    lead_id INT NOT NULL REFERENCES leads(lead_id),
    learner_words TEXT NOT NULL,
    category objection_category,
    category_suggested BOOLEAN NOT NULL DEFAULT FALSE,  -- the category came from a suggestion, not staff
    action_taken TEXT,
    status objection_status NOT NULL DEFAULT 'Open',
    resolution TEXT,
    resolved_by INT REFERENCES users(user_id),
    resolved_at TIMESTAMP WITH TIME ZONE,
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT lead_objections_words_not_blank CHECK (btrim(learner_words) <> ''),
    CONSTRAINT lead_objections_closed_recorded
        CHECK (status = 'Open' OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution IS NOT NULL))
);
CREATE INDEX lead_objections_open_idx ON lead_objections (lead_id) WHERE status = 'Open';
CREATE TRIGGER trg_lead_objections_updated_at BEFORE UPDATE ON lead_objections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The learner's words are evidence: they never change
CREATE OR REPLACE FUNCTION guard_lead_objection() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.lead_id, NEW.learner_words, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.lead_id, OLD.learner_words, OLD.created_by, OLD.created_at) THEN
        RAISE EXCEPTION 'The learner''s recorded words can''t be changed; record a new objection instead';
    END IF;
    IF OLD.status <> 'Open' AND NEW.status = 'Open' THEN
        RAISE EXCEPTION 'A closed objection can''t be reopened; record a new objection instead';
    END IF;
    IF NEW.status <> 'Open' AND OLD.status = 'Open' THEN
        NEW.resolved_at := COALESCE(NEW.resolved_at, CURRENT_TIMESTAMP);
        NEW.resolved_by := COALESCE(NEW.resolved_by, NULLIF(current_setting('app.current_user_id', TRUE), '')::INT);
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_lead_objections_guard BEFORE UPDATE ON lead_objections
    FOR EACH ROW EXECUTE FUNCTION guard_lead_objection();

-- ---------------------------------------------------------------------------
-- Approved sales knowledge and reply templates
-- ---------------------------------------------------------------------------
CREATE TABLE sales_knowledge (
    knowledge_id SERIAL PRIMARY KEY,
    kind knowledge_kind NOT NULL,
    title VARCHAR(200) NOT NULL,
    course_id INT REFERENCES courses(course_id),       -- NULL = any course
    branch_id INT REFERENCES branches(branch_id),      -- NULL = all branches
    situation reply_situation,                         -- reply templates only
    language app_language NOT NULL DEFAULT 'English',
    body TEXT NOT NULL,
    link_url TEXT,
    status playbook_review_status NOT NULL DEFAULT 'Draft',
    version INT NOT NULL DEFAULT 1,
    owner_user_id INT REFERENCES users(user_id),
    approved_by INT REFERENCES users(user_id),
    approved_at TIMESTAMP WITH TIME ZONE,
    review_due_on DATE,                                -- shown as stale after this date
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT sales_knowledge_template_situation CHECK ((kind = 'Reply template') = (situation IS NOT NULL)),
    CONSTRAINT sales_knowledge_approval_recorded
        CHECK (status <> 'Approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
    CONSTRAINT sales_knowledge_link_kinds CHECK (kind NOT IN ('Syllabus', 'Brochure') OR link_url IS NOT NULL)
);
CREATE INDEX sales_knowledge_lookup_idx ON sales_knowledge (kind, course_id, branch_id) WHERE status = 'Approved';
CREATE TRIGGER trg_sales_knowledge_updated_at BEFORE UPDATE ON sales_knowledge
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Approver: Founder / CEO, Super Admin, or a Branch Manager of the row's branch (any branch for company-wide rows).
-- Changing the content of an approved row makes it a new Draft version that needs approval again.
CREATE OR REPLACE FUNCTION guard_sales_knowledge() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status = 'Approved'
       AND (NEW.kind, NEW.title, NEW.course_id, NEW.branch_id, NEW.situation, NEW.language, NEW.body, NEW.link_url)
           IS DISTINCT FROM (OLD.kind, OLD.title, OLD.course_id, OLD.branch_id, OLD.situation, OLD.language, OLD.body, OLD.link_url) THEN
        NEW.status := 'Draft';
        NEW.version := OLD.version + 1;
        NEW.approved_by := NULL;
        NEW.approved_at := NULL;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'Retired' AND NEW.status <> 'Retired' THEN
        RAISE EXCEPTION 'Retired knowledge can''t be brought back; create a new item';
    END IF;
    IF NEW.status = 'Approved' AND (TG_OP = 'INSERT' OR OLD.status <> 'Approved') THEN
        NEW.approved_by := COALESCE(NEW.approved_by, NULLIF(current_setting('app.current_user_id', TRUE), '')::INT);
        NEW.approved_at := COALESCE(NEW.approved_at, CURRENT_TIMESTAMP);
        IF NOT user_has_role(NEW.approved_by, ARRAY['FOUNDER_CEO', 'SUPER_ADMIN', 'BRANCH_MANAGER'], NEW.branch_id) THEN
            RAISE EXCEPTION 'Only a Founder / CEO, Super Admin or Branch Manager can approve sales knowledge';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_sales_knowledge_guard BEFORE INSERT OR UPDATE ON sales_knowledge
    FOR EACH ROW EXECUTE FUNCTION guard_sales_knowledge();
CREATE OR REPLACE FUNCTION prevent_playbook_delete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are never deleted; retire them instead', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER trg_sales_knowledge_no_delete BEFORE DELETE ON sales_knowledge
    FOR EACH ROW EXECUTE FUNCTION prevent_playbook_delete();

-- The spec's draft patterns (page 8). They come from the business-approved playbook, so they start Approved
-- (attributed to the first Founder / CEO); edit them in Sales playbook → Knowledge.
INSERT INTO sales_knowledge (kind, title, situation, body, status, approved_by, approved_at)
SELECT 'Reply template', t.title, t.situation::reply_situation, t.body, 'Approved', f.user_id, CURRENT_TIMESTAMP
FROM (VALUES
    ('New enquiry reply', 'New enquiry',
     'Hello {name}, thank you for enquiring about {course}. Are you looking for classroom or online training, and which timings suit you?'),
    ('Missed call reply', 'Missed call',
     'Hello {name}, we missed your call to Nipuna {branch}. What course would you like information about, and when can our counsellor call you?'),
    ('Syllabus share', 'Syllabus request',
     'Here is the approved {course} syllabus: {approved_link}. Which topics are most relevant to your goal? I can help you check a suitable batch.'),
    ('Agreed callback', 'Agreed callback',
     'You asked us to contact you at {time}. Is this still a convenient time to discuss {specific_question}?'),
    ('Demo reminder', 'Demo reminder',
     'Your confirmed {course} demo is on {date_time} at {branch_or_mode}. {approved_location_or_link}. Please let us know if you need help attending.'),
    ('Post-demo discussion', 'Post-demo discussion',
     'How was your {course} demo? Is there any question about the syllabus, timing or fee that you would like us to clarify before deciding?')
) AS t(title, situation, body)
CROSS JOIN LATERAL (
    SELECT s.user_id FROM active_user_role_scopes s JOIN roles r USING (role_id)
    WHERE r.role_code IN ('FOUNDER_CEO', 'SUPER_ADMIN') ORDER BY r.role_code = 'FOUNDER_CEO' DESC, s.user_id LIMIT 1
) f;

-- ---------------------------------------------------------------------------
-- Course paths (optional next course for an existing student)
-- ---------------------------------------------------------------------------
CREATE TABLE course_paths (
    course_path_id SERIAL PRIMARY KEY,
    from_course_id INT NOT NULL REFERENCES courses(course_id),
    to_course_id INT NOT NULL REFERENCES courses(course_id),
    learner_benefit TEXT NOT NULL,
    helps_when TEXT,
    skip_when TEXT,
    prerequisites TEXT,
    suggested_question TEXT,
    status playbook_review_status NOT NULL DEFAULT 'Draft',
    approved_by INT REFERENCES users(user_id),
    approved_at TIMESTAMP WITH TIME ZONE,
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT course_paths_pair_key UNIQUE (from_course_id, to_course_id),
    CONSTRAINT course_paths_different_courses CHECK (from_course_id <> to_course_id),
    CONSTRAINT course_paths_approval_recorded
        CHECK (status <> 'Approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE TRIGGER trg_course_paths_updated_at BEFORE UPDATE ON course_paths
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_course_paths_no_delete BEFORE DELETE ON course_paths
    FOR EACH ROW EXECUTE FUNCTION prevent_playbook_delete();

CREATE OR REPLACE FUNCTION guard_course_path() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status = 'Approved'
       AND (NEW.from_course_id, NEW.to_course_id, NEW.learner_benefit, NEW.helps_when, NEW.skip_when, NEW.prerequisites,
            NEW.suggested_question)
           IS DISTINCT FROM (OLD.from_course_id, OLD.to_course_id, OLD.learner_benefit, OLD.helps_when, OLD.skip_when,
                             OLD.prerequisites, OLD.suggested_question) THEN
        NEW.status := 'Draft';
        NEW.approved_by := NULL;
        NEW.approved_at := NULL;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'Retired' AND NEW.status <> 'Retired' THEN
        RAISE EXCEPTION 'A retired course path can''t be brought back; create it again';
    END IF;
    IF NEW.status = 'Approved' AND (TG_OP = 'INSERT' OR OLD.status <> 'Approved') THEN
        NEW.approved_by := COALESCE(NEW.approved_by, NULLIF(current_setting('app.current_user_id', TRUE), '')::INT);
        NEW.approved_at := COALESCE(NEW.approved_at, CURRENT_TIMESTAMP);
        IF NOT user_has_role(NEW.approved_by, ARRAY['FOUNDER_CEO', 'SUPER_ADMIN', 'ACADEMIC_COORDINATOR']) THEN
            RAISE EXCEPTION 'Only an Academic Coordinator, Founder / CEO or Super Admin can approve a course path';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_course_paths_guard BEFORE INSERT OR UPDATE ON course_paths
    FOR EACH ROW EXECUTE FUNCTION guard_course_path();

-- The spec's illustrative seeds (page 13) for courses that exist, as Draft: the academic owner approves before use.
-- MS Office → Excel, Excel → Power BI and Java → full-stack have no matching pair in the course catalogue.
INSERT INTO course_paths (from_course_id, to_course_id, learner_benefit, helps_when, skip_when, suggested_question)
SELECT f.course_id, t.course_id, s.benefit, s.helps, s.skip, s.question
FROM (VALUES
    ('NIT-CRS-019', 'NIT-CRS-018', 'Querying and analysing data with SQL and Python beyond dashboards',
     'Data querying or analysis is relevant to the stated role or project',
     'A prerequisite is missing or the course adds no useful capability now',
     'You mentioned working with data; would querying it with SQL or Python help what you want to do?'),
    ('NIT-CRS-018', 'NIT-CRS-052', 'Building web applications on the Python foundation',
     'The learner has the Python foundation and a specific web project or career goal',
     'It is an advanced leap without prerequisites, or a vague trend-based pitch',
     'Do you have a web application you would like to build with Python?'),
    ('NIT-CRS-052', 'NIT-CRS-018', 'Applied AI and machine learning on the Python foundation',
     'The learner has the Python foundation and a specific data or AI project goal',
     'It is an advanced leap without prerequisites, or a vague trend-based pitch',
     'Is there a data or AI problem you would like to solve with Python?'),
    ('NIT-CRS-025', 'NIT-CRS-026', 'Content production: turning designs into video',
     'Content-production or campaign work requires the additional skill',
     'The learner has no relevant interest or time for the extra work',
     'Does your work involve producing video content as well as designs?'),
    ('NIT-CRS-025', 'NIT-CRS-028', 'Running campaigns with the creatives they design',
     'Campaign work requires the additional skill',
     'The learner has no relevant interest or time for the extra work',
     'Would you like to run campaigns using the designs you create?')
) AS s(from_code, to_code, benefit, helps, skip, question)
JOIN courses f ON f.course_code = s.from_code
JOIN courses t ON t.course_code = s.to_code;

-- ---------------------------------------------------------------------------
-- AI controls per branch
-- ---------------------------------------------------------------------------
CREATE TABLE ai_branch_controls (
    branch_id INT PRIMARY KEY REFERENCES branches(branch_id),
    execution_profile ai_execution_profile NOT NULL DEFAULT 'Assist',
    is_paused BOOLEAN NOT NULL DEFAULT FALSE,
    pause_reason TEXT,
    paused_by INT REFERENCES users(user_id),
    paused_at TIMESTAMP WITH TIME ZONE,
    updated_by INT REFERENCES users(user_id),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ai_branch_controls_pause_recorded
        CHECK (NOT is_paused OR (pause_reason IS NOT NULL AND paused_by IS NOT NULL AND paused_at IS NOT NULL)),
    -- No live WhatsApp / telephony channel has passed the retry, stale-send and opt-out tests yet (spec page 21)
    CONSTRAINT ai_branch_controls_no_automatic_yet CHECK (execution_profile <> 'Approved automatic')
);
CREATE TRIGGER trg_ai_branch_controls_updated_at BEFORE UPDATE ON ai_branch_controls
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
INSERT INTO ai_branch_controls (branch_id) SELECT branch_id FROM branches;

-- ---------------------------------------------------------------------------
-- AI action record
-- ---------------------------------------------------------------------------
CREATE TABLE ai_actions (
    ai_action_id BIGSERIAL PRIMARY KEY,
    action_type ai_action_type NOT NULL,
    action_code VARCHAR(80) NOT NULL,                  -- e.g. first_attempt, callback_due, course:5>1, reply:Missed call
    fingerprint VARCHAR(64) NOT NULL,                  -- hash of the evidence: a changed fact makes a new suggestion
    lead_id INT REFERENCES leads(lead_id),
    person_id INT REFERENCES persons(person_id),
    branch_id INT NOT NULL REFERENCES branches(branch_id),
    owner_user_id INT REFERENCES users(user_id),
    course_id INT REFERENCES courses(course_id),       -- the suggested course (course suggestions)
    suggestion TEXT NOT NULL,
    reason TEXT,
    evidence JSONB NOT NULL DEFAULT '[]',
    draft_text TEXT,
    payload JSONB,
    record_version TIMESTAMP WITH TIME ZONE,           -- the lead's updated_at when the suggestion was made
    status ai_action_status NOT NULL DEFAULT 'Suggested',
    final_text TEXT,
    disposition_note TEXT,
    disposition_by INT REFERENCES users(user_id),
    disposition_at TIMESTAMP WITH TIME ZONE,
    remind_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    policy_version VARCHAR(30) NOT NULL DEFAULT 'playbook-2.0',
    prompt_version VARCHAR(30),
    model VARCHAR(100),
    execution_result TEXT,
    failure_reason TEXT,
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ai_actions_has_subject CHECK (lead_id IS NOT NULL OR person_id IS NOT NULL),
    CONSTRAINT ai_actions_disposition_recorded
        CHECK (status IN ('Suggested', 'Expired', 'Failed') OR (disposition_by IS NOT NULL AND disposition_at IS NOT NULL)),
    CONSTRAINT ai_actions_snooze_has_date CHECK (status <> 'Snoozed' OR remind_at IS NOT NULL),
    CONSTRAINT ai_actions_edit_has_text CHECK (status <> 'Edited' OR final_text IS NOT NULL),
    CONSTRAINT ai_actions_failure_reason CHECK (status <> 'Failed' OR failure_reason IS NOT NULL)
);
CREATE INDEX ai_actions_lead_idx ON ai_actions (lead_id, action_code, fingerprint);
CREATE INDEX ai_actions_person_course_idx ON ai_actions (person_id, course_id) WHERE action_type = 'Course suggestion';
CREATE INDEX ai_actions_created_idx ON ai_actions (branch_id, created_at);
CREATE TRIGGER trg_ai_actions_updated_at BEFORE UPDATE ON ai_actions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Original evidence and the suggestion are kept as made; only the disposition and the result change
CREATE OR REPLACE FUNCTION guard_ai_action() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.action_type, NEW.action_code, NEW.fingerprint, NEW.lead_id, NEW.person_id, NEW.branch_id, NEW.course_id,
        NEW.suggestion, NEW.reason, NEW.evidence, NEW.draft_text, NEW.payload, NEW.record_version, NEW.policy_version,
        NEW.prompt_version, NEW.model, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.action_type, OLD.action_code, OLD.fingerprint, OLD.lead_id, OLD.person_id, OLD.branch_id, OLD.course_id,
        OLD.suggestion, OLD.reason, OLD.evidence, OLD.draft_text, OLD.payload, OLD.record_version, OLD.policy_version,
        OLD.prompt_version, OLD.model, OLD.created_by, OLD.created_at) THEN
        RAISE EXCEPTION 'An AI suggestion and its evidence can''t be changed; record the staff decision instead';
    END IF;
    IF OLD.status IN ('Used', 'Edited', 'Ignored', 'Expired', 'Failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'This suggestion was already %; it can''t be changed', lower(OLD.status::TEXT);
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('Used', 'Edited', 'Ignored', 'Snoozed') THEN
        NEW.disposition_by := COALESCE(NEW.disposition_by, NULLIF(current_setting('app.current_user_id', TRUE), '')::INT);
        NEW.disposition_at := CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_ai_actions_guard BEFORE UPDATE ON ai_actions
    FOR EACH ROW EXECUTE FUNCTION guard_ai_action();
CREATE TRIGGER trg_ai_actions_no_delete BEFORE DELETE ON ai_actions
    FOR EACH ROW EXECUTE FUNCTION prevent_playbook_delete();

-- ---------------------------------------------------------------------------
-- First-response escalation rules (spec page 4: cover at 2, Branch Manager at 10, Founder / CEO at 30 staffed minutes)
-- ---------------------------------------------------------------------------
INSERT INTO notification_rules (rule_code, event_type, description, recipient_role_id, category)
SELECT v.code, 'lead.first_attempt', v.description, r.role_id, v.category::notification_category
FROM (VALUES
    ('FIRST_ATTEMPT_COVER', 'New enquiry without a staff attempt: Front Office cover can help now', 'FRONT_OFFICE', 'Action Required'),
    ('FIRST_ATTEMPT_MANAGER', 'New enquiry without a staff attempt at its 10-minute deadline', 'BRANCH_MANAGER', 'Escalation'),
    ('FIRST_ATTEMPT_FOUNDER', 'New enquiry still without a staff attempt after 30 staffed minutes', 'FOUNDER_CEO', 'Escalation')
) AS v(code, description, role_code, category)
JOIN roles r ON r.role_code = v.role_code;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
-- Eligible = a genuine enquiry (not college outreach, spam or test). Escalation times are staffed minutes from capture.
CREATE VIEW lead_response_clock AS
SELECT l.lead_id, l.branch_id, l.assigned_to, l.intake_status,
       lead_capture_at(l.original_enquiry_id, l.created_at) AS captured_at,
       l.first_attempt_due_at AS due_at,
       l.first_staff_attempt_at AS attempted_at,
       l.first_staff_attempt_by AS attempted_by,
       l.intake_status NOT IN ('Outreach Prospect', 'Invalid-Spam', 'Test') AS is_eligible,
       add_staffed_minutes(l.branch_id, lead_capture_at(l.original_enquiry_id, l.created_at),
                           setting_int('first_attempt_cover_minutes', 2)) AS cover_alert_at,
       add_staffed_minutes(l.branch_id, lead_capture_at(l.original_enquiry_id, l.created_at),
                           setting_int('first_attempt_manager_minutes', 10)) AS manager_alert_at,
       add_staffed_minutes(l.branch_id, lead_capture_at(l.original_enquiry_id, l.created_at),
                           setting_int('first_attempt_founder_minutes', 30)) AS founder_alert_at,
       CASE
           WHEN l.first_staff_attempt_at IS NOT NULL AND l.first_staff_attempt_at <= l.first_attempt_due_at THEN 'Met'
           WHEN l.first_staff_attempt_at IS NOT NULL THEN 'Met Late'
           WHEN l.stage IN ('Admitted', 'Lost - closed') THEN 'Closed Without Attempt'
           WHEN CURRENT_TIMESTAMP > l.first_attempt_due_at THEN 'Breached'
           WHEN CURRENT_TIMESTAMP > l.first_attempt_due_at - INTERVAL '5 minutes' THEN 'At Risk'
           ELSE 'Pending'
       END AS sla_state
FROM leads l;

-- Shared attempt counters for staff and agents. "Reached" = any inbound contact, a meeting, or an outcome that shows
-- a conversation happened. Counters only limit outreach while the learner has never been reached.
CREATE VIEW lead_contact_counters AS
SELECT l.lead_id,
       NOT EXISTS (
           SELECT 1 FROM lead_activities a
           WHERE a.lead_id = l.lead_id AND a.activity_type IN ('Call', 'WhatsApp', 'Email', 'SMS', 'Meeting')
             AND (a.direction = 'Inbound' OR a.activity_type = 'Meeting'
                  OR a.outcome IN ('Connected', 'Callback requested', 'Demo booked', 'Interested', 'Later',
                                   'Not interested', 'Stop contact', 'Call back later', 'Needs time'))
       ) AS never_reached,
       (SELECT count(*) FROM lead_activities a WHERE a.lead_id = l.lead_id AND a.activity_type = 'Call'
          AND a.direction = 'Outbound' AND a.performed_by IS NOT NULL)::INT AS outbound_calls,
       (SELECT count(*) FROM lead_activities a WHERE a.lead_id = l.lead_id AND a.activity_type = 'WhatsApp'
          AND a.direction = 'Outbound' AND a.performed_by IS NOT NULL)::INT AS outbound_whatsapp,
       (SELECT count(*) FROM lead_activities a WHERE a.lead_id = l.lead_id
          AND a.activity_type IN ('Call', 'WhatsApp', 'Email', 'SMS')
          AND a.direction = 'Outbound' AND a.performed_by IS NOT NULL)::INT AS outbound_attempts,
       (SELECT max(a.occurred_at) FROM lead_activities a WHERE a.lead_id = l.lead_id
          AND a.activity_type IN ('Call', 'WhatsApp', 'Email', 'SMS') AND a.direction = 'Outbound') AS last_outbound_at,
       (SELECT max(a.occurred_at) FROM lead_activities a WHERE a.lead_id = l.lead_id AND a.direction = 'Inbound') AS last_inbound_at
FROM leads l;
