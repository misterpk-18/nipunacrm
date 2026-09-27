"""Admin / Settings: integrations, incidents, audit log, deletion requests, sessions."""
from flask import request

from controllers.common import Validator, created, get_page_params, json_body, no_content, ok, paginated, require_changes
from models.enums import (
    DELETION_REQUEST_STATUSES, INCIDENT_SEVERITIES, INCIDENT_STATUSES, INTEGRATION_STATES, VERIFICATION_STATES,
)
from services import admin as admin_service


def list_integrations():
    return ok([i.to_dict() for i in admin_service.list_integrations()])


def update_integration(code: str):
    v = Validator(json_body())
    v.choice("state", INTEGRATION_STATES)
    v.choice("verification", VERIFICATION_STATES)
    v.datetime("last_successful_test_at", nullable=True)
    v.string("notes", nullable=True)
    return ok(admin_service.update_integration(code, require_changes(v.validate())).to_dict())


def _incident_rules(v: Validator, creating: bool) -> None:
    v.string("title", required=creating, max_length=255)
    v.string("description", nullable=True)
    v.choice("severity", INCIDENT_SEVERITIES)
    v.choice("status", INCIDENT_STATUSES)
    v.integer("owner_user_id", nullable=True, min_value=1)
    v.datetime("detected_at")
    v.string("root_cause", nullable=True)
    v.string("backup_reference", nullable=True, max_length=255)


def list_incidents():
    v = Validator(request.args.to_dict())
    v.choice("status", INCIDENT_STATUSES)
    v.choice("severity", INCIDENT_SEVERITIES)
    page, per_page = get_page_params()
    rows, meta = admin_service.list_incidents(v.validate(), page, per_page)
    return paginated([r.to_dict() for r in rows], meta)


def save_incident(incident_id: int | None = None):
    v = Validator(json_body())
    _incident_rules(v, incident_id is None)
    data = v.validate() if incident_id is None else require_changes(v.validate())
    incident = admin_service.save_incident(incident_id, data)
    return created(incident.to_dict()) if incident_id is None else ok(incident.to_dict())


def audit_log():
    v = Validator(request.args.to_dict())
    v.string("entity_type", max_length=50)
    v.string("entity_id", max_length=50)
    v.integer("actor_id", min_value=1)
    v.string("action", max_length=50, upper=True)
    v.integer("branch_id", min_value=1)
    v.datetime("from")
    v.datetime("to")
    page, per_page = get_page_params()
    rows, meta = admin_service.audit_log(v.validate(), page, per_page)
    return paginated([r.to_dict() for r in rows], meta)


def list_deletions():
    v = Validator(request.args.to_dict())
    v.choice("status", DELETION_REQUEST_STATUSES)
    page, per_page = get_page_params()
    rows, meta = admin_service.list_deletions(v.validate().get("status"), page, per_page)
    return paginated([r.to_dict() for r in rows], meta)


def request_deletion():
    v = Validator(json_body())
    v.choice("entity_type", tuple(admin_service.DELETABLE), required=True)
    v.integer("entity_id", required=True, min_value=1)
    v.string("reason", required=True)
    return created(admin_service.request_deletion(v.validate()).to_dict())


def decide_deletion(request_id: int, approve: bool):
    return ok(admin_service.decide_deletion(request_id, approve).to_dict())


def execute_deletion(request_id: int):
    return ok(admin_service.execute_deletion(request_id).to_dict())


def list_sessions():
    v = Validator(request.args.to_dict())
    v.integer("user_id", min_value=1)
    rows = admin_service.list_sessions(v.validate().get("user_id"))
    return ok([{**s.to_dict(), "user": {"user_id": u.user_id, "full_name": u.full_name, "email": u.email}} for s, u in rows])


def revoke_session(session_id: str):
    admin_service.revoke_session(session_id)
    return no_content()
