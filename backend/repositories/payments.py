"""Payments ledger, unallocated advances and correction request queries."""
from sqlalchemy import Select

from config.database import db
from models import Payment, PaymentCorrectionRequest, UnallocatedAdvance
from repositories.common import raw_parts, raw_select, text

# Equality filters: request field -> fixed SQL (the value always travels as a :named parameter).
_EQUALS_FILTERS = {
    "branch_id": "p.collecting_branch_id = :branch_id",
    "status": "p.verification_status = :status",
    "entry_type": "p.entry_type = :entry_type",
    "invoice_id": "p.invoice_id = :invoice_id",
    "person_id": "p.person_id = :person_id",
    "admission_id": "p.admission_id = :admission_id",
    "payment_mode_id": "p.payment_mode_id = :payment_mode_id",
}


def payments_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    conditions = ["TRUE"]
    params = {}
    if branch_ids is not None:
        conditions.append("p.collecting_branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    for field, fragment in _EQUALS_FILTERS.items():
        if filters.get(field) is not None:
            conditions.append(fragment)
            params[field] = filters[field]
    if filters.get("from"):
        conditions.append("p.payment_date >= :date_from")
        params["date_from"] = filters["from"]
    if filters.get("to"):
        conditions.append("p.payment_date <= :date_to")
        params["date_to"] = filters["to"]
    if filters.get("q"):
        conditions.append("(p.receipt_number ILIKE :pattern OR p.transaction_number ILIKE :pattern "
                          "OR pe.full_name ILIKE :pattern OR p.reference ILIKE :pattern)")
        params["pattern"] = f"%{filters['q']}%"
    sql = text("""
        SELECT p.*
        FROM payments p
        JOIN persons pe ON pe.person_id = p.person_id
        WHERE """ + " AND ".join(conditions))
    return raw_select(Payment, sql, params, "created_at DESC, payment_id DESC")


def totals(stmt: Select) -> dict:
    """Verified net (reversals included) and pending verification (never counted)."""
    inner_sql, params = raw_parts(stmt)
    sql = text("""
        SELECT COALESCE(SUM(f.amount) FILTER (WHERE f.verification_status = 'Verified'), 0),
               COALESCE(SUM(f.amount) FILTER (WHERE f.verification_status = 'Pending Verification' AND f.amount > 0), 0)
        FROM (""" + inner_sql + """) f
    """)
    row = db.session.execute(sql, params).one()
    return {"verified_net": row[0], "pending_verification": row[1]}


def invoice_taken(invoice_id: int):
    """Money already on the invoice that counts against its cap (everything except Failed)."""
    return db.session.execute(
        text("SELECT COALESCE(SUM(amount), 0) FROM payments "
             "WHERE invoice_id = :invoice_id AND verification_status != 'Failed'"),
        {"invoice_id": invoice_id},
    ).scalar_one()


def unallocated_stmt(branch_ids: set[int] | None, person_id: int | None = None) -> Select:
    conditions = ["TRUE"]
    params = {}
    if branch_ids is not None:
        conditions.append("ua.collecting_branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    if person_id:
        conditions.append("ua.person_id = :person_id")
        params["person_id"] = person_id
    sql = text("""
        SELECT ua.*
        FROM unallocated_advances ua
        WHERE """ + " AND ".join(conditions))
    return raw_select(UnallocatedAdvance, sql, params, "payment_date, payment_id")


def corrections_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    conditions = ["TRUE"]
    params = {}
    if branch_ids is not None:
        conditions.append("p.collecting_branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    if filters.get("status"):
        conditions.append("pcr.status = :status")
        params["status"] = filters["status"]
    if filters.get("invoice_id"):
        conditions.append("p.invoice_id = :invoice_id")
        params["invoice_id"] = filters["invoice_id"]
    sql = text("""
        SELECT pcr.*
        FROM payment_correction_requests pcr
        JOIN payments p ON p.payment_id = pcr.payment_id
        WHERE """ + " AND ".join(conditions))
    return raw_select(PaymentCorrectionRequest, sql, params, "requested_at DESC")
