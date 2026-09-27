"""Pipeline: stages in order with counts and lead cards (Kanban) or rows (Table)."""
from flask import request

from controllers.common import Validator, get_page_params, ok, paginated
from models.enums import LEAD_PRIORITIES
from services import pipeline as pipeline_service
from services.context import current_user


def get_pipeline():
    args = request.args.to_dict()
    owner = args.pop("owner_id", None)
    v = Validator(args)
    v.choice("view", ("kanban", "table"), default="kanban")
    v.integer("branch_id", min_value=1)
    v.integer("course_id", min_value=1)
    v.integer("source_id", min_value=1)
    v.choice("priority", LEAD_PRIORITIES)
    v.string("q", max_length=100)
    v.integer("per_stage", default=20, min_value=1)
    filters = v.validate()
    view, per_stage = filters.pop("view"), min(filters.pop("per_stage"), 100)

    if owner == "me":
        filters["assigned_to"] = current_user().user_id
    elif owner == "unassigned":
        filters["assigned_to"] = None
    elif owner is not None:
        o = Validator({"owner_id": owner})
        o.integer("owner_id", min_value=1)
        filters["assigned_to"] = o.validate()["owner_id"]

    if view == "table":
        page, per_page = get_page_params()
        leads, meta = pipeline_service.table(filters, page, per_page)
        return paginated([lead.to_row() for lead in leads], meta)

    stages = pipeline_service.board(filters, per_stage)
    return ok({
        "total": sum(s["count"] for s in stages),
        "stages": [{**s, "leads": [lead.to_row() for lead in s["leads"]]} for s in stages],
    })
