"""Step 3: internal task, notification and staffed-time services (no public API yet)."""
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import select, text

from config.database import db
from models import Notification, Task
from services import notifications, sla, tasks

IST = timezone(timedelta(hours=5, minutes=30))


# ---------------------------------------------------------------- tasks

def test_system_task_is_idempotent_with_dedupe_key(app):
    due = datetime(2026, 10, 1, 12, 0, tzinfo=IST)

    first = tasks.create_system_task("GENERAL", "Check branch setup", 1, due, team_role_code="BRANCH_MANAGER",
                                     dedupe_key="setup:1")
    second = tasks.create_system_task("GENERAL", "Different title", 1, due, dedupe_key="setup:1")

    assert first.task_id == second.task_id
    assert second.title == "Check branch setup"
    assert first.source == "System" and first.team_role.role_code == "BRANCH_MANAGER"
    assert db.session.execute(select(Task).where(Task.dedupe_key == "setup:1")).scalars().all() == [first]


def test_system_task_validation(app):
    due = datetime(2026, 10, 1, tzinfo=IST)

    with pytest.raises(ValueError, match="Unknown or inactive task type"):
        tasks.create_system_task("NOT_A_TYPE", "x", 1, due)
    with pytest.raises(ValueError, match="at most one record"):
        tasks.create_system_task("GENERAL", "x", 1, due, lead_id=1, admission_id=1)
    with pytest.raises(ValueError, match="Unknown task link"):
        tasks.create_system_task("GENERAL", "x", 1, due, banana_id=1)


def test_complete_system_task(app):
    tasks.create_system_task("GENERAL", "x", 1, datetime(2026, 10, 1, tzinfo=IST), dedupe_key="close-me")

    assert tasks.complete_system_task("close-me") is True
    assert tasks.complete_system_task("close-me") is False  # already completed
    task = db.session.execute(select(Task).where(Task.dedupe_key == "close-me")).scalar_one()
    db.session.refresh(task)
    assert task.status == "Completed" and task.completed_at is not None


# ---------------------------------------------------------------- notifications

def test_notify_goes_to_role_holders_at_the_branch_once(app, make_user):
    guntur_bm = make_user(roles=[("BRANCH_MANAGER", 1)])
    make_user(roles=[("BRANCH_MANAGER", 2)])            # other branch: not notified
    make_user(roles=[("BRANCH_MANAGER", 1)], is_active=False)  # inactive: not notified

    sent = notifications.notify("SCR_PENDING", event_key="scr.created:SCR-00001", entity_type="special_closing_request",
                                entity_id=1, branch_id=1, title="Approve special closing SCR-00001")
    again = notifications.notify("SCR_PENDING", event_key="scr.created:SCR-00001", entity_type="special_closing_request",
                                 entity_id=1, branch_id=1, title="Approve special closing SCR-00001")

    assert [n.recipient_user_id for n in sent] == [guntur_bm.user_id]
    assert [n.notification_id for n in again] == [n.notification_id for n in sent]  # deduplicated
    note = sent[0]
    db.session.refresh(note)
    assert note.category == "Action Required" and note.is_action_required
    assert note.escalate_at - note.delivered_at == timedelta(minutes=5)  # from the rule, via trigger


def test_notify_explicit_recipients_and_disabled_rules(app, make_user, run_sql):
    accounts = make_user(roles=[("ACCOUNTS", 2)])

    sent = notifications.notify("PAYMENT_PENDING_VERIFICATION", event_key="payment.recorded:VIJ-R-1",
                                entity_type="payment", entity_id=1, branch_id=2, title="Verify payment",
                                recipient_user_ids=[accounts.user_id])
    assert len(sent) == 1

    run_sql("UPDATE notification_rules SET is_active = false WHERE rule_code = 'PAYMENT_PENDING_VERIFICATION'")
    assert notifications.notify("PAYMENT_PENDING_VERIFICATION", event_key="payment.recorded:VIJ-R-2",
                                entity_type="payment", entity_id=2, branch_id=2, title="x") == []
    assert db.session.execute(select(Notification).where(Notification.entity_id == "2")).first() is None


# ---------------------------------------------------------------- staffed time

def test_staffed_deadline_and_working_days(app):
    saturday_evening = datetime(2026, 9, 26, 18, 58, tzinfo=IST)

    deadline = sla.staffed_deadline(1, saturday_evening, 5)
    next_working_day = sla.add_working_days(1, date(2026, 9, 26), 1)  # Saturday -> Monday (Sunday closed)
    close = sla.working_day_end(1, date(2026, 9, 28))

    assert deadline.astimezone(IST) == datetime(2026, 9, 28, 9, 3, tzinfo=IST)
    assert next_working_day == date(2026, 9, 28)
    assert close.astimezone(IST).hour == 19
    assert db.session.execute(text("SELECT business_tz()")).scalar() == "Asia/Kolkata"
