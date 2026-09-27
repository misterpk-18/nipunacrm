"""Collections: instalment dues (invoice level, pre-admission invoices included) and ageing."""
from sqlalchemy import func, select

from config.database import db
from models import InstallmentDue, Invoice, PaymentPromise

AGE_BANDS = ("1–3", "4–7", "8–15", "16–30", "31–60", "61–90", "91+")


def _filtered(filters: dict, branch_ids: set[int] | None):
    stmt = select(InstallmentDue).where(InstallmentDue.balance > 0, InstallmentDue.due_position != "Cancelled")
    if branch_ids is not None:
        stmt = stmt.where(InstallmentDue.collecting_branch_id.in_(branch_ids))
    for field, column in (("branch_id", InstallmentDue.collecting_branch_id), ("position", InstallmentDue.due_position),
                          ("age_band", InstallmentDue.age_band), ("contact_hold", InstallmentDue.contact_hold),
                          ("person_id", InstallmentDue.person_id)):
        if filters.get(field) is not None:
            stmt = stmt.where(column == filters[field])
    if filters.get("plan_code"):
        stmt = stmt.join(Invoice, Invoice.invoice_id == InstallmentDue.invoice_id).where(
            Invoice.payment_plan.has(plan_code=filters["plan_code"]))
    return stmt


def due_invoice_ids(filters: dict, branch_ids: set[int] | None, page: int, per_page: int) -> tuple[list[int], int]:
    """One coordinated plan per invoice: page over invoices, earliest due first."""
    sub = _filtered(filters, branch_ids).subquery()
    grouped = (select(sub.c.invoice_id, func.min(sub.c.due_date).label("first_due"))
               .group_by(sub.c.invoice_id).order_by("first_due", sub.c.invoice_id))
    total = db.session.execute(select(func.count()).select_from(grouped.subquery())).scalar_one()
    ids = [row.invoice_id for row in db.session.execute(grouped.limit(per_page).offset((page - 1) * per_page))]
    return ids, total


def dues_for_invoices(invoice_ids: list[int], filters: dict, branch_ids: set[int] | None) -> list[InstallmentDue]:
    if not invoice_ids:
        return []
    stmt = _filtered(filters, branch_ids).where(InstallmentDue.invoice_id.in_(invoice_ids)).order_by(
        InstallmentDue.invoice_id, InstallmentDue.installment_no)
    return list(db.session.execute(stmt).scalars())


def ageing(filters: dict, branch_ids: set[int] | None) -> dict[str, dict]:
    sub = _filtered({**filters, "position": "Overdue"}, branch_ids).subquery()
    rows = db.session.execute(select(sub.c.age_band, func.count(), func.coalesce(func.sum(sub.c.balance), 0))
                              .group_by(sub.c.age_band)).all()
    found = {band: {"installments": count, "balance": balance} for band, count, balance in rows}
    return {band: found.get(band, {"installments": 0, "balance": 0}) for band in AGE_BANDS}


def promises_for(admission_id: int) -> list[PaymentPromise]:
    stmt = select(PaymentPromise).where(PaymentPromise.admission_id == admission_id).order_by(PaymentPromise.promise_id.desc())
    return list(db.session.execute(stmt).scalars())
