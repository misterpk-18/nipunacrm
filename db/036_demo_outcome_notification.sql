-- Demo outcome recorded by the trainer: the owner counsellor is told, and the next step is the fee discussion.
-- The notification goes to the lead's owner (explicit recipient); the rule's role is the fallback.
--
-- Depends on: 031_sales_playbook.sql

INSERT INTO notification_rules (rule_code, event_type, description, recipient_role_id, category)
SELECT 'DEMO_OUTCOME_RECORDED', 'demo.outcome_recorded',
       'The trainer recorded a demo outcome: start the fee discussion', r.role_id, 'Action Required'
FROM roles r
WHERE r.role_code = 'SALES';
