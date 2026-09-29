-- 017 — The pipeline tracks persons, not leads.
--
-- A lead is an Active enquiry for one course while it sits at New Enquiry. On its first stage change it
-- leaves the Leads list (lead_status = Inactive) and the person joins the pipeline: one pipeline entry
-- (card) per person per branch, holding the shared stage, owner, next follow-up and priority.
--
-- 1. Joining. A lead that leaves New Enquiry joins the person's open card at that branch, or opens a
--    new card at the lead's new stage. A lead that joins an existing card takes the card's stage. While
--    the person has an open card, any new lead for them at that branch (another course, or a Lost lead
--    reactivated) joins the card straight away. Opening a card pulls in the person's other New Enquiry
--    leads at that branch.
-- 2. Shared stage. Moving any open lead on a card moves the card, and moving the card moves every open
--    lead on it (each lead's timeline still logs the change).
-- 3. Closing. A course that is Admitted or Lost closes only that lead. The card stays open for the
--    remaining courses and closes when the last one does: Admitted if any course on it was admitted,
--    otherwise Lost. If a course is admitted while the card is in Payment Pending Verification and
--    other courses remain, the card goes back to Fee Discussion / Payment Awaited. Moving the card to
--    Lost closes every open course on it with the card's lost reason. A closed card never reopens;
--    a later enquiry starts as a new lead (and a new card).
-- 4. A lead that goes straight from New Enquiry to Lost becomes Inactive without a card. A lead can
--    only move back to New Enquiry from Lost (reactivation), where it becomes Active again.
--
-- Existing leads past New Enquiry are backfilled: one card per person per branch with open leads, at
-- the furthest stage among them; the person's other open leads there move to that stage.
--
-- Depends on: 016_complimentary_rules.sql

CREATE TYPE lead_status AS ENUM ('Active', 'Inactive');

-- ---------------------------------------------------------------------------
-- Pipeline entries: one card per person per branch
-- ---------------------------------------------------------------------------
CREATE TABLE pipeline_entries (
    pipeline_entry_id SERIAL PRIMARY KEY,
    entry_code VARCHAR(20) NOT NULL UNIQUE,         -- PL-GNT-00001
    person_id INT NOT NULL REFERENCES persons(person_id),
    branch_id INT NOT NULL REFERENCES branches(branch_id),
    stage lead_stage NOT NULL,
    stage_changed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assigned_to INT REFERENCES users(user_id),
    next_follow_up_at TIMESTAMP WITH TIME ZONE,
    ai_priority lead_priority,
    ai_score SMALLINT,
    lost_reason_id INT REFERENCES lost_reasons(lost_reason_id),
    lost_competitor VARCHAR(150),
    lost_notes TEXT,
    reactivation_date DATE,
    closed_at TIMESTAMP WITH TIME ZONE,             -- set when the card reaches Admitted / Lost
    created_by INT REFERENCES users(user_id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pipeline_entries_not_new_enquiry CHECK (stage <> 'New Enquiry'),
    CONSTRAINT pipeline_entries_lost_reason_required CHECK (stage <> 'Lost - closed' OR lost_reason_id IS NOT NULL),
    CONSTRAINT pipeline_entries_ai_score_range CHECK (ai_score BETWEEN 0 AND 100)
);

CREATE UNIQUE INDEX pipeline_entries_one_open_per_person_branch ON pipeline_entries (person_id, branch_id)
    WHERE stage NOT IN ('Admitted', 'Lost - closed');
CREATE INDEX pipeline_entries_branch_stage_idx ON pipeline_entries (branch_id, stage);
CREATE INDEX pipeline_entries_assigned_follow_up_idx ON pipeline_entries (assigned_to, next_follow_up_at);

CREATE TRIGGER trg_pipeline_entries_updated_at
    BEFORE UPDATE ON pipeline_entries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION set_pipeline_entry_code() RETURNS trigger AS $$
DECLARE
    v_prefix VARCHAR;
BEGIN
    SELECT receipt_prefix INTO v_prefix FROM branches WHERE branch_id = NEW.branch_id;
    NEW.entry_code = 'PL-' || v_prefix || '-' || LPAD(next_number('PIPELINE-' || v_prefix)::TEXT, 5, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_pipeline_entries_code
    BEFORE INSERT ON pipeline_entries
    FOR EACH ROW WHEN (NEW.entry_code IS NULL)
    EXECUTE FUNCTION set_pipeline_entry_code();

-- Card-level moves. app.pipeline_sync = 'on' marks a move made by the sync triggers below
-- (closing a card, or stepping it back after one course is admitted), which the guard allows.
CREATE OR REPLACE FUNCTION guard_pipeline_entry_stage() RETURNS trigger AS $$
BEGIN
    IF OLD.stage IN ('Admitted', 'Lost - closed') THEN
        RAISE EXCEPTION 'Pipeline card % is closed (%); its stage can no longer change', OLD.entry_code, OLD.stage;
    END IF;
    IF current_setting('app.pipeline_sync', TRUE) IS DISTINCT FROM 'on' THEN
        IF NEW.stage = 'Admitted' THEN
            RAISE EXCEPTION 'Pipeline card % becomes Admitted when its last course is admitted; admit each course instead', OLD.entry_code;
        ELSIF OLD.stage = 'Payment Pending Verification' AND NEW.stage <> 'Lost - closed' THEN
            RAISE EXCEPTION 'Pipeline card % is in Payment Pending Verification and cannot move back to %', OLD.entry_code, NEW.stage;
        END IF;
    END IF;
    NEW.stage_changed_at = CURRENT_TIMESTAMP;
    IF NEW.stage IN ('Admitted', 'Lost - closed') THEN
        NEW.closed_at = CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_pipeline_entries_a_stage_guard
    BEFORE UPDATE OF stage ON pipeline_entries
    FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage)
    EXECUTE FUNCTION guard_pipeline_entry_stage();

-- Moving the card moves every open lead on it (Lost copies the card's lost details).
CREATE OR REPLACE FUNCTION cascade_pipeline_entry_stage() RETURNS trigger AS $$
BEGIN
    IF NEW.stage = 'Lost - closed' THEN
        UPDATE leads SET stage = NEW.stage, lost_reason_id = NEW.lost_reason_id, lost_competitor = NEW.lost_competitor,
                         lost_notes = NEW.lost_notes, reactivation_date = NEW.reactivation_date
        WHERE pipeline_entry_id = NEW.pipeline_entry_id AND stage NOT IN ('Admitted', 'Lost - closed');
    ELSIF NEW.stage <> 'Admitted' THEN
        UPDATE leads SET stage = NEW.stage
        WHERE pipeline_entry_id = NEW.pipeline_entry_id AND stage NOT IN ('Admitted', 'Lost - closed')
          AND stage <> NEW.stage;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_pipeline_entries_cascade
    AFTER UPDATE OF stage ON pipeline_entries
    FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage)
    EXECUTE FUNCTION cascade_pipeline_entry_stage();

-- ---------------------------------------------------------------------------
-- Leads: Active while at New Enquiry, linked to a card once in the pipeline
-- ---------------------------------------------------------------------------
ALTER TABLE leads
    ADD COLUMN pipeline_entry_id INT REFERENCES pipeline_entries(pipeline_entry_id),
    ADD COLUMN lead_status lead_status NOT NULL
        GENERATED ALWAYS AS (CASE WHEN stage = 'New Enquiry' THEN 'Active'::lead_status
                                  ELSE 'Inactive'::lead_status END) STORED;

CREATE INDEX leads_pipeline_entry_idx ON leads (pipeline_entry_id);
CREATE INDEX leads_status_branch_idx ON leads (lead_status, branch_id);

-- The PPV rule is card-level now: when one course is admitted, the rest of the card may step back.
CREATE OR REPLACE FUNCTION guard_lead_stage() RETURNS trigger AS $$
BEGIN
    IF OLD.stage = 'Admitted' THEN
        RAISE EXCEPTION 'Lead % is Admitted; its stage can no longer change', OLD.lead_code;
    ELSIF OLD.stage = 'Payment Pending Verification' AND NEW.stage NOT IN ('Admitted', 'Lost - closed')
          AND current_setting('app.pipeline_sync', TRUE) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'Lead % is in Payment Pending Verification and cannot move back to %', OLD.lead_code, NEW.stage;
    ELSIF NEW.stage = 'New Enquiry' AND OLD.stage <> 'Lost - closed' THEN
        RAISE EXCEPTION 'Lead % is in the pipeline and cannot move back to New Enquiry', OLD.lead_code;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Before insert / stage change: join the person's open card at this branch, or open one.
CREATE OR REPLACE FUNCTION attach_lead_to_pipeline() RETURNS trigger AS $$
DECLARE
    v_entry pipeline_entries%ROWTYPE;
BEGIN
    IF NEW.stage IN ('Admitted', 'Lost - closed') THEN
        RETURN NEW;
    END IF;
    -- Already on an open card: the AFTER trigger syncs the card
    IF NEW.pipeline_entry_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM pipeline_entries WHERE pipeline_entry_id = NEW.pipeline_entry_id
          AND stage NOT IN ('Admitted', 'Lost - closed')) THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_entry FROM pipeline_entries
    WHERE person_id = NEW.person_id AND branch_id = NEW.branch_id AND stage NOT IN ('Admitted', 'Lost - closed')
    FOR UPDATE;

    IF FOUND THEN
        NEW.pipeline_entry_id = v_entry.pipeline_entry_id;
        NEW.stage = v_entry.stage;
    ELSIF NEW.stage <> 'New Enquiry' THEN
        INSERT INTO pipeline_entries (person_id, branch_id, stage, assigned_to, next_follow_up_at, ai_priority,
                                      ai_score, created_by)
        VALUES (NEW.person_id, NEW.branch_id, NEW.stage, NEW.assigned_to, NEW.next_follow_up_at, NEW.ai_priority,
                NEW.ai_score, NULLIF(current_setting('app.current_user_id', TRUE), '')::INT)
        RETURNING pipeline_entry_id INTO NEW.pipeline_entry_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_leads_b_pipeline_insert       -- "b_": after the code, before nothing else on insert
    BEFORE INSERT ON leads
    FOR EACH ROW EXECUTE FUNCTION attach_lead_to_pipeline();

CREATE TRIGGER trg_leads_b_pipeline              -- "b_": after the stage guard, before the stage-change logger
    BEFORE UPDATE OF stage ON leads
    FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage)
    EXECUTE FUNCTION attach_lead_to_pipeline();

-- After insert / stage change: pull in the person's other New Enquiry leads, move or close the card.
CREATE OR REPLACE FUNCTION sync_pipeline_from_lead() RETURNS trigger AS $$
DECLARE
    v_entry pipeline_entries%ROWTYPE;
    v_open INT;
BEGIN
    IF NEW.pipeline_entry_id IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT * INTO v_entry FROM pipeline_entries WHERE pipeline_entry_id = NEW.pipeline_entry_id FOR UPDATE;
    IF v_entry.stage IN ('Admitted', 'Lost - closed') THEN
        RETURN NULL;
    END IF;

    UPDATE leads SET stage = v_entry.stage, pipeline_entry_id = v_entry.pipeline_entry_id
    WHERE person_id = NEW.person_id AND branch_id = NEW.branch_id AND stage = 'New Enquiry'
      AND lead_id <> NEW.lead_id;

    IF NEW.stage NOT IN ('Admitted', 'Lost - closed') THEN
        IF v_entry.stage <> NEW.stage THEN
            UPDATE pipeline_entries SET stage = NEW.stage WHERE pipeline_entry_id = v_entry.pipeline_entry_id;
        END IF;
        RETURN NULL;
    END IF;

    SELECT count(*) INTO v_open FROM leads
    WHERE pipeline_entry_id = v_entry.pipeline_entry_id AND stage NOT IN ('Admitted', 'Lost - closed');

    PERFORM set_config('app.pipeline_sync', 'on', TRUE);
    IF v_open = 0 THEN
        IF EXISTS (SELECT 1 FROM leads WHERE pipeline_entry_id = v_entry.pipeline_entry_id AND stage = 'Admitted') THEN
            UPDATE pipeline_entries SET stage = 'Admitted' WHERE pipeline_entry_id = v_entry.pipeline_entry_id;
        ELSE
            UPDATE pipeline_entries SET stage = 'Lost - closed', lost_reason_id = NEW.lost_reason_id,
                   lost_competitor = NEW.lost_competitor, lost_notes = NEW.lost_notes,
                   reactivation_date = NEW.reactivation_date
            WHERE pipeline_entry_id = v_entry.pipeline_entry_id;
        END IF;
    ELSIF NEW.stage = 'Admitted' AND v_entry.stage = 'Payment Pending Verification' THEN
        UPDATE pipeline_entries SET stage = 'Fee Discussion / Payment Awaited'
        WHERE pipeline_entry_id = v_entry.pipeline_entry_id;
    END IF;
    PERFORM set_config('app.pipeline_sync', 'off', TRUE);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_leads_z_pipeline_sync_insert
    AFTER INSERT ON leads
    FOR EACH ROW EXECUTE FUNCTION sync_pipeline_from_lead();

CREATE TRIGGER trg_leads_z_pipeline_sync
    AFTER UPDATE OF stage ON leads
    FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage)
    EXECUTE FUNCTION sync_pipeline_from_lead();

-- ---------------------------------------------------------------------------
-- Backfill: one card per person per branch with open leads past New Enquiry
-- ---------------------------------------------------------------------------
INSERT INTO pipeline_entries (person_id, branch_id, stage, stage_changed_at, assigned_to, next_follow_up_at,
                              ai_priority, ai_score, created_by, created_at)
SELECT DISTINCT ON (person_id, branch_id)
       person_id, branch_id, stage, stage_changed_at, assigned_to, next_follow_up_at, ai_priority, ai_score,
       created_by, created_at
FROM leads
WHERE stage NOT IN ('New Enquiry', 'Admitted', 'Lost - closed')
ORDER BY person_id, branch_id, stage DESC, stage_changed_at DESC, lead_id DESC;

-- Link the person's open leads (New Enquiry ones join too); siblings move to the card's stage
UPDATE leads l SET pipeline_entry_id = e.pipeline_entry_id, stage = e.stage
FROM pipeline_entries e
WHERE e.person_id = l.person_id AND e.branch_id = l.branch_id
  AND l.stage NOT IN ('Admitted', 'Lost - closed');
