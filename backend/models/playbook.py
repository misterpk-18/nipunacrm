"""CRM AI sales playbook (db 031): objections, approved sales knowledge, course paths, AI branch controls, the AI
action record, and the response-clock / contact-counter views."""
from datetime import date, datetime, time
from typing import Any

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, String, Text, Time
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.access import User
from models.courses import Course
from models.enums import (
    AiActionStatus, AiActionType, AiExecutionProfile, AppLanguage, BatchStatus, DeliveryMode, IntakeStatus, KnowledgeKind, ObjectionCategory,
    ObjectionStatus, PlaybookReviewStatus, ReplySituation,
)
from models.leads import user_summary
from models.masters import Branch


class LeadObjection(db.Model):
    __tablename__ = "lead_objections"

    objection_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    lead_id: Mapped[int] = mapped_column(Integer, ForeignKey("leads.lead_id"))
    learner_words: Mapped[str] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(ObjectionCategory)
    category_suggested: Mapped[bool] = mapped_column(Boolean, default=False)
    action_taken: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(ObjectionStatus, default="Open")
    resolution: Mapped[str | None] = mapped_column(Text)
    resolved_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    creator: Mapped[User | None] = relationship(foreign_keys=[created_by], lazy="joined")
    resolver: Mapped[User | None] = relationship(foreign_keys=[resolved_by], lazy="joined")

    def to_dict(self) -> dict:
        return {"objection_id": self.objection_id, "lead_id": self.lead_id, "learner_words": self.learner_words,
                "category": self.category, "category_suggested": self.category_suggested,
                "action_taken": self.action_taken, "status": self.status, "resolution": self.resolution,
                "resolved_by": user_summary(self.resolver), "resolved_at": self.resolved_at,
                "created_by": user_summary(self.creator), "created_at": self.created_at}


class SalesKnowledge(db.Model):
    __tablename__ = "sales_knowledge"

    knowledge_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(KnowledgeKind)
    title: Mapped[str] = mapped_column(String(200))
    course_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("courses.course_id"))
    branch_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    situation: Mapped[str | None] = mapped_column(ReplySituation)
    language: Mapped[str] = mapped_column(AppLanguage, default="English")
    body: Mapped[str] = mapped_column(Text)
    link_url: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(PlaybookReviewStatus, default="Draft")
    version: Mapped[int] = mapped_column(Integer, default=1)
    owner_user_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    approved_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_due_on: Mapped[date | None] = mapped_column(Date)
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    course: Mapped[Course | None] = relationship(lazy="joined")
    branch: Mapped[Branch | None] = relationship(lazy="joined")
    owner: Mapped[User | None] = relationship(foreign_keys=[owner_user_id], lazy="joined")
    approver: Mapped[User | None] = relationship(foreign_keys=[approved_by], lazy="joined")

    def is_stale(self, today: date) -> bool:
        return self.review_due_on is not None and self.review_due_on < today

    def to_dict(self, today: date | None = None) -> dict:
        return {"knowledge_id": self.knowledge_id, "kind": self.kind, "title": self.title,
                "course": self.course.to_summary() if self.course else None,
                "branch": self.branch.to_summary() if self.branch else None, "situation": self.situation,
                "language": self.language, "body": self.body, "link_url": self.link_url, "status": self.status,
                "version": self.version, "owner": user_summary(self.owner), "approved_by": user_summary(self.approver),
                "approved_at": self.approved_at, "review_due_on": self.review_due_on,
                "is_stale": self.is_stale(today) if today else None, "updated_at": self.updated_at}


class CoursePath(db.Model):
    __tablename__ = "course_paths"

    course_path_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    from_course_id: Mapped[int] = mapped_column(Integer, ForeignKey("courses.course_id"))
    to_course_id: Mapped[int] = mapped_column(Integer, ForeignKey("courses.course_id"))
    learner_benefit: Mapped[str] = mapped_column(Text)
    helps_when: Mapped[str | None] = mapped_column(Text)
    skip_when: Mapped[str | None] = mapped_column(Text)
    prerequisites: Mapped[str | None] = mapped_column(Text)
    suggested_question: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(PlaybookReviewStatus, default="Draft")
    approved_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    from_course: Mapped[Course] = relationship(foreign_keys=[from_course_id], lazy="joined")
    to_course: Mapped[Course] = relationship(foreign_keys=[to_course_id], lazy="joined")
    approver: Mapped[User | None] = relationship(foreign_keys=[approved_by], lazy="joined")

    def to_dict(self) -> dict:
        return {"course_path_id": self.course_path_id, "from_course": self.from_course.to_summary(),
                "to_course": self.to_course.to_summary(), "learner_benefit": self.learner_benefit,
                "helps_when": self.helps_when, "skip_when": self.skip_when, "prerequisites": self.prerequisites,
                "suggested_question": self.suggested_question, "status": self.status,
                "approved_by": user_summary(self.approver), "approved_at": self.approved_at,
                "updated_at": self.updated_at}


class AiBranchControl(db.Model):
    __tablename__ = "ai_branch_controls"

    branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"), primary_key=True)
    execution_profile: Mapped[str] = mapped_column(AiExecutionProfile, default="Assist")
    is_paused: Mapped[bool] = mapped_column(Boolean, default=False)
    pause_reason: Mapped[str | None] = mapped_column(Text)
    paused_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    paused_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    branch: Mapped[Branch] = relationship(lazy="joined")
    pauser: Mapped[User | None] = relationship(foreign_keys=[paused_by], lazy="joined")

    def to_dict(self) -> dict:
        return {"branch": self.branch.to_summary(), "execution_profile": self.execution_profile,
                "is_paused": self.is_paused, "pause_reason": self.pause_reason, "paused_by": user_summary(self.pauser),
                "paused_at": self.paused_at, "updated_at": self.updated_at}


class AiAction(db.Model):
    __tablename__ = "ai_actions"

    ai_action_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    action_type: Mapped[str] = mapped_column(AiActionType)
    action_code: Mapped[str] = mapped_column(String(80))
    fingerprint: Mapped[str] = mapped_column(String(64))
    lead_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("leads.lead_id"))
    person_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("persons.person_id"))
    branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    owner_user_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    course_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("courses.course_id"))
    suggestion: Mapped[str] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text)
    evidence: Mapped[Any] = mapped_column(JSONB, default=list)
    draft_text: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[Any] = mapped_column(JSONB)
    record_version: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(AiActionStatus, default="Suggested")
    final_text: Mapped[str | None] = mapped_column(Text)
    disposition_note: Mapped[str | None] = mapped_column(Text)
    disposition_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    disposition_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    remind_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    policy_version: Mapped[str] = mapped_column(String(30), default="playbook-2.0")
    prompt_version: Mapped[str | None] = mapped_column(String(30))
    model: Mapped[str | None] = mapped_column(String(100))
    execution_result: Mapped[str | None] = mapped_column(Text)
    failure_reason: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    course: Mapped[Course | None] = relationship(lazy="joined")
    decider: Mapped[User | None] = relationship(foreign_keys=[disposition_by], lazy="joined")

    def to_dict(self) -> dict:
        return {"ai_action_id": self.ai_action_id, "action_type": self.action_type, "action_code": self.action_code,
                "fingerprint": self.fingerprint, "lead_id": self.lead_id, "person_id": self.person_id,
                "branch_id": self.branch_id, "owner_user_id": self.owner_user_id,
                "course": self.course.to_summary() if self.course else None, "suggestion": self.suggestion,
                "reason": self.reason, "evidence": self.evidence, "draft_text": self.draft_text,
                "payload": self.payload, "record_version": self.record_version, "status": self.status,
                "final_text": self.final_text, "disposition_note": self.disposition_note,
                "disposition_by": user_summary(self.decider), "disposition_at": self.disposition_at,
                "remind_at": self.remind_at, "expires_at": self.expires_at, "policy_version": self.policy_version,
                "prompt_version": self.prompt_version, "model": self.model, "execution_result": self.execution_result,
                "failure_reason": self.failure_reason, "created_at": self.created_at,
                "requires_human_review": True}


class LeadResponseClock(db.Model):
    """First-attempt SLA per lead (view)."""

    __tablename__ = "lead_response_clock"

    lead_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    branch_id: Mapped[int] = mapped_column(Integer)
    assigned_to: Mapped[int | None] = mapped_column(Integer)
    intake_status: Mapped[str] = mapped_column(IntakeStatus)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    attempted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempted_by: Mapped[int | None] = mapped_column(Integer)
    is_eligible: Mapped[bool] = mapped_column(Boolean)
    cover_alert_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    manager_alert_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    founder_alert_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    sla_state: Mapped[str] = mapped_column(String(30))

    def to_dict(self) -> dict:
        return {"captured_at": self.captured_at, "due_at": self.due_at, "attempted_at": self.attempted_at,
                "is_eligible": self.is_eligible, "cover_alert_at": self.cover_alert_at,
                "manager_alert_at": self.manager_alert_at, "founder_alert_at": self.founder_alert_at,
                "sla_state": self.sla_state}


class LeadContactCounter(db.Model):
    """Shared outbound attempt counters (view)."""

    __tablename__ = "lead_contact_counters"

    lead_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    never_reached: Mapped[bool] = mapped_column(Boolean)
    outbound_calls: Mapped[int] = mapped_column(Integer)
    outbound_whatsapp: Mapped[int] = mapped_column(Integer)
    outbound_attempts: Mapped[int] = mapped_column(Integer)
    last_outbound_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_inbound_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class OfferableBatch(db.Model):
    """Batches sales may name to a learner (view, db 032): Planned / Open, not Blocked in the LMS, a seat left."""

    __tablename__ = "offerable_batches"

    batch_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_code: Mapped[str] = mapped_column(String(30))
    lms_course_id: Mapped[str | None] = mapped_column(String(100))
    course_id: Mapped[int] = mapped_column(Integer)
    branch_id: Mapped[int] = mapped_column(Integer)
    delivery_mode: Mapped[str] = mapped_column(DeliveryMode)
    status: Mapped[str] = mapped_column(BatchStatus)
    start_date: Mapped[date] = mapped_column(Date)
    schedule_days: Mapped[str | None] = mapped_column(String(50))
    start_time: Mapped[time | None] = mapped_column(Time)
    end_time: Mapped[time | None] = mapped_column(Time)
    location: Mapped[str | None] = mapped_column(String(255))
    capacity: Mapped[int] = mapped_column(Integer)
    seats_left: Mapped[int] = mapped_column(Integer)
    lms_readiness: Mapped[str | None] = mapped_column(String(30))
    lms_readiness_reason: Mapped[str | None] = mapped_column(Text)
    is_offerable: Mapped[bool] = mapped_column(Boolean)
    not_offerable_reason: Mapped[str | None] = mapped_column(Text)
    timing_confirmed: Mapped[bool] = mapped_column(Boolean)

    def timing(self) -> str:
        if not self.timing_confirmed:
            return "Timing not confirmed: ask the Branch Manager"
        return f"{self.schedule_days} · {self.start_time:%H:%M}–{self.end_time:%H:%M}" + (f" · {self.location}" if self.location else "")

    def to_dict(self) -> dict:
        return {"batch_id": self.batch_id, "batch_code": self.batch_code, "lms_batch_code": self.lms_course_id,
                "delivery_mode": self.delivery_mode, "status": self.status, "start_date": self.start_date,
                "schedule_days": self.schedule_days,
                "start_time": self.start_time.strftime("%H:%M") if self.start_time else None,
                "end_time": self.end_time.strftime("%H:%M") if self.end_time else None,
                "location": self.location, "seats_left": self.seats_left, "is_offerable": self.is_offerable,
                "not_offerable_reason": self.not_offerable_reason, "timing_confirmed": self.timing_confirmed,
                "timing": self.timing()}
