"""Reports (#12), Target Master, Dashboard (#1) and Admin / Settings."""
from flask import Blueprint

from controllers import admin as admin_controller
from controllers import management as management_controller
from routes.decorators import fresh_auth, login_required, require_roles
from services.context import ADMIN_ROLES, COUNSELLOR_ROLES, MANAGER_ROLES, STAFF_ROLES

management_bp = Blueprint("management", __name__)
REPORT_ROLES = MANAGER_ROLES + ("ACCOUNTS",)


def route(rule: str, method: str, roles, fresh=False):
    def decorator(view):
        wrapped = fresh_auth(view) if fresh else view
        return getattr(management_bp, method)(rule)(login_required(require_roles(*roles)(wrapped)))
    return decorator


# ---------------------------------------------------------------- reports

@route("/reports/management", "get", REPORT_ROLES)
def management_report():
    return management_controller.management_report()


@route("/reports/funnel", "get", REPORT_ROLES)
def funnel_report():
    return management_controller.funnel_report()


@route("/reports/performance", "get", REPORT_ROLES)
def performance_report():
    return management_controller.performance_report()


@route("/reports/sla", "get", REPORT_ROLES)
def sla_report():
    return management_controller.sla_report()


@route("/reports/<any(management, funnel, performance, sla):name>/export", "get", REPORT_ROLES)
def export_report(name: str):
    return management_controller.export_report(name)


@route("/scheduled-reports", "get", ADMIN_ROLES)
def list_scheduled():
    return management_controller.list_scheduled()


@route("/scheduled-reports", "post", ADMIN_ROLES)
def create_scheduled():
    return management_controller.save_scheduled()


@route("/scheduled-reports/<int:report_id>", "patch", ADMIN_ROLES)
def update_scheduled(report_id: int):
    return management_controller.save_scheduled(report_id)


# ---------------------------------------------------------------- targets

@route("/targets", "get", REPORT_ROLES)
def list_targets():
    return management_controller.list_targets()


@route("/targets", "post", ADMIN_ROLES)
def create_target():
    return management_controller.create_target()


@route("/targets/achievement", "get", REPORT_ROLES)
def target_achievement():
    return management_controller.target_achievement()


@route("/targets/<int:version_id>", "get", REPORT_ROLES)
def get_target(version_id: int):
    return management_controller.get_target(version_id)


@route("/targets/<int:version_id>/approve", "post", ADMIN_ROLES, fresh=True)
def approve_target(version_id: int):
    return management_controller.approve_target(version_id)


# ---------------------------------------------------------------- dashboards

@route("/dashboard", "get", STAFF_ROLES)
def dashboard():
    return management_controller.dashboard()


@route("/dashboard/counsellor", "get", COUNSELLOR_ROLES + MANAGER_ROLES)
def counsellor_dashboard():
    return management_controller.counsellor_dashboard()


@route("/dashboard/overview", "get", STAFF_ROLES)
def dashboard_overview():
    return management_controller.dashboard_overview()


# ---------------------------------------------------------------- admin

@route("/integrations", "get", ADMIN_ROLES)
def list_integrations():
    return admin_controller.list_integrations()


@route("/integrations/<code>", "patch", ADMIN_ROLES)
def update_integration(code: str):
    return admin_controller.update_integration(code)


@route("/incidents", "get", ADMIN_ROLES)
def list_incidents():
    return admin_controller.list_incidents()


@route("/incidents", "post", ADMIN_ROLES)
def create_incident():
    return admin_controller.save_incident()


@route("/incidents/<int:incident_id>", "patch", ADMIN_ROLES)
def update_incident(incident_id: int):
    return admin_controller.save_incident(incident_id)


@route("/audit-log", "get", ADMIN_ROLES)
def audit_log():
    return admin_controller.audit_log()


@route("/deletion-requests", "get", ADMIN_ROLES)
def list_deletions():
    return admin_controller.list_deletions()


@route("/deletion-requests", "post", ADMIN_ROLES)
def request_deletion():
    return admin_controller.request_deletion()


@route("/deletion-requests/<int:request_id>/approve", "post", ADMIN_ROLES, fresh=True)
def approve_deletion(request_id: int):
    return admin_controller.decide_deletion(request_id, True)


@route("/deletion-requests/<int:request_id>/reject", "post", ADMIN_ROLES)
def reject_deletion(request_id: int):
    return admin_controller.decide_deletion(request_id, False)


@route("/deletion-requests/<int:request_id>/execute", "post", ADMIN_ROLES, fresh=True)
def execute_deletion(request_id: int):
    return admin_controller.execute_deletion(request_id)


@route("/admin/sessions", "get", ADMIN_ROLES)
def list_sessions():
    return admin_controller.list_sessions()


@route("/admin/sessions/<session_id>", "delete", ADMIN_ROLES, fresh=True)
def revoke_session(session_id: str):
    return admin_controller.revoke_session(session_id)
