"""Payments ledger (immutable; corrections are approved reversals) and correction requests."""
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.access import User
from models.enums import CorrectionRequestStatus, PaymentEntryType, PaymentVerification
from models.leads import Person, user_summary
from models.masters import Branch, PaymentMode


class Payment(db.Model):
    """Belongs to a person: an unallocated advance (no invoice) or allocated to an invoice (admission filled by trigger)."""

    __tablename__ = "payments"

    payment_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    receipt_number: Mapped[str] = mapped_column(String(30), unique=True)  # GNT-R-2627-00001 / REV-GNT-2627-00001
    entry_type: Mapped[str] = mapped_column(PaymentEntryType, default="Payment")
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    payment_mode_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("payment_modes.payment_mode_id"))
    payment_date: Mapped[date] = mapped_column(Date, server_default=db.func.current_date())
    reference: Mapped[str | None] = mapped_column(String(100))
    collected_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    collecting_branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    verification_status: Mapped[str] = mapped_column(PaymentVerification, default="Pending Verification")
    verified_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_reason: Mapped[str | None] = mapped_column(Text)
    reverses_payment_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("payments.payment_id"))
    reversal_reason: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    person_id: Mapped[int] = mapped_column(Integer, ForeignKey("persons.person_id"))
    lead_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("leads.lead_id"))
    invoice_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("invoices.invoice_id"))
    admission_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("admissions.admission_id"))
    exception_approved_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    correction_request_id: Mapped[int | None] = mapped_column(Integer)
    proof_file_path: Mapped[str | None] = mapped_column(String(500))
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    person: Mapped[Person] = relationship(lazy="joined")
    mode: Mapped[PaymentMode | None] = relationship(lazy="joined")
    collecting_branch: Mapped[Branch] = relationship(lazy="joined")
    collector: Mapped[User | None] = relationship(foreign_keys=[collected_by], lazy="joined")
    verifier: Mapped[User | None] = relationship(foreign_keys=[verified_by], lazy="joined")
    invoice = relationship("Invoice", lazy="joined")
    reversed_by: Mapped["Payment | None"] = relationship(
        primaryjoin="Payment.payment_id == foreign(Payment.reverses_payment_id)", uselist=False, viewonly=True,
        lazy="select",
    )

    @property
    def is_reversed(self) -> bool:
        return self.entry_type == "Payment" and self.reversed_by is not None

    def to_row(self) -> dict:
        return {
            "payment_id": self.payment_id,
            "receipt_number": self.receipt_number,
            "entry_type": self.entry_type,
            "amount": self.amount,
            "payment_date": self.payment_date,
            "mode": self.mode.label if self.mode else None,
            "reference": self.reference,
            "person": self.person.to_summary(),
            "invoice": {"invoice_id": self.invoice_id, "invoice_number": self.invoice.invoice_number}
            if self.invoice_id else None,
            "admission_id": self.admission_id,
            "collecting_branch": self.collecting_branch.to_summary(),
            "verification_status": self.verification_status,
            "recorded_by": user_summary(self.collector),
            "created_at": self.created_at,
        }

    def to_dict(self) -> dict:
        return {
            **self.to_row(),
            "lead_id": self.lead_id,
            "verified_by": user_summary(self.verifier),
            "verified_at": self.verified_at,
            "failure_reason": self.failure_reason,
            "reverses_payment_id": self.reverses_payment_id,
            "reversal_reason": self.reversal_reason,
            "reversed_by_payment_id": self.reversed_by.payment_id if self.is_reversed else None,
            "exception_approved_by": self.exception_approved_by,
            "correction_request_id": self.correction_request_id,
            "proof_file_path": self.proof_file_path,
            "notes": self.notes,
        }


class PaymentCorrectionRequest(db.Model):
    """CR-GNT-0001: approval (by a distinct Founder / CEO or Super Admin) appends the reversal (trigger)."""

    __tablename__ = "payment_correction_requests"

    correction_request_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    request_code: Mapped[str] = mapped_column(String(20), unique=True)  # set by trigger
    payment_id: Mapped[int] = mapped_column(Integer, ForeignKey("payments.payment_id"))
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2))  # copied from the payment by trigger
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(CorrectionRequestStatus, default="Pending Approval")
    requested_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.user_id"))
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    decided_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_note: Mapped[str | None] = mapped_column(Text)
    reversal_payment_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("payments.payment_id"))

    payment: Mapped[Payment] = relationship(foreign_keys=[payment_id], lazy="joined")
    requester: Mapped[User] = relationship(foreign_keys=[requested_by], lazy="joined")
    decider: Mapped[User | None] = relationship(foreign_keys=[decided_by], lazy="joined")
    reversal: Mapped[Payment | None] = relationship(foreign_keys=[reversal_payment_id], lazy="joined")

    def to_dict(self) -> dict:
        return {
            "correction_request_id": self.correction_request_id,
            "request_code": self.request_code,
            "payment_id": self.payment_id,
            "receipt_number": self.payment.receipt_number,
            "invoice_id": self.payment.invoice_id,
            "collecting_branch_id": self.payment.collecting_branch_id,
            "amount": self.amount,
            "reason": self.reason,
            "status": self.status,
            "requested_by": user_summary(self.requester),
            "requested_at": self.requested_at,
            "decided_by": user_summary(self.decider),
            "decided_at": self.decided_at,
            "decision_note": self.decision_note,
            "reversal": {"payment_id": self.reversal.payment_id, "receipt_number": self.reversal.receipt_number}
            if self.reversal else None,
        }


class UnallocatedAdvance(db.Model):
    """Read-only view: payments not yet allocated to an invoice (and not reversed)."""

    __tablename__ = "unallocated_advances"

    payment_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    receipt_number: Mapped[str] = mapped_column(String(30))
    person_id: Mapped[int] = mapped_column(Integer, ForeignKey("persons.person_id"))
    lead_id: Mapped[int | None] = mapped_column(Integer)
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    payment_date: Mapped[date] = mapped_column(Date)
    collecting_branch_id: Mapped[int] = mapped_column(Integer)
    verification_status: Mapped[str] = mapped_column(PaymentVerification)

    person: Mapped[Person] = relationship(lazy="joined", viewonly=True)

    def to_dict(self) -> dict:
        return {"payment_id": self.payment_id, "receipt_number": self.receipt_number, "person": self.person.to_summary(),
                "lead_id": self.lead_id, "amount": self.amount, "payment_date": self.payment_date,
                "collecting_branch_id": self.collecting_branch_id, "verification_status": self.verification_status}
