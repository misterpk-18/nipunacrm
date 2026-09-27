"""Admissions (created from an invoice), balances view, service-branch transfers and post-admission fee changes."""
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.access import User
from models.commercials import PaymentPlan
from models.courses import Course
from models.enums import (
    CurriculumStatus, DeliveryMode, EnrolmentStatus, FeeChangeStatus, HandoverStatus, LmsStatus, SeatType,
)
from models.leads import Person, user_summary
from models.masters import Branch


class Admission(db.Model):
    """Parties, fee, plan and first qualifying payment come from the invoice (trigger); fee / plan / date then freeze."""

    __tablename__ = "admissions"

    ACTIVE_STATUSES = ("Awaiting Batch Allocation", "Scheduled", "In Progress", "Deferred", "Paused")

    admission_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    admission_code: Mapped[str] = mapped_column(String(30), unique=True)  # NIT-GNT-2026-000001, set by trigger
    person_id: Mapped[int] = mapped_column(Integer, ForeignKey("persons.person_id"))
    lead_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("leads.lead_id"))
    invoice_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("invoices.invoice_id"))
    fee_version_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("fee_discussion_versions.version_id"))
    course_id: Mapped[int] = mapped_column(Integer, ForeignKey("courses.course_id"))
    original_branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    service_branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    delivery_mode: Mapped[str] = mapped_column(DeliveryMode, default="Classroom")
    seat_type: Mapped[str] = mapped_column(SeatType)
    planned_start_date: Mapped[date | None] = mapped_column(Date)
    final_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    payment_plan_id: Mapped[int] = mapped_column(Integer, ForeignKey("payment_plans.payment_plan_id"))
    admission_date: Mapped[date] = mapped_column(Date, server_default=db.func.current_date())
    counsellor_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    record_owner_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    finance_owner_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    academic_owner_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    first_qualifying_payment_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("payments.payment_id"))
    first_verified_payment_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    enrolment_status: Mapped[str] = mapped_column(EnrolmentStatus, default="Awaiting Batch Allocation")
    curriculum_status: Mapped[str] = mapped_column(CurriculumStatus, default="Mapping Pending")
    handover_status: Mapped[str] = mapped_column(HandoverStatus, default="Pending")
    lms_status: Mapped[str] = mapped_column(LmsStatus, default="Not Created")
    lms_last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lms_last_activity_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    complimentary_of_admission_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("admissions.admission_id"))
    offer_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("offers.offer_id"))
    access_until: Mapped[date | None] = mapped_column(Date)
    cancelled_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancellation_reason: Mapped[str | None] = mapped_column(Text)
    academic_completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completion_authorised_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    support_until: Mapped[date | None] = mapped_column(Date)
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    person: Mapped[Person] = relationship(lazy="joined")
    course: Mapped[Course] = relationship(lazy="joined")
    original_branch: Mapped[Branch] = relationship(foreign_keys=[original_branch_id], lazy="joined")
    service_branch: Mapped[Branch] = relationship(foreign_keys=[service_branch_id], lazy="joined")
    payment_plan: Mapped[PaymentPlan] = relationship(lazy="joined")
    counsellor: Mapped[User | None] = relationship(foreign_keys=[counsellor_id], lazy="joined")
    invoice = relationship("Invoice", foreign_keys=[invoice_id], lazy="joined")
    balance: Mapped["AdmissionBalance"] = relationship(
        primaryjoin="Admission.admission_id == foreign(AdmissionBalance.admission_id)", lazy="joined", viewonly=True
    )

    @property
    def is_active(self) -> bool:
        return self.enrolment_status in self.ACTIVE_STATUSES

    def to_summary(self) -> dict:
        return {"admission_id": self.admission_id, "admission_code": self.admission_code,
                "course": self.course.to_summary(), "enrolment_status": self.enrolment_status}

    def to_row(self) -> dict:
        return {
            **self.to_summary(),
            "person": self.person.to_summary(),
            "original_branch": self.original_branch.to_summary(),
            "service_branch": self.service_branch.to_summary(),
            "seat_type": self.seat_type,
            "delivery_mode": self.delivery_mode,
            "final_fee": self.final_fee,
            "admission_date": self.admission_date,
            "curriculum_status": self.curriculum_status,
            "handover_status": self.handover_status,
            "lms_status": self.lms_status,
            "complimentary_of_admission_id": self.complimentary_of_admission_id,
            "payment_completion": self.balance.payment_completion,
            "outstanding": self.balance.outstanding,
        }

    def to_dict(self) -> dict:
        balance = self.balance
        return {
            **self.to_row(),
            "lead_id": self.lead_id,
            "invoice": self.invoice.to_summary() if self.invoice_id else None,
            "fee_version_id": self.fee_version_id,
            "payment_plan": {"payment_plan_id": self.payment_plan_id, "plan_code": self.payment_plan.plan_code,
                             "plan_name": self.payment_plan.plan_name},
            "planned_start_date": self.planned_start_date,
            "counsellor": user_summary(self.counsellor),
            "record_owner_id": self.record_owner_id,
            "finance_owner_id": self.finance_owner_id,
            "academic_owner_id": self.academic_owner_id,
            "first_qualifying_payment_id": self.first_qualifying_payment_id,
            "first_verified_payment_at": self.first_verified_payment_at,
            "balance": {"final_fee": balance.final_fee, "verified_paid": balance.verified_paid,
                        "pending_verification": balance.pending_verification, "waived": balance.waived,
                        "refunded": balance.refunded, "outstanding": balance.outstanding,
                        "payment_completion": balance.payment_completion},
            "offer_id": self.offer_id,
            "access_until": self.access_until,
            "lms_last_synced_at": self.lms_last_synced_at,
            "lms_last_activity_at": self.lms_last_activity_at,
            "cancellation": {"cancelled_by": self.cancelled_by, "cancelled_at": self.cancelled_at,
                             "reason": self.cancellation_reason} if self.cancelled_at else None,
            "academic_completed_at": self.academic_completed_at,
            "completion_authorised_by": self.completion_authorised_by,
            "support_until": self.support_until,
            "created_at": self.created_at,
        }


class AdmissionBalance(db.Model):
    """Read-only view: final fee, verified paid, pending, waived, refunded, outstanding, completion."""

    __tablename__ = "admission_balances"

    admission_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    admission_code: Mapped[str] = mapped_column(String(30))
    person_id: Mapped[int] = mapped_column(Integer)
    service_branch_id: Mapped[int] = mapped_column(Integer)
    enrolment_status: Mapped[str] = mapped_column(EnrolmentStatus)
    final_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    verified_paid: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    pending_verification: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    waived: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    refunded: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    outstanding: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    payment_completion: Mapped[str] = mapped_column(String(20))


class AdmissionTransfer(db.Model):
    """Service-branch history; inserting one moves admissions.service_branch_id (trigger)."""

    __tablename__ = "admission_transfers"

    transfer_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    admission_id: Mapped[int] = mapped_column(Integer, ForeignKey("admissions.admission_id"))
    from_branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))  # set by trigger
    to_branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    effective_date: Mapped[date] = mapped_column(Date, server_default=db.func.current_date())
    reason: Mapped[str] = mapped_column(Text)
    requested_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    approved_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    def to_dict(self) -> dict:
        return {"transfer_id": self.transfer_id, "admission_id": self.admission_id, "from_branch_id": self.from_branch_id,
                "to_branch_id": self.to_branch_id, "effective_date": self.effective_date, "reason": self.reason,
                "requested_by": self.requested_by, "approved_by": self.approved_by, "created_at": self.created_at}


class AdmissionFeeChange(db.Model):
    """Founder / CEO or Super Admin approves (never the requester); Accounts applies; instalments are rebuilt."""

    __tablename__ = "admission_fee_changes"

    fee_change_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    admission_id: Mapped[int] = mapped_column(Integer, ForeignKey("admissions.admission_id"))
    old_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2))  # set by trigger
    new_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(FeeChangeStatus, default="Pending")
    requested_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.user_id"))
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    approved_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    accounts_corrected_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    admission: Mapped[Admission] = relationship(lazy="joined")

    def to_dict(self) -> dict:
        return {
            "fee_change_id": self.fee_change_id,
            "admission_id": self.admission_id,
            "admission_code": self.admission.admission_code,
            "old_fee": self.old_fee,
            "new_fee": self.new_fee,
            "reason": self.reason,
            "status": self.status,
            "requested_by": self.requested_by,
            "requested_at": self.requested_at,
            "approved_by": self.approved_by,
            "approved_at": self.approved_at,
            "rejection_reason": self.rejection_reason,
            "accounts_corrected_by": self.accounts_corrected_by,
            "applied_at": self.applied_at,
        }
