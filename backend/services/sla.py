"""Staffed-time deadlines, using each branch's shifts and holidays (SQL functions in db/)."""
from datetime import date, datetime

from sqlalchemy import func, select

from config.database import db


def staffed_deadline(branch_id: int, start: datetime, minutes: int) -> datetime:
    """start + N staffed minutes (skips closed hours, off days and holidays). E.g. SCR target = 5 minutes."""
    return db.session.execute(select(func.add_staffed_minutes(branch_id, start, minutes))).scalar_one()


def add_working_days(branch_id: int, day: date, days: int) -> date:
    return db.session.execute(select(func.add_working_days(branch_id, day, days))).scalar_one()


def working_day_end(branch_id: int, day: date) -> datetime:
    """Closing time of the branch on that day."""
    return db.session.execute(select(func.working_day_end(branch_id, day))).scalar_one()
