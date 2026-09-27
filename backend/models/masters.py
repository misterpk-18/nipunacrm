"""Branches, shifts, holidays and dropdown lookups."""
from datetime import date, datetime, time

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, SmallInteger, String, Text, Time
from sqlalchemy.orm import Mapped, mapped_column

from config.database import db


class Branch(db.Model):
    __tablename__ = "branches"

    branch_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    branch_code: Mapped[str] = mapped_column(String(20), unique=True)
    branch_name: Mapped[str] = mapped_column(String(100))
    city: Mapped[str] = mapped_column(String(100))
    receipt_prefix: Mapped[str] = mapped_column(String(10), unique=True)
    address: Mapped[str | None] = mapped_column(Text)
    phone: Mapped[str | None] = mapped_column(String(20))
    email: Mapped[str | None] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    def to_dict(self) -> dict:
        return {
            "branch_id": self.branch_id,
            "branch_code": self.branch_code,
            "branch_name": self.branch_name,
            "city": self.city,
            "receipt_prefix": self.receipt_prefix,
            "address": self.address,
            "phone": self.phone,
            "email": self.email,
            "is_active": self.is_active,
        }

    def to_summary(self) -> dict:
        return {"branch_id": self.branch_id, "branch_code": self.branch_code, "branch_name": self.branch_name}


class BranchShift(db.Model):
    """Staffed hours per weekday (ISO: 1 = Monday). Drives every staffed-time deadline."""

    __tablename__ = "branch_shifts"

    branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"), primary_key=True)
    day_of_week: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    opens_at: Mapped[time] = mapped_column(Time)
    closes_at: Mapped[time] = mapped_column(Time)

    def to_dict(self) -> dict:
        return {
            "day_of_week": self.day_of_week,
            "opens_at": self.opens_at.strftime("%H:%M"),
            "closes_at": self.closes_at.strftime("%H:%M"),
        }


class Holiday(db.Model):
    __tablename__ = "holidays"

    holiday_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    branch_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("branches.branch_id"))  # NULL = all branches
    holiday_date: Mapped[date] = mapped_column(Date)
    name: Mapped[str] = mapped_column(String(100))

    def to_dict(self) -> dict:
        return {"holiday_id": self.holiday_id, "branch_id": self.branch_id, "holiday_date": self.holiday_date,
                "name": self.name}


# ---------------------------------------------------------------- lookups

class LookupMixin:
    """Shared shape of the dropdown tables: code (fixed), label, sort order, active flag."""

    ID_COLUMN = ""
    EXTRA_FIELDS: tuple[str, ...] = ()

    code: Mapped[str] = mapped_column(String(50), unique=True)
    label: Mapped[str] = mapped_column(String(100))
    sort_order: Mapped[int] = mapped_column(SmallInteger, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    @property
    def id(self) -> int:
        return getattr(self, self.ID_COLUMN)

    def to_dict(self) -> dict:
        data = {"id": self.id, "code": self.code, "label": self.label, "sort_order": self.sort_order,
                "is_active": self.is_active}
        data.update({field: getattr(self, field) for field in self.EXTRA_FIELDS})
        return data


class LeadSource(LookupMixin, db.Model):
    __tablename__ = "lead_sources"
    ID_COLUMN = "lead_source_id"
    lead_source_id: Mapped[int] = mapped_column(Integer, primary_key=True)


class ContactChannel(LookupMixin, db.Model):
    __tablename__ = "contact_channels"
    ID_COLUMN = "contact_channel_id"
    contact_channel_id: Mapped[int] = mapped_column(Integer, primary_key=True)


class EntryMethod(LookupMixin, db.Model):
    __tablename__ = "entry_methods"
    ID_COLUMN = "entry_method_id"
    entry_method_id: Mapped[int] = mapped_column(Integer, primary_key=True)


class PaymentMode(LookupMixin, db.Model):
    __tablename__ = "payment_modes"
    ID_COLUMN = "payment_mode_id"
    EXTRA_FIELDS = ("requires_reference", "requires_approval")
    payment_mode_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    requires_reference: Mapped[bool] = mapped_column(Boolean, default=True)
    requires_approval: Mapped[bool] = mapped_column(Boolean, default=False)


class LostReason(LookupMixin, db.Model):
    __tablename__ = "lost_reasons"
    ID_COLUMN = "lost_reason_id"
    lost_reason_id: Mapped[int] = mapped_column(Integer, primary_key=True)


class TaskType(LookupMixin, db.Model):
    __tablename__ = "task_types"
    ID_COLUMN = "task_type_id"
    task_type_id: Mapped[int] = mapped_column(Integer, primary_key=True)


class DocumentType(LookupMixin, db.Model):
    __tablename__ = "document_types"
    ID_COLUMN = "document_type_id"
    EXTRA_FIELDS = ("is_mandatory",)
    document_type_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    is_mandatory: Mapped[bool] = mapped_column(Boolean, default=False)


class SupportCaseType(LookupMixin, db.Model):
    __tablename__ = "support_case_types"
    ID_COLUMN = "support_case_type_id"
    support_case_type_id: Mapped[int] = mapped_column(Integer, primary_key=True)


# URL name used by /lookups/<type> -> model
LOOKUPS = {
    "lead-sources": LeadSource,
    "contact-channels": ContactChannel,
    "entry-methods": EntryMethod,
    "payment-modes": PaymentMode,
    "lost-reasons": LostReason,
    "task-types": TaskType,
    "document-types": DocumentType,
    "support-case-types": SupportCaseType,
}
