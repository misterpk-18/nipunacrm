"""Automatic WhatsApp messages for demos, admissions and the delivery plan confirmation."""
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from config.database import db
from models import Demo, DemoReminder, Task, WhatsappOutbox
from services import jobs, whatsapp, whatsapp_events
from tests.helpers import admitted, call, create_deal, future
from tests.test_whatsapp import PHONE, of, provider, rows


@pytest.fixture(autouse=True)
def quiet_other_events(monkeypatch):
    for name in ("enquiry_received", "delivery_plan_accepted"):
        monkeypatch.setattr(whatsapp_events, name, lambda *args, **kwargs: None)


def book(client, people, course, hours=48, **body):
    lead = create_deal(client, people["sravani"]["h"], course_id=course)
    return call(client, "post", f"/leads/{lead['lead_id']}/demos", people["sravani"]["h"], 201,
                json={"scheduled_at": future(hours), **body})


def make_due(run_sql, demo_id, kind):
    run_sql("UPDATE demo_reminders SET due_at = now() - interval '1 minute' "
            "WHERE demo_id = :d AND reminder_type = :k AND state = 'Pending'", d=demo_id, k=kind)


def reminder_state(demo_id, kind):
    row = db.session.execute(select(DemoReminder).where(
        DemoReminder.demo_id == demo_id, DemoReminder.reminder_type == kind)).scalar_one()
    db.session.refresh(row)
    return row.state


# ---------------------------------------------------------------- demos

def test_booking_sends_the_learner_the_details(client, people, course, run_sql):
    run_sql("UPDATE branches SET address = 'Plot 5, Benz Circle' WHERE branch_id = 1")
    demo = book(client, people, course, trainer_user_id=people["trainer"]["id"])
    (row,) = of("demo_booked")
    assert row.status == "Queued" and row.to_phone == PHONE and row.event_key == f"demo-booked:{demo['demo_id']}"
    assert "In person at" in row.params["demo_venue"] and "Plot 5, Benz Circle" in row.params["demo_venue"]
    assert row.params["trainer_name"] == "Trainer G1" and row.params["demo_time"]


def test_online_booking_carries_the_link_and_a_missing_trainer_is_to_be_confirmed(client, people, course):
    book(client, people, course, mode="Online", meeting_link="https://meet.example/abc")
    (row,) = of("demo_booked")
    assert row.params["demo_venue"] == "Online. Joining link: https://meet.example/abc"
    assert row.params["trainer_name"] == "To be confirmed"


def test_reschedule_and_cancel_send_notes_and_leave_no_stale_reminder(client, people, course, run_sql):
    sravani = people["sravani"]["h"]
    demo = book(client, people, course, trainer_user_id=people["trainer"]["id"])
    new = call(client, "post", f"/demos/{demo['demo_id']}/reschedule", sravani, 201,
               json={"scheduled_at": future(72), "reason": "Student requested"})
    (moved,) = of("demo_rescheduled")
    assert moved.event_key == f"demo-rescheduled:{new['demo_id']}"
    assert reminder_state(demo["demo_id"], "24h student reminder") == "Superseded"
    call(client, "post", f"/demos/{new['demo_id']}/cancel", sravani, json={"reason": "Other"})
    (gone,) = of("demo_cancelled")
    assert gone.event_key == f"demo-cancelled:{new['demo_id']}" and "cancelled" in gone.body_text
    for demo_id in (demo["demo_id"], new["demo_id"]):  # even if the clock reached their reminder times
        run_sql("UPDATE demo_reminders SET due_at = now() - interval '1 hour' WHERE demo_id = :d", d=demo_id)
    jobs.demo_reminders()
    assert of("demo_reminder") == [] and of("staff_demo_reminder_v1") == []


def test_reminders_go_to_the_learner_and_the_trainer(client, people, course, run_sql):
    run_sql("UPDATE users SET phone = '90000 11111' WHERE user_id = :u", u=people["trainer"]["id"])
    run_sql("UPDATE app_settings SET setting_value = 'true' WHERE setting_key = 'whatsapp_staff_alerts_enabled'")
    demo = book(client, people, course, hours=30, trainer_user_id=people["trainer"]["id"])
    make_due(run_sql, demo["demo_id"], "24h student reminder")
    jobs.demo_reminders()
    (learner,) = of("demo_reminder")
    assert learner.to_phone == PHONE and learner.params["starts_in"] == "24 hours"
    (trainer,) = of("staff_demo_reminder_v1")
    assert trainer.to_phone == "919000011111" and trainer.params["learner_name"] and trainer.params["starts_in"] == "24 hours"
    assert reminder_state(demo["demo_id"], "24h student reminder") == "Sent"
    assert db.session.execute(select(Task).where(Task.demo_id == demo["demo_id"])).scalars().all() == [], "no task: WhatsApp took it"
    jobs.demo_reminders()
    assert len(of("demo_reminder")) == 1 and len(of("staff_demo_reminder_v1")) == 1  # once


def test_trainer_alerts_follow_the_staff_setting_and_need_a_phone(client, people, course, run_sql):
    run_sql("UPDATE app_settings SET setting_value = 'false' WHERE setting_key = 'whatsapp_staff_alerts_enabled'")
    demo = book(client, people, course, hours=30, trainer_user_id=people["trainer"]["id"])
    make_due(run_sql, demo["demo_id"], "24h student reminder")
    jobs.demo_reminders()
    assert len(of("demo_reminder")) == 1 and of("staff_demo_reminder_v1") == []  # setting off
    run_sql("UPDATE app_settings SET setting_value = 'true' WHERE setting_key = 'whatsapp_staff_alerts_enabled'")
    make_due(run_sql, demo["demo_id"], "1h student + trainer reminder")
    jobs.demo_reminders()
    (alert,) = of("staff_demo_reminder_v1")  # the trainer has no phone: recorded as Skipped, not sent
    assert alert.status == "Skipped" and "No WhatsApp number" in alert.skip_reason


def test_whatsapp_off_keeps_the_task(client, people, course, run_sql, monkeypatch):
    monkeypatch.setattr(whatsapp, "configured", lambda: False)
    demo = book(client, people, course, hours=30)
    make_due(run_sql, demo["demo_id"], "24h student reminder")
    jobs.demo_reminders()
    assert of("demo_reminder") == []
    assert db.session.execute(select(Task).where(Task.demo_id == demo["demo_id"])).scalars().all()


# ---------------------------------------------------------------- admissions

def test_admission_message_once_per_admission(client, people, course):
    flow = admitted(client, people, course)
    (row,) = of("admission_confirmed")
    admission = flow["admission"]
    assert row.event_key == f"admission-confirmed:{admission['admission_id']}"
    assert row.params["admission_no"] == admission["admission_code"] and row.params["learning_mode"]
    assert row.params["course_name"] and row.params["branch_name"] and row.params["start_date"]
    jobs_rows = [r for r in rows() if r.template_name == row.template_name]
    assert len(jobs_rows) == 1


# ---------------------------------------------------------------- delivery plan

def confirms():
    return [r for r in rows() if r.template_name == "nipuna_delivery_plan_confirm_v1"]


def save_plan(client, people, lead_id, **body):
    start = (date.today() + timedelta(days=10)).isoformat()
    return call(client, "put", f"/leads/{lead_id}/delivery-plan", people["sravani"]["h"],
                json={"delivery_mode": "Classroom", "capacity_review": "Checked", "planned_start_date": start, **body})


def test_a_ready_plan_goes_out_once_and_again_only_after_a_withdrawing_edit(client, people, course):
    lead = create_deal(client, people["sravani"]["h"], course_id=course)
    incomplete = call(client, "put", f"/leads/{lead['lead_id']}/delivery-plan", people["sravani"]["h"],
                      json={"delivery_mode": "Classroom"})  # no start date yet: not ready
    assert confirms() == [] and incomplete["plan"]["confirmation_requested_at"] is None
    state = save_plan(client, people, lead["lead_id"])
    (first,) = confirms()
    assert state["plan"]["confirmation_requested_at"] and first.event_key.endswith(":1")
    save_plan(client, people, lead["lead_id"])  # nothing changed, a request is pending
    assert len(confirms()) == 1
    save_plan(client, people, lead["lead_id"], delivery_mode="Online")  # edited: the request was withdrawn, so resend
    assert len(confirms()) == 2
    call(client, "post", f"/leads/{lead['lead_id']}/delivery-plan/send-for-confirmation", people["sravani"]["h"])
    assert len(confirms()) == 3  # the button still resends


def test_accepting_in_person_does_not_send_a_confirmation(client, people, course):
    lead = create_deal(client, people["sravani"]["h"], course_id=course)
    start = (date.today() + timedelta(days=10)).isoformat()
    call(client, "post", f"/leads/{lead['lead_id']}/delivery-plan/accept", people["sravani"]["h"],
         json={"delivery_mode": "Classroom", "capacity_review": "Checked", "planned_start_date": start,
               "student_accepted": True, "acceptance_method": "in_person"})
    assert confirms() == []
