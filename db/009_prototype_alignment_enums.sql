-- Prototype alignment, part 1: enum changes
-- Kept separate because a new enum value can't be used in the transaction that adds it.
-- Depends on: 008_phase6_management.sql

-- Intake status values from the prototype's lead list (replaces the guessed values)
ALTER TABLE leads ALTER COLUMN intake_status DROP DEFAULT;
ALTER TABLE leads ALTER COLUMN intake_status TYPE TEXT;
DROP TYPE lead_intake_status;
CREATE TYPE lead_intake_status AS ENUM ('New', 'Incomplete', 'Duplicate Review', 'Outreach Prospect');
ALTER TABLE leads ALTER COLUMN intake_status TYPE lead_intake_status USING intake_status::lead_intake_status;
ALTER TABLE leads ALTER COLUMN intake_status SET DEFAULT 'New';

-- "Waiting for Batch / Future Joining" is an AI priority in the prototype
ALTER TYPE lead_priority ADD VALUE 'Waiting for Batch / Future Joining';

-- "Fee Shared" is a fee discussion milestone
ALTER TYPE fee_discussion_milestone ADD VALUE 'Fee Shared' AFTER 'Approved';

-- Special closing actions are Approve / Counteroffer / Reject
ALTER TYPE scr_status ADD VALUE 'Counteroffered' AFTER 'Approved';
