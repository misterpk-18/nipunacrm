-- 043 — Remove curriculum versions and curriculum mapping; merge the Academic Coordinator role into Branch Manager.
--
-- The CRM no longer tracks a curriculum. A course carries none, an admission is not "mapped" to a version, and a batch
-- follows no version. Allocation now checks only: the enrolment isn't Paused / Completed / Cancelled, the batch isn't
-- Completed / Cancelled, same course (or a component of the combo), same service branch, and a seat is left.
-- Fee, offer, target and certificate versions are untouched.
--
--   dropped tables     admission_curricula, curriculum_versions (this takes migration 030's mapping and sync columns)
--   dropped columns    batches.curriculum_version_id, admissions.curriculum_status
--   dropped types      curriculum_status, curriculum_version_status, curriculum_lms_status, curriculum_lms_sync
--   dropped functions  check_curriculum_mapped, check_admission_curriculum (and their triggers)
--   rewritten          before_allocation_insert (no curriculum checks), check_demo_rules and guard_course_path
--                      (Branch Manager instead of Academic Coordinator)
--   lms_outbox         AdmissionCurriculumMapped is no longer a valid event; the 7 already written are deleted, with
--                      their lms_sync_versions keys
--   roles              the Academic Coordinator role is removed: its users are deactivated, its scopes deleted, its open
--                      tasks go to the Branch Manager team. Open "LMS refused curriculum mapping" tasks are cancelled.
--   lms_pull_state     last_reconcile_at stays: the daily drift check still runs for the other fields
--
-- Depends on: 042_staff_whatsapp_alerts.sql

-- ---------------------------------------------------------------------------
-- 1. Tasks: the curriculum refusals are moot; the rest of the coordinator queue goes to the Branch Manager team
-- ---------------------------------------------------------------------------
UPDATE tasks
SET status = 'Cancelled', cancel_reason = 'Curriculum mapping was removed from the CRM'
WHERE title LIKE 'LMS refused curriculum mapping:%' AND status IN ('Open', 'In Progress', 'Waiting/Blocked');

UPDATE tasks
SET team_role_id = (SELECT role_id FROM roles WHERE role_code = 'BRANCH_MANAGER')
WHERE team_role_id = (SELECT role_id FROM roles WHERE role_code = 'ACADEMIC_COORDINATOR');

-- ---------------------------------------------------------------------------
-- 2. Allocation: course, branch, seat and enrolment status only
-- ---------------------------------------------------------------------------
DROP TRIGGER trg_admissions_curriculum_mapped ON admissions;
DROP TRIGGER trg_admission_curricula_check ON admission_curricula;
DROP FUNCTION check_curriculum_mapped();
DROP FUNCTION check_admission_curriculum();

CREATE OR REPLACE FUNCTION before_allocation_insert() RETURNS trigger AS $$
DECLARE
    v_batch batches%ROWTYPE;
    v_admission admissions%ROWTYPE;
    v_taken INT;
BEGIN
    IF lms_sync_session() THEN
        NEW.course_id = COALESCE(NEW.course_id, (SELECT course_id FROM batches WHERE batch_id = NEW.batch_id));
        RETURN NEW;
    END IF;

    SELECT * INTO v_batch FROM batches WHERE batch_id = NEW.batch_id FOR UPDATE;
    SELECT * INTO v_admission FROM admissions WHERE admission_id = NEW.admission_id;
    NEW.course_id = v_batch.course_id;

    IF v_admission.enrolment_status IN ('Cancelled', 'Paused', 'Completed') THEN
        RAISE EXCEPTION 'Enrolment of % is %; allocation blocked', v_admission.admission_code, v_admission.enrolment_status;
    END IF;
    IF v_batch.status IN ('Completed', 'Cancelled') THEN
        RAISE EXCEPTION 'Batch % is %', v_batch.batch_code, v_batch.status;
    END IF;
    IF v_batch.branch_id <> v_admission.service_branch_id THEN
        RAISE EXCEPTION 'Wrong branch: batch % is not at the student''s service branch. Cross-branch allocation is never automatic',
            v_batch.batch_code;
    END IF;
    IF v_batch.course_id <> v_admission.course_id AND NOT EXISTS (
        SELECT 1 FROM combo_courses WHERE combo_course_id = v_admission.course_id AND component_course_id = v_batch.course_id
    ) THEN
        RAISE EXCEPTION 'Batch % is for a course that is not part of admission %', v_batch.batch_code, v_admission.admission_code;
    END IF;
    IF NEW.status = 'Active' THEN
        SELECT COUNT(*) INTO v_taken FROM batch_allocations WHERE batch_id = NEW.batch_id AND status = 'Active';
        IF v_taken >= v_batch.capacity THEN
            RAISE EXCEPTION 'Full capacity: batch % has % of % seats taken', v_batch.batch_code, v_taken, v_batch.capacity;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 3. The LMS outbox no longer carries curriculum mappings
-- ---------------------------------------------------------------------------
DELETE FROM lms_sync_versions WHERE version_key LIKE 'curriculum:%';
ALTER TABLE admission_curricula DROP COLUMN lms_outbox_id;   -- frees the outbox rows below
DELETE FROM lms_outbox WHERE event_type = 'AdmissionCurriculumMapped';
ALTER TABLE lms_outbox DROP CONSTRAINT lms_outbox_event_type_valid;
ALTER TABLE lms_outbox ADD CONSTRAINT lms_outbox_event_type_valid CHECK (event_type IN (
    'CourseUpserted', 'AdmissionQualified', 'AdmissionUpdated', 'AdmissionCancelled', 'FinanceSummaryUpdated',
    'BranchUpserted', 'BranchFinanceSnapshot'));

-- ---------------------------------------------------------------------------
-- 4. Drop the curriculum tables, columns and types
-- ---------------------------------------------------------------------------
ALTER TABLE batches DROP COLUMN curriculum_version_id;
ALTER TABLE admissions DROP COLUMN curriculum_status;
DROP TABLE admission_curricula;
DROP TABLE curriculum_versions;
DROP TYPE curriculum_status;
DROP TYPE curriculum_version_status;
DROP TYPE curriculum_lms_status;
DROP TYPE curriculum_lms_sync;

UPDATE app_settings
SET description = 'Batches, allocations, joining dates, completion and certificates are managed in the Nipuna LMS and mirrored into the CRM (read-only here)'
WHERE setting_key = 'academics_managed_in_lms';

-- ---------------------------------------------------------------------------
-- 5. Approvals: Branch Manager replaces Academic Coordinator
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_demo_rules() RETURNS trigger AS $$
DECLARE
    v_max INT := COALESCE((SELECT (setting_value #>> '{}')::INT FROM app_settings WHERE setting_key = 'demo_max_attended'), 2);
    v_attended INT;
BEGIN
    IF NEW.status IN ('Scheduled', 'Confirmed') AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
        SELECT COUNT(*) INTO v_attended FROM demos
        WHERE lead_id = NEW.lead_id AND status = 'Attended' AND demo_id IS DISTINCT FROM NEW.demo_id;
        IF v_attended >= v_max AND (NEW.extra_demo_approved_by IS NULL OR NOT user_has_role(
                NEW.extra_demo_approved_by, ARRAY['BRANCH_MANAGER'], NEW.branch_id)) THEN
            RAISE EXCEPTION 'Lead already attended % demos; another needs Branch Manager approval', v_attended;
        END IF;
    END IF;

    IF NEW.status IN ('Attended', 'No Show') AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
        NEW.commercial_follow_up_due_at = COALESCE(NEW.commercial_follow_up_due_at,
            add_staffed_minutes(NEW.branch_id, CURRENT_TIMESTAMP,
                COALESCE((SELECT (setting_value #>> '{}')::INT FROM app_settings
                          WHERE setting_key = 'commercial_follow_up_staffed_minutes'), 120)));
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_course_path() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status = 'Approved'
       AND (NEW.from_course_id, NEW.to_course_id, NEW.learner_benefit, NEW.helps_when, NEW.skip_when, NEW.prerequisites,
            NEW.suggested_question)
           IS DISTINCT FROM (OLD.from_course_id, OLD.to_course_id, OLD.learner_benefit, OLD.helps_when, OLD.skip_when,
                             OLD.prerequisites, OLD.suggested_question) THEN
        NEW.status := 'Draft';
        NEW.approved_by := NULL;
        NEW.approved_at := NULL;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'Retired' AND NEW.status <> 'Retired' THEN
        RAISE EXCEPTION 'A retired course path can''t be brought back; create it again';
    END IF;
    IF NEW.status = 'Approved' AND (TG_OP = 'INSERT' OR OLD.status <> 'Approved') THEN
        NEW.approved_by := COALESCE(NEW.approved_by, NULLIF(current_setting('app.current_user_id', TRUE), '')::INT);
        NEW.approved_at := COALESCE(NEW.approved_at, CURRENT_TIMESTAMP);
        IF NOT user_has_role(NEW.approved_by, ARRAY['FOUNDER_CEO', 'SUPER_ADMIN', 'BRANCH_MANAGER']) THEN
            RAISE EXCEPTION 'Only a Branch Manager, Founder / CEO or Super Admin can approve a course path';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

UPDATE app_settings SET description = replace(description, 'the Academic Coordinator', 'the Branch Manager')
WHERE setting_key IN ('batch_delay_coordinator_days', 'batch_delay_future_plan_hours');

-- ---------------------------------------------------------------------------
-- 6. The Academic Coordinator role goes
-- ---------------------------------------------------------------------------
-- Users whose only role was Academic Coordinator can no longer do anything: deactivate them and end their sessions.
UPDATE users SET is_active = FALSE
WHERE user_id IN (SELECT user_id FROM user_role_scopes
                  WHERE role_id = (SELECT role_id FROM roles WHERE role_code = 'ACADEMIC_COORDINATOR'))
  AND NOT EXISTS (SELECT 1 FROM user_role_scopes s
                  WHERE s.user_id = users.user_id AND s.revoked_at IS NULL
                    AND s.role_id <> (SELECT role_id FROM roles WHERE role_code = 'ACADEMIC_COORDINATOR'));

UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP, revoke_reason = 'Academic Coordinator role removed'
WHERE revoked_at IS NULL
  AND user_id IN (SELECT user_id FROM users WHERE NOT is_active);

DELETE FROM user_role_scopes WHERE role_id = (SELECT role_id FROM roles WHERE role_code = 'ACADEMIC_COORDINATOR');
DELETE FROM roles WHERE role_code = 'ACADEMIC_COORDINATOR';
