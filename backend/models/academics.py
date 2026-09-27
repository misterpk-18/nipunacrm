"""Curriculum versions, batches, batch allocations, and the occupancy / allocation-queue views."""
from datetime import date, datetime, time

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, SmallInteger, String, Text, Time
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.access import User
from models.admissions import Admission
from models.courses import Course
from models.enums import AllocationStatus, BatchStatus, CurriculumVersionStatus, DeliveryMode, SeatType
from models.leads import user_summary
from models.masters import Branch


class CurriculumVersion(db.Model):
    """"Published v2026.1": one Published version per course at a time."""

    __tablename__ = "curriculum_versions"

    curriculum_version_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    course_id: Mapped[int] = mapped_column(Integer, ForeignKey("courses.course_id"))
    version_label: Mapped[str] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(CurriculumVersionStatus, default="Draft")
    notes: Mapped[str | None] = mapped_column(Text)
    published_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    course: Mapped[Course] = relationship(lazy="joined")

    def to_dict(self) -> dict:
        return {"curriculum_version_id": self.curriculum_version_id, "course": self.course.to_summary(),
                "version_label": self.version_label, "status": self.status, "notes": self.notes,
                "published_by": self.published_by, "published_at": self.published_at, "created_at": self.created_at}


class AdmissionCurriculum(db.Model):
    __tablename__ = "admission_curricula"

    admission_id: Mapped[int] = mapped_column(Integer, ForeignKey("admissions.admission_id"), primary_key=True)
    curriculum_version_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("curriculum_versions.curriculum_version_id"), primary_key=True
    )
    mapped_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    mapped_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    curriculum_version: Mapped[CurriculumVersion] = relationship(lazy="joined")

    def to_dict(self) -> dict:
        return {"admission_id": self.admission_id, **self.curriculum_version.to_dict(), "mapped_by": self.mapped_by,
                "mapped_at": self.mapped_at}


class Batch(db.Model):
    """GNT-B-0001 (trigger). Standalone courses only."""

    __tablename__ = "batches"

    batch_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_code: Mapped[str] = mapped_column(String(30), unique=True)
    batch_name: Mapped[str] = mapped_column(String(150))
    course_id: Mapped[int] = mapped_column(Integer, ForeignKey("courses.course_id"))
    branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    curriculum_version_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("curriculum_versions.curriculum_version_id"))
    delivery_mode: Mapped[str] = mapped_column(DeliveryMode, default="Classroom")
    trainer_user_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    schedule_days: Mapped[str | None] = mapped_column(String(50))
    start_time: Mapped[time | None] = mapped_column(Time)
    end_time: Mapped[time | None] = mapped_column(Time)
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    capacity: Mapped[int] = mapped_column(SmallInteger)
    min_students: Mapped[int | None] = mapped_column(SmallInteger)
    location: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(BatchStatus, default="Planned")
    lms_course_id: Mapped[str | None] = mapped_column(String(100))
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    course: Mapped[Course] = relationship(lazy="joined")
    branch: Mapped[Branch] = relationship(lazy="joined")
    trainer: Mapped[User | None] = relationship(foreign_keys=[trainer_user_id], lazy="joined")
    curriculum_version: Mapped[CurriculumVersion | None] = relationship(lazy="joined")
    occupancy: Mapped["BatchOccupancy"] = relationship(
        primaryjoin="Batch.batch_id == foreign(BatchOccupancy.batch_id)", lazy="joined", viewonly=True
    )

    def to_dict(self) -> dict:
        occupancy = self.occupancy
        return {
            "batch_id": self.batch_id,
            "batch_code": self.batch_code,
            "batch_name": self.batch_name,
            "course": self.course.to_summary(),
            "branch": self.branch.to_summary(),
            "curriculum_version": {"curriculum_version_id": self.curriculum_version_id,
                                   "version_label": self.curriculum_version.version_label}
            if self.curriculum_version else None,
            "delivery_mode": self.delivery_mode,
            "trainer": user_summary(self.trainer),
            "schedule_days": self.schedule_days,
            "start_time": self.start_time.strftime("%H:%M") if self.start_time else None,
            "end_time": self.end_time.strftime("%H:%M") if self.end_time else None,
            "start_date": self.start_date,
            "end_date": self.end_date,
            "capacity": self.capacity,
            "min_students": self.min_students,
            "allocated": occupancy.allocated,
            "seats_left": occupancy.seats_left,
            "is_full": occupancy.is_full,
            "location": self.location,
            "status": self.status,
            "lms_course_id": self.lms_course_id,
        }


class BatchAllocation(db.Model):
    """Admission → batch. Closing (Moved / Withdrawn / Completed) is final; change batch = close + new allocation."""

    __tablename__ = "batch_allocations"

    allocation_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    admission_id: Mapped[int] = mapped_column(Integer, ForeignKey("admissions.admission_id"))
    batch_id: Mapped[int] = mapped_column(Integer, ForeignKey("batches.batch_id"))
    course_id: Mapped[int] = mapped_column(Integer, ForeignKey("courses.course_id"))  # set by trigger
    status: Mapped[str] = mapped_column(AllocationStatus, default="Active")
    joining_date: Mapped[date | None] = mapped_column(Date)
    allocated_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    allocated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    end_reason: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    batch: Mapped[Batch] = relationship(lazy="joined")
    admission: Mapped[Admission] = relationship(lazy="joined")

    def to_dict(self) -> dict:
        return {"allocation_id": self.allocation_id, "admission_id": self.admission_id,
                "admission_code": self.admission.admission_code, "batch_id": self.batch_id,
                "batch_code": self.batch.batch_code, "course_id": self.course_id, "status": self.status,
                "joining_date": self.joining_date, "allocated_by": self.allocated_by, "allocated_at": self.allocated_at,
                "ended_at": self.ended_at, "end_reason": self.end_reason}


class BatchOccupancy(db.Model):
    __tablename__ = "batch_occupancy"

    batch_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    capacity: Mapped[int] = mapped_column(SmallInteger)
    allocated: Mapped[int] = mapped_column(BigInteger)
    seats_left: Mapped[int] = mapped_column(BigInteger)
    is_full: Mapped[bool] = mapped_column(Boolean)


class BatchAllocationQueue(db.Model):
    """Admissions awaiting a batch: allocate-by (confirmed seat: 1 working day, future: 48h before start), escalate-at."""

    __tablename__ = "batch_allocation_queue"

    admission_id: Mapped[int] = mapped_column(Integer, ForeignKey("admissions.admission_id"), primary_key=True)
    admission_code: Mapped[str] = mapped_column(String(30))
    service_branch_id: Mapped[int] = mapped_column(Integer)
    seat_type: Mapped[str] = mapped_column(SeatType)
    planned_start_date: Mapped[date | None] = mapped_column(Date)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    allocate_by: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    escalate_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    admission: Mapped[Admission] = relationship(lazy="joined", viewonly=True)

    def to_dict(self) -> dict:
        return {"admission": self.admission.to_row(), "seat_type": self.seat_type,
                "planned_start_date": self.planned_start_date, "allocate_by": self.allocate_by,
                "escalate_at": self.escalate_at}
