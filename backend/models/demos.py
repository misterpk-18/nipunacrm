"""Demos and their reminders (reminder rows are created and settled by database triggers)."""
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, SmallInteger, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.access import User
from models.courses import Course
from models.enums import DemoMode, DemoReminderState, DemoReminderType, DemoStatus, DemoType
from models.leads import Lead, user_summary
from models.masters import Branch


class Demo(db.Model):
    __tablename__ = "demos"

    OPEN_STATUSES = ("Scheduled", "Confirmed")

    demo_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    demo_code: Mapped[str] = mapped_column(String(20), unique=True)  # DM-GNT-0001, set by trigger
    lead_id: Mapped[int] = mapped_column(Integer, ForeignKey("leads.lead_id"))
    course_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("courses.course_id"))  # NULL = no course chosen
    branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    duration_minutes: Mapped[int] = mapped_column(SmallInteger, default=45)
    mode: Mapped[str] = mapped_column(DemoMode, default="In-person")
    meeting_link: Mapped[str | None] = mapped_column(String(500))
    trainer_user_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    status: Mapped[str] = mapped_column(DemoStatus, default="Scheduled")
    demo_type: Mapped[str] = mapped_column(DemoType, default="Standard")
    rescheduled_from_demo_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("demos.demo_id"))
    extra_demo_approved_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    student_feedback: Mapped[str | None] = mapped_column(Text)
    trainer_feedback: Mapped[str | None] = mapped_column(Text)
    rating: Mapped[int | None] = mapped_column(SmallInteger)
    outcome: Mapped[str | None] = mapped_column(String(100))
    recommended_course_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("courses.course_id"))
    next_action: Mapped[str | None] = mapped_column(Text)
    commercial_owner_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    next_follow_up_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    commercial_follow_up_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # set by trigger
    reschedule_reason: Mapped[str | None] = mapped_column(String(100))
    cancel_reason: Mapped[str | None] = mapped_column(String(100))
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    lead: Mapped[Lead] = relationship(lazy="joined")
    course: Mapped[Course | None] = relationship(foreign_keys=[course_id], lazy="joined")
    branch: Mapped[Branch] = relationship(lazy="joined")
    trainer: Mapped[User | None] = relationship(foreign_keys=[trainer_user_id], lazy="joined")
    commercial_owner: Mapped[User | None] = relationship(foreign_keys=[commercial_owner_id], lazy="joined")
    recommended_course: Mapped[Course | None] = relationship(foreign_keys=[recommended_course_id], lazy="joined")
    reminders: Mapped[list["DemoReminder"]] = relationship(lazy="selectin", order_by="DemoReminder.due_at")

    @property
    def is_open(self) -> bool:
        return self.status in self.OPEN_STATUSES

    def to_row(self) -> dict:
        return {
            "demo_id": self.demo_id,
            "demo_code": self.demo_code,
            "lead": {"lead_id": self.lead_id, "lead_code": self.lead.lead_code, "name": self.lead.person.full_name,
                     "stage": self.lead.stage},
            "course": self.course.to_summary() if self.course else None,
            "branch": self.branch.to_summary(),
            "scheduled_at": self.scheduled_at,
            "duration_minutes": self.duration_minutes,
            "demo_type": self.demo_type,
            "mode": self.mode,
            "trainer": user_summary(self.trainer),
            "status": self.status,
            "outcome": self.outcome,
        }

    def to_dict(self) -> dict:
        return {
            **self.to_row(),
            "meeting_link": self.meeting_link,
            "rescheduled_from_demo_id": self.rescheduled_from_demo_id,
            "extra_demo_approved_by": self.extra_demo_approved_by,
            "student_feedback": self.student_feedback,
            "trainer_feedback": self.trainer_feedback,
            "rating": self.rating,
            "recommended_course": self.recommended_course.to_summary() if self.recommended_course else None,
            "next_action": self.next_action,
            "commercial_owner": user_summary(self.commercial_owner),
            "next_follow_up_at": self.next_follow_up_at,
            "commercial_follow_up_due_at": self.commercial_follow_up_due_at,
            "reschedule_reason": self.reschedule_reason,
            "cancel_reason": self.cancel_reason,
            "reminders": [r.to_dict() for r in self.reminders],
            "created_at": self.created_at,
        }


class DemoReminder(db.Model):
    __tablename__ = "demo_reminders"

    reminder_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    demo_id: Mapped[int] = mapped_column(Integer, ForeignKey("demos.demo_id"))
    reminder_type: Mapped[str] = mapped_column(DemoReminderType)
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    state: Mapped[str] = mapped_column(DemoReminderState, default="Pending")
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_reason: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    def to_dict(self) -> dict:
        return {"reminder_id": self.reminder_id, "reminder_type": self.reminder_type, "due_at": self.due_at,
                "state": self.state, "sent_at": self.sent_at, "failure_reason": self.failure_reason, "note": self.note}
