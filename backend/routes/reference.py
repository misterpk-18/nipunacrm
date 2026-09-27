from flask import Blueprint

from controllers import reference as reference_controller
from routes.decorators import login_required

reference_bp = Blueprint("reference", __name__)


@reference_bp.get("/roles")
@login_required
def list_roles():
    return reference_controller.list_roles()


@reference_bp.get("/staff")
@login_required
def list_staff():
    return reference_controller.list_staff()
