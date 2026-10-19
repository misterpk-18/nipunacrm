-- 047: enquiries from the nipunatechnologies.com form. The website's server posts each submission to
-- POST /api/v1/integrations/website/enquiries (service key); it lands in Enquiries, never straight in Leads.
--
--   enquiries.external_ref        the website's submission_id. Unique per entry method, so a retried submission
--                                 returns the first enquiry instead of a second one.
--   enquiries.attribution         UTM values, page URL and referrer sent by the website (a JSON object).
--                                 The source stays Website whatever the UTM says.
--   enquiries.whatsapp_consent    the form's WhatsApp checkbox (NULL = the form didn't ask). Copied to the person
--                                 as Explicit Consent, source 'Web form', when staff convert or link the enquiry.
--
--   settings                      website_repeat_window_hours: an unconverted enquiry with the same phone / email
--                                 inside this window puts the new one in Duplicate Review (never merged).
--                                 website_max_per_phone_per_hour / website_max_per_minute: request limits.
--   notification rule             WEBSITE_ENQUIRY_RECEIVED: the branch's Branch Managers (Founder / Super Admin
--                                 always get every notification).
--
-- Depends on: 046_password_reset_codes.sql

ALTER TABLE enquiries
    ADD COLUMN external_ref VARCHAR(100),
    ADD COLUMN attribution JSONB,
    ADD COLUMN whatsapp_consent BOOLEAN,
    ADD CONSTRAINT enquiries_attribution_is_object CHECK (attribution IS NULL OR jsonb_typeof(attribution) = 'object');

CREATE UNIQUE INDEX enquiries_external_ref_key ON enquiries (entry_method_id, external_ref)
    WHERE external_ref IS NOT NULL;

-- Repeat-submission check: unconverted enquiries by phone / email
CREATE INDEX enquiries_unlinked_phone_idx ON enquiries (raw_phone, received_at DESC) WHERE lead_id IS NULL;
CREATE INDEX enquiries_unlinked_email_idx ON enquiries (lower(raw_email), received_at DESC) WHERE lead_id IS NULL;

INSERT INTO app_settings (setting_key, setting_value, description)
SELECT v.k, v.val::JSONB, v.d
FROM (VALUES
    ('website_repeat_window_hours', '24',
     'Hours in which a website enquiry with the same phone or email as an unconverted enquiry goes to Duplicate Review'),
    ('website_max_per_phone_per_hour', '5', 'Website enquiries accepted from one phone number in an hour'),
    ('website_max_per_minute', '30', 'Website enquiries accepted in a minute, all numbers together')
) AS v(k, val, d)
WHERE NOT EXISTS (SELECT 1 FROM app_settings s WHERE s.setting_key = v.k);

INSERT INTO notification_rules (rule_code, event_type, description, recipient_role_id, category)
SELECT 'WEBSITE_ENQUIRY_RECEIVED', 'enquiry.website_received',
       'A new enquiry came in from the website form: review it and convert or link it', r.role_id, 'Action Required'
FROM roles r
WHERE r.role_code = 'BRANCH_MANAGER';
