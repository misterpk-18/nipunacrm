"""Invoice register queries (scoped by collecting branch)."""
from sqlalchemy import Select, func, or_, select

from config.database import db
from models import InstallmentDue, Invoice, InvoiceBalance, Payment, PaymentCorrectionRequest, Person


def invoices_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    stmt = (
        select(Invoice)
        .join(InvoiceBalance, InvoiceBalance.invoice_id == Invoice.invoice_id)
        .join(Person, Person.person_id == Invoice.person_id)
        .order_by(Invoice.issued_on.desc(), Invoice.invoice_id.desc())
    )
    if branch_ids is not None:
        stmt = stmt.where(Invoice.collecting_branch_id.in_(branch_ids))
    for field, column in (("branch_id", Invoice.collecting_branch_id), ("status", Invoice.status),
                          ("person_id", Invoice.person_id), ("lead_id", Invoice.lead_id),
                          ("completion", InvoiceBalance.payment_completion)):
        if filters.get(field) is not None:
            stmt = stmt.where(column == filters[field])
    if filters.get("q"):
        pattern = f"%{filters['q']}%"
        stmt = stmt.where(or_(Invoice.invoice_number.ilike(pattern), Person.full_name.ilike(pattern)))
    return stmt


def totals(stmt: Select) -> dict:
    """Billed, verified paid, pending verification (never counted), outstanding over the filtered invoices."""
    ids = stmt.order_by(None).with_only_columns(Invoice.invoice_id).subquery()
    row = db.session.execute(
        select(func.coalesce(func.sum(InvoiceBalance.billed_amount), 0),
               func.coalesce(func.sum(InvoiceBalance.verified_paid), 0),
               func.coalesce(func.sum(InvoiceBalance.pending_verification), 0),
               func.coalesce(func.sum(InvoiceBalance.outstanding), 0))
        .where(InvoiceBalance.invoice_id.in_(select(ids.c.invoice_id)), InvoiceBalance.status == "Issued")
    ).one()
    return dict(zip(("billed", "verified_paid", "pending_verification", "outstanding"), row))


def dues_for(invoice_id: int) -> list[InstallmentDue]:
    stmt = select(InstallmentDue).where(InstallmentDue.invoice_id == invoice_id).order_by(InstallmentDue.installment_no)
    return list(db.session.execute(stmt).scalars())


def payments_for(invoice_id: int) -> list[Payment]:
    stmt = select(Payment).where(Payment.invoice_id == invoice_id).order_by(Payment.created_at, Payment.payment_id)
    return list(db.session.execute(stmt).scalars())


def corrections_for(invoice_id: int) -> list[PaymentCorrectionRequest]:
    stmt = (select(PaymentCorrectionRequest).join(Payment, Payment.payment_id == PaymentCorrectionRequest.payment_id)
            .where(Payment.invoice_id == invoice_id).order_by(PaymentCorrectionRequest.correction_request_id))
    return list(db.session.execute(stmt).scalars())


def first_qualifying_payment(invoice_id: int) -> Payment | None:
    """The earliest Verified, un-reversed payment allocated to the invoice (admission prerequisite 2)."""
    reversed_ids = select(Payment.reverses_payment_id).where(Payment.reverses_payment_id.is_not(None))
    stmt = (select(Payment).where(Payment.invoice_id == invoice_id, Payment.entry_type == "Payment",
                                  Payment.verification_status == "Verified", Payment.payment_id.not_in(reversed_ids))
            .order_by(Payment.verified_at, Payment.payment_id).limit(1))
    return db.session.execute(stmt).scalar_one_or_none()
