"""Tasks (+ task_board view), notifications and rules, communications inbox and branch channels."""
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.access import Role, User
from models.enums import (
    ActivityDirection, CommDeliveryStatus, CommMatchStatus, ExternalDeliveryStatus, IntegrationMode,
    NotificationCategory, TaskSource, TaskStatus,
)
from models.leads import user_summary
from models.masters import Branch, ContactChannel, TaskType


class Task(db.Model):
    __tablename__ = "tasks"

    CLOSED_STATUSES = ("Completed", "Cancelled")

    task_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    task_type_id: Mapped[int] = mapped_column(Integer, ForeignKey("task_types.task_type_id"))
    title: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    owner_user_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    team_role_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("roles.role_id"))
    status: Mapped[str] = mapped_column(TaskStatus, default="Open")
    source: Mapped[str] = mapped_column(TaskSource, default="Manual")
    dedupe_key: Mapped[str | None] = mapped_column(String(200), unique=True)
    original_due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revised_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revision_reason: Mapped[str | None] = mapped_column(Text)
    blocked_reason: Mapped[str | None] = mapped_column(Text)
    lead_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("leads.lead_id"))
    demo_id: Mapped[int | None] = mapped_column(Integer)
    fee_discussion_id: Mapped[int | None] = mapped_column(Integer)
    scr_id: Mapped[int | None] = mapped_column(Integer)
    admission_id: Mapped[int | None] = mapped_column(Integer)
    payment_id: Mapped[int | None] = mapped_column(Integer)
    refund_case_id: Mapped[int | None] = mapped_column(Integer)
    document_id: Mapped[int | None] = mapped_column(Integer)
    communication_id: Mapped[int | None] = mapped_column(BigInteger)
    support_case_id: Mapped[int | None] = mapped_column(Integer)
    enquiry_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("enquiries.enquiry_id"))
    invoice_id: Mapped[int | None] = mapped_column(Integer)
    correction_request_id: Mapped[int | None] = mapped_column(Integer)
    completed_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancel_reason: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    task_type: Mapped[TaskType] = relationship(lazy="joined")
    team_role: Mapped[Role | None] = relationship(lazy="joined")
    owner: Mapped[User | None] = relationship(foreign_keys=[owner_user_id], lazy="joined")

    # Linked-record columns (a task links to at most one)
    LINK_FIELDS = ("lead_id", "demo_id", "fee_discussion_id", "scr_id", "admission_id", "payment_id",
                   "refund_case_id", "document_id", "communication_id", "support_case_id", "enquiry_id", "invoice_id",
                   "correction_request_id")

    @property
    def is_open(self) -> bool:
        return self.status not in self.CLOSED_STATUSES

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "task_type": self.task_type.label,
            "title": self.title,
            "description": self.description,
            "branch_id": self.branch_id,
            "owner_user_id": self.owner_user_id,
            "owner": user_summary(self.owner),
            "team_role": self.team_role.role_code if self.team_role else None,
            "status": self.status,
            "source": self.source,
            "original_due_at": self.original_due_at,
            "revised_due_at": self.revised_due_at,
            "revision_reason": self.revision_reason,
            "due_at": self.revised_due_at or self.original_due_at,
            "blocked_reason": self.blocked_reason,
            "cancel_reason": self.cancel_reason,
            "linked": {field: getattr(self, field) for field in self.LINK_FIELDS if getattr(self, field) is not None},
            "completed_by": self.completed_by,
            "completed_at": self.completed_at,
            "created_at": self.created_at,
        }


class TaskBoard(db.Model):
    """Read-only view: due date (revised or original), overdue / due today / unassigned, linked record code."""

    __tablename__ = "task_board"

    task_id: Mapped[int] = mapped_column(Integer, ForeignKey("tasks.task_id"), primary_key=True)
    task_type: Mapped[str] = mapped_column(String(100))
    title: Mapped[str] = mapped_column(String(255))
    branch_id: Mapped[int] = mapped_column(Integer)
    owner_user_id: Mapped[int | None] = mapped_column(Integer)
    team_role_id: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(TaskStatus)
    original_due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revised_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    is_overdue: Mapped[bool] = mapped_column(Boolean)
    is_due_today: Mapped[bool] = mapped_column(Boolean)
    is_unassigned: Mapped[bool] = mapped_column(Boolean)
    linked_record: Mapped[str | None] = mapped_column(String(50))

    task: Mapped[Task] = relationship(lazy="joined", viewonly=True)

    def to_dict(self) -> dict:
        return {**self.task.to_dict(), "is_overdue": self.is_overdue, "is_due_today": self.is_due_today,
                "is_unassigned": self.is_unassigned, "linked_record": self.linked_record}


class NotificationRule(db.Model):
    __tablename__ = "notification_rules"

    rule_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    rule_code: Mapped[str] = mapped_column(String(50), unique=True)
    event_type: Mapped[str] = mapped_column(String(50))
    description: Mapped[str | None] = mapped_column(Text)
    recipient_role_id: Mapped[int] = mapped_column(Integer, ForeignKey("roles.role_id"))
    category: Mapped[str] = mapped_column(NotificationCategory, default="Action Required")
    warn_after_minutes: Mapped[int | None] = mapped_column(Integer)
    escalate_after_minutes: Mapped[int | None] = mapped_column(Integer)
    escalate_to_role_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("roles.role_id"))
    send_whatsapp: Mapped[bool] = mapped_column(Boolean, default=False)
    send_email: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    recipient_role: Mapped[Role] = relationship(foreign_keys=[recipient_role_id], lazy="joined")
    escalate_to_role: Mapped[Role | None] = relationship(foreign_keys=[escalate_to_role_id], lazy="joined")

    def to_dict(self) -> dict:
        return {
            "rule_id": self.rule_id,
            "rule_code": self.rule_code,
            "event_type": self.event_type,
            "description": self.description,
            "recipient_role": self.recipient_role.role_code,
            "category": self.category,
            "warn_after_minutes": self.warn_after_minutes,
            "escalate_after_minutes": self.escalate_after_minutes,
            "escalate_to_role": self.escalate_to_role.role_code if self.escalate_to_role else None,
            "send_whatsapp": self.send_whatsapp,
            "send_email": self.send_email,
            "is_active": self.is_active,
        }


class Notification(db.Model):
    """Delivery, read, acknowledgement and action completion are tracked separately."""

    __tablename__ = "notifications"

    notification_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    rule_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("notification_rules.rule_id"))
    category: Mapped[str] = mapped_column(NotificationCategory, default="Information")
    event_key: Mapped[str] = mapped_column(String(200))
    purpose: Mapped[str] = mapped_column(String(50), default="notify")
    entity_type: Mapped[str] = mapped_column(String(50))
    entity_id: Mapped[str] = mapped_column(String(50))
    recipient_user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.user_id"))
    branch_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    title: Mapped[str] = mapped_column(String(255))
    body: Mapped[str | None] = mapped_column(Text)
    is_action_required: Mapped[bool] = mapped_column(Boolean, default=False)
    delivered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    action_completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    warn_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    escalate_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    escalated_from_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("notifications.notification_id"))
    external_channel: Mapped[str | None] = mapped_column(String(20))
    external_status: Mapped[str] = mapped_column(ExternalDeliveryStatus, default="Not Sent")
    external_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    external_failure_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    def to_dict(self) -> dict:
        return {
            "notification_id": self.notification_id,
            "category": self.category,
            "title": self.title,
            "body": self.body,
            "entity_type": self.entity_type,
            "entity_id": self.entity_id,
            "branch_id": self.branch_id,
            "is_action_required": self.is_action_required,
            "delivered_at": self.delivered_at,
            "read_at": self.read_at,
            "acknowledged_at": self.acknowledged_at,
            "action_completed_at": self.action_completed_at,
            "warn_at": self.warn_at,
            "escalate_at": self.escalate_at,
            "escalated_at": self.escalated_at,
            "escalated_from_id": self.escalated_from_id,
            "external_channel": self.external_channel,
            "external_status": self.external_status,
        }


class BranchChannel(db.Model):
    """A branch's WhatsApp number / email / phone line."""

    __tablename__ = "branch_channels"

    branch_channel_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    contact_channel_id: Mapped[int] = mapped_column(Integer, ForeignKey("contact_channels.contact_channel_id"))
    address: Mapped[str] = mapped_column(String(255))
    mode: Mapped[str] = mapped_column(IntegrationMode, default="Manual")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    branch: Mapped[Branch] = relationship(lazy="joined")
    channel: Mapped[ContactChannel] = relationship(lazy="joined")

    def to_dict(self) -> dict:
        return {"branch_channel_id": self.branch_channel_id, "branch": self.branch.to_summary(),
                "channel": self.channel.label, "contact_channel_id": self.contact_channel_id, "address": self.address,
                "mode": self.mode, "is_active": self.is_active}


class Communication(db.Model):
    __tablename__ = "communications"

    communication_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    contact_channel_id: Mapped[int] = mapped_column(Integer, ForeignKey("contact_channels.contact_channel_id"))
    direction: Mapped[str] = mapped_column(ActivityDirection)
    from_address: Mapped[str | None] = mapped_column(String(255))
    to_address: Mapped[str | None] = mapped_column(String(255))
    subject: Mapped[str | None] = mapped_column(String(255))
    body: Mapped[str | None] = mapped_column(Text)
    call_duration_seconds: Mapped[int | None] = mapped_column(Integer)
    delivery_status: Mapped[str] = mapped_column(CommDeliveryStatus)
    failure_reason: Mapped[str | None] = mapped_column(Text)
    retry_of_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("communications.communication_id"))
    is_manual: Mapped[bool] = mapped_column(Boolean, default=True)
    external_message_id: Mapped[str | None] = mapped_column(String(255), unique=True)
    match_status: Mapped[str] = mapped_column(CommMatchStatus, default="Unmatched")
    person_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("persons.person_id"))
    lead_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("leads.lead_id"))
    matched_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    needs_response: Mapped[bool] = mapped_column(Boolean, default=False)
    response_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    handled_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    channel: Mapped[ContactChannel] = relationship(lazy="joined")

    def to_dict(self) -> dict:
        return {
            "communication_id": self.communication_id,
            "branch_id": self.branch_id,
            "channel": self.channel.label,
            "contact_channel_id": self.contact_channel_id,
            "direction": self.direction,
            "from_address": self.from_address,
            "to_address": self.to_address,
            "subject": self.subject,
            "body": self.body,
            "call_duration_seconds": self.call_duration_seconds,
            "delivery_status": self.delivery_status,
            "failure_reason": self.failure_reason,
            "retry_of_id": self.retry_of_id,
            "is_manual": self.is_manual,
            "match_status": self.match_status,
            "person_id": self.person_id,
            "lead_id": self.lead_id,
            "matched_by": self.matched_by,
            "needs_response": self.needs_response,
            "response_due_at": self.response_due_at,
            "responded_at": self.responded_at,
            "handled_by": self.handled_by,
            "occurred_at": self.occurred_at,
        }


class CommunicationInbox(db.Model):
    """Read-only view over communications with queue and SLA state."""

    __tablename__ = "communication_inbox"

    communication_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("communications.communication_id"), primary_key=True
    )
    branch_id: Mapped[int] = mapped_column(Integer)
    match_status: Mapped[str] = mapped_column(CommMatchStatus)
    needs_response: Mapped[bool] = mapped_column(Boolean)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    queue: Mapped[str] = mapped_column(String(30))
    sla_state: Mapped[str | None] = mapped_column(String(20))

    communication: Mapped[Communication] = relationship(lazy="joined", viewonly=True)

    def to_dict(self) -> dict:
        return {**self.communication.to_dict(), "queue": self.queue, "sla_state": self.sla_state}
