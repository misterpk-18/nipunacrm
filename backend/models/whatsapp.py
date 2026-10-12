"""WhatsApp outbox (db 033): template messages to learners, written in the same transaction as the change they report."""
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, SmallInteger, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.enums import WhatsappStatus


class WhatsappOutbox(db.Model):
    """The message (template, values, text, number) is fixed once written (trigger); only the delivery columns change."""

    __tablename__ = "whatsapp_outbox"

    outbox_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    event_key: Mapped[str] = mapped_column(String(120), unique=True)
    template_name: Mapped[str] = mapped_column(String(80))
    language: Mapped[str] = mapped_column(String(10), default="en")
    category: Mapped[str] = mapped_column(String(20), default="Utility")
    person_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("persons.person_id"))  # None: an LMS message to
    branch_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("branches.branch_id"))  # someone not in the CRM (db 045)
    to_phone: Mapped[str | None] = mapped_column(String(20))
    recipient_user_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))  # set = a staff alert (db 042)
    params: Mapped[dict[str, Any]] = mapped_column(JSONB)
    body_text: Mapped[str] = mapped_column(Text)
    source_type: Mapped[str] = mapped_column(String(30))
    source_id: Mapped[int | None] = mapped_column(Integer)
    secret_params: Mapped[dict[str, Any] | None] = mapped_column(JSONB)  # LMS reset codes / tokens; cleared once sent (db 045)
    status: Mapped[str] = mapped_column(WhatsappStatus, default="Queued")
    skip_reason: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    provider_message_id: Mapped[str | None] = mapped_column(String(200))
    last_http_status: Mapped[int | None] = mapped_column(SmallInteger)
    last_error: Mapped[str | None] = mapped_column(Text)
    queued_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    person: Mapped["Person"] = relationship("Person", lazy="joined")
    branch: Mapped["Branch"] = relationship("Branch", lazy="joined")
    recipient: Mapped["User | None"] = relationship("User", foreign_keys=[recipient_user_id])

    def to_dict(self) -> dict:
        return {
            "outbox_id": self.outbox_id, "person_name": self.person.full_name if self.person else None,
            "branch_name": self.branch.branch_name if self.branch else None, "event_key": self.event_key,
            "template_name": self.template_name, "sent_by": "LMS" if self.source_type == "lms" else "CRM",
            "category": self.category, "person_id": self.person_id, "branch_id": self.branch_id,
            "to_phone": self.to_phone, "recipient_user_id": self.recipient_user_id,
            "recipient_kind": "Staff" if self.recipient_user_id else "Learner" if self.person_id else "Not in the CRM",
            "recipient_name": self.recipient.full_name if self.recipient else None, "body_text": self.body_text, "source_type": self.source_type,
            "source_id": self.source_id, "status": self.status, "skip_reason": self.skip_reason,
            "attempts": self.attempts, "provider_message_id": self.provider_message_id,
            "last_error": self.last_error, "created_at": self.created_at, "sent_at": self.sent_at,
            "delivered_at": self.delivered_at, "read_at": self.read_at,
        }


class WhatsappWebhookLog(db.Model):
    """What the provider's callbacks sent (db 034), kept 30 days, so its real format can be checked."""

    __tablename__ = "whatsapp_webhook_log"

    log_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    kind: Mapped[str] = mapped_column(String(20))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    result: Mapped[str | None] = mapped_column(String(300))
