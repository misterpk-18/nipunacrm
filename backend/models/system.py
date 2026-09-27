"""Audit log and app settings."""
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from config.database import db
from models.enums import DeletionRequestStatus, IncidentSeverity, IncidentStatus, IntegrationState, VerificationState


class AuditLog(db.Model):
    """Append-only (UPDATE / DELETE are blocked by a trigger)."""

    __tablename__ = "audit_log"

    audit_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    actor_user_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    action: Mapped[str] = mapped_column(String(50))
    entity_type: Mapped[str] = mapped_column(String(50))
    entity_id: Mapped[str] = mapped_column(String(50))
    branch_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    old_values: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    new_values: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    reason: Mapped[str | None] = mapped_column(Text)
    ip_address: Mapped[str | None] = mapped_column(INET)

    def to_dict(self) -> dict:
        return {"audit_id": self.audit_id, "occurred_at": self.occurred_at, "actor_user_id": self.actor_user_id,
                "action": self.action, "entity_type": self.entity_type, "entity_id": self.entity_id,
                "branch_id": self.branch_id, "old_values": self.old_values, "new_values": self.new_values,
                "reason": self.reason, "ip_address": str(self.ip_address) if self.ip_address else None}


class AppSetting(db.Model):
    __tablename__ = "app_settings"

    setting_key: Mapped[str] = mapped_column(String(100), primary_key=True)
    setting_value: Mapped[Any] = mapped_column(JSONB)
    description: Mapped[str | None] = mapped_column(Text)
    updated_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    def to_dict(self) -> dict:
        return {"key": self.setting_key, "value": self.setting_value, "description": self.description,
                "updated_by": self.updated_by, "updated_at": self.updated_at}


class IntegrationStatus(db.Model):
    __tablename__ = "integration_status"

    service_code: Mapped[str] = mapped_column(String(50), primary_key=True)
    service_name: Mapped[str] = mapped_column(String(100))
    state: Mapped[str] = mapped_column(IntegrationState, default="Planned")
    verification: Mapped[str] = mapped_column(VerificationState, default="Pending Verification")
    last_successful_test_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)
    updated_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    def to_dict(self) -> dict:
        return {"service_code": self.service_code, "service_name": self.service_name, "state": self.state,
                "verification": self.verification, "last_successful_test_at": self.last_successful_test_at,
                "notes": self.notes, "updated_by": self.updated_by, "updated_at": self.updated_at}


class Incident(db.Model):
    """IR-00001 (trigger); resolving stamps resolved_at."""

    __tablename__ = "incidents"

    incident_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    incident_code: Mapped[str] = mapped_column(String(20), unique=True)
    title: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    severity: Mapped[str] = mapped_column(IncidentSeverity, default="Not Set")
    status: Mapped[str] = mapped_column(IncidentStatus, default="Open")
    owner_user_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    root_cause: Mapped[str | None] = mapped_column(Text)
    backup_reference: Mapped[str | None] = mapped_column(String(255))
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    FIELDS = ("title", "description", "severity", "status", "owner_user_id", "detected_at", "root_cause",
              "backup_reference")

    def to_dict(self) -> dict:
        return {"incident_id": self.incident_id, "incident_code": self.incident_code,
                **{f: getattr(self, f) for f in self.FIELDS}, "resolved_at": self.resolved_at,
                "created_by": self.created_by, "created_at": self.created_at}


class DeletionRequest(db.Model):
    """Sensitive deletion: an independent approver (never the requester) decides, then it's executed."""

    __tablename__ = "deletion_requests"

    request_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(50))
    entity_id: Mapped[str] = mapped_column(String(50))
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(DeletionRequestStatus, default="Pending")
    requested_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.user_id"))
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    decided_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    executed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    def to_dict(self) -> dict:
        return {"request_id": self.request_id, "entity_type": self.entity_type, "entity_id": self.entity_id,
                "reason": self.reason, "status": self.status, "requested_by": self.requested_by,
                "requested_at": self.requested_at, "decided_by": self.decided_by, "decided_at": self.decided_at,
                "executed_at": self.executed_at}
