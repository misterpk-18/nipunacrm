"""Waiting for batch (admitted, not yet allocated in the LMS): read-only, branch-scoped."""
from flask import Blueprint

from controllers import batch_waiting as batch_waiting_controller
from routes.decorators import login_required, require_roles
from services.context import ACADEMIC_ROLES, COUNSELLOR_ROLES

batch_waiting_bp = Blueprint("batch_waiting", __name__)
WAITING_READERS = ACADEMIC_ROLES + COUNSELLOR_ROLES  # sales see their branch, read-only


@batch_waiting_bp.get("/batch-waiting")
@login_required
@require_roles(*WAITING_READERS)
def list_waiting():
    return batch_waiting_controller.list_waiting()
