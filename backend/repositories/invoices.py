"""Invoice register queries (scoped by collecting branch)."""
from sqlalchemy import Select, exists, func, or_, select, text

from config.database import db
from models import (
    Admission, Course, InstallmentDue, Invoice, InvoiceBalance, InvoiceLine, Payment, PaymentCorrectionRequest, Person,
)


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
                          ("person_id", Invoice.person_id), ("completion", InvoiceBalance.payment_completion)):
        if filters.get(field) is not None:
            stmt = stmt.where(column == filters[field])
    if filters.get("lead_id") is not None:
        stmt = stmt.where(exists().where(InvoiceLine.invoice_id == Invoice.invoice_id,
                                         InvoiceLine.lead_id == filters["lead_id"]))
    if filters.get("outstanding"):
        stmt = stmt.where(InvoiceBalance.outstanding > 0, Invoice.status == "Issued")
    if filters.get("q"):
        pattern = f"%{filters['q']}%"
        course_match = exists().where(InvoiceLine.invoice_id == Invoice.invoice_id,
                                      InvoiceLine.course_id == Course.course_id, Course.course_title.ilike(pattern))
        stmt = stmt.where(or_(Invoice.invoice_number.ilike(pattern), Person.full_name.ilike(pattern), course_match))
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


def admissions_for(invoice_id: int) -> list[Admission]:
    stmt = select(Admission).where(Admission.invoice_id == invoice_id).order_by(Admission.admission_id)
    return list(db.session.execute(stmt).scalars())


def line_token_status(invoice_line_id: int) -> dict:
    """Admission prerequisite (db 021): verified money on the course line reaching the admission token (₹1,000 or
    the whole line if smaller). payment_id is the payment that reached it (None until then)."""
    row = db.session.execute(text("SELECT * FROM invoice_line_token_payment(:id)"),
                             {"id": invoice_line_id}).mappings().one()
    return dict(row)
