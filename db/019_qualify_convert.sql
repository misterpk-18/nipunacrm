-- 019 — Qualification checklist and Convert to deal (UI V4).
--
-- 1. Qualification. A lead has six checks (genuine intent; reachable contact; intended course(s) understood;
--    branch and delivery mode discussed; exact next action agreed; possible identity match reviewed — never
--    auto-merged). Each ticked check records who reviewed it and when. "Mark Qualified" (qualified_at) needs all
--    six; afterwards the checks are frozen. Qualifying never changes the stage.
-- 2. Conversion. A lead joins the pipeline only through Convert (converted_at), no longer on its first stage
--    change (replaces 017's rule). Conversion needs a qualified lead; it moves the chosen courses to Counselling,
--    so the person's card at that branch opens or they join it. New Enquiry leads are no longer pulled onto an
--    open card automatically, and a new lead for a person with an open card stays in Leads until converted.
--    Moving an unconverted lead straight to Lost is still allowed (it closes without a card).
-- 3. Reactivating a Lost lead to New Enquiry makes it an unconverted lead again (converted_at cleared); a lead
--    reactivated straight into a pipeline stage keeps its conversion and opens a new card (as in 017).
-- 4. pipeline_entries.expected_close_date — the expected close date given at conversion.
--
-- Existing leads that are in (or went through) the pipeline are treated as already qualified and converted.
--
-- Depends on: 018_flexible_instalments.sql

CREATE TYPE qualification_check AS ENUM (
    'Genuine intent confirmed',
    'Reachable contact confirmed',
    'Intended course(s) understood',
    'Branch and delivery mode discussed',
    'Exact next action agreed',
    'Possible identity match reviewed'
);

ALTER TABLE leads
    ADD COLUMN qualified_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN qualified_by INT REFERENCES users(user_id),
    ADD COLUMN converted_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN converted_by INT REFERENCES users(user_id);

ALTER TABLE pipeline_entries ADD COLUMN expected_close_date DATE;

CREATE TABLE lead_qualification_reviews (
    lead_id INT NOT NULL REFERENCES leads(lead_id),
    check_code qualification_check NOT NULL,
    reviewed_by INT NOT NULL REFERENCES users(user_id),
    reviewed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,
    PRIMARY KEY (lead_id, check_code)
);

-- ---------------------------------------------------------------------------
-- Backfill: leads already in or through the pipeline count as qualified and converted
-- ---------------------------------------------------------------------------
UPDATE leads
SET qualified_at = created_at, converted_at = created_at
WHERE pipeline_entry_id IS NOT NULL OR stage NOT IN ('New Enquiry', 'Lost - closed');

ALTER TABLE leads
    ADD CONSTRAINT leads_converted_needs_qualified CHECK (converted_at IS NULL OR qualified_at IS NOT NULL),
    ADD CONSTRAINT leads_pipeline_needs_conversion
        CHECK (stage IN ('New Enquiry', 'Lost - closed') OR converted_at IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Checklist: ticks are frozen once the lead is qualified; qualifying needs every check
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_qualification_review() RETURNS trigger AS $$
DECLARE
    v_lead leads%ROWTYPE;
BEGIN
    SELECT * INTO v_lead FROM leads WHERE lead_id = COALESCE(NEW.lead_id, OLD.lead_id);
    IF v_lead.qualified_at IS NOT NULL THEN
        RAISE EXCEPTION 'Lead % is already qualified; its checklist can no longer change', v_lead.lead_code;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    IF v_lead.stage IN ('Admitted', 'Lost - closed') THEN
        RAISE EXCEPTION 'Lead % is %', v_lead.lead_code, v_lead.stage;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_lead_qualification_reviews_guard
    BEFORE INSERT OR UPDATE OR DELETE ON lead_qualification_reviews
    FOR EACH ROW EXECUTE FUNCTION guard_qualification_review();

CREATE OR REPLACE FUNCTION check_lead_qualification() RETURNS trigger AS $$
DECLARE
    v_missing TEXT;
BEGIN
    IF NEW.qualified_at IS NULL THEN
        IF OLD.qualified_at IS NOT NULL THEN
            RAISE EXCEPTION 'Lead % is qualified; qualification can''t be withdrawn', OLD.lead_code;
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.qualified_at IS NOT NULL THEN
        IF NEW.qualified_at IS DISTINCT FROM OLD.qualified_at OR NEW.qualified_by IS DISTINCT FROM OLD.qualified_by THEN
            RAISE EXCEPTION 'Lead % is already qualified', OLD.lead_code;
        END IF;
        RETURN NEW;
    END IF;
    -- Conversion of a course added by Convert copies the source lead's qualification; that path sets the flag
    IF current_setting('app.converting_leads', TRUE) IS DISTINCT FROM 'on' THEN
        SELECT string_agg(c::TEXT, '; ' ORDER BY c) INTO v_missing
        FROM unnest(enum_range(NULL::qualification_check)) c
        WHERE NOT EXISTS (SELECT 1 FROM lead_qualification_reviews r WHERE r.lead_id = NEW.lead_id AND r.check_code = c);
        IF v_missing IS NOT NULL THEN
            RAISE EXCEPTION 'Complete every qualification check first — still open: %', v_missing;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_leads_qualification
    BEFORE UPDATE OF qualified_at, qualified_by ON leads
    FOR EACH ROW EXECUTE FUNCTION check_lead_qualification();

-- ---------------------------------------------------------------------------
-- Stage guard: entering the pipeline needs a conversion; reactivating to New Enquiry clears it
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_lead_stage() RETURNS trigger AS $$
BEGIN
    IF OLD.stage = 'Admitted' THEN
        RAISE EXCEPTION 'Lead % is Admitted; its stage can no longer change', OLD.lead_code;
    ELSIF OLD.stage = 'Payment Pending Verification' AND NEW.stage NOT IN ('Admitted', 'Lost - closed')
          AND current_setting('app.pipeline_sync', TRUE) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'Lead % is in Payment Pending Verification and cannot move back to %', OLD.lead_code, NEW.stage;
    ELSIF NEW.stage = 'New Enquiry' AND OLD.stage <> 'Lost - closed' THEN
        RAISE EXCEPTION 'Lead % is in the pipeline and cannot move back to New Enquiry', OLD.lead_code;
    ELSIF NEW.stage NOT IN ('New Enquiry', 'Lost - closed') AND NEW.converted_at IS NULL THEN
        RAISE EXCEPTION 'Lead % must be qualified and converted to a deal before it can move to %', OLD.lead_code, NEW.stage;
    END IF;
    IF NEW.stage = 'New Enquiry' THEN
        NEW.converted_at = NULL;       -- reactivated as a lead: it has to be converted again
        NEW.converted_by = NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Joining the pipeline: only a converted lead that leaves New Enquiry joins (or opens) the person's card
CREATE OR REPLACE FUNCTION attach_lead_to_pipeline() RETURNS trigger AS $$
DECLARE
    v_entry pipeline_entries%ROWTYPE;
BEGIN
    IF NEW.stage IN ('New Enquiry', 'Admitted', 'Lost - closed') THEN
        RETURN NEW;
    END IF;
    IF NEW.converted_at IS NULL THEN
        RAISE EXCEPTION 'A lead enters the pipeline only through Convert to deal';
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
    ELSE
        INSERT INTO pipeline_entries (person_id, branch_id, stage, assigned_to, next_follow_up_at, ai_priority,
                                      ai_score, created_by)
        VALUES (NEW.person_id, NEW.branch_id, NEW.stage, NEW.assigned_to, NEW.next_follow_up_at, NEW.ai_priority,
                NEW.ai_score, NULLIF(current_setting('app.current_user_id', TRUE), '')::INT)
        RETURNING pipeline_entry_id INTO NEW.pipeline_entry_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- After insert / stage change: move or close the card (other New Enquiry leads are no longer pulled in)
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
