-- 035: qualification checks the system can know are ticked by "System" (UX build, section 2).
-- A check is ticked automatically when the event that proves it is saved (a reached-contact outcome, a course on the
-- lead, a dated next action). Those rows carry reviewed_by NULL = System, like other system actions in this schema;
-- staff can still tick or untick any check until the lead is qualified.
-- Depends on: 019_qualify_convert.sql

ALTER TABLE lead_qualification_reviews ALTER COLUMN reviewed_by DROP NOT NULL;
COMMENT ON COLUMN lead_qualification_reviews.reviewed_by IS 'NULL = ticked automatically by the system';
