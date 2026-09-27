"""Target Master (versions + lines, achievement view), scheduled reports and report runs."""
from datetime import date, datetime, time
from decimal import Decimal

from sqlalchemy import (
    BigInteger, Boolean, Column, Date, DateTime, ForeignKey, Integer, Numeric, SmallInteger, String, Table, Text, Time,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from config.database import db
from models.enums import ExternalDeliveryStatus, ReportCompleteness, ReportFormat, ReportFrequency, TargetStatus


class TargetVersion(db.Model):
    """TM-2026-10-v1 (trigger). Approving supersedes any overlapping approved version (trigger)."""

    __tablename__ = "target_versions"

    target_version_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    version_code: Mapped[str] = mapped_column(String(30), unique=True)
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    status: Mapped[str] = mapped_column(TargetStatus, default="Draft")
    notes: Mapped[str | None] = mapped_column(Text)
    approved_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    superseded_by_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("target_versions.target_version_id"))
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    def to_dict(self, lines: list[dict] | None = None) -> dict:
        data = {"target_version_id": self.target_version_id, "version_code": self.version_code,
                "period_start": self.period_start, "period_end": self.period_end, "status": self.status,
                "notes": self.notes, "approved_by": self.approved_by, "approved_at": self.approved_at,
                "superseded_by_id": self.superseded_by_id, "created_by": self.created_by}
        if lines is not None:
            data["lines"] = lines
        return data


# target_lines has no primary key (branch_id NULL = Company line), so it's used through Core, not the ORM
target_lines = Table(
    "target_lines", db.metadata,
    Column("target_version_id", Integer, ForeignKey("target_versions.target_version_id")),
    Column("branch_id", Integer, ForeignKey("branches.branch_id")),
    Column("verified_collections_target", Numeric(12, 2)),
    Column("paid_admissions_target", Integer),
)


class TargetAchievement(db.Model):
    """Read-only view: approved targets vs verified collections (collecting branch) and paid admissions (original branch)."""

    __tablename__ = "target_achievement"

    version_code: Mapped[str] = mapped_column(String(30), primary_key=True)
    scope: Mapped[str] = mapped_column(String(20), primary_key=True)
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    branch_id: Mapped[int | None] = mapped_column(Integer)
    verified_collections_target: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    verified_collections: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    collections_pct: Mapped[Decimal | None] = mapped_column(Numeric(6, 1))
    paid_admissions_target: Mapped[int | None] = mapped_column(Integer)
    paid_admissions: Mapped[int] = mapped_column(BigInteger)
    admissions_pct: Mapped[Decimal | None] = mapped_column(Numeric(6, 1))

    def to_dict(self) -> dict:
        return {"version_code": self.version_code, "scope": self.scope, "branch_id": self.branch_id,
                "period_start": self.period_start, "period_end": self.period_end,
                "verified_collections_target": self.verified_collections_target,
                "verified_collections": self.verified_collections, "collections_pct": self.collections_pct,
                "paid_admissions_target": self.paid_admissions_target, "paid_admissions": self.paid_admissions,
                "admissions_pct": self.admissions_pct}


class ScheduledReport(db.Model):
    __tablename__ = "scheduled_reports"

    scheduled_report_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    report_name: Mapped[str] = mapped_column(String(150))
    frequency: Mapped[str] = mapped_column(ReportFrequency)
    schedule_day: Mapped[int | None] = mapped_column(SmallInteger)
    send_time: Mapped[time] = mapped_column(Time)
    period: Mapped[str] = mapped_column(String(50))
    branch_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    recipients: Mapped[list[str]] = mapped_column(ARRAY(Text))
    format: Mapped[str] = mapped_column(ReportFormat, default="Excel")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_delivery_status: Mapped[str] = mapped_column(ExternalDeliveryStatus, default="Not Sent")
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    FIELDS = ("report_name", "frequency", "schedule_day", "period", "branch_id", "format", "is_active")

    def to_dict(self) -> dict:
        return {"scheduled_report_id": self.scheduled_report_id, **{f: getattr(self, f) for f in self.FIELDS},
                "send_time": self.send_time.strftime("%H:%M"), "recipients": list(self.recipients),
                "last_sent_at": self.last_sent_at, "last_delivery_status": self.last_delivery_status}


class ReportRun(db.Model):
    """Every export / scheduled delivery: cutoff, refresh time, completeness."""

    __tablename__ = "report_runs"

    report_run_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    scheduled_report_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("scheduled_reports.scheduled_report_id"))
    report_name: Mapped[str] = mapped_column(String(150))
    branch_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    cutoff_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    refreshed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    completeness: Mapped[str] = mapped_column(ReportCompleteness)
    completeness_notes: Mapped[str | None] = mapped_column(Text)
    format: Mapped[str | None] = mapped_column(ReportFormat)
    file_path: Mapped[str | None] = mapped_column(String(500))
    generated_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    delivery_status: Mapped[str] = mapped_column(ExternalDeliveryStatus, default="Not Sent")

    def to_dict(self) -> dict:
        return {"report_run_id": self.report_run_id, "scheduled_report_id": self.scheduled_report_id,
                "report_name": self.report_name, "branch_id": self.branch_id, "period_start": self.period_start,
                "period_end": self.period_end, "cutoff_at": self.cutoff_at, "refreshed_at": self.refreshed_at,
                "completeness": self.completeness, "completeness_notes": self.completeness_notes,
                "format": self.format, "generated_by": self.generated_by, "delivery_status": self.delivery_status}
