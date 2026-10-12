"""Demos (sidebar #4)."""
from flask import Blueprint, request

from controllers import demos as demos_controller
from routes.decorators import login_required, require_roles
from services.context import DEMO_ROLES, LEAD_ROLES, current_user
from services.errors import Forbidden

demos_bp = Blueprint("demos", __name__)


@demos_bp.get("/demos")
@login_required
@require_roles(*DEMO_ROLES, "ACCOUNTS")
def list_demos():
    # Accounts only reads one lead's demos (read-only Lead 360), never the whole demo schedule
    user = current_user()
    if not user.has_role(*DEMO_ROLES) and request.args.get("lead_id") is None:
        raise Forbidden("You don't have access to this action")
    return demos_controller.list_demos()


@demos_bp.get("/demos/slots")
@login_required
@require_roles(*LEAD_ROLES)
def demo_slots():
    return demos_controller.slots()


@demos_bp.get("/demos/<int:demo_id>")
@login_required
@require_roles(*DEMO_ROLES)
def get_demo(demo_id: int):
    return demos_controller.get_demo(demo_id)


@demos_bp.post("/leads/<int:lead_id>/demos")
@login_required
@require_roles(*LEAD_ROLES)
def schedule_demo(lead_id: int):
    return demos_controller.schedule_demo(lead_id)


@demos_bp.patch("/demos/<int:demo_id>")
@login_required
@require_roles(*LEAD_ROLES)
def update_demo(demo_id: int):
    return demos_controller.update_demo(demo_id)


@demos_bp.post("/demos/<int:demo_id>/confirm")
@login_required
@require_roles(*LEAD_ROLES)
def confirm_demo(demo_id: int):
    return demos_controller.confirm_demo(demo_id)


@demos_bp.post("/demos/<int:demo_id>/reschedule")
@login_required
@require_roles(*LEAD_ROLES)
def reschedule_demo(demo_id: int):
    return demos_controller.reschedule_demo(demo_id)


@demos_bp.post("/demos/<int:demo_id>/cancel")
@login_required
@require_roles(*LEAD_ROLES)
def cancel_demo(demo_id: int):
    return demos_controller.cancel_demo(demo_id)


@demos_bp.post("/demos/<int:demo_id>/outcome")
@login_required
@require_roles(*LEAD_ROLES, "TRAINER")
def record_outcome(demo_id: int):
    return demos_controller.record_outcome(demo_id)


@demos_bp.get("/demos/<int:demo_id>/reminders")
@login_required
@require_roles(*DEMO_ROLES)
def list_reminders(demo_id: int):
    return demos_controller.list_reminders(demo_id)


@demos_bp.post("/demos/<int:demo_id>/approve-extra")
@login_required
@require_roles("BRANCH_MANAGER")
def approve_extra(demo_id: int):
    return demos_controller.approve_extra(demo_id)
