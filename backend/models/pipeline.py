"""Pipeline cards: one per person per branch; the person's open courses (leads) share its stage (db 017)."""
from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Integer, SmallInteger, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.access import User
from models.enums import CLOSED_STAGES, LeadPriority, LeadStage
from models.leads import Lead, Person, user_summary
from models.masters import Branch, LostReason


class PipelineEntry(db.Model):
    __tablename__ = "pipeline_entries"

    pipeline_entry_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entry_code: Mapped[str] = mapped_column(String(20), unique=True)  # PL-GNT-00001, set by trigger
    person_id: Mapped[int] = mapped_column(Integer, ForeignKey("persons.person_id"))
    branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    stage: Mapped[str] = mapped_column(LeadStage)
    stage_changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    assigned_to: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    next_follow_up_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ai_priority: Mapped[str | None] = mapped_column(LeadPriority)
    ai_score: Mapped[int | None] = mapped_column(SmallInteger)
    lost_reason_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("lost_reasons.lost_reason_id"))
    lost_competitor: Mapped[str | None] = mapped_column(String(150))
    lost_notes: Mapped[str | None] = mapped_column(Text)
    reactivation_date: Mapped[date | None] = mapped_column(Date)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expected_close_date: Mapped[date | None] = mapped_column(Date)  # db 019, given at conversion
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    person: Mapped[Person] = relationship(lazy="joined")
    branch: Mapped[Branch] = relationship(lazy="joined")
    owner: Mapped[User | None] = relationship(foreign_keys=[assigned_to], lazy="joined")
    lost_reason: Mapped[LostReason | None] = relationship(lazy="joined")
    leads: Mapped[list[Lead]] = relationship(lazy="selectin", order_by=Lead.lead_id, viewonly=True)

    @property
    def is_open(self) -> bool:
        return self.stage not in CLOSED_STAGES

    @property
    def open_leads(self) -> list[Lead]:
        return [lead for lead in self.leads if lead.is_open]

    def to_summary(self) -> dict:
        return {"pipeline_entry_id": self.pipeline_entry_id, "entry_code": self.entry_code, "stage": self.stage}

    def to_row(self) -> dict:
        """Kanban card / table row: the person plus their open courses at this branch."""
        return {
            **self.to_summary(),
            "person": self.person.to_summary(),
            "branch": self.branch.to_summary(),
            "owner": user_summary(self.owner),
            "next_follow_up_at": self.next_follow_up_at,
            "ai_priority": self.ai_priority,
            "ai_score": self.ai_score,
            "stage_changed_at": self.stage_changed_at,
            "expected_close_date": self.expected_close_date,
            "courses": [
                {"lead_id": lead.lead_id, "lead_code": lead.lead_code,
                 "course": lead.course.to_summary() if lead.course else None, "stage": lead.stage}
                for lead in self.open_leads
            ],
        }

    def to_dict(self) -> dict:
        return {
            **self.to_row(),
            "is_open": self.is_open,
            "closed_at": self.closed_at,
            "leads": [lead.to_summary() for lead in self.leads],
            "lost": {
                "reason": self.lost_reason.label if self.lost_reason else None,
                "competitor": self.lost_competitor,
                "notes": self.lost_notes,
                "reactivation_date": self.reactivation_date,
            } if self.stage == "Lost - closed" else None,
            "created_at": self.created_at,
        }
