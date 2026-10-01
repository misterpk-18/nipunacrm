-- LMS round 2, decisions D3 and D4: two more outbox events for the Nipuna LMS.
--
--   BranchUpserted         a branch's name, city, receipt prefix (the LMS short code), shared email and active flag;
--                          written when a branch is edited and by the backfill. Record and version key 'branch:<id>'.
--   BranchFinanceSnapshot  one branch's dashboard finance figures (target, verified collections, paid admissions,
--                          overdue dues by age band, pending verifications, follow-ups), written every 15 minutes by the
--                          job lms-finance-snapshot. Record and version key 'branch-finance:<id>'.
--
-- A snapshot that is still Pending when the next one is written is worth nothing to the LMS (each one replaces the
-- previous), so it becomes Superseded and is never sent. Contract: LMS repo docs/CRM_INTEGRATION.md §2.1, §3.12–3.13.
-- Depends on: 028_lms_status_pull.sql

ALTER TYPE lms_outbox_status ADD VALUE IF NOT EXISTS 'Superseded';

ALTER TABLE lms_outbox DROP CONSTRAINT lms_outbox_event_type_valid;
ALTER TABLE lms_outbox ADD CONSTRAINT lms_outbox_event_type_valid CHECK (event_type IN (
    'CourseUpserted', 'AdmissionQualified', 'AdmissionUpdated', 'AdmissionCancelled', 'FinanceSummaryUpdated',
    'BranchUpserted', 'BranchFinanceSnapshot'));
