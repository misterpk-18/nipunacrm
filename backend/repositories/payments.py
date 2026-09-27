"""Payments ledger, unallocated advances and correction request queries."""
from sqlalchemy import Select, func, or_, select

from config.database import db
from models import Payment, PaymentCorrectionRequest, Person, UnallocatedAdvance


def payments_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    stmt = (select(Payment).join(Person, Person.person_id == Payment.person_id)
            .order_by(Payment.created_at.desc(), Payment.payment_id.desc()))
    if branch_ids is not None:
        stmt = stmt.where(Payment.collecting_branch_id.in_(branch_ids))
    for field, column in (("branch_id", Payment.collecting_branch_id), ("status", Payment.verification_status),
                          ("entry_type", Payment.entry_type), ("invoice_id", Payment.invoice_id),
                          ("person_id", Payment.person_id), ("admission_id", Payment.admission_id),
                          ("payment_mode_id", Payment.payment_mode_id)):
        if filters.get(field) is not None:
            stmt = stmt.where(column == filters[field])
    if filters.get("from"):
        stmt = stmt.where(Payment.payment_date >= filters["from"])
    if filters.get("to"):
        stmt = stmt.where(Payment.payment_date <= filters["to"])
    if filters.get("q"):
        pattern = f"%{filters['q']}%"
        stmt = stmt.where(or_(Payment.receipt_number.ilike(pattern), Person.full_name.ilike(pattern),
                              Payment.reference.ilike(pattern)))
    return stmt


def totals(stmt: Select) -> dict:
    """Verified net (reversals included) and pending verification (never counted)."""
    sub = stmt.order_by(None).with_only_columns(Payment.amount, Payment.verification_status).subquery()
    row = db.session.execute(select(
        func.coalesce(func.sum(sub.c.amount).filter(sub.c.verification_status == "Verified"), 0),
        func.coalesce(func.sum(sub.c.amount).filter(sub.c.verification_status == "Pending Verification",
                                                    sub.c.amount > 0), 0),
    )).one()
    return {"verified_net": row[0], "pending_verification": row[1]}


def invoice_taken(invoice_id: int):
    """Money already on the invoice that counts against its cap (everything except Failed)."""
    return db.session.execute(
        select(func.coalesce(func.sum(Payment.amount), 0))
        .where(Payment.invoice_id == invoice_id, Payment.verification_status != "Failed")
    ).scalar_one()


def unallocated_stmt(branch_ids: set[int] | None, person_id: int | None = None) -> Select:
    stmt = select(UnallocatedAdvance).order_by(UnallocatedAdvance.payment_date, UnallocatedAdvance.payment_id)
    if branch_ids is not None:
        stmt = stmt.where(UnallocatedAdvance.collecting_branch_id.in_(branch_ids))
    if person_id:
        stmt = stmt.where(UnallocatedAdvance.person_id == person_id)
    return stmt


def corrections_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    stmt = (select(PaymentCorrectionRequest).join(Payment, Payment.payment_id == PaymentCorrectionRequest.payment_id)
            .order_by(PaymentCorrectionRequest.requested_at.desc()))
    if branch_ids is not None:
        stmt = stmt.where(Payment.collecting_branch_id.in_(branch_ids))
    if filters.get("status"):
        stmt = stmt.where(PaymentCorrectionRequest.status == filters["status"])
    if filters.get("invoice_id"):
        stmt = stmt.where(Payment.invoice_id == filters["invoice_id"])
    return stmt
