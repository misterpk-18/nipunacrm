"""Background jobs (run by `flask jobs run`, scheduled with cron): escalations, demo reminders, collections
follow-ups, instalments due soon, broken promises, batch-allocation escalation, scheduled reports, clean-up and the
Nipuna LMS (outbox delivery, status pull, branch finance snapshots) and WhatsApp messages (whatsapp-send).

Every job is idempotent: system tasks use dedupe keys and notifications deduplicate, so running a job twice in a
row changes nothing. Jobs never commit; the CLI commits each job on its own — except lms-sync, lms-status-pull and
whatsapp-send, which commit each record so no transaction stays open while the other side answers.
"""
import logging
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import String, cast, func, select, update
from sqlalchemy.dialects.postgresql import insert

from config.database import db
from models import (
    BatchAllocationQueue, Demo, DemoReminder, FeeDiscussionVersion, InstallmentDue, Invoice, Notification,
    Offer, PaymentPromise, ReportRun, ScheduledReport, SpecialClosingRequest, UserSession,
)
from repositories import settings as settings_repo
from repositories import users as users_repo
from services import collections as collections_service
from services import fees as fees_service
from services import reports as reports_service
from services import batch_waiting, lms_delivery, lms_finance, lms_pull, lms_reconcile, payment_alerts, sla, staff_alerts, tasks, whatsapp, whatsapp_inbound

logger = logging.getLogger(__name__)

# Collections cadence: days relative to the due date → who follows up
COLLECTION_STEPS = {-3: None, 0: None, 3: None, 4: "owner", 7: "BRANCH_MANAGER", 14: "BRANCH_MANAGER",
                    21: "BRANCH_MANAGER", 28: "BRANCH_MANAGER"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _today() -> date:
    return reports_service.business_now().date()


# ---------------------------------------------------------------- notifications

def escalate_notifications() -> int:
    """Action-required notifications past their escalation time go to the rule's escalation role."""
    from models.operations import NotificationRule

    due = db.session.execute(
        select(Notification, NotificationRule.escalate_to_role_id)
        .join(NotificationRule, NotificationRule.rule_id == Notification.rule_id)
        .where(Notification.is_action_required, Notification.action_completed_at.is_(None),
               Notification.escalated_at.is_(None), Notification.escalate_at <= func.now(),
               Notification.escalated_from_id.is_(None),
               Notification.recipient_user_id.not_in(users_repo.admin_user_ids()))  # Founder / Super Admin copies don't escalate
    ).all()
    for note, role_id in due:
        for user_id in users_repo.user_ids_with_role(role_id, note.branch_id) if role_id else []:
            db.session.execute(insert(Notification).values(
                escalated_from_id=note.notification_id, event_key=note.event_key, purpose="escalation",
                entity_type=note.entity_type, entity_id=note.entity_id, recipient_user_id=user_id,
                branch_id=note.branch_id, title=f"Escalated: {note.title}", body=note.body,
            ).on_conflict_do_nothing(index_elements=["event_key", "entity_type", "entity_id", "recipient_user_id", "purpose"]))
        note.escalated_at = _now()
        if note.entity_type == "special_closing_request":
            scr = db.session.get(SpecialClosingRequest, int(note.entity_id))
            if scr is not None and scr.status == "Pending" and scr.escalated_at is None:
                scr.escalated_at = _now()
                staff_alerts.approval_waiting(scr, escalated=True)  # WhatsApp to Founder / Super Admin too
    db.session.flush()
    return len(due)


# ---------------------------------------------------------------- demos

DEMO_REMINDER_LEAD = {"24h student reminder": "24 hours", "1h student + trainer reminder": "1 hour"}


def _demo_reminder_on_whatsapp(reminder, demo) -> bool:
    """WhatsApp is live: the booking confirmation went out when the demo was booked; a 24h / 1h reminder goes to the
    learner (and the trainer, when staff alerts are on). False when the learner has no WhatsApp number: the task
    fallback then asks staff to call."""
    from services import whatsapp_events

    if whatsapp.recipient_phone(demo.lead.person) is None:
        return False
    if reminder.reminder_type != "Booking confirmation":
        starts_in = DEMO_REMINDER_LEAD[reminder.reminder_type]
        whatsapp_events.demo_reminder(demo, reminder.reminder_id, starts_in)
        whatsapp_events.demo_trainer_reminder(demo, reminder.reminder_id, starts_in)
    reminder.state, reminder.sent_at, reminder.note = "Sent", _now(), "Sent on WhatsApp"
    return True


def demo_reminders() -> int:
    """Due reminders: with WhatsApp live each is queued as a message (the learner, and the trainer for the 24h / 1h
    ones); otherwise each becomes a task for the lead's owner to send it by hand. A demo that was rescheduled,
    cancelled or has started never fires: the database settles its reminders and the job skips the rest."""
    rows = db.session.execute(
        select(DemoReminder, Demo).join(Demo, Demo.demo_id == DemoReminder.demo_id)
        .where(DemoReminder.state == "Pending", DemoReminder.due_at <= func.now())
    ).all()
    for reminder, demo in rows:
        if not demo.is_open or demo.scheduled_at <= _now():
            reminder.state, reminder.note = "Skipped", "Demo already started or closed"
            continue
        if whatsapp.configured() and _demo_reminder_on_whatsapp(reminder, demo):
            continue
        owner = demo.commercial_owner_id or demo.lead.assigned_to
        tasks.create_system_task("DEMO", f"Send {reminder.reminder_type.lower()} · {demo.demo_code} · "
                                 f"{demo.lead.person.full_name}", demo.branch_id, _now(), owner_user_id=owner,
                                 team_role_code=None if owner else "FRONT_OFFICE",
                                 dedupe_key=f"demo-reminder:{reminder.reminder_id}", demo_id=demo.demo_id)
        reminder.state, reminder.sent_at = "Sent", _now()
        reminder.note = "Manual channel: task created for staff to send"
    db.session.flush()
    return len(rows)


# ---------------------------------------------------------------- collections

def collections_reminders() -> int:
    """Day −3, due date, +3, +4 (owner), +7 (manager), then weekly to Day 30. Contact hold (pending verification)
    and cancelled enrolments are skipped."""
    today = _today()
    windows = [today - timedelta(days=offset) for offset in COLLECTION_STEPS]
    rows = db.session.execute(
        select(InstallmentDue).where(InstallmentDue.balance > 0, InstallmentDue.due_date.in_(windows),
                                     InstallmentDue.due_position != "Cancelled", InstallmentDue.contact_hold.is_(False))
    ).scalars().all()
    for due in rows:
        offset = (today - due.due_date).days
        escalate = COLLECTION_STEPS[offset]
        invoice = db.session.get(Invoice, due.invoice_id)
        owners = sorted(payment_alerts.invoice_owners(invoice))
        owner = owners[0] if owners else None
        label = f"Day {offset:+d}" if offset else "due today"
        title = (f"Collections {label}: {invoice.invoice_number} instalment {due.installment_no} · "
                 f"{due.person.full_name} · ₹{due.balance}")
        tasks.create_system_task(
            "COLLECTIONS", title, due.collecting_branch_id, sla.working_day_end(due.collecting_branch_id, today),
            owner_user_id=None if escalate == "BRANCH_MANAGER" else owner,
            team_role_code="BRANCH_MANAGER" if escalate == "BRANCH_MANAGER" else None,
            dedupe_key=f"collections:{due.installment_id}:{offset}", invoice_id=due.invoice_id,
        )
    collections_service.send_learner_reminders(today)  # WhatsApp to the learner: -3, due date, +3
    return len(rows)


def broken_promises() -> int:
    promises = db.session.execute(select(PaymentPromise).where(
        PaymentPromise.status == "Pending", PaymentPromise.promised_date < _today())).scalars().all()
    for promise in promises:
        promise.status, promise.resolved_at = "Broken", _now()
        invoice = promise.invoice
        tasks.create_system_task("COLLECTIONS", f"Broken promise: {invoice.invoice_number} · {invoice.person.full_name} "
                                 f"· ₹{promise.promised_amount} due {promise.promised_date}",
                                 invoice.collecting_branch_id, _now(), team_role_code="BRANCH_MANAGER",
                                 dedupe_key=f"promise-broken:{promise.promise_id}", invoice_id=invoice.invoice_id)
    db.session.flush()
    return len(promises)


# ---------------------------------------------------------------- academics

def batch_allocation_escalation() -> int:
    """Off while academics are managed in the LMS: its allocation-escalation job raises these instead."""
    if lms_pull.lms_owns_academics():
        return 0
    rows = db.session.execute(select(BatchAllocationQueue).where(BatchAllocationQueue.escalate_at <= func.now())).scalars().all()
    for row in rows:
        tasks.create_system_task("ACADEMIC", f"Allocate a batch now: {row.admission_code} starts {row.planned_start_date}",
                                 row.service_branch_id, _now(), team_role_code="BRANCH_MANAGER",
                                 dedupe_key=f"allocation-escalate:{row.admission_id}", admission_id=row.admission_id)
    return len(rows)


# ---------------------------------------------------------------- reports

def _schedule_due(report: ScheduledReport, now_local: datetime) -> bool:
    if now_local.time() < report.send_time:
        return False
    if report.frequency == "Weekly" and now_local.isoweekday() != report.schedule_day:
        return False
    if report.frequency == "Monthly" and now_local.day != report.schedule_day:
        return False
    already = db.session.execute(select(ReportRun.report_run_id).where(
        ReportRun.scheduled_report_id == report.scheduled_report_id,
        func.date(func.timezone(func.business_tz(), ReportRun.refreshed_at)) == now_local.date())).first()
    return already is None


def scheduled_reports() -> int:
    """Generate due schedules into report_runs. Email delivery waits for the email integration (Not Sent)."""
    now_local = reports_service.business_now()
    ran = 0
    for report in db.session.execute(select(ScheduledReport).where(ScheduledReport.is_active)).scalars():
        if not _schedule_due(report, now_local):
            continue
        filters = {"branch_id": report.branch_id} if report.branch_id else {}
        _, run = reports_service.export(report.report_name, report.period, None, None, filters, "CSV")
        run.scheduled_report_id = report.scheduled_report_id
        report.last_delivery_status = "Not Sent"
        ran += 1
    db.session.flush()
    return ran


# ---------------------------------------------------------------- clean-up

def cleanup() -> dict:
    """Close expired / idle sessions, expire lapsed fee versions and offers, drop old WhatsApp callback logs."""
    now = _now()
    idle = settings_repo.get_int("session_idle_minutes", 30)
    sessions = db.session.execute(
        update(UserSession).where(UserSession.revoked_at.is_(None),
                                  (UserSession.expires_at < now) | (UserSession.last_seen_at < now - timedelta(minutes=idle)))
        .values(revoked_at=now, revoke_reason="expired")
    ).rowcount
    versions = db.session.execute(
        update(FeeDiscussionVersion).where(FeeDiscussionVersion.valid_until < _today(),
                                           FeeDiscussionVersion.status.in_(("Discussion Saved", "Counteroffered")))
        .values(status="Expired")
    ).rowcount
    offers = db.session.execute(
        update(Offer).where(Offer.status == "Active", Offer.valid_to < _today()).values(status="Expired")
    ).rowcount
    webhooks = whatsapp_inbound.prune_log()
    return {"sessions_closed": sessions, "fee_versions_expired": versions, "offers_expired": offers,
            "whatsapp_callbacks_pruned": webhooks}


# ---------------------------------------------------------------- first staff attempt (playbook page 4)

FIRST_ATTEMPT_RULES = (("cover_alert_at", "FIRST_ATTEMPT_COVER", "Front Office cover"),
                       ("manager_alert_at", "FIRST_ATTEMPT_MANAGER", "Branch Manager"),
                       ("founder_alert_at", "FIRST_ATTEMPT_FOUNDER", "Founder / CEO"))
FIRST_ATTEMPT_LOOKBACK_DAYS = 2  # older never-attempted leads appear in the recovery list, not as fresh alerts


def first_attempt_alerts() -> int:
    """New genuine enquiries with no staff attempt: alert cover at 2, the Branch Manager at 10 and the Founder / CEO
    at 30 staffed minutes after the original capture. Bot / system activity never stops the clock. Alerts close once
    a staff member contacts the learner. Escalation never changes the owner."""
    from models import Lead, LeadResponseClock, Person
    from models.enums import CLOSED_STAGES
    from services import notifications

    now = _now()
    rows = db.session.execute(
        select(LeadResponseClock, Lead).join(Lead, Lead.lead_id == LeadResponseClock.lead_id)
        .join(Person, Person.person_id == Lead.person_id)
        .where(LeadResponseClock.is_eligible, LeadResponseClock.attempted_at.is_(None),
               LeadResponseClock.cover_alert_at <= now, Lead.stage.not_in(CLOSED_STAGES), Lead.converted_at.is_(None),
               Person.stop_contact_at.is_(None),
               LeadResponseClock.captured_at >= now - timedelta(days=FIRST_ATTEMPT_LOOKBACK_DAYS))
    ).all()
    sent = 0
    for clock, lead in rows:
        for column, rule, who in FIRST_ATTEMPT_RULES:
            if getattr(clock, column) <= now:
                course = lead.course.course_title if lead.course else "course not chosen"
                sent += len(notifications.notify(
                    rule, event_key=f"first-attempt:{rule}", entity_type="lead", entity_id=lead.lead_id,
                    branch_id=lead.branch_id, purpose="first-attempt",
                    title=f"No staff attempt yet: {lead.person.full_name} · {course}",
                    body=f"{lead.lead_code} captured {clock.captured_at:%d %b %H:%M}; first attempt was due "
                         f"{clock.due_at:%d %b %H:%M}. Owner: {lead.owner.full_name if lead.owner else 'unassigned'}. "
                         f"For: {who}."))
    # close the alerts of leads someone has now contacted
    attempted = select(cast(LeadResponseClock.lead_id, String)).where(LeadResponseClock.attempted_at.is_not(None))
    db.session.execute(update(Notification).where(
        Notification.purpose == "first-attempt", Notification.entity_type == "lead",
        Notification.action_completed_at.is_(None), Notification.is_action_required,
        Notification.entity_id.in_(attempted)).values(action_completed_at=func.now()))
    return sent


JOBS = {
    "escalations": escalate_notifications,
    "first-attempt": first_attempt_alerts,
    "demo-reminders": demo_reminders,
    "collections": collections_reminders,
    "dues-due-soon": payment_alerts.due_soon,
    "broken-promises": broken_promises,
    "fee-expiry": fees_service.expiry_reminders,
    "batch-allocation": batch_allocation_escalation,
    "batch-delay-alerts": batch_waiting.delay_alerts,
    "scheduled-reports": scheduled_reports,
    "cleanup": cleanup,
    "lms-sync": lms_delivery.deliver,
    "lms-status-pull": lms_pull.pull_if_due,
    "lms-finance-snapshot": lms_finance.send_snapshots,
    "lms-reconcile": lms_reconcile.daily,
    "whatsapp-send": whatsapp.deliver,
}
