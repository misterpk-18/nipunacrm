-- Sales playbook × LMS: what the CRM needs to offer a batch honestly (LMS reply CRM_PLAYBOOK_LMS_REPLY.md, A2 / Q3).
-- The timetable (schedule_days, start_time, end_time, location) already has columns; the pull now fills them.
--
--   lms_seats_left        the LMS's own count (capacity minus students holding an active allocation; a combo student
--                         counts once per batch, which the CRM's allocation-row count can't do). Preferred when present.
--   lms_readiness         the LMS's readiness (e.g. Ready, Pending Verification, Blocked). Blocked = not public: sales
--                         never offers it. LMS-owned values, so free text rather than an enum.
--   lms_readiness_reason  why it is blocked, for staff only.
--
-- Depends on: 031_sales_playbook.sql

ALTER TABLE batches
    ADD COLUMN lms_seats_left SMALLINT,
    ADD COLUMN lms_readiness VARCHAR(30),
    ADD COLUMN lms_readiness_reason TEXT,
    ADD CONSTRAINT batches_lms_seats_left_valid CHECK (lms_seats_left IS NULL OR lms_seats_left >= 0),
    ADD CONSTRAINT batches_lms_offer_fields_mirrored
        CHECK (lms_mirrored OR (lms_seats_left IS NULL AND lms_readiness IS NULL AND lms_readiness_reason IS NULL));

-- A batch sales may name to a learner: Planned / Open, not Blocked in the LMS, with a seat left
CREATE VIEW offerable_batches AS
SELECT b.batch_id, b.batch_code, b.lms_course_id, b.course_id, b.branch_id, b.delivery_mode, b.status,
       b.start_date, b.schedule_days, b.start_time, b.end_time, b.location, b.capacity,
       COALESCE(b.lms_seats_left, o.seats_left) AS seats_left,
       b.lms_readiness, b.lms_readiness_reason,
       b.status IN ('Planned', 'Open') AND b.lms_readiness IS DISTINCT FROM 'Blocked'
           AND COALESCE(b.lms_seats_left, o.seats_left) > 0 AS is_offerable,
       CASE
           WHEN b.status NOT IN ('Planned', 'Open') THEN 'Batch is ' || b.status
           WHEN b.lms_readiness = 'Blocked' THEN 'Not public yet: ' || COALESCE(b.lms_readiness_reason, 'blocked in the LMS')
           WHEN COALESCE(b.lms_seats_left, o.seats_left) <= 0 THEN 'Full'
       END AS not_offerable_reason,
       b.start_time IS NOT NULL AND b.schedule_days IS NOT NULL AS timing_confirmed
FROM batches b
JOIN batch_occupancy o ON o.batch_id = b.batch_id;
