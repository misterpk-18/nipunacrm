"""Collections: instalment dues (invoice level, pre-admission invoices included) and ageing."""
from sqlalchemy import select

from config.database import db
from models import InstallmentDue, PaymentPromise
from repositories.common import text

AGE_BANDS = ("1–3", "4–7", "8–15", "16–30", "31–60", "61–90", "91+")

# Equality filters: request field -> fixed SQL (the value always travels as a :named parameter).
_EQUALS_FILTERS = {
    "branch_id": "d.collecting_branch_id = :branch_id",
    "position": "d.due_position = :position",
    "age_band": "d.age_band = :age_band",
    "contact_hold": "d.contact_hold = :contact_hold",
    "person_id": "d.person_id = :person_id",
}


def _where(filters: dict, branch_ids: set[int] | None) -> tuple[str, dict]:
    """WHERE fragment (over installment_dues aliased d) and its params, shared by every query below."""
    conditions = ["d.balance > 0", "d.due_position != 'Cancelled'"]
    params = {}
    if branch_ids is not None:
        conditions.append("d.collecting_branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    for field, fragment in _EQUALS_FILTERS.items():
        if filters.get(field) is not None:
            conditions.append(fragment)
            params[field] = filters[field]
    if filters.get("plan_code"):
        conditions.append("""EXISTS (SELECT 1 FROM invoices i JOIN payment_plans pp ON pp.payment_plan_id = i.payment_plan_id
                             WHERE i.invoice_id = d.invoice_id AND pp.plan_code = :plan_code)""")
        params["plan_code"] = filters["plan_code"]
    return " AND ".join(conditions), params


def due_invoice_ids(filters: dict, branch_ids: set[int] | None, page: int, per_page: int) -> tuple[list[int], int]:
    """One coordinated plan per invoice: page over invoices, earliest due first."""
    where, params = _where(filters, branch_ids)
    grouped = """
        SELECT d.invoice_id, MIN(d.due_date) AS first_due
        FROM installment_dues d
        WHERE """ + where + """
        GROUP BY d.invoice_id"""
    total = db.session.execute(text("SELECT COUNT(*) FROM (" + grouped + ") g"), params).scalar_one()
    page_sql = text(grouped + """
        ORDER BY first_due, d.invoice_id
        LIMIT :limit OFFSET :offset""")
    rows = db.session.execute(page_sql, {**params, "limit": per_page, "offset": (page - 1) * per_page})
    return [row.invoice_id for row in rows], total


def dues_for_invoices(invoice_ids: list[int], filters: dict, branch_ids: set[int] | None) -> list[InstallmentDue]:
    if not invoice_ids:
        return []
    where, params = _where(filters, branch_ids)
    sql = text("""
        SELECT d.*
        FROM installment_dues d
        WHERE """ + where + """ AND d.invoice_id = ANY(:invoice_ids)
        ORDER BY d.invoice_id, d.installment_no""")
    return list(db.session.execute(select(InstallmentDue).from_statement(sql),
                                   {**params, "invoice_ids": list(invoice_ids)}).scalars())


def ageing(filters: dict, branch_ids: set[int] | None) -> dict[str, dict]:
    where, params = _where({**filters, "position": "Overdue"}, branch_ids)
    sql = text("""
        SELECT d.age_band, COUNT(*), COALESCE(SUM(d.balance), 0)
        FROM installment_dues d
        WHERE """ + where + """
        GROUP BY d.age_band""")
    rows = db.session.execute(sql, params).all()
    found = {band: {"installments": count, "balance": balance} for band, count, balance in rows}
    return {band: found.get(band, {"installments": 0, "balance": 0}) for band in AGE_BANDS}


def promises_for(invoice_id: int) -> list[PaymentPromise]:
    sql = text("""
        SELECT pp.*
        FROM payment_promises pp
        WHERE pp.invoice_id = :invoice_id
        ORDER BY pp.promise_id DESC
    """)
    return list(db.session.execute(select(PaymentPromise).from_statement(sql), {"invoice_id": invoice_id}).scalars())
