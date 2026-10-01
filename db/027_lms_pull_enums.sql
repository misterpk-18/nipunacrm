-- LMS status pull (round 2), part 1: enum values used by 028.
-- A certificate reissued in the LMS keeps its number; the earlier version becomes Superseded (LMS CRM_INTEGRATION §3.6,
-- owner decision D2: the LMS register's number series). Own file because 028 uses the value in an index.
-- Depends on: 026_lms_outbox.sql

ALTER TYPE certificate_status ADD VALUE IF NOT EXISTS 'Superseded' AFTER 'Issued';
