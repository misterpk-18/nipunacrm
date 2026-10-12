-- Payment claim outcomes reach the owner counsellor: a bell notification when Accounts verifies a claim, and one
-- (with the reason) when it fails, plus an optional WhatsApp message to the staff member's phone (users.phone).
-- The notification goes to the lead's owner (explicit recipient); the rule's role is the fallback.
-- The WhatsApp staff alert uses template nipuna_staff_payment_status_v1 (needs Pinbot approval) and stays OFF until
-- the app setting is switched on; even then it only reaches numbers on WHATSAPP_TEST_NUMBERS while that is set.
--
-- Depends on: 037_delivery_plan_ux.sql

INSERT INTO notification_rules (rule_code, event_type, description, recipient_role_id, category)
SELECT v.code, v.event_type, v.description, r.role_id, 'Information'::notification_category
FROM roles r
CROSS JOIN (VALUES
    ('PAYMENT_VERIFIED', 'payment.verified', 'Accounts verified a payment claim: the receipt is issued'),
    ('PAYMENT_FAILED', 'payment.failed', 'Accounts marked a payment claim failed: follow up with the learner')
) AS v(code, event_type, description)
WHERE r.role_code = 'SALES';

INSERT INTO app_settings (setting_key, setting_value, description) VALUES
    ('whatsapp_staff_alerts_enabled', 'false',
     'Send the owner counsellor a WhatsApp message when a payment claim is verified or fails (template nipuna_staff_payment_status_v1)');
