"""Branch details, staffed shifts and holidays."""
from datetime import date

from sqlalchemy import delete, extract, select

from config.database import db
from models import Branch, BranchShift, Holiday
from services import audit, lms_sync
from services.errors import NotFound, ValidationError


def list_branches() -> list[Branch]:
    return list(db.session.execute(select(Branch).where(Branch.is_active).order_by(Branch.branch_id)).scalars())


def get_branch(branch_id: int) -> Branch:
    branch = db.session.get(Branch, branch_id)
    if branch is None:
        raise NotFound("Branch not found")
    return branch


def update_branch(branch_id: int, data: dict) -> Branch:
    branch = get_branch(branch_id)
    old = branch.to_dict()
    for field, value in data.items():
        setattr(branch, field, value)
    db.session.flush()
    new = branch.to_dict()
    audit.record("BRANCH_UPDATED", "branch", branch_id, old=old, new=new, branch_id=branch_id)
    lms_sync.branch_changed(branch_id, [field for field in data if old[field] != new[field]])
    return branch


# ---------------------------------------------------------------- shifts

def list_shifts(branch_id: int) -> list[BranchShift]:
    get_branch(branch_id)
    stmt = select(BranchShift).where(BranchShift.branch_id == branch_id).order_by(BranchShift.day_of_week)
    return list(db.session.execute(stmt).scalars())


def replace_shifts(branch_id: int, shifts: list[dict]) -> list[BranchShift]:
    """Replace the whole week. Days not listed are closed."""
    old = [s.to_dict() for s in list_shifts(branch_id)]

    days = [s["day_of_week"] for s in shifts]
    if len(days) != len(set(days)):
        raise ValidationError("Each day can appear only once", {"shifts": ["Duplicate day_of_week"]})
    if not shifts:
        raise ValidationError("A branch needs at least one staffed day", {"shifts": ["Add at least 1"]})

    db.session.execute(delete(BranchShift).where(BranchShift.branch_id == branch_id))
    for shift in shifts:
        db.session.add(BranchShift(branch_id=branch_id, **shift))
    db.session.flush()  # DB checks closes_at > opens_at

    new = list_shifts(branch_id)
    audit.record("SHIFTS_UPDATED", "branch", branch_id, old={"shifts": old},
                 new={"shifts": [s.to_dict() for s in new]}, branch_id=branch_id)
    return new


# ---------------------------------------------------------------- holidays

def list_holidays(year: int | None, branch_id: int | None) -> list[Holiday]:
    stmt = select(Holiday).order_by(Holiday.holiday_date)
    if year:
        stmt = stmt.where(extract("year", Holiday.holiday_date) == year)
    if branch_id:
        stmt = stmt.where((Holiday.branch_id == branch_id) | Holiday.branch_id.is_(None))
    return list(db.session.execute(stmt).scalars())


def create_holiday(data: dict) -> Holiday:
    if data.get("branch_id") is not None:
        get_branch(data["branch_id"])
    holiday = Holiday(**data)
    db.session.add(holiday)
    db.session.flush()  # unique per branch + date
    audit.record("HOLIDAY_CREATED", "holiday", holiday.holiday_id, new=holiday.to_dict())
    return holiday


def delete_holiday(holiday_id: int) -> None:
    holiday = db.session.get(Holiday, holiday_id)
    if holiday is None:
        raise NotFound("Holiday not found")
    if holiday.holiday_date < date.today():
        raise ValidationError("Past holidays can't be removed; they explain past deadlines")
    audit.record("HOLIDAY_DELETED", "holiday", holiday_id, old=holiday.to_dict())
    db.session.delete(holiday)
