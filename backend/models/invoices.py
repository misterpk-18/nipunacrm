"""Invoice register, instalment schedule, and the balance / dues views built on them."""
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, SmallInteger, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from config.database import db
from models.commercials import PaymentPlan
from models.courses import Course
from models.enums import InvoiceStatus
from models.leads import Lead, Person, user_summary
from models.masters import Branch


class Invoice(db.Model):
    """One learner at one issuing branch; one line per course (db 021). Immutable except status and a fee-change
    revision (triggers). The issuer block is a snapshot taken when the invoice is issued."""

    __tablename__ = "invoices"

    invoice_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    invoice_number: Mapped[str] = mapped_column(String(30), unique=True)  # INV-GNT-2627-0001, set by trigger
    person_id: Mapped[int] = mapped_column(Integer, ForeignKey("persons.person_id"))
    collecting_branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    payment_plan_id: Mapped[int] = mapped_column(Integer, ForeignKey("payment_plans.payment_plan_id"))
    standard_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0)  # sum of lines (trigger)
    billed_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0)  # sum of lines (trigger)
    terms: Mapped[str | None] = mapped_column(Text)
    issued_on: Mapped[date] = mapped_column(Date, server_default=db.func.current_date())
    day0_date: Mapped[date] = mapped_column(Date)
    status: Mapped[str] = mapped_column(InvoiceStatus, default="Issued")
    superseded_by_invoice_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("invoices.invoice_id"))
    cancel_reason: Mapped[str | None] = mapped_column(Text)
    original_billed_amount: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    revised_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    issued_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.user_id"))
    issuer_legal_name: Mapped[str | None] = mapped_column(String(150))
    issuer_branch_code: Mapped[str | None] = mapped_column(String(20))
    issuer_branch_name: Mapped[str | None] = mapped_column(String(100))
    issuer_address: Mapped[str | None] = mapped_column(Text)
    issuer_phone: Mapped[str | None] = mapped_column(String(20))
    issuer_email: Mapped[str | None] = mapped_column(String(255))
    issuer_accent: Mapped[str | None] = mapped_column(String(7))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    person: Mapped[Person] = relationship(lazy="joined")
    collecting_branch: Mapped[Branch] = relationship(lazy="joined")
    payment_plan: Mapped[PaymentPlan] = relationship(lazy="joined")
    lines: Mapped[list["InvoiceLine"]] = relationship(lazy="selectin", order_by="InvoiceLine.line_no",
                                                      back_populates="invoice")
    installments: Mapped[list["Installment"]] = relationship(lazy="selectin", order_by="Installment.installment_no")
    balance: Mapped["InvoiceBalance"] = relationship(
        primaryjoin="Invoice.invoice_id == foreign(InvoiceBalance.invoice_id)", lazy="joined", viewonly=True
    )

    @property
    def issuer(self) -> dict:
        return {"legal_name": self.issuer_legal_name, "branch_code": self.issuer_branch_code,
                "branch_name": self.issuer_branch_name, "address": self.issuer_address, "phone": self.issuer_phone,
                "email": self.issuer_email, "accent": self.issuer_accent}

    def to_summary(self) -> dict:
        return {"invoice_id": self.invoice_id, "invoice_number": self.invoice_number, "status": self.status,
                "billed_amount": self.billed_amount}

    def to_row(self) -> dict:
        balance = self.balance
        return {
            **self.to_summary(),
            "person": self.person.to_summary(),
            "collecting_branch": self.collecting_branch.to_summary(),
            "courses": [{"invoice_line_id": line.invoice_line_id, "line_code": line.line_code,
                         "lead_id": line.lead_id, "course": line.course.to_summary(),
                         "billed_amount": line.billed_amount} for line in self.lines],
            "payment_plan": {"plan_code": self.payment_plan.plan_code, "plan_name": self.payment_plan.plan_name,
                             "installments": len(self.installments)},
            "issued_on": self.issued_on,
            "verified_paid": balance.verified_paid,
            "pending_verification": balance.pending_verification,
            "waived": balance.waived,
            "outstanding": balance.outstanding,
            "payment_completion": balance.payment_completion,
            "invoice_state": balance.invoice_state,
            "admitted_lines": balance.admitted_lines,
        }

    def to_dict(self) -> dict:
        return {
            **self.to_row(),
            "standard_fee": self.standard_fee,
            "terms": self.terms,
            "day0_date": self.day0_date,
            "issuer": self.issuer,
            "superseded_by_invoice_id": self.superseded_by_invoice_id,
            "cancel_reason": self.cancel_reason,
            "original_billed_amount": self.original_billed_amount,
            "revised_at": self.revised_at,
            "issued_by": self.issued_by,
            "created_at": self.created_at,
        }


class InvoiceLine(db.Model):
    """One course deal on an invoice (db 021). Filled from the deal's approved fee version by a trigger."""

    __tablename__ = "invoice_lines"

    invoice_line_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    invoice_id: Mapped[int] = mapped_column(Integer, ForeignKey("invoices.invoice_id"))
    line_no: Mapped[int] = mapped_column(SmallInteger)                 # set by trigger
    line_code: Mapped[str] = mapped_column(String(40), unique=True)    # INV-GNT-2627-0001-L1, set by trigger
    lead_id: Mapped[int] = mapped_column(Integer, ForeignKey("leads.lead_id"))
    fee_discussion_id: Mapped[int] = mapped_column(Integer, ForeignKey("fee_discussions.fee_discussion_id"))
    fee_version_id: Mapped[int] = mapped_column(Integer, ForeignKey("fee_discussion_versions.version_id"))
    course_id: Mapped[int] = mapped_column(Integer, ForeignKey("courses.course_id"))
    delivery_plan_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("delivery_plans.delivery_plan_id"))
    standard_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    billed_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    original_billed_amount: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    revised_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=db.func.now())

    invoice: Mapped[Invoice] = relationship(back_populates="lines")
    lead: Mapped[Lead] = relationship(lazy="joined")
    course: Mapped[Course] = relationship(lazy="joined")
    balance: Mapped["InvoiceLineBalance"] = relationship(
        primaryjoin="InvoiceLine.invoice_line_id == foreign(InvoiceLineBalance.invoice_line_id)", lazy="joined",
        viewonly=True,
    )

    def to_dict(self) -> dict:
        balance = self.balance
        return {
            "invoice_line_id": self.invoice_line_id, "line_no": self.line_no, "line_code": self.line_code,
            "lead": self.lead.to_summary(), "course": self.course.to_summary(),
            "fee_discussion_id": self.fee_discussion_id, "fee_version_id": self.fee_version_id,
            "delivery_plan_id": self.delivery_plan_id, "standard_fee": self.standard_fee,
            "billed_amount": self.billed_amount, "original_billed_amount": self.original_billed_amount,
            "revised_at": self.revised_at,
            "verified_paid": balance.verified_paid, "pending_verification": balance.pending_verification,
            "waived": balance.waived, "outstanding": balance.outstanding,
            "open_to_allocate": balance.open_to_allocate, "payment_completion": balance.payment_completion,
            "admission_id": balance.admission_id,
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
    line_count: Mapped[int] = mapped_column(Integer)
    admitted_lines: Mapped[int] = mapped_column(Integer)
    all_admissions_cancelled: Mapped[bool] = mapped_column(Boolean)


class InvoiceLineBalance(db.Model):
    """Read-only view (db 021): per course line — verified, pending (never counted), waived, outstanding, and what
    can still be allocated (pending counts against the cap)."""

    __tablename__ = "invoice_line_balances"

    invoice_line_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    line_code: Mapped[str] = mapped_column(String(40))
    line_no: Mapped[int] = mapped_column(SmallInteger)
    invoice_id: Mapped[int] = mapped_column(Integer)
    invoice_number: Mapped[str] = mapped_column(String(30))
    person_id: Mapped[int] = mapped_column(Integer)
    lead_id: Mapped[int] = mapped_column(Integer)
    course_id: Mapped[int] = mapped_column(Integer)
    collecting_branch_id: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(InvoiceStatus)
    admission_id: Mapped[int | None] = mapped_column(Integer)
    billed_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    verified_paid: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    pending_verification: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    waived: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    taken: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    outstanding: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    open_to_allocate: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    payment_completion: Mapped[str] = mapped_column(String(20))


class InstallmentDue(db.Model):
    """Read-only view: per instalment, verified money applied oldest-first, due position, age band, contact hold."""

    __tablename__ = "installment_dues"

    installment_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    invoice_id: Mapped[int] = mapped_column(Integer)
    invoice_number: Mapped[str] = mapped_column(String(30))
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


class PaymentGap(db.Model):
    """Read-only view (db 018): open invoices whose next unpaid instalment is due more than
    `payment_gap_alert_days` after the last verified payment."""

    __tablename__ = "payment_gaps"

    invoice_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    invoice_number: Mapped[str] = mapped_column(String(30))
    person_id: Mapped[int] = mapped_column(Integer, ForeignKey("persons.person_id"))
    lead_id: Mapped[int] = mapped_column(Integer, ForeignKey("leads.lead_id"))  # the invoice's first course
    collecting_branch_id: Mapped[int] = mapped_column(Integer, ForeignKey("branches.branch_id"))
    last_payment_date: Mapped[date] = mapped_column(Date)
    next_installment_no: Mapped[int] = mapped_column(SmallInteger)
    next_due_date: Mapped[date] = mapped_column(Date)
    next_due_balance: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    gap_days: Mapped[int] = mapped_column(Integer)
    outstanding: Mapped[Decimal] = mapped_column(Numeric(12, 2))

    person: Mapped[Person] = relationship(lazy="joined", viewonly=True)
    lead: Mapped[Lead] = relationship(lazy="joined", viewonly=True)
    branch: Mapped[Branch] = relationship(lazy="joined", viewonly=True)
    invoice: Mapped[Invoice] = relationship(primaryjoin="PaymentGap.invoice_id == foreign(Invoice.invoice_id)",
                                            lazy="joined", viewonly=True)

    def to_dict(self) -> dict:
        return {
            "invoice_id": self.invoice_id,
            "invoice_number": self.invoice_number,
            "person": self.person.to_summary(),
            "lead_id": self.lead_id,
            "owner": user_summary(self.lead.owner),
            "courses": [line.course.to_summary() for line in self.invoice.lines],
            "branch": self.branch.to_summary(),
            "last_payment_date": self.last_payment_date,
            "next_installment_no": self.next_installment_no,
            "next_due_date": self.next_due_date,
            "next_due_balance": self.next_due_balance,
            "gap_days": self.gap_days,
            "outstanding": self.outstanding,
        }
