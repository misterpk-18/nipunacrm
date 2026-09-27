-- Demos no longer need a course: a lead that hasn't decided on a course can still attend a demo.
--   demos.course_id becomes nullable (NULL = no course chosen when booking). The outcome's
--   recommended_course_id still records the course suggested after the demo.
-- Depends on: 012_prototype_v1_1.sql

ALTER TABLE demos ALTER COLUMN course_id DROP NOT NULL;
