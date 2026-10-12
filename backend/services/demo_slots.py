"""Demo slots: a trainer's free time for a course over the next days, and the clash check behind booking.

A trainer is free when the branch is staffed (shifts, minus holidays) and they have no open demo and no batch
session then. Batch sessions come from the batch timetable (`schedule_days` + `start_time` / `end_time` between
`start_date` and `end_date`) of every live batch whose trainer is the user (the LMS-mirrored ones match by
`trainer_user_id` or by the trainer's e-mail in `trainer_emails`). A batch without a confirmed timetable blocks nothing.
"""
import re
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select

from config.database import db
from models import Batch, BranchShift, Course, Demo, Holiday, User
from repositories import settings as settings_repo
from repositories import users as users_repo
from services.context import current_user
from services.errors import Conflict, Forbidden, NotFound, ValidationError

DURATION = {"Standard": 45, "Practical": 60}
SLOT_STEP_MINUTES = 30
MAX_DAYS = 14
LIVE_BATCH_STATUSES = ("Planned", "Open", "In Progress")
_DAYS = {"mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6, "sun": 7}


def business_tz() -> ZoneInfo:
    return ZoneInfo(settings_repo.get("business_timezone", "Asia/Kolkata"))


def parse_days(text: str | None) -> set[int]:
    """'Sat, Sun' / 'Mon-Fri' / 'Mon Wed Fri' → ISO weekdays (1 = Monday). Unreadable parts are ignored."""
    if not text:
        return set()
    cleaned = re.sub(r"\s*(-|–|—|\bto\b)\s*", "-", text.lower())
    days: set[int] = set()
    for part in re.split(r"[,;/&\s]+|\band\b", cleaned):
        if "-" in part:
            first, _, last = part.partition("-")
            if first[:3] in _DAYS and last[:3] in _DAYS:
                day = _DAYS[first[:3]]
                days.add(day)
                while day != _DAYS[last[:3]]:
                    day = day % 7 + 1
                    days.add(day)
        elif part[:3] in _DAYS:
            days.add(_DAYS[part[:3]])
    return days


# ---------------------------------------------------------------- busy time

def _local(day: date, at: time, tz: ZoneInfo) -> datetime:
    return datetime.combine(day, at, tzinfo=tz)


def _trainer_batches(trainer: User) -> list[Batch]:
    email = (trainer.email or "").lower()
    stmt = select(Batch).where(Batch.status.in_(LIVE_BATCH_STATUSES), Batch.start_time.is_not(None),
                               Batch.end_time.is_not(None), Batch.schedule_days.is_not(None))
    rows = db.session.execute(stmt).unique().scalars()
    return [b for b in rows if b.trainer_user_id == trainer.user_id
            or (email and email in {e.lower() for e in (b.trainer_emails or [])})
            or (email and (b.lead_trainer_email or "").lower() == email)]


def _batch_sessions(batches: list[Batch], first: date, last: date, tz: ZoneInfo) -> list[tuple[datetime, datetime, str]]:
    sessions = []
    for batch in batches:
        weekdays = parse_days(batch.schedule_days)
        day = max(first, batch.start_date)
        end = min(last, batch.end_date) if batch.end_date else last
        while day <= end:
            if day.isoweekday() in weekdays:
                sessions.append((_local(day, batch.start_time, tz), _local(day, batch.end_time, tz),
                                 f"batch {batch.lms_course_id or batch.batch_code}"))
            day += timedelta(days=1)
    return sessions


def _busy(trainer: User, start: datetime, end: datetime, tz: ZoneInfo,
          exclude_demo_id: int | None = None) -> list[tuple[datetime, datetime, str]]:
    """The trainer's open demos and batch sessions that touch [start, end)."""
    demos = db.session.execute(
        select(Demo).where(Demo.trainer_user_id == trainer.user_id, Demo.status.in_(Demo.OPEN_STATUSES),
                           Demo.scheduled_at < end, Demo.scheduled_at > start - timedelta(hours=3))
    ).unique().scalars()
    busy = [(d.scheduled_at, d.scheduled_at + timedelta(minutes=d.duration_minutes), f"demo {d.demo_code}")
            for d in demos if d.demo_id != exclude_demo_id]
    first, last = start.astimezone(tz).date(), end.astimezone(tz).date()
    busy += _batch_sessions(_trainer_batches(trainer), first, last, tz)
    return [b for b in busy if b[0] < end and b[1] > start]


def ensure_trainer_free(trainer_id: int, start: datetime, minutes: int, exclude_demo_id: int | None = None) -> None:
    """Refuse a booking that overlaps the trainer's other demos or batch sessions."""
    trainer = db.session.get(User, trainer_id)
    if trainer is None:
        return
    end = start + timedelta(minutes=minutes)
    clash = _busy(trainer, start, end, business_tz(), exclude_demo_id)
    if clash:
        raise Conflict(f"{trainer.full_name} is busy then ({clash[0][2]}). Pick another slot or trainer.",
                       {"trainer_user_id": ["Not free at that time"], "busy": clash[0][2]})


# ---------------------------------------------------------------- free slots

def _working_windows(branch_id: int, first: date, days: int, tz: ZoneInfo) -> list[tuple[datetime, datetime]]:
    shifts = {s.day_of_week: s for s in db.session.execute(
        select(BranchShift).where(BranchShift.branch_id == branch_id)).scalars()}
    last = first + timedelta(days=days - 1)
    holidays = set(db.session.execute(
        select(Holiday.holiday_date).where((Holiday.branch_id == branch_id) | Holiday.branch_id.is_(None),
                                           Holiday.holiday_date.between(first, last))).scalars())
    windows = []
    for offset in range(days):
        day = first + timedelta(days=offset)
        shift = shifts.get(day.isoweekday())
        if shift and day not in holidays:
            windows.append((_local(day, shift.opens_at, tz), _local(day, shift.closes_at, tz)))
    return windows


def _teaches(course_id: int, branch_id: int) -> tuple[set[int], set[str]]:
    """Trainers who run (or ran) a batch of the course at the branch: CRM user ids and LMS e-mails."""
    ids, emails = set(), set()
    for batch in db.session.execute(select(Batch).where(Batch.course_id == course_id, Batch.branch_id == branch_id)
                                    ).unique().scalars():
        if batch.trainer_user_id:
            ids.add(batch.trainer_user_id)
        emails |= {e.lower() for e in (batch.trainer_emails or [])}
        if batch.lead_trainer_email:
            emails.add(batch.lead_trainer_email.lower())
    return ids, emails


def free_slots(course_id: int, branch_id: int, demo_type: str, first: date | None, days: int) -> dict:
    user = current_user()
    if not user.can_access_branch(branch_id):
        raise NotFound("Branch not found")
    if not (user.is_manager_of(branch_id) or user.has_role("SALES", "FRONT_OFFICE", branch_id=branch_id)):
        raise Forbidden("Only counsellors or a branch manager can book demos")
    course = db.session.get(Course, course_id)
    if course is None or course.status != "Active":
        raise ValidationError("Unknown or inactive course", {"course_id": ["Not an active course"]})

    tz = business_tz()
    now = datetime.now(timezone.utc)
    days = max(1, min(days, MAX_DAYS))
    first = first or now.astimezone(tz).date()
    minutes = DURATION[demo_type]
    windows = _working_windows(branch_id, first, days, tz)
    teach_ids, teach_emails = _teaches(course_id, branch_id)

    trainer_ids = users_repo.user_ids_with_any_role(("TRAINER",), branch_id)
    trainers = list(db.session.execute(select(User).where(User.user_id.in_(trainer_ids))
                                       .order_by(User.full_name, User.user_id)).scalars()) if trainer_ids else []
    horizon = (_local(first, time(0), tz), _local(first + timedelta(days=days), time(0), tz))
    result = []
    for trainer in trainers:
        busy = _busy(trainer, horizon[0], horizon[1], tz)
        slots = []
        for opens, closes in windows:
            start = opens
            while start + timedelta(minutes=minutes) <= closes:
                end = start + timedelta(minutes=minutes)
                if start > now and not any(b[0] < end and b[1] > start for b in busy):
                    slots.append({"start": start.isoformat(), "end": end.isoformat()})
                start += timedelta(minutes=SLOT_STEP_MINUTES)
        result.append({
            "user_id": trainer.user_id, "full_name": trainer.full_name,
            "teaches_course": trainer.user_id in teach_ids or (trainer.email or "").lower() in teach_emails,
            "slots": slots,
        })
    result.sort(key=lambda t: (not t["teaches_course"], t["full_name"].lower()))
    return {"course_id": course_id, "branch_id": branch_id, "demo_type": demo_type, "duration_minutes": minutes,
            "from": first, "days": days, "timezone": str(tz), "trainers": result}

