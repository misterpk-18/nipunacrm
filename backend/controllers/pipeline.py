"""Pipeline: stages in order with counts and person cards (Kanban) or rows (Table); card stage / owner / follow-up."""
from flask import request

from controllers.common import Validator, get_page_params, json_body, ok, paginated
from models.enums import LEAD_PRIORITIES
from services import pipeline as pipeline_service
from services.context import current_user
from services.errors import ValidationError


def get_pipeline():
    args = request.args.to_dict()
    owner = args.pop("owner_id", None)
    v = Validator(args)
    v.choice("view", ("kanban", "table"), default="kanban")
    v.integer("branch_id", min_value=1)
    v.integer("course_id", min_value=1)
    v.integer("source_id", min_value=1)
    v.choice("priority", LEAD_PRIORITIES)
    v.choice("stage", pipeline_service.CHIP_STAGES)
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
        rows, meta = pipeline_service.table(filters, page, per_page)
        return paginated(rows, meta)
    return ok(pipeline_service.board(filters, per_stage))


def next_actions():
    v = Validator(request.args.to_dict())
    v.integer("branch_id", min_value=1)
    v.integer("course_id", min_value=1)
    v.string("q", max_length=100)
    return ok(pipeline_service.next_actions(v.validate()))


def get_entry(entry_id: int):
    entry = pipeline_service.get_entry(entry_id)
    details = pipeline_service.card_details([entry])[entry.pipeline_entry_id]
    return ok({**entry.to_dict(), "courses": details["courses"], "value": details["value"],
               "delivery_plan_status": details["delivery_plan_status"]})


def change_stage(entry_id: int):
    v = Validator(json_body())
    v.choice("stage", pipeline_service.CARD_STAGES, required=True)
    v.string("note", nullable=True, max_length=2000)
    v.integer("lost_reason_id", nullable=True, min_value=1)
    v.string("lost_competitor", nullable=True, max_length=150)
    v.string("lost_notes", nullable=True, max_length=2000)
    v.date("reactivation_date", nullable=True)
    return ok(pipeline_service.change_stage(entry_id, v.validate()).to_dict())


def update_entry(entry_id: int):
    v = Validator(json_body())
    v.integer("assigned_to", min_value=1)
    v.datetime("next_follow_up_at")
    v.date("expected_close_date", nullable=True)
    data = v.validate()
    if not data:
        raise ValidationError("Provide at least one field to update")
    return ok(pipeline_service.update_entry(entry_id, data).to_dict())
