"""LMS outbox (db 026): events for the Nipuna LMS, written in the same transaction as the change."""
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, DateTime, Integer, SmallInteger, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from config.database import db
from models.enums import LmsOutboxStatus


class LmsSyncVersion(db.Model):
    """One counter per record ('course:<id>', 'admission:<id>', 'finance:<id>'): the events' source_version."""

    __tablename__ = "lms_sync_versions"

    version_key: Mapped[str] = mapped_column(String(60), primary_key=True)
    version: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())


class LmsOutbox(db.Model):
    """The envelope (event_id … payload) is fixed once written (trigger); only the delivery columns change."""

    __tablename__ = "lms_outbox"

    outbox_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    event_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), unique=True, default=uuid.uuid4)
    event_type: Mapped[str] = mapped_column(String(40))
    record_key: Mapped[str] = mapped_column(String(60))
    source_version: Mapped[int] = mapped_column(Integer)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(LmsOutboxStatus, default="Pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_http_status: Mapped[int | None] = mapped_column(SmallInteger)
    last_error: Mapped[str | None] = mapped_column(Text)
    response_status: Mapped[str | None] = mapped_column(String(40))
    response_result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    activation_token_issued: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    def envelope(self) -> dict:
        """The request body: identical on every retry."""
        return {"event_id": str(self.event_id), "event_type": self.event_type, "source_version": self.source_version,
                "occurred_at": self.occurred_at.isoformat(), "data": self.payload}

    def to_dict(self) -> dict:
        return {
            "outbox_id": self.outbox_id, "event_id": str(self.event_id), "event_type": self.event_type,
            "record_key": self.record_key, "source_version": self.source_version, "occurred_at": self.occurred_at,
            "status": self.status, "attempts": self.attempts, "next_attempt_at": self.next_attempt_at,
            "last_http_status": self.last_http_status, "last_error": self.last_error,
            "response_status": self.response_status, "response_result": self.response_result,
            "activation_token_issued": self.activation_token_issued, "created_at": self.created_at,
            "delivered_at": self.delivered_at, "payload": self.payload,
        }


class LmsPullState(db.Model):
    """The status pull's watermark (db 028): one row; `since` is the LMS's last as_of, stored exactly as returned."""

    __tablename__ = "lms_pull_state"

    pull_state_id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, default=1)
    since: Mapped[str] = mapped_column(Text)
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_http_status: Mapped[int | None] = mapped_column(SmallInteger)
    last_error: Mapped[str | None] = mapped_column(Text)
    last_counts: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # a running pull's claim
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    def to_dict(self) -> dict:
        return {"since": self.since, "last_attempt_at": self.last_attempt_at, "last_success_at": self.last_success_at,
                "last_http_status": self.last_http_status, "last_error": self.last_error,
                "last_counts": self.last_counts}


class LmsPullHold(db.Model):
    """A pulled record that couldn't be applied yet; retried on every pull, replaced by a newer copy (db 028)."""

    __tablename__ = "lms_pull_holds"

    record_key: Mapped[str] = mapped_column(String(60), primary_key=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    reason: Mapped[str] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=1)
    first_held_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    last_tried_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    def to_dict(self) -> dict:
        return {"record_key": self.record_key, "reason": self.reason, "attempts": self.attempts,
                "first_held_at": self.first_held_at, "last_tried_at": self.last_tried_at}
