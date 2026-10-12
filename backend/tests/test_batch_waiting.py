"""Waiting for batch (db 039): the list, its exclusions and scoping, working days waiting, the escalating delay alerts
(idempotent, closed by the LMS pull) and the preferred batch in the LMS payload."""
from datetime import date, timedelta

import pytest
from sqlalchemy import select, text

from config.database import db
from models import Admission, BatchAllocation, Notification, Task
from repositories import users as users_repo
from services import batch_waiting, jobs, lms_pull, lms_sync
from tests.helpers import admitted, call
from tests.test_lms_pull import academics_entry, allocation, batch_entry, fake_pull, lms_owned  # noqa: F401


def waiting(client, headers, **params):
    return client.get("/api/v1/batch-waiting", headers=headers, query_string=params).get_json()["data"]


def age(run_sql, admission_id, days):
    """Admitted `days` calendar days ago (the admission date is frozen by a trigger, so disable it for the update)."""
    run_sql("ALTER TABLE admissions DISABLE TRIGGER USER")
    run_sql("UPDATE admissions SET admission_date = current_date - :d, created_at = now() - make_interval(days => :d) "
            "WHERE admission_id = :a", d=days, a=admission_id)
    run_sql("ALTER TABLE admissions ENABLE TRIGGER USER")
    db.session.expire_all()


def set_status(run_sql, admission_id, status):
    run_sql("ALTER TABLE admissions DISABLE TRIGGER USER")
    extra = {"Cancelled": ", cancelled_at = now(), cancellation_reason = 'Left', cancelled_by = created_by",
             "Completed": ", academic_completed_at = now(), completion_authorised_by_email = 'ac@lms.test'"}.get(status, "")
    run_sql(f"UPDATE admissions SET enrolment_status = :s{extra} WHERE admission_id = :a", s=status, a=admission_id)
    run_sql("ALTER TABLE admissions ENABLE TRIGGER USER")
    db.session.expire_all()


def set_preferred(admission, code, label=None):
    """Preferred batch on the deal's delivery plan (the plan is frozen once admitted, so write past its guard)."""
    db.session.execute(text("ALTER TABLE delivery_plans DISABLE TRIGGER trg_delivery_plans_guard"))
    db.session.execute(text("UPDATE delivery_plans SET preferred_lms_batch_code = :c, preferred_lms_batch_label = :l "
                            "WHERE lead_id = :i"), {"c": code, "l": label, "i": admission.lead_id})
    db.session.execute(text("ALTER TABLE delivery_plans ENABLE TRIGGER trg_delivery_plans_guard"))
    db.session.expire_all()


def open_tasks(aid):
    return db.session.execute(select(Task).where(Task.admission_id == aid, Task.dedupe_key.like("batch-wait:%"))
                              .order_by(Task.dedupe_key)).scalars().all()


def alerts(aid):
    return db.session.execute(select(Notification).where(Notification.entity_type == "batch_wait",
                                                         Notification.entity_id == str(aid))
                              .order_by(Notification.notification_id)).scalars().all()


# ---------------------------------------------------------------- the list

def test_list_row_scoping_and_roles(client, people, course):
    flow = admitted(client, people, course)
    aid = flow["admission"]["admission_id"]
    rows = waiting(client, people["bm"]["h"])
    assert [r["admission_id"] for r in rows] == [aid]
    row = rows[0]
    assert row["admission_code"] == flow["admission"]["admission_code"] and row["course"]["course_title"] == "Data Science"
    assert row["seat_type"] == "Confirmed Seat" and row["days_waiting"] == 0 and row["delay"] is None
    assert "mapping_status" not in row and row["preferred_batch"] is None
    assert row["lms_url"].startswith("http://lms-web.test/academic/batches?crm_admission_id=")

    for who in ("bm", "sravani", "nikhil", "admin", "founder"):
        assert [r["admission_id"] for r in waiting(client, people[who]["h"])] == [aid], who
    for who in ("mounika", "bm_vij"):  # the other branch sees nothing
        assert waiting(client, people[who]["h"]) == [], who
    for who in ("trainer", "accounts", "placement"):
        call(client, "get", "/batch-waiting", people[who]["h"], 403)
    assert waiting(client, people["admin"]["h"], seat_type="Future Plan") == []
    assert len(waiting(client, people["admin"]["h"], q=flow["admission"]["person"]["full_name"][:4])) == 1


@pytest.mark.parametrize("status", ["Paused", "Cancelled", "Completed", "Scheduled", "In Progress"])
def test_not_waiting_when_not_awaiting(client, people, course, run_sql, status):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    set_status(run_sql, aid, status)
    assert waiting(client, people["admin"]["h"]) == []


def test_active_allocation_excludes_even_if_status_lags(client, people, course, run_sql, fake_pull, lms_owned):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    fake_pull({"batches": [batch_entry()], "academics": [academics_entry(aid, allocations=[allocation()])]})
    lms_pull.pull()
    assert db.session.execute(select(BatchAllocation).where(BatchAllocation.admission_id == aid)).scalars().all()
    set_status(run_sql, aid, "Awaiting Batch Allocation")
    assert waiting(client, people["admin"]["h"]) == []


def test_days_waiting_counts_working_days(client, people, course, run_sql):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    age(run_sql, aid, 14)
    row = waiting(client, people["admin"]["h"])[0]
    admission = db.session.get(Admission, aid)
    expected = db.session.execute(select(db.func.working_days_between(
        admission.service_branch_id, admission.admission_date, date.today()))).scalar_one()
    assert row["days_waiting"] == expected and 8 <= expected <= 12  # two weeks, minus Sundays and holidays
    assert row["delay"] == "founder"


def test_preferred_batch_shown_from_the_delivery_plan(client, people, course):
    flow = admitted(client, people, course)
    admission = db.session.get(Admission, flow["admission"]["admission_id"])
    set_preferred(admission, "NIT-GNT-BAT-2026-000101", "Morning batch")
    row = batch_waiting.row(admission, date.today())
    assert row["preferred_batch"] == {"code": "NIT-GNT-BAT-2026-000101", "label": "Morning batch"}


# ---------------------------------------------------------------- the alerts

def test_alerts_escalate_once_and_stay_quiet_on_rerun(client, people, course, run_sql, lms_owned):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    assert jobs.JOBS["batch-delay-alerts"]() == 0 and open_tasks(aid) == []  # on time: nothing yet

    # 1 working day on: the Branch Manager is tasked and the owner counsellor told
    age(run_sql, aid, 2)
    run_sql("UPDATE app_settings SET setting_value = '10' WHERE setting_key = 'batch_delay_manager_days'")
    run_sql("UPDATE app_settings SET setting_value = '20' WHERE setting_key = 'batch_delay_founder_days'")
    jobs.JOBS["batch-delay-alerts"]()
    assert [t.dedupe_key for t in open_tasks(aid)] == [f"batch-wait:coordinator:{aid}"]
    task = open_tasks(aid)[0]
    assert task.team_role_id is not None and task.owner_user_id is None and task.status == "Open"
    owner_notes = [n for n in alerts(aid) if n.recipient_user_id not in users_repo.admin_user_ids()]
    assert len(owner_notes) == 1 and owner_notes[0].recipient_user_id == people["sravani"]["id"]

    # 2 working days: the Branch Manager gets a task and a notification
    run_sql("UPDATE app_settings SET setting_value = '2' WHERE setting_key = 'batch_delay_manager_days'")
    age(run_sql, aid, 6)
    jobs.JOBS["batch-delay-alerts"]()
    assert [t.dedupe_key.split(":")[1] for t in open_tasks(aid)] == ["coordinator", "manager"]
    assert {n.recipient_user_id for n in alerts(aid)} == {people["sravani"]["id"], people["bm"]["id"], *users_repo.admin_user_ids()}

    # a long delay: Founder / CEO and Super Admin are notified
    run_sql("UPDATE app_settings SET setting_value = '5' WHERE setting_key = 'batch_delay_founder_days'")
    age(run_sql, aid, 14)
    jobs.JOBS["batch-delay-alerts"]()
    recipients = {n.recipient_user_id for n in alerts(aid)}
    assert {people["founder"]["id"], people["admin"]["id"], people["bm"]["id"], people["sravani"]["id"]} <= recipients

    # idempotent: running again changes nothing
    before = ([t.task_id for t in open_tasks(aid)], [n.notification_id for n in alerts(aid)])
    jobs.JOBS["batch-delay-alerts"]()
    assert ([t.task_id for t in open_tasks(aid)], [n.notification_id for n in alerts(aid)]) == before


def test_future_plan_alert_is_48_hours_before_start(client, people, course, run_sql, lms_owned):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    for days_ahead, expected in ((10, 0), (1, 1)):
        run_sql("ALTER TABLE admissions DISABLE TRIGGER USER")
        run_sql("UPDATE admissions SET seat_type = 'Future Plan', planned_start_date = :d WHERE admission_id = :a",
                d=date.today() + timedelta(days=days_ahead), a=aid)
        run_sql("ALTER TABLE admissions ENABLE TRIGGER USER")
        db.session.expire_all()
        jobs.JOBS["batch-delay-alerts"]()
        assert len(open_tasks(aid)) == expected, days_ahead


def test_alerts_close_when_the_lms_allocates(client, people, course, run_sql, fake_pull, lms_owned):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    age(run_sql, aid, 14)
    jobs.JOBS["batch-delay-alerts"]()
    assert len(open_tasks(aid)) == 2 and any(n.is_action_required for n in alerts(aid))

    fake_pull({"batches": [batch_entry()],
               "academics": [academics_entry(aid, enrolment_status="Scheduled", allocations=[allocation()])]})
    lms_pull.pull()
    db.session.expire_all()
    assert all(t.status == "Completed" for t in open_tasks(aid))
    assert all(n.action_completed_at is not None for n in alerts(aid) if n.is_action_required)
    assert waiting(client, people["admin"]["h"]) == []
    assert jobs.JOBS["batch-delay-alerts"]() == 0


def test_sweep_closes_alerts_of_a_paused_admission(client, people, course, run_sql, lms_owned):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    age(run_sql, aid, 14)
    jobs.JOBS["batch-delay-alerts"]()
    set_status(run_sql, aid, "Paused")
    jobs.JOBS["batch-delay-alerts"]()
    db.session.expire_all()
    assert open_tasks(aid) and all(t.status == "Completed" for t in open_tasks(aid))


def test_job_is_off_while_the_crm_runs_academics(client, people, course, run_sql):
    aid = admitted(client, people, course)["admission"]["admission_id"]
    age(run_sql, aid, 14)
    assert jobs.JOBS["batch-delay-alerts"]() == 0 and open_tasks(aid) == []


# ---------------------------------------------------------------- the LMS payload

def test_payload_carries_preferred_batch_only_when_chosen(client, people, course):
    admission = db.session.get(Admission, admitted(client, people, course)["admission"]["admission_id"])
    assert "preferred_batch_code" not in lms_sync.admission_data(db.session, admission)["admission"]
    set_preferred(admission, "NIT-GNT-BAT-2026-000101")
    data = lms_sync.admission_data(db.session, admission)
    assert data["admission"]["preferred_batch_code"] == "NIT-GNT-BAT-2026-000101"
    assert data["admission"]["course_code"] == "NIT-CRS-018"  # the rest of the contract is unchanged
