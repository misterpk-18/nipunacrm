"""Demo schedule queries."""
from sqlalchemy import Select, func, select

from config.database import db
from models import Demo


def _local_date(column):
    return func.date(func.timezone(func.business_tz(), column))


def demos_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    stmt = select(Demo).order_by(Demo.scheduled_at, Demo.demo_id)
    if branch_ids is not None:
        stmt = stmt.where(Demo.branch_id.in_(branch_ids))
    for field, column in (("branch_id", Demo.branch_id), ("trainer_id", Demo.trainer_user_id),
                          ("status", Demo.status), ("lead_id", Demo.lead_id)):
        if filters.get(field) is not None:
            stmt = stmt.where(column == filters[field])
    if filters.get("from"):
        stmt = stmt.where(_local_date(Demo.scheduled_at) >= filters["from"])
    if filters.get("to"):
        stmt = stmt.where(_local_date(Demo.scheduled_at) <= filters["to"])
    return stmt


def attended_counts(lead_ids: list[int]) -> dict[int, int]:
    if not lead_ids:
        return {}
    rows = db.session.execute(
        select(Demo.lead_id, func.count()).where(Demo.lead_id.in_(lead_ids), Demo.status == "Attended")
        .group_by(Demo.lead_id)
    ).all()
    return dict(rows)
