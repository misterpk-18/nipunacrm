"""Pipeline (sidebar #3). Stage changes reuse POST /leads/{id}/stage."""
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
