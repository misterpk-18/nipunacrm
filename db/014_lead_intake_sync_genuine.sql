-- Marking a lead Invalid-Spam / Test now takes its enquiries out of "Genuine Enquiries".
--   The genuine count reads enquiries (is_genuine, else intake_status), but staff classify the lead, so an
--   edit to leads.intake_status never reached the count. This trigger carries the decision to every
--   enquiry linked to the lead:
--     * into Invalid-Spam / Test          → enquiries.is_genuine = FALSE
--     * out of Invalid-Spam / Test        → enquiries.is_genuine = TRUE (staff re-classified it as genuine)
--     * between other statuses            → enquiries untouched
-- Depends on: 013_demo_course_optional.sql

CREATE OR REPLACE FUNCTION sync_lead_intake_to_enquiries() RETURNS TRIGGER AS $$
DECLARE
    v_was_excluded BOOLEAN := OLD.intake_status IN ('Invalid-Spam', 'Test');
    v_is_excluded  BOOLEAN := NEW.intake_status IN ('Invalid-Spam', 'Test');
BEGIN
    IF v_was_excluded IS DISTINCT FROM v_is_excluded THEN
        UPDATE enquiries SET is_genuine = NOT v_is_excluded
        WHERE lead_id = NEW.lead_id AND is_genuine IS DISTINCT FROM NOT v_is_excluded;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_leads_sync_enquiry_genuine AFTER UPDATE OF intake_status ON leads
    FOR EACH ROW WHEN (OLD.intake_status IS DISTINCT FROM NEW.intake_status)
    EXECUTE FUNCTION sync_lead_intake_to_enquiries();

-- Leads already marked Invalid-Spam / Test before this migration: exclude their unclassified enquiries
UPDATE enquiries e SET is_genuine = FALSE
FROM leads l
WHERE e.lead_id = l.lead_id AND l.intake_status IN ('Invalid-Spam', 'Test') AND e.is_genuine IS NULL;
