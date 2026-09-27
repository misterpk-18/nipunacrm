"""Placement: companies, Job Opening Master, placement profiles, applications + events; alumni view, support extensions."""
from datetime import date, datetime

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, SmallInteger, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.enums import (
    ApplicationEventType, ApplicationStage, ConsentStatus, CvReviewStatus, EmploymentType, EvidenceStatus, JobStatus,
    PlacementReadiness, WorkMode,
)
from models.leads import Person


class Company(db.Model):
    __tablename__ = "companies"

    company_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    company_name: Mapped[str] = mapped_column(String(200))
    industry: Mapped[str | None] = mapped_column(String(100))
    website: Mapped[str | None] = mapped_column(String(255))
    city: Mapped[str | None] = mapped_column(String(100))
    contact_name: Mapped[str | None] = mapped_column(String(150))
    contact_email: Mapped[str | None] = mapped_column(String(255))
    contact_phone: Mapped[str | None] = mapped_column(String(20))
    notes: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    FIELDS = ("company_name", "industry", "website", "city", "contact_name", "contact_email", "contact_phone", "notes",
              "is_active")

    def to_dict(self) -> dict:
        return {"company_id": self.company_id, **{f: getattr(self, f) for f in self.FIELDS}}


class JobOpening(db.Model):
    """JOB-00001 (trigger)."""

    __tablename__ = "job_openings"

    job_opening_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_code: Mapped[str] = mapped_column(String(20), unique=True)
    company_id: Mapped[int] = mapped_column(Integer, ForeignKey("companies.company_id"))
    job_title: Mapped[str] = mapped_column(String(200))
    employment_type: Mapped[str] = mapped_column(EmploymentType, default="Full-time")
    location: Mapped[str | None] = mapped_column(String(150))
    work_mode: Mapped[str] = mapped_column(WorkMode, default="On-site")
    branch_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    required_skills: Mapped[str | None] = mapped_column(Text)
    salary_ctc: Mapped[str | None] = mapped_column(String(100))
    openings_count: Mapped[int | None] = mapped_column(SmallInteger)
    closing_date: Mapped[date | None] = mapped_column(Date)
    source: Mapped[str | None] = mapped_column(String(150))
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(JobStatus, default="Review Required")
    placement_owner_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    company: Mapped[Company] = relationship(lazy="joined")

    FIELDS = ("company_id", "job_title", "employment_type", "location", "work_mode", "branch_id", "required_skills",
              "salary_ctc", "openings_count", "closing_date", "source", "last_verified_at", "status",
              "placement_owner_id")

    def to_dict(self) -> dict:
        return {"job_opening_id": self.job_opening_id, "job_code": self.job_code,
                "company_name": self.company.company_name, **{f: getattr(self, f) for f in self.FIELDS}}


class PlacementProfile(db.Model):
    """One per person; applications need explicit referral consent (trigger)."""

    __tablename__ = "placement_profiles"

    profile_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    person_id: Mapped[int] = mapped_column(Integer, ForeignKey("persons.person_id"), unique=True)
    readiness: Mapped[str] = mapped_column(PlacementReadiness, default="Not Yet Assessed")
    cv_file_path: Mapped[str | None] = mapped_column(String(500))
    cv_version: Mapped[int] = mapped_column(SmallInteger, default=0)
    cv_review_status: Mapped[str] = mapped_column(CvReviewStatus, default="No CV")
    skills: Mapped[str | None] = mapped_column(Text)
    projects: Mapped[str | None] = mapped_column(Text)
    qualification: Mapped[str | None] = mapped_column(String(150))
    career_gap_notes: Mapped[str | None] = mapped_column(Text)
    expected_salary: Mapped[str | None] = mapped_column(String(100))
    preferred_location: Mapped[str | None] = mapped_column(String(150))
    preferred_mode: Mapped[str | None] = mapped_column(WorkMode)
    preferred_role: Mapped[str | None] = mapped_column(String(150))
    consent_status: Mapped[str] = mapped_column(ConsentStatus, default="Not Recorded")
    consent_recorded_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    consent_recorded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    evidence_status: Mapped[str] = mapped_column(EvidenceStatus, default="Student Reported")
    placement_owner_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    person: Mapped[Person] = relationship(lazy="joined")

    EDITABLE_FIELDS = ("readiness", "cv_file_path", "cv_review_status", "skills", "projects", "qualification",
                       "career_gap_notes", "expected_salary", "preferred_location", "preferred_mode", "preferred_role",
                       "evidence_status", "placement_owner_id")

    def to_dict(self) -> dict:
        return {"profile_id": self.profile_id, "person": self.person.to_summary(), "cv_version": self.cv_version,
                "consent_status": self.consent_status, "consent_recorded_by": self.consent_recorded_by,
                "consent_recorded_at": self.consent_recorded_at,
                **{f: getattr(self, f) for f in self.EDITABLE_FIELDS}}


class JobApplication(db.Model):
    """Every stage change is logged by trigger (application_events)."""

    __tablename__ = "job_applications"

    application_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    profile_id: Mapped[int] = mapped_column(Integer, ForeignKey("placement_profiles.profile_id"))
    job_opening_id: Mapped[int] = mapped_column(Integer, ForeignKey("job_openings.job_opening_id"))
    stage: Mapped[str] = mapped_column(ApplicationStage, default="Applied")
    stage_changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    interview_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    offer_ctc: Mapped[str | None] = mapped_column(String(100))
    joined_date: Mapped[date | None] = mapped_column(Date)
    evidence_status: Mapped[str] = mapped_column(EvidenceStatus, default="Verification Pending")
    evidence_file_path: Mapped[str | None] = mapped_column(String(500))
    notes: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    profile: Mapped[PlacementProfile] = relationship(lazy="joined")
    job_opening: Mapped[JobOpening] = relationship(lazy="joined")
    events: Mapped[list["ApplicationEvent"]] = relationship(lazy="selectin", order_by="ApplicationEvent.event_id")

    def to_dict(self) -> dict:
        return {"application_id": self.application_id, "profile_id": self.profile_id,
                "person": self.profile.person.to_summary(), "job_opening_id": self.job_opening_id,
                "job_code": self.job_opening.job_code, "job_title": self.job_opening.job_title, "stage": self.stage,
                "stage_changed_at": self.stage_changed_at, "interview_at": self.interview_at,
                "offer_ctc": self.offer_ctc, "joined_date": self.joined_date, "evidence_status": self.evidence_status,
                "notes": self.notes, "events": [e.to_dict() for e in self.events]}


class ApplicationEvent(db.Model):
    __tablename__ = "application_events"

    event_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    application_id: Mapped[int] = mapped_column(Integer, ForeignKey("job_applications.application_id"))
    event_type: Mapped[str] = mapped_column(ApplicationEventType)
    from_stage: Mapped[str | None] = mapped_column(ApplicationStage)
    to_stage: Mapped[str | None] = mapped_column(ApplicationStage)
    notes: Mapped[str | None] = mapped_column(Text)
    evidence_file_path: Mapped[str | None] = mapped_column(String(500))
    recorded_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    def to_dict(self) -> dict:
        return {"event_id": self.event_id, "event_type": self.event_type, "from_stage": self.from_stage,
                "to_stage": self.to_stage, "notes": self.notes, "recorded_by": self.recorded_by,
                "occurred_at": self.occurred_at}


class SupportExtension(db.Model):
    """Alumni support beyond the standard period; Founder / CEO or Super Admin only (trigger)."""

    __tablename__ = "support_extensions"

    extension_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    admission_id: Mapped[int] = mapped_column(Integer, ForeignKey("admissions.admission_id"))
    previous_until: Mapped[date] = mapped_column(Date)  # set by trigger
    extended_until: Mapped[date] = mapped_column(Date)
    reason: Mapped[str] = mapped_column(Text)
    approved_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    def to_dict(self) -> dict:
        return {"extension_id": self.extension_id, "admission_id": self.admission_id,
                "previous_until": self.previous_until, "extended_until": self.extended_until, "reason": self.reason,
                "approved_by": self.approved_by, "created_at": self.created_at}


class Alumni(db.Model):
    """Read-only view: people with at least one authorised completion."""

    __tablename__ = "alumni"

    person_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    person_code: Mapped[str] = mapped_column(String(20))
    full_name: Mapped[str] = mapped_column(String(150))
    alumni_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_admissions: Mapped[int] = mapped_column(BigInteger)
    is_also_active: Mapped[bool] = mapped_column(Boolean)
    support_until: Mapped[date | None] = mapped_column(Date)
    support_active: Mapped[bool] = mapped_column(Boolean)

    def to_dict(self) -> dict:
        return {"person_id": self.person_id, "person_code": self.person_code, "full_name": self.full_name,
                "alumni_since": self.alumni_since, "completed_admissions": self.completed_admissions,
                "is_also_active": self.is_also_active, "support_until": self.support_until,
                "support_active": self.support_active}
