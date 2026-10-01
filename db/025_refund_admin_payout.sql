-- 025 — Founder / CEO and Super Admin may pay out a refund they decided themselves.
--
-- Only Founder / CEO or Super Admin can decide a refund (check_refund_decision), so "payout_executed_by <> decided_by"
-- only ever blocked those two roles. It is dropped, as the fee-change self-approval check was in 023. Accounts still
-- pays out as before; payout stays within the approved amount and needs reconciliation before Completed.
--
-- Depends on: 024_admin_accounts_access.sql

ALTER TABLE refund_cases DROP CONSTRAINT refund_separation_of_duties;
