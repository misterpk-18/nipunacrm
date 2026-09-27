"""Pipeline board: lead counts and cards per stage (Postgres enum order = pipeline order)."""
from sqlalchemy import Select, func, select

from config.database import db
from models import Lead
from repositories import leads as leads_repo


def stage_counts(filters: dict, branch_ids: set[int] | None) -> dict[str, int]:
    base = leads_repo.leads_stmt(filters, branch_ids).order_by(None).subquery()
    rows = db.session.execute(select(base.c.stage, func.count()).group_by(base.c.stage)).all()
    return {stage: count for stage, count in rows}


def stage_cards(filters: dict, branch_ids: set[int] | None, stage: str, limit: int) -> list[Lead]:
    stmt = (
        leads_repo.leads_stmt({**filters, "stage": stage}, branch_ids)
        .order_by(None)
        .order_by(Lead.next_follow_up_at.asc().nulls_last(), Lead.created_at.desc())
        .limit(limit)
    )
    return list(db.session.execute(stmt).scalars())


def table_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    return (
        leads_repo.leads_stmt(filters, branch_ids)
        .order_by(None)
        .order_by(Lead.stage, Lead.next_follow_up_at.asc().nulls_last(), Lead.lead_id.desc())
    )
