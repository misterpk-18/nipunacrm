"""Demo schedule, booking, reschedule / cancel, outcome, reminders, extra-demo approval."""
from flask import request

from controllers.common import Validator, created, get_page_params, json_body, ok, paginated, require_changes
from models.enums import DEMO_MODES, DEMO_STATUSES, DEMO_TYPES
from services import demos as demos_service

RESCHEDULE_REASONS = ("Student requested", "Trainer unavailable", "Batch timing change", "Other")
CANCEL_REASONS = ("Student not available", "Duplicate booking", "Course changed", "Other")
OUTCOMES = ("Interested — fee discussion", "Needs another demo", "Considering other course", "Not interested",
            "No-show — reschedule attempt")


def _with_attended(demo, counts: dict, detail: bool = False) -> dict:
    data = demo.to_dict() if detail else demo.to_row()
    data["attended_demos"] = demos_service.attended_label(counts, demo.lead_id)
    return data


def list_demos():
    v = Validator(request.args.to_dict())
    v.date("from")
    v.date("to")
    v.integer("branch_id", min_value=1)
    v.integer("trainer_id", min_value=1)
    v.integer("lead_id", min_value=1)
    v.choice("status", DEMO_STATUSES)
    filters = v.validate()
    page, per_page = get_page_params()
    demos, meta, counts = demos_service.list_demos(filters, page, per_page)
    return paginated([_with_attended(d, counts) for d in demos], meta)


def get_demo(demo_id: int):
    demo = demos_service.get_demo(demo_id)
    return ok(demo.to_dict())


def schedule_demo(lead_id: int):
    v = Validator(json_body())
    v.datetime("scheduled_at", required=True)
    v.integer("course_id", nullable=True, min_value=1)
    v.choice("demo_type", DEMO_TYPES)
    v.integer("duration_minutes", min_value=1)
    v.choice("mode", DEMO_MODES)
    v.string("meeting_link", nullable=True, max_length=500)
    v.integer("trainer_user_id", nullable=True, min_value=1)
    v.integer("extra_demo_approved_by", nullable=True, min_value=1)
    return created(demos_service.schedule(lead_id, v.validate()).to_dict())


def update_demo(demo_id: int):
    v = Validator(json_body())
    v.integer("trainer_user_id", nullable=True, min_value=1)
    v.choice("mode", DEMO_MODES)
    v.string("meeting_link", nullable=True, max_length=500)
    v.integer("duration_minutes", min_value=1)
    return ok(demos_service.update(demo_id, require_changes(v.validate())).to_dict())


def confirm_demo(demo_id: int):
    return ok(demos_service.confirm(demo_id).to_dict())


def reschedule_demo(demo_id: int):
    v = Validator(json_body())
    v.datetime("scheduled_at", required=True)
    v.choice("reason", RESCHEDULE_REASONS, required=True)
    data = v.validate()
    return created(demos_service.reschedule(demo_id, data["scheduled_at"], data["reason"]).to_dict())


def cancel_demo(demo_id: int):
    v = Validator(json_body())
    v.choice("reason", CANCEL_REASONS, required=True)
    return ok(demos_service.cancel(demo_id, v.validate()["reason"]).to_dict())


def record_outcome(demo_id: int):
    v = Validator(json_body())
    v.choice("status", ("Attended", "No Show"), required=True)
    v.string("student_feedback", nullable=True)
    v.string("trainer_feedback", nullable=True)
    v.integer("rating", nullable=True, min_value=1, max_value=5)
    v.choice("outcome", OUTCOMES, nullable=True)
    v.integer("recommended_course_id", nullable=True, min_value=1)
    v.string("next_action", nullable=True)
    v.integer("commercial_owner_id", nullable=True, min_value=1)
    v.datetime("next_follow_up_at", required=True)
    return ok(demos_service.record_outcome(demo_id, v.validate()).to_dict())


def list_reminders(demo_id: int):
    return ok([r.to_dict() for r in demos_service.reminders(demo_id)])


def approve_extra(demo_id: int):
    return ok(demos_service.approve_extra(demo_id).to_dict())
