-- 039 — Admitted but not yet in a batch: delay alerts and a working-days counter.
--
-- Batches and allocation are done in the Nipuna LMS. The CRM's "Waiting for batch" list and the `batch-delay-alerts`
-- job watch admitted students who are still *Awaiting Batch Allocation* and escalate, in working time:
--   coordinator task + owner counsellor notified   Confirmed Seat: batch_delay_coordinator_days working days after the
--                                                  admission (to the branch's closing time); Future Plan:
--                                                  batch_delay_future_plan_hours before the planned start
--   Branch Manager task + notification             batch_delay_manager_days working days
--   Founder / CEO and Super Admin notification     batch_delay_founder_days working days
-- (for a Future Plan the days are counted from its 48-hour mark). Everything stops as soon as the LMS reports an
-- allocation (the pull closes the alerts) or the admission is paused / cancelled.
--
--   working_days_between(branch, from, to)   staffed days in (from, to]: days with a branch shift that aren't holidays.
--                                            The counterpart of add_working_days.
--
-- Depends on: 034_whatsapp_phase2_4.sql

CREATE OR REPLACE FUNCTION working_days_between(p_branch_id INT, p_from DATE, p_to DATE) RETURNS INT AS $$
    SELECT COUNT(*)::INT
    FROM (SELECT g::DATE AS day FROM generate_series(p_from + 1, p_to, INTERVAL '1 day') AS g) AS d
    WHERE EXISTS (SELECT 1 FROM branch_shifts s
                  WHERE s.branch_id = p_branch_id AND s.day_of_week = EXTRACT(ISODOW FROM d.day))
      AND NOT EXISTS (SELECT 1 FROM holidays h
                      WHERE h.holiday_date = d.day AND (h.branch_id IS NULL OR h.branch_id = p_branch_id));
$$ LANGUAGE sql STABLE;

INSERT INTO app_settings (setting_key, setting_value, description) VALUES
    ('batch_delay_coordinator_days', '1', 'Confirmed Seat: working days after admission before the Academic Coordinator is tasked (and the owner told) that no batch is allocated'),
    ('batch_delay_future_plan_hours', '48', 'Future Plan: hours before the planned start when the Academic Coordinator is tasked (and the owner told) that no batch is allocated'),
    ('batch_delay_manager_days', '2', 'Working days without a batch before the Branch Manager is tasked and notified'),
    ('batch_delay_founder_days', '5', 'Working days without a batch before the Founder / CEO and Super Admin are notified');

INSERT INTO notification_rules (rule_code, event_type, description, recipient_role_id, category)
SELECT v.code, 'admission.batch_delay', v.descr, r.role_id, v.category::notification_category
FROM (VALUES
    ('BATCH_DELAY_OWNER', 'An admitted learner has no batch yet: the owner counsellor can reassure them', 'SALES', 'Information'),
    ('BATCH_DELAY_MANAGER', 'An admitted learner is still waiting for a batch: Branch Manager escalation', 'BRANCH_MANAGER', 'Action Required'),
    ('BATCH_DELAY_FOUNDER', 'An admitted learner is still waiting for a batch after a long delay', 'FOUNDER_CEO', 'Escalation')
) AS v(code, descr, role_code, category)
JOIN roles r ON r.role_code = v.role_code;
