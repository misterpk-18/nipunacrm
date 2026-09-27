"""Admin / Settings: integration status, incident register, audit log, deletion approvals, session control."""
from datetime import datetime, timezone

from sqlalchemy import select

from config.database import db
from models import (
    ActiveSession, AuditLog, BranchChannel, DeletionRequest, Document, Incident, IntegrationStatus, SavedView, User,
)
from repositories import sessions as sessions_repo
from repositories.common import paginate
from services import audit, storage
from services.context import current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError

# Record types a deletion request can remove (everything else is kept for history and corrected instead)
DELETABLE = {"document": Document, "saved_view": SavedView, "branch_channel": BranchChannel}


# ---------------------------------------------------------------- integrations

def list_integrations() -> list[IntegrationStatus]:
    return list(db.session.execute(select(IntegrationStatus).order_by(IntegrationStatus.service_name)).scalars())


def update_integration(code: str, data: dict) -> IntegrationStatus:
    row = db.session.get(IntegrationStatus, code.upper())
    if row is None:
        raise NotFound("Integration not found")
    old = row.to_dict()
    for field, value in data.items():
        setattr(row, field, value)
    if data.get("verification") == "Verified" and "last_successful_test_at" not in data:
        row.last_successful_test_at = datetime.now(timezone.utc)
    row.updated_by = current_user().user_id
    db.session.flush()
    audit.record("INTEGRATION_UPDATED", "integration", row.service_code, old=old, new=data)
    return row


# ---------------------------------------------------------------- incidents

def list_incidents(filters: dict, page: int, per_page: int):
    stmt = select(Incident).order_by(Incident.detected_at.desc())
    for field in ("status", "severity"):
        if filters.get(field):
            stmt = stmt.where(getattr(Incident, field) == filters[field])
    return paginate(stmt, page, per_page)


def save_incident(incident_id: int | None, data: dict) -> Incident:
    incident = Incident(created_by=current_user().user_id) if incident_id is None else db.session.get(Incident, incident_id)
    if incident is None:
        raise NotFound("Incident not found")
    for field, value in data.items():
        setattr(incident, field, value)
    db.session.add(incident)
    db.session.flush()  # code and resolved_at from the DB
    db.session.refresh(incident)
    audit.record("INCIDENT_SAVED", "incident", incident.incident_id, new=data)
    return incident


# ---------------------------------------------------------------- audit log

def audit_log(filters: dict, page: int, per_page: int):
    stmt = select(AuditLog).order_by(AuditLog.occurred_at.desc(), AuditLog.audit_id.desc())
    for field, column in (("entity_type", AuditLog.entity_type), ("entity_id", AuditLog.entity_id),
                          ("actor_id", AuditLog.actor_user_id), ("action", AuditLog.action),
                          ("branch_id", AuditLog.branch_id)):
        if filters.get(field) is not None:
            stmt = stmt.where(column == (str(filters[field]) if field == "entity_id" else filters[field]))
    if filters.get("from"):
        stmt = stmt.where(AuditLog.occurred_at >= filters["from"])
    if filters.get("to"):
        stmt = stmt.where(AuditLog.occurred_at <= filters["to"])
    return paginate(stmt, page, per_page)


# ---------------------------------------------------------------- deletion requests

def list_deletions(status: str | None, page: int, per_page: int):
    stmt = select(DeletionRequest).order_by(DeletionRequest.requested_at.desc())
    if status:
        stmt = stmt.where(DeletionRequest.status == status)
    return paginate(stmt, page, per_page)


def request_deletion(data: dict) -> DeletionRequest:
    model = DELETABLE.get(data["entity_type"])
    if model is None:
        raise ValidationError("This record type can't be deleted", {"entity_type": [f"One of: {', '.join(DELETABLE)}"]})
    if db.session.get(model, int(data["entity_id"])) is None:
        raise ValidationError("Record not found", {"entity_id": ["Not found"]})
    request = DeletionRequest(entity_type=data["entity_type"], entity_id=str(data["entity_id"]), reason=data["reason"],
                              requested_by=current_user().user_id)
    db.session.add(request)
    db.session.flush()
    audit.record("DELETION_REQUESTED", data["entity_type"], data["entity_id"], reason=data["reason"])
    return request


def _get_deletion(request_id: int) -> DeletionRequest:
    request = db.session.get(DeletionRequest, request_id)
    if request is None:
        raise NotFound("Deletion request not found")
    return request


def decide_deletion(request_id: int, approve: bool) -> DeletionRequest:
    request = _get_deletion(request_id)
    if request.status != "Pending":
        raise BusinessRule(f"Request is {request.status}")
    if request.requested_by == current_user().user_id:
        raise Forbidden("An independent approver must decide")
    request.status = "Approved" if approve else "Rejected"
    request.decided_by = current_user().user_id
    request.decided_at = datetime.now(timezone.utc)
    db.session.flush()
    audit.record("DELETION_APPROVED" if approve else "DELETION_REJECTED", request.entity_type, request.entity_id)
    return request


def execute_deletion(request_id: int) -> DeletionRequest:
    request = _get_deletion(request_id)
    if request.status != "Approved":
        raise BusinessRule("Only an approved request can be executed")
    record = db.session.get(DELETABLE[request.entity_type], int(request.entity_id))
    if record is not None:
        snapshot = record.to_dict()
        if isinstance(record, Document):
            _detach_document_tasks(record.document_id)
            storage.delete_file(record.file_path)
        db.session.delete(record)
        audit.record("RECORD_DELETED", request.entity_type, request.entity_id, old=snapshot)
    request.status = "Executed"
    request.executed_at = datetime.now(timezone.utc)
    db.session.flush()
    return request


def _detach_document_tasks(document_id: int) -> None:
    """Tasks keep their history: open ones are cancelled, all lose the link to the deleted file."""
    from models import Task

    for task in db.session.execute(select(Task).where(Task.document_id == document_id)).scalars():
        if task.is_open:
            task.status, task.cancel_reason = "Cancelled", "Document deleted"
        task.document_id = None
    db.session.flush()


# ---------------------------------------------------------------- sessions

def list_sessions(user_id: int | None) -> list[tuple[ActiveSession, User]]:
    stmt = (select(ActiveSession, User).join(User, User.user_id == ActiveSession.user_id)
            .order_by(ActiveSession.last_seen_at.desc()))
    if user_id:
        stmt = stmt.where(ActiveSession.user_id == user_id)
    return list(db.session.execute(stmt).all())


def revoke_session(session_id: str) -> None:
    session = sessions_repo.find_active(session_id)
    if session is None:
        raise NotFound("Session not found")
    sessions_repo.revoke(session_id, f"revoked by admin {current_user().user_id}")
    audit.record("SESSION_REVOKED_BY_ADMIN", "user", session.user_id, new={"session": session_id[:12]})
