"""People and the sales pipeline: persons, enquiries, leads, lead activities, saved views, CSV imports."""
from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, SmallInteger, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.access import User
from models.courses import Course
from models.enums import (
    ActivityDirection, ActivityType, AppLanguage, CLOSED_STAGES, IntakeStatus, LeadImportRowResult, LeadImportStatus,
    LeadPriority, LeadStage,
)
from models.masters import Branch, ContactChannel, EntryMethod, LeadSource, LostReason


def user_summary(user: User | None) -> dict | None:
    return {"user_id": user.user_id, "full_name": user.full_name} if user else None


class Person(db.Model):
    """One canonical record per human; shared by enquiries, leads and admissions."""

    __tablename__ = "persons"

    person_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    person_code: Mapped[str] = mapped_column(String(20), unique=True)  # PER-GNT-00001, set by trigger
    full_name: Mapped[str] = mapped_column(String(150))
    phone: Mapped[str] = mapped_column(String(20))
    alternate_phone: Mapped[str | None] = mapped_column(String(20))
    email: Mapped[str | None] = mapped_column(String(255))
    city: Mapped[str | None] = mapped_column(String(100))
    highest_qualification: Mapped[str | None] = mapped_column(String(100))
    registered_branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    preferred_language: Mapped[str] = mapped_column(AppLanguage, default="English")
    whatsapp_number: Mapped[str | None] = mapped_column(String(20))  # NULL = same as mobile
    lms_user_id: Mapped[str | None] = mapped_column(String(100))
    lms_provisioned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    registered_branch: Mapped[Branch] = relationship(lazy="joined")

    def to_summary(self) -> dict:
        return {"person_id": self.person_id, "person_code": self.person_code, "full_name": self.full_name,
                "phone": self.phone, "email": self.email}

    def to_dict(self) -> dict:
        return {
            **self.to_summary(),
            "alternate_phone": self.alternate_phone,
            "whatsapp_number": self.whatsapp_number or self.phone,
            "city": self.city,
            "highest_qualification": self.highest_qualification,
            "preferred_language": self.preferred_language,
            "registered_branch": self.registered_branch.to_summary(),
            "created_at": self.created_at,
        }


class Enquiry(db.Model):
    """Every enquiry, including repeats. A lead keeps its original enquiry's source."""

    __tablename__ = "enquiries"

    enquiry_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    enquiry_code: Mapped[str] = mapped_column(String(20), unique=True)  # ENQ-00001, set by trigger
    lead_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("leads.lead_id"))
    person_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("persons.person_id"))
    branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    course_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("courses.course_id"))
    lead_source_id: Mapped[int] = mapped_column(Integer, ForeignKey("lead_sources.lead_source_id"))
    contact_channel_id: Mapped[int] = mapped_column(Integer, ForeignKey("contact_channels.contact_channel_id"))
    entry_method_id: Mapped[int] = mapped_column(Integer, ForeignKey("entry_methods.entry_method_id"))
    intake_status: Mapped[str] = mapped_column(IntakeStatus, default="New")
    is_genuine: Mapped[bool | None] = mapped_column(Boolean)
    owner_user_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    raw_name: Mapped[str | None] = mapped_column(String(150))
    raw_phone: Mapped[str | None] = mapped_column(String(20))
    raw_email: Mapped[str | None] = mapped_column(String(255))
    message: Mapped[str | None] = mapped_column(Text)
    communication_id: Mapped[int | None] = mapped_column(BigInteger)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    branch: Mapped[Branch] = relationship(lazy="joined")
    course: Mapped[Course | None] = relationship(lazy="joined")
    source: Mapped[LeadSource] = relationship(lazy="joined")
    channel: Mapped[ContactChannel] = relationship(lazy="joined")
    entry_method: Mapped[EntryMethod] = relationship(lazy="joined")
    owner: Mapped[User | None] = relationship(foreign_keys=[owner_user_id], lazy="joined")
    lead: Mapped["Lead | None"] = relationship(foreign_keys=[lead_id], lazy="joined")

    def to_dict(self) -> dict:
        return {
            "enquiry_id": self.enquiry_id,
            "enquiry_code": self.enquiry_code,
            "lead_id": self.lead_id,
            "lead_code": self.lead.lead_code if self.lead else None,
            "person_id": self.person_id,
            "branch": self.branch.to_summary(),
            "course": self.course.to_summary() if self.course else None,
            "source": self.source.label,
            "channel": self.channel.label,
            "entry_method": self.entry_method.label,
            "intake_status": self.intake_status,
            "is_genuine": self.is_genuine,
            "owner": user_summary(self.owner),
            "raw_name": self.raw_name,
            "raw_phone": self.raw_phone,
            "raw_email": self.raw_email,
            "message": self.message,
            "received_at": self.received_at,
        }


class Lead(db.Model):
    __tablename__ = "leads"

    lead_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    lead_code: Mapped[str] = mapped_column(String(20), unique=True)  # LD-00001, set by trigger
    person_id: Mapped[int] = mapped_column(Integer, ForeignKey("persons.person_id"))
    course_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("courses.course_id"))
    branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    original_source_id: Mapped[int] = mapped_column(Integer, ForeignKey("lead_sources.lead_source_id"))
    original_channel_id: Mapped[int] = mapped_column(Integer, ForeignKey("contact_channels.contact_channel_id"))
    original_entry_method_id: Mapped[int] = mapped_column(Integer, ForeignKey("entry_methods.entry_method_id"))
    original_enquiry_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("enquiries.enquiry_id"))
    intake_status: Mapped[str] = mapped_column(IntakeStatus, default="New")
    assigned_to: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    stage: Mapped[str] = mapped_column(LeadStage, default="New Enquiry")
    stage_changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    next_follow_up_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_contacted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ai_priority: Mapped[str | None] = mapped_column(LeadPriority)
    ai_score: Mapped[int | None] = mapped_column(SmallInteger)
    ai_priority_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lost_reason_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("lost_reasons.lost_reason_id"))
    lost_competitor: Mapped[str | None] = mapped_column(String(150))
    lost_notes: Mapped[str | None] = mapped_column(Text)
    reactivation_date: Mapped[date | None] = mapped_column(Date)
    campaign: Mapped[str | None] = mapped_column(String(150))
    remarks: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    person: Mapped[Person] = relationship(lazy="joined")
    course: Mapped[Course | None] = relationship(lazy="joined")
    branch: Mapped[Branch] = relationship(lazy="joined")
    source: Mapped[LeadSource] = relationship(lazy="joined")
    channel: Mapped[ContactChannel] = relationship(lazy="joined")
    entry_method: Mapped[EntryMethod] = relationship(lazy="joined")
    owner: Mapped[User | None] = relationship(foreign_keys=[assigned_to], lazy="joined")
    lost_reason: Mapped[LostReason | None] = relationship(lazy="joined")

    @property
    def is_open(self) -> bool:
        return self.stage not in CLOSED_STAGES

    def to_summary(self) -> dict:
        return {"lead_id": self.lead_id, "lead_code": self.lead_code, "branch_code": self.branch.branch_code,
                "course_code": self.course.course_code if self.course else None, "stage": self.stage}

    def to_row(self) -> dict:
        """Leads list row (prototype columns)."""
        return {
            "lead_id": self.lead_id,
            "lead_code": self.lead_code,
            "name": self.person.full_name,
            "phone": self.person.phone,
            "course": self.course.to_summary() if self.course else None,
            "branch": self.branch.to_summary(),
            "original_source": self.source.label,
            "contact_channel": self.channel.label,
            "entry_method": self.entry_method.label,
            "intake_status": self.intake_status,
            "owner": user_summary(self.owner),
            "stage": self.stage,
            "next_follow_up_at": self.next_follow_up_at,
            "last_contacted_at": self.last_contacted_at,
            "age_days": (datetime.now(timezone.utc) - self.created_at).days,
            "ai_priority": self.ai_priority,
            "ai_score": self.ai_score,
        }

    def to_dict(self) -> dict:
        return {
            **self.to_row(),
            "person": self.person.to_dict(),
            "original_enquiry_id": self.original_enquiry_id,
            "campaign": self.campaign,
            "remarks": self.remarks,
            "stage_changed_at": self.stage_changed_at,
            "is_open": self.is_open,
            "lost": {
                "reason": self.lost_reason.label if self.lost_reason else None,
                "competitor": self.lost_competitor,
                "notes": self.lost_notes,
                "reactivation_date": self.reactivation_date,
            } if self.stage == "Lost - closed" else None,
            "created_at": self.created_at,
        }


class LeadActivity(db.Model):
    """Lead timeline. Stage changes are written by a database trigger."""

    __tablename__ = "lead_activities"

    activity_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    lead_id: Mapped[int] = mapped_column(Integer, ForeignKey("leads.lead_id"))
    activity_type: Mapped[str] = mapped_column(ActivityType)
    direction: Mapped[str | None] = mapped_column(ActivityDirection)
    contact_channel_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("contact_channels.contact_channel_id"))
    outcome: Mapped[str | None] = mapped_column(String(100))
    summary: Mapped[str | None] = mapped_column(Text)
    call_duration_seconds: Mapped[int | None] = mapped_column(Integer)
    from_stage: Mapped[str | None] = mapped_column(LeadStage)
    to_stage: Mapped[str | None] = mapped_column(LeadStage)
    performed_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    communication_id: Mapped[int | None] = mapped_column(BigInteger)
    purpose: Mapped[str | None] = mapped_column(String(100))
    demo_id: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    performer: Mapped[User | None] = relationship(foreign_keys=[performed_by], lazy="joined")
    channel: Mapped[ContactChannel | None] = relationship(lazy="joined")

    def to_dict(self) -> dict:
        return {
            "activity_id": self.activity_id,
            "activity_type": self.activity_type,
            "direction": self.direction,
            "channel": self.channel.label if self.channel else None,
            "purpose": self.purpose,
            "outcome": self.outcome,
            "summary": self.summary,
            "call_duration_seconds": self.call_duration_seconds,
            "from_stage": self.from_stage,
            "to_stage": self.to_stage,
            "demo_id": self.demo_id,
            "communication_id": self.communication_id,
            "performed_by": user_summary(self.performer),
            "occurred_at": self.occurred_at,
        }


class SavedView(db.Model):
    """Saved list filters. user_id NULL = shared view for everyone."""

    __tablename__ = "saved_views"

    saved_view_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    module: Mapped[str] = mapped_column(String(50))
    name: Mapped[str] = mapped_column(String(100))
    filters: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    sort_order: Mapped[int] = mapped_column(SmallInteger, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    def to_dict(self) -> dict:
        return {"saved_view_id": self.saved_view_id, "module": self.module, "name": self.name, "filters": self.filters,
                "shared": self.user_id is None, "user_id": self.user_id, "sort_order": self.sort_order}


class LeadImport(db.Model):
    """A CSV upload: rows are validated first, then imported on request."""

    __tablename__ = "lead_imports"

    import_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    import_code: Mapped[str] = mapped_column(String(20), unique=True)  # IMP-00001, set by trigger
    file_name: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(LeadImportStatus, default="Uploaded")
    total_rows: Mapped[int] = mapped_column(Integer, default=0)
    ready_rows: Mapped[int] = mapped_column(Integer, default=0)
    duplicate_rows: Mapped[int] = mapped_column(Integer, default=0)
    invalid_rows: Mapped[int] = mapped_column(Integer, default=0)
    uploaded_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.user_id"))
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    imported_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    imported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    rows: Mapped[list["LeadImportRow"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin", order_by="LeadImportRow.row_no"
    )

    # CSV column -> CRM field (prototype "Field mapping")
    FIELD_MAPPING = {"full_name": "Name", "mobile": "Primary mobile", "email": "Email", "course": "Course (Course Master)",
                     "branch": "Branch", "source": "Original Source (Entry Method = CSV import)"}

    def to_dict(self, include_rows: bool = True) -> dict:
        data = {
            "import_id": self.import_id,
            "import_code": self.import_code,
            "file_name": self.file_name,
            "status": self.status,
            "total_rows": self.total_rows,
            "ready_rows": self.ready_rows,
            "duplicate_rows": self.duplicate_rows,
            "invalid_rows": self.invalid_rows,
            "uploaded_by": self.uploaded_by,
            "uploaded_at": self.uploaded_at,
            "imported_by": self.imported_by,
            "imported_at": self.imported_at,
            "field_mapping": self.FIELD_MAPPING,
        }
        if include_rows:
            data["rows"] = [row.to_dict() for row in self.rows]
        return data


class LeadImportRow(db.Model):
    __tablename__ = "lead_import_rows"

    import_row_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    import_id: Mapped[int] = mapped_column(Integer, ForeignKey("lead_imports.import_id"))
    row_no: Mapped[int] = mapped_column(Integer)
    raw_data: Mapped[dict[str, Any]] = mapped_column(JSONB)
    full_name: Mapped[str | None] = mapped_column(String(150))
    phone: Mapped[str | None] = mapped_column(String(20))
    email: Mapped[str | None] = mapped_column(String(255))
    course_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("courses.course_id"))
    branch_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    lead_source_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("lead_sources.lead_source_id"))
    issues: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    result: Mapped[str] = mapped_column(LeadImportRowResult)
    matched_lead_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("leads.lead_id"))
    lead_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("leads.lead_id"))
    enquiry_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("enquiries.enquiry_id"))

    def to_dict(self) -> dict:
        return {
            "row_no": self.row_no,
            "raw_data": self.raw_data,
            "full_name": self.full_name,
            "phone": self.phone,
            "email": self.email,
            "course_id": self.course_id,
            "branch_id": self.branch_id,
            "lead_source_id": self.lead_source_id,
            "issues": list(self.issues or []),
            "result": self.result,
            "matched_lead_id": self.matched_lead_id,
            "lead_id": self.lead_id,
            "enquiry_id": self.enquiry_id,
        }
