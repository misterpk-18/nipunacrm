"""Tasks screen: my / team board, manual tasks, workflow actions, deadline revisions."""
from flask import request

from controllers.common import Validator, created, get_page_params, json_body, ok, paginated, require_changes
from models import Task
from models.enums import TASK_STATUSES
from services import tasks as tasks_service


def list_tasks():
    v = Validator(request.args.to_dict())
    v.choice("view", ("my", "team"), default="my")
    v.choice("status", TASK_STATUSES)
    v.boolean("overdue")
    v.boolean("unassigned")
    v.boolean("due_today")
    v.boolean("open")
    v.string("type", max_length=50, upper=True)
    v.integer("branch_id", min_value=1)
    v.integer("owner_user_id", min_value=1)
    _link_rules(v)
    page, per_page = get_page_params()
    rows, meta = tasks_service.list_tasks(v.validate(), page, per_page)
    return paginated([r.to_dict() for r in rows], meta)


def _link_rules(v: Validator) -> None:
    for field in Task.LINK_FIELDS:
        v.integer(field, min_value=1)


def create_task():
    v = Validator(json_body())
    v.integer("task_type_id", required=True, min_value=1)
    v.string("title", required=True, max_length=255)
    v.string("description", nullable=True)
    v.integer("branch_id", required=True, min_value=1)
    v.integer("owner_user_id", nullable=True, min_value=1)
    v.datetime("due_at", required=True)
    v.nested("link", _link_rules, nullable=True)
    return created(tasks_service.create_manual_task(v.validate()).to_dict())


def get_task(task_id: int):
    return ok(tasks_service.get_task(task_id).to_dict())


def update_task(task_id: int):
    v = Validator(json_body())
    v.string("title", max_length=255)
    v.string("description", nullable=True)
    v.integer("owner_user_id", nullable=True, min_value=1)
    return ok(tasks_service.update_task(task_id, require_changes(v.validate())).to_dict())


def transition(task_id: int, action: str):
    v = Validator(json_body())
    v.string("reason", required=action in ("block", "cancel"), nullable=action not in ("block", "cancel"))
    return ok(tasks_service.transition(task_id, action, v.validate().get("reason")).to_dict())


def revise_deadline(task_id: int):
    v = Validator(json_body())
    v.datetime("due_at", required=True)
    v.string("reason", required=True)
    data = v.validate()
    return ok(tasks_service.revise_deadline(task_id, data["due_at"], data["reason"]).to_dict())
