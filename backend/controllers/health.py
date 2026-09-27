from controllers.common import ok
from services import health as health_service


def get_health():
    status = health_service.get_status()
    return ok(status, status=200 if status["database"] == "ok" else 503)
