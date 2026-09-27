from flask import Blueprint

from controllers import health as health_controller

health_bp = Blueprint("health", __name__)


@health_bp.get("/health")
def get_health():
    return health_controller.get_health()
