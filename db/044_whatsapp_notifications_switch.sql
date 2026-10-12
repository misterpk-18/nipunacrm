-- 044: one WhatsApp notifications switch per person (Person 360 header).
--
--   persons.whatsapp_notifications   TRUE (the default, as before) = the CRM may message this person on WhatsApp.
--                                    FALSE = nothing is sent to them automatically or by hand: every message to the
--                                    person is saved as Skipped ("switched off") and never reaches the provider.
--                                    Staff alerts about the learner go to staff phones and are not affected.
--                                    Turning it on also records Explicit Consent when none is recorded (done by the
--                                    API, source "Profile switch"), so marketing templates can follow.
--
-- Depends on: 043_remove_curriculum.sql

ALTER TABLE persons
    ADD COLUMN whatsapp_notifications BOOLEAN NOT NULL DEFAULT TRUE;
