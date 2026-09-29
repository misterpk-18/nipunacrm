"""Pipeline (sidebar #3): person cards. POST /leads/{id}/stage also moves the lead's card."""
from flask import Blueprint

from controllers import pipeline as pipeline_controller
from routes.decorators import login_required, require_roles
from services.context import LEAD_ROLES

pipeline_bp = Blueprint("pipeline", __name__)


@pipeline_bp.get("/pipeline")
@login_required
@require_roles(*LEAD_ROLES)
def get_pipeline():
    return pipeline_controller.get_pipeline()


@pipeline_bp.get("/pipeline/next-actions")
@login_required
@require_roles(*LEAD_ROLES)
def get_next_actions():
    return pipeline_controller.next_actions()


@pipeline_bp.get("/pipeline-entries/<int:entry_id>")
@login_required
@require_roles(*LEAD_ROLES)
def get_pipeline_entry(entry_id: int):
    return pipeline_controller.get_entry(entry_id)


@pipeline_bp.patch("/pipeline-entries/<int:entry_id>")
@login_required
@require_roles(*LEAD_ROLES)
def update_pipeline_entry(entry_id: int):
    return pipeline_controller.update_entry(entry_id)


@pipeline_bp.post("/pipeline-entries/<int:entry_id>/stage")
@login_required
@require_roles(*LEAD_ROLES)
def change_pipeline_entry_stage(entry_id: int):
    return pipeline_controller.change_stage(entry_id)
