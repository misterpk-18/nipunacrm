"""Invoice register, instalment schedule, and the balance / dues views built on them."""
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, SmallInteger, String, Text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.commercials import PaymentPlan
from models.courses import Course
from models.enums import InvoiceStatus
from models.leads import Lead, Person
from models.masters import Branch


class Invoice(db.Model):
    """Issued from an Approved fee version; immutable except status and a fee-change revision (triggers)."""

    __tablename__ = "invoices"

    invoice_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    invoice_number: Mapped[str] = mapped_column(String(30), unique=True)  # INV-GNT-2627-0001, set by trigger
    fee_discussion_id: Mapped[int] = mapped_column(Integer, ForeignKey("fee_discussions.fee_discussion_id"))
    fee_version_id: Mapped[int] = mapped_column(Integer, ForeignKey("fee_discussion_versions.version_id"))
    person_id: Mapped[int] = mapped_column(Integer, ForeignKey("persons.person_id"))
    lead_id: Mapped[int] = mapped_column(Integer, ForeignKey("leads.lead_id"))
    course_id: Mapped[int] = mapped_column(Integer, ForeignKey("courses.course_id"))
    collecting_branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    payment_plan_id: Mapped[int] = mapped_column(Integer, ForeignKey("payment_plans.payment_plan_id"))
    standard_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    billed_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    terms: Mapped[str | None] = mapped_column(Text)
    issued_on: Mapped[date] = mapped_column(Date, server_default=db.func.current_date())
    day0_date: Mapped[date] = mapped_column(Date)
    agreed_due_days: Mapped[list[int] | None] = mapped_column(ARRAY(SmallInteger))
    status: Mapped[str] = mapped_column(InvoiceStatus, default="Issued")
    superseded_by_invoice_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("invoices.invoice_id"))
    cancel_reason: Mapped[str | None] = mapped_column(Text)
    original_billed_amount: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    revised_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    issued_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    person: Mapped[Person] = relationship(lazy="joined")
    lead: Mapped[Lead] = relationship(lazy="joined")
    course: Mapped[Course] = relationship(lazy="joined")
    collecting_branch: Mapped[Branch] = relationship(lazy="joined")
    payment_plan: Mapped[PaymentPlan] = relationship(lazy="joined")
    installments: Mapped[list["Installment"]] = relationship(lazy="selectin", order_by="Installment.installment_no")
    balance: Mapped["InvoiceBalance"] = relationship(
        primaryjoin="Invoice.invoice_id == foreign(InvoiceBalance.invoice_id)", lazy="joined", viewonly=True
    )

    def to_summary(self) -> dict:
        return {"invoice_id": self.invoice_id, "invoice_number": self.invoice_number, "status": self.status,
                "billed_amount": self.billed_amount}

    def to_row(self) -> dict:
        balance = self.balance
        return {
            **self.to_summary(),
            "person": self.person.to_summary(),
            "lead_id": self.lead_id,
            "lead_code": self.lead.lead_code,
            "course": self.course.to_summary(),
            "collecting_branch": self.collecting_branch.to_summary(),
            "payment_plan": {"plan_code": self.payment_plan.plan_code, "plan_name": self.payment_plan.plan_name},
            "issued_on": self.issued_on,
            "admission_id": balance.admission_id,
            "verified_paid": balance.verified_paid,
            "pending_verification": balance.pending_verification,
            "waived": balance.waived,
            "outstanding": balance.outstanding,
            "payment_completion": balance.payment_completion,
            "invoice_state": balance.invoice_state,
        }

    def to_dict(self) -> dict:
        return {
            **self.to_row(),
            "fee_discussion_id": self.fee_discussion_id,
            "fee_version_id": self.fee_version_id,
            "standard_fee": self.standard_fee,
            "terms": self.terms,
            "day0_date": self.day0_date,
            "agreed_due_days": list(self.agreed_due_days) if self.agreed_due_days else None,
            "superseded_by_invoice_id": self.superseded_by_invoice_id,
            "cancel_reason": self.cancel_reason,
            "original_billed_amount": self.original_billed_amount,
            "revised_at": self.revised_at,
            "issued_by": self.issued_by,
            "created_at": self.created_at,
        }


class Installment(db.Model):
    """Built by a trigger when the invoice is issued. Amounts change only through an approved fee change."""

    __tablename__ = "installments"

    installment_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    invoice_id: Mapped[int] = mapped_column(Integer, ForeignKey("invoices.invoice_id"))
    installment_no: Mapped[int] = mapped_column(SmallInteger)
    amount_due: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    due_date: Mapped[date] = mapped_column(Date)


class InvoiceBalance(db.Model):
    """Read-only view: billed, verified paid, pending (never counted), waived, outstanding, completion."""

    __tablename__ = "invoice_balances"

    invoice_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    invoice_number: Mapped[str] = mapped_column(String(30))
    person_id: Mapped[int] = mapped_column(Integer)
    lead_id: Mapped[int] = mapped_column(Integer)
    admission_id: Mapped[int | None] = mapped_column(Integer)
    course_id: Mapped[int] = mapped_column(Integer)
    collecting_branch_id: Mapped[int] = mapped_column(Integer)
    issued_on: Mapped[date] = mapped_column(Date)
    status: Mapped[str] = mapped_column(InvoiceStatus)
    billed_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    verified_paid: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    pending_verification: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    waived: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    outstanding: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    payment_completion: Mapped[str] = mapped_column(String(20))
    invoice_state: Mapped[str] = mapped_column(String(20))


class InstallmentDue(db.Model):
    """Read-only view: per instalment, verified money applied oldest-first, due position, age band, contact hold."""

    __tablename__ = "installment_dues"

    installment_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    invoice_id: Mapped[int] = mapped_column(Integer)
    invoice_number: Mapped[str] = mapped_column(String(30))
    admission_id: Mapped[int | None] = mapped_column(Integer)
    person_id: Mapped[int] = mapped_column(Integer, ForeignKey("persons.person_id"))
    collecting_branch_id: Mapped[int] = mapped_column(Integer)
    installment_no: Mapped[int] = mapped_column(SmallInteger)
    due_date: Mapped[date] = mapped_column(Date)
    amount_due: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    amount_covered: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    balance: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    due_position: Mapped[str] = mapped_column(String(20))
    days_overdue: Mapped[int | None] = mapped_column(Integer)
    age_band: Mapped[str | None] = mapped_column(String(10))
    contact_hold: Mapped[bool] = mapped_column(Boolean)

    person: Mapped[Person] = relationship(lazy="joined", viewonly=True)

    def to_dict(self) -> dict:
        return {
            "installment_id": self.installment_id,
            "installment_no": self.installment_no,
            "invoice_id": self.invoice_id,
            "invoice_number": self.invoice_number,
            "admission_id": self.admission_id,
            "person": self.person.to_summary(),
            "collecting_branch_id": self.collecting_branch_id,
            "due_date": self.due_date,
            "amount_due": self.amount_due,
            "amount_covered": self.amount_covered,
            "balance": self.balance,
            "due_position": self.due_position,
            "days_overdue": self.days_overdue,
            "age_band": self.age_band,
            "contact_hold": self.contact_hold,
        }
