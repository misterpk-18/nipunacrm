"""AI Copilot (#14) and Ask Nipuna."""
from flask import Blueprint

from controllers import ai as ai_controller
from routes.decorators import login_required, require_roles
from services.context import COUNSELLOR_ROLES, LEAD_ROLES, MANAGER_ROLES, STAFF_ROLES

ai_bp = Blueprint("ai", __name__)


@ai_bp.post("/leads/<int:lead_id>/ai/brief")
@login_required
@require_roles(*LEAD_ROLES)
def lead_brief(lead_id: int):
    return ai_controller.lead_brief(lead_id)


@ai_bp.get("/leads/<int:lead_id>/ai/insights")
@login_required
@require_roles(*LEAD_ROLES)
def lead_insights(lead_id: int):
    return ai_controller.lead_insights(lead_id)


@ai_bp.post("/ai/next-best-action")
@login_required
@require_roles(*COUNSELLOR_ROLES, "BRANCH_MANAGER")
def next_best_action():
    return ai_controller.next_best_action()


@ai_bp.post("/ai/ask")
@login_required
@require_roles(*MANAGER_ROLES, "ACCOUNTS")
def ask():
    return ai_controller.ask()


@ai_bp.post("/ai/feedback")
@login_required
@require_roles(*STAFF_ROLES)
def feedback():
    return ai_controller.feedback()


@ai_bp.get("/ai/management-brief")
@login_required
@require_roles(*MANAGER_ROLES)
def management_brief():
    return ai_controller.management_brief()
