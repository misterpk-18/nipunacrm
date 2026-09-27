"""Pipeline (Kanban / Table) over the user's visible leads."""
from models.enums import LEAD_STAGES
from repositories import pipeline as pipeline_repo
from repositories.common import paginate
from services.context import current_user


def board(filters: dict, per_stage: int) -> list[dict]:
    branch_ids = current_user().branch_ids()
    counts = pipeline_repo.stage_counts(filters, branch_ids)
    return [
        {"stage": stage, "count": counts.get(stage, 0),
         "leads": pipeline_repo.stage_cards(filters, branch_ids, stage, per_stage) if counts.get(stage) else []}
        for stage in LEAD_STAGES
    ]


def table(filters: dict, page: int, per_page: int):
    return paginate(pipeline_repo.table_stmt(filters, current_user().branch_ids()), page, per_page)
