"""Admitted students who are not in a batch yet ("Waiting for batch"), and the delay alerts that chase them.

Academics run in the Nipuna LMS: the Branch Manager allocates there and the pull mirrors it back (services/lms_pull.py). The
CRM only watches. A student is *waiting* while the admission is Awaiting Batch Allocation and has no active allocation —
paused, cancelled, completed and already-allocated admissions are never listed or chased.

Alerts (job `batch-delay-alerts`, db 039 settings), in working time and idempotent (task dedupe keys, notification
event keys):
  Branch Manager task + owner counsellor notified   Confirmed Seat: batch_delay_coordinator_days working days after the
                                                 admission, to the branch's closing time (or the planned start, if
                                                 sooner); Future Plan: batch_delay_future_plan_hours before its start
  Branch Manager task + notification             batch_delay_manager_days working days
  Founder / CEO and Super Admin notification     batch_delay_founder_days working days
Days are counted from the admission (a Future Plan: from its coordinator deadline). The alerts close when the LMS reports
an allocation (close_alerts, called by the pull) and the job also sweeps any left open for an admission that is no
longer waiting.
"""
from datetime import date, datetime, time, timedelta, timezone
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from flask import current_app
from sqlalchemy import Select, exists, func, or_, select, update

from config.database import db
from models import (
    Admission, Batch, BatchAllocation, DeliveryPlan, Lead, Notification, Person, Task,
)
from repositories import settings as settings_repo
from repositories import users as users_repo
from repositories.common import paginate
from services import notifications, sla, tasks
from services.context import current_user
from services.reports import business_now

WAITING_STATUS = "Awaiting Batch Allocation"
KEY_PREFIX = "batch-wait"
STAGES = ("coordinator", "manager", "founder")
ADMIN_ROLES = ("FOUNDER_CEO", "SUPER_ADMIN")


# ---------------------------------------------------------------- who is waiting

def waiting_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    """Admissions waiting for a batch, longest wait first. Branch scope: the service or original branch."""
    stmt = (select(Admission).join(Person, Person.person_id == Admission.person_id)
            .where(Admission.enrolment_status == WAITING_STATUS,
                   ~exists().where(BatchAllocation.admission_id == Admission.admission_id,
                                   BatchAllocation.status == "Active"))
            .order_by(Admission.admission_date, Admission.admission_id))
    if branch_ids is not None:
        stmt = stmt.where(or_(Admission.service_branch_id.in_(branch_ids), Admission.original_branch_id.in_(branch_ids)))
    if filters.get("branch_id"):
        stmt = stmt.where(or_(Admission.service_branch_id == filters["branch_id"],
                              Admission.original_branch_id == filters["branch_id"]))
    if filters.get("course_id"):
        stmt = stmt.where(Admission.course_id == filters["course_id"])
    if filters.get("seat_type"):
        stmt = stmt.where(Admission.seat_type == filters["seat_type"])
    if filters.get("q"):
        pattern = f"%{filters['q']}%"
        stmt = stmt.where(or_(Admission.admission_code.ilike(pattern), Person.full_name.ilike(pattern),
                              Person.phone.ilike(pattern)))
    return stmt


def working_days_waiting(admission: Admission, today: date | None = None) -> int:
    """Staffed days of the service branch since the admission date (0 on the day itself)."""
    today = today or business_now().date()
    return db.session.execute(select(func.working_days_between(
        admission.service_branch_id, admission.admission_date, max(today, admission.admission_date)))).scalar_one()


# ---------------------------------------------------------------- deadlines

def _setting(key: str, default: int) -> int:
    return settings_repo.get_int(key, default)


def business_tz() -> ZoneInfo:
    return ZoneInfo(settings_repo.get("business_timezone", "Asia/Kolkata"))


def _local(day: date, at: time = time.min) -> datetime:
    return datetime.combine(day, at, tzinfo=business_tz())


def deadlines(admission: Admission) -> dict[str, datetime]:
    """When each alert stage is due, as instants. Closing time of the branch's working day, from the admission date
    (Future Plan: from its coordinator deadline)."""
    branch = admission.service_branch_id
    if admission.seat_type == "Future Plan" and admission.planned_start_date:
        coordinator = _local(admission.planned_start_date) - timedelta(hours=_setting("batch_delay_future_plan_hours", 48))
        clock_day = coordinator.astimezone(business_tz()).date()
    else:
        clock_day = admission.admission_date
        coordinator = sla.working_day_end(
            branch, sla.add_working_days(branch, clock_day, _setting("batch_delay_coordinator_days", 1)))
        if admission.planned_start_date:  # never later than the first class
            coordinator = min(coordinator, _local(admission.planned_start_date))
    return {
        "coordinator": coordinator,
        "manager": sla.working_day_end(branch, sla.add_working_days(branch, clock_day,
                                                                    _setting("batch_delay_manager_days", 2))),
        "founder": sla.working_day_end(branch, sla.add_working_days(branch, clock_day,
                                                                    _setting("batch_delay_founder_days", 5))),
    }


def delay_stage(due: dict[str, datetime], now: datetime | None = None) -> str | None:
    """The highest stage reached ('founder' > 'manager' > 'coordinator'), or None while still on time."""
    now = now or datetime.now(timezone.utc)
    reached = [stage for stage in STAGES if due[stage] <= now]
    return reached[-1] if reached else None


# ---------------------------------------------------------------- the screen

def preferred_batch(admission: Admission) -> dict | None:
    """The counsellor's preferred LMS batch, kept on the delivery plan (db 037). It is a preference only: the
    Branch Manager still allocates in the LMS."""
    if admission.lead_id is None:
        return None
    plan = db.session.execute(select(DeliveryPlan).where(DeliveryPlan.lead_id == admission.lead_id)).scalar_one_or_none()
    code = getattr(plan, "preferred_lms_batch_code", None) if plan else None
    if not code:
        return None
    label = getattr(plan, "preferred_lms_batch_label", None)
    if not label:
        batch = db.session.execute(select(Batch).where(Batch.lms_course_id == code)).scalar_one_or_none()
        label = batch.batch_name if batch else None
    return {"code": code, "label": label}


def lms_url(admission: Admission) -> str | None:
    """Deep link into the LMS's allocation screen; None until LMS_WEB_URL is set."""
    base = (current_app.config.get("LMS_WEB_URL") or "").rstrip("/")
    if not base:
        return None
    query = {"crm_admission_id": admission.admission_id}
    if admission.person.lms_user_id:
        query["student"] = admission.person.lms_user_id
    return f"{base}/academic/batches?{urlencode(query)}"


def row(admission: Admission, today: date) -> dict:
    due = deadlines(admission)
    return {
        "admission_id": admission.admission_id, "admission_code": admission.admission_code,
        "person": admission.person.to_summary(), "lead_id": admission.lead_id,
        "course": admission.course.to_summary(), "service_branch": admission.service_branch.to_summary(),
        "admission_date": admission.admission_date, "days_waiting": working_days_waiting(admission, today),
        "seat_type": admission.seat_type, "planned_start_date": admission.planned_start_date,
        "preferred_batch": preferred_batch(admission),
        "allocate_by": due["coordinator"], "delay": delay_stage(due),
        "lms_url": lms_url(admission),
    }


def list_waiting(filters: dict, page: int, per_page: int) -> tuple[list[dict], dict]:
    admissions, meta = paginate(waiting_stmt(filters, current_user().branch_ids()), page, per_page)
    today = business_now().date()
    return [row(a, today) for a in admissions], meta


# ---------------------------------------------------------------- alerts

def _key(stage: str, admission_id: int) -> str:
    return f"{KEY_PREFIX}:{stage}:{admission_id}"


def _owner(admission: Admission) -> int | None:
    owner = admission.counsellor_id or admission.record_owner_id
    if owner is None and admission.lead_id:
        lead = db.session.get(Lead, admission.lead_id)
        owner = lead.assigned_to if lead else None
    return owner


def _alert(admission: Admission, stage: str, due: datetime, days: int) -> None:
    person = admission.person.full_name
    course = admission.course.course_title
    where = admission.service_branch.branch_name
    waiting = f"{admission.admission_code} · {person} · {course} ({where})"
    detail = (f"Admitted {admission.admission_date:%d %b %Y}, {days} working day(s) ago; "
              f"{admission.seat_type}" + (f", starts {admission.planned_start_date:%d %b %Y}"
                                         if admission.planned_start_date else "") + ". "
              "The Branch Manager allocates the batch in the Nipuna LMS.")
    branch = admission.service_branch_id
    if stage == "coordinator":
        tasks.create_system_task(
            "ACADEMIC", f"Allocate a batch: {waiting}", branch, due, owner_user_id=admission.academic_owner_id,
            team_role_code=None if admission.academic_owner_id else "BRANCH_MANAGER", description=detail,
            dedupe_key=_key(stage, admission.admission_id), admission_id=admission.admission_id)
        owner = _owner(admission)
        if owner is not None:
            notifications.notify(
                "BATCH_DELAY_OWNER", event_key="batch-wait:owner", entity_type="batch_wait",
                entity_id=admission.admission_id, branch_id=branch, recipient_user_ids=[owner],
                title=f"No batch yet for {person} · {course}",
                body=f"{detail} You may want to reassure the learner.")
    elif stage == "manager":
        tasks.create_system_task(
            "ACADEMIC", f"Still no batch after {days} working days: {waiting}", branch, due,
            team_role_code="BRANCH_MANAGER", description=detail,
            dedupe_key=_key(stage, admission.admission_id), admission_id=admission.admission_id)
        notifications.notify(
            "BATCH_DELAY_MANAGER", event_key="batch-wait:manager", entity_type="batch_wait",
            entity_id=admission.admission_id, branch_id=branch,
            title=f"Still waiting for a batch: {person} · {course}", body=detail)
    else:
        notifications.notify(
            "BATCH_DELAY_FOUNDER", event_key="batch-wait:founder", entity_type="batch_wait",
            entity_id=admission.admission_id, branch_id=branch,
            recipient_user_ids=sorted(users_repo.user_ids_with_any_role(ADMIN_ROLES, branch)),
            title=f"{days} working days without a batch: {person} · {course} ({where})", body=detail)


def delay_alerts() -> int:
    """Job `batch-delay-alerts`: raise each waiting admission's due alerts (all stages already reached, so a missed
    run catches up), then close what no longer applies. Off while the CRM runs its own academics (its
    `batch-allocation` job covers that). Returns the alerts considered."""
    from services.lms_pull import lms_owns_academics

    if not lms_owns_academics():
        return 0
    now = datetime.now(timezone.utc)
    today = business_now().date()
    count = 0
    waiting = db.session.execute(waiting_stmt({}, None)).scalars().all()
    for admission in waiting:
        due = deadlines(admission)
        days = working_days_waiting(admission, today)
        for stage in STAGES:
            if due[stage] <= now:
                _alert(admission, stage, due[stage], days)
                count += 1
    db.session.flush()
    close_stale({a.admission_id for a in waiting})
    return count


# ---------------------------------------------------------------- closing

def close_alerts(admission_id: int) -> None:
    """The student is allocated (or paused / cancelled): close its open tasks and action notifications."""
    for stage in ("coordinator", "manager"):
        tasks.complete_system_task(_key(stage, admission_id))
    notifications.complete_for("batch_wait", admission_id)


def close_stale(waiting_ids: set[int]) -> int:
    """Close alerts of admissions that are no longer waiting (allocation arrived between runs, pause, cancel)."""
    stale_tasks = db.session.execute(
        update(Task).where(Task.dedupe_key.like(f"{KEY_PREFIX}:%"), Task.status.not_in(("Completed", "Cancelled")),
                           Task.admission_id.not_in(waiting_ids) if waiting_ids else Task.admission_id.is_not(None))
        .values(status="Completed")).rowcount
    keep = {str(i) for i in waiting_ids}
    stale_notes = db.session.execute(
        update(Notification).where(Notification.entity_type == "batch_wait", Notification.is_action_required,
                                   Notification.action_completed_at.is_(None),
                                   Notification.entity_id.not_in(keep) if keep else Notification.entity_id.is_not(None))
        .values(action_completed_at=func.now(), read_at=func.coalesce(Notification.read_at, func.now()))).rowcount
    return stale_tasks + stale_notes
