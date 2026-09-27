"""Collections promises and refund cases (registration → decision → payout → reconciliation)."""
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.admissions import Admission
from models.enums import PayoutStatus, PromiseStatus, RefundCaseStatus, RefundDecision, RefundEvidenceStatus


class PaymentPromise(db.Model):
    __tablename__ = "payment_promises"

    promise_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    admission_id: Mapped[int] = mapped_column(Integer, ForeignKey("admissions.admission_id"))
    promised_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    promised_date: Mapped[date] = mapped_column(Date)
    status: Mapped[str] = mapped_column(PromiseStatus, default="Pending")
    notes: Mapped[str | None] = mapped_column(Text)
    recorded_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    admission: Mapped[Admission] = relationship(lazy="joined")

    def to_dict(self) -> dict:
        return {"promise_id": self.promise_id, "admission_id": self.admission_id,
                "admission_code": self.admission.admission_code, "promised_amount": self.promised_amount,
                "promised_date": self.promised_date, "status": self.status, "notes": self.notes,
                "recorded_by": self.recorded_by, "recorded_at": self.recorded_at, "resolved_at": self.resolved_at}


class RefundCase(db.Model):
    """NIT-RF-00001. Decision due in 7 working days, payout in 18 (triggers); decider ≠ payout executor."""

    __tablename__ = "refund_cases"

    refund_case_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    case_code: Mapped[str] = mapped_column(String(20), unique=True)
    admission_id: Mapped[int] = mapped_column(Integer, ForeignKey("admissions.admission_id"))
    status: Mapped[str] = mapped_column(RefundCaseStatus, default="Registered")
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    request_reason: Mapped[str] = mapped_column(Text)
    request_timing: Mapped[str | None] = mapped_column(String(100))
    evidence_status: Mapped[str] = mapped_column(RefundEvidenceStatus, default="Evidence Pending")
    assessment_date: Mapped[date | None] = mapped_column(Date)
    assessment_notes: Mapped[str | None] = mapped_column(Text)
    refund_decision: Mapped[str] = mapped_column(RefundDecision, default="Pending")
    approved_refund_amount: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    approved_waiver_amount: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    decision_reason: Mapped[str | None] = mapped_column(Text)
    decision_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    payout_status: Mapped[str] = mapped_column(PayoutStatus, default="Not Started")
    payout_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    payout_amount: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    payout_mode_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("payment_modes.payment_mode_id"))
    payout_reference: Mapped[str | None] = mapped_column(String(100))
    payout_executed_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    payout_completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    payout_failure_reason: Mapped[str | None] = mapped_column(Text)
    reconciled_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    reconciled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    admission: Mapped[Admission] = relationship(lazy="joined")
    receipts: Mapped[list["RefundCaseReceipt"]] = relationship(cascade="all, delete-orphan", lazy="selectin")

    CLOSED_STATUSES = ("Completed", "Withdrawn")

    def to_row(self) -> dict:
        return {
            "refund_case_id": self.refund_case_id,
            "case_code": self.case_code,
            "admission": self.admission.to_summary(),
            "person": self.admission.person.to_summary(),
            "service_branch_id": self.admission.service_branch_id,
            "status": self.status,
            "requested_at": self.requested_at,
            "evidence_status": self.evidence_status,
            "refund_decision": self.refund_decision,
            "decision_due_at": self.decision_due_at,
            "payout_status": self.payout_status,
            "payout_due_at": self.payout_due_at,
        }

    def to_dict(self) -> dict:
        return {
            **self.to_row(),
            "request_reason": self.request_reason,
            "request_timing": self.request_timing,
            "assessment_date": self.assessment_date,
            "assessment_notes": self.assessment_notes,
            "approved_refund_amount": self.approved_refund_amount,
            "approved_waiver_amount": self.approved_waiver_amount,
            "decision_reason": self.decision_reason,
            "decided_by": self.decided_by,
            "decided_at": self.decided_at,
            "payout_amount": self.payout_amount,
            "payout_mode_id": self.payout_mode_id,
            "payout_reference": self.payout_reference,
            "payout_executed_by": self.payout_executed_by,
            "payout_completed_at": self.payout_completed_at,
            "payout_failure_reason": self.payout_failure_reason,
            "reconciled_by": self.reconciled_by,
            "reconciled_at": self.reconciled_at,
            "receipt_payment_ids": sorted(r.payment_id for r in self.receipts),
            "created_by": self.created_by,
        }


class RefundCaseReceipt(db.Model):
    __tablename__ = "refund_case_receipts"

    refund_case_id: Mapped[int] = mapped_column(Integer, ForeignKey("refund_cases.refund_case_id"), primary_key=True)
    payment_id: Mapped[int] = mapped_column(Integer, ForeignKey("payments.payment_id"), primary_key=True)
