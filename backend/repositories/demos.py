"""Demo schedule queries."""
from sqlalchemy import Select

from config.database import db
from models import Demo
from repositories.common import raw_select, text

# Equality filters: request field -> fixed SQL (the value always travels as a :named parameter).
_EQUALS_FILTERS = {
    "branch_id": "d.branch_id = :branch_id",
    "trainer_id": "d.trainer_user_id = :trainer_id",
    "status": "d.status = :status",
    "lead_id": "d.lead_id = :lead_id",
}


def demos_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    conditions = ["TRUE"]
    params = {}
    if branch_ids is not None:
        conditions.append("d.branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    for field, fragment in _EQUALS_FILTERS.items():
        if filters.get(field) is not None:
            conditions.append(fragment)
            params[field] = filters[field]
    if filters.get("owner_id") is not None:  # demos of leads this counsellor owns
        conditions.append("EXISTS (SELECT 1 FROM leads l WHERE l.lead_id = d.lead_id AND l.assigned_to = :owner_id)")
        params["owner_id"] = filters["owner_id"]
    if filters.get("outcome_due"):  # booked, and the slot has ended: the trainer / counsellor still has to record it
        conditions.append("CAST(d.status AS text) = ANY(:open_statuses) "
                          "AND d.scheduled_at + d.duration_minutes * INTERVAL '1 minute' <= now()")
        params["open_statuses"] = list(Demo.OPEN_STATUSES)
    if filters.get("from"):
        conditions.append("date(timezone(business_tz(), d.scheduled_at)) >= :date_from")
        params["date_from"] = filters["from"]
    if filters.get("to"):
        conditions.append("date(timezone(business_tz(), d.scheduled_at)) <= :date_to")
        params["date_to"] = filters["to"]
    sql = text("SELECT d.* FROM demos d WHERE " + " AND ".join(conditions))
    return raw_select(Demo, sql, params, "scheduled_at, demo_id")


def attended_counts(lead_ids: list[int]) -> dict[int, int]:
    if not lead_ids:
        return {}
    rows = db.session.execute(
        text("SELECT lead_id, COUNT(*) FROM demos WHERE lead_id = ANY(:lead_ids) AND status = 'Attended' "
             "GROUP BY lead_id"),
        {"lead_ids": list(lead_ids)},
    ).all()
    return dict(rows)
