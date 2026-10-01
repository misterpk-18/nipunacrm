-- 023 — Founder / CEO and Super Admin may approve their own fee change requests.
--
-- Fee changes can only be approved by a Founder / CEO or Super Admin (enforced in before_fee_change_write), so the
-- "approver <> requester" check only ever blocked those two roles. It is dropped. Counsellors and Branch Managers can
-- still only request; they cannot approve. Accounts still applies the change.
--
-- Depends on: 022_transaction_receipts.sql

ALTER TABLE admission_fee_changes DROP CONSTRAINT fee_changes_no_self_approval;
