"""Invoice register queries (scoped by collecting branch)."""
from sqlalchemy import Select, select

from config.database import db
from models import Admission, InstallmentDue, Invoice, Payment, PaymentCorrectionRequest
from repositories.common import raw_parts, raw_select, text

# Equality filters: request field -> fixed SQL (the value always travels as a :named parameter).
_EQUALS_FILTERS = {
    "branch_id": "i.collecting_branch_id = :branch_id",
    "status": "i.status = :status",
    "person_id": "i.person_id = :person_id",
    "completion": "ib.payment_completion = :completion",
}


def invoices_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    conditions = ["TRUE"]
    params = {}
    if branch_ids is not None:
        conditions.append("i.collecting_branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    for field, fragment in _EQUALS_FILTERS.items():
        if filters.get(field) is not None:
            conditions.append(fragment)
            params[field] = filters[field]
    if filters.get("lead_id") is not None:
        conditions.append("EXISTS (SELECT 1 FROM invoice_lines il WHERE il.invoice_id = i.invoice_id "
                          "AND il.lead_id = :lead_id)")
        params["lead_id"] = filters["lead_id"]
    if filters.get("outstanding"):
        conditions.append("ib.outstanding > 0 AND i.status = 'Issued'")
    if filters.get("q"):
        conditions.append("""(i.invoice_number ILIKE :pattern OR pe.full_name ILIKE :pattern
            OR EXISTS (SELECT 1 FROM invoice_lines il JOIN courses c ON c.course_id = il.course_id
                       WHERE il.invoice_id = i.invoice_id AND c.course_title ILIKE :pattern))""")
        params["pattern"] = f"%{filters['q']}%"
    sql = text("""
        SELECT i.*
        FROM invoices i
        JOIN invoice_balances ib ON ib.invoice_id = i.invoice_id
        JOIN persons pe ON pe.person_id = i.person_id
        WHERE """ + " AND ".join(conditions))
    return raw_select(Invoice, sql, params, "issued_on DESC, invoice_id DESC")


def totals(stmt: Select) -> dict:
    """Billed, verified paid, pending verification (never counted), outstanding over the filtered invoices."""
    inner_sql, params = raw_parts(stmt)
    sql = text("""
        SELECT COALESCE(SUM(billed_amount), 0), COALESCE(SUM(verified_paid), 0),
               COALESCE(SUM(pending_verification), 0), COALESCE(SUM(outstanding), 0)
        FROM invoice_balances
        WHERE invoice_id IN (SELECT f.invoice_id FROM (""" + inner_sql + """) f) AND status = 'Issued'
    """)
    row = db.session.execute(sql, params).one()
    return dict(zip(("billed", "verified_paid", "pending_verification", "outstanding"), row))


def dues_for(invoice_id: int) -> list[InstallmentDue]:
    sql = text("""
        SELECT d.*
        FROM installment_dues d
        WHERE d.invoice_id = :invoice_id
        ORDER BY d.installment_no
    """)
    return list(db.session.execute(select(InstallmentDue).from_statement(sql), {"invoice_id": invoice_id}).scalars())


def payments_for(invoice_id: int) -> list[Payment]:
    sql = text("""
        SELECT p.*
        FROM payments p
        WHERE p.invoice_id = :invoice_id
        ORDER BY p.created_at, p.payment_id
    """)
    return list(db.session.execute(select(Payment).from_statement(sql), {"invoice_id": invoice_id}).scalars())


def corrections_for(invoice_id: int) -> list[PaymentCorrectionRequest]:
    sql = text("""
        SELECT pcr.*
        FROM payment_correction_requests pcr
        JOIN payments p ON p.payment_id = pcr.payment_id
        WHERE p.invoice_id = :invoice_id
        ORDER BY pcr.correction_request_id
    """)
    return list(db.session.execute(select(PaymentCorrectionRequest).from_statement(sql),
                                    {"invoice_id": invoice_id}).scalars())


def admissions_for(invoice_id: int) -> list[Admission]:
    sql = text("""
        SELECT a.*
        FROM admissions a
        WHERE a.invoice_id = :invoice_id
        ORDER BY a.admission_id
    """)
    return list(db.session.execute(select(Admission).from_statement(sql), {"invoice_id": invoice_id}).scalars())


def line_token_status(invoice_line_id: int) -> dict:
    """Admission prerequisite (db 021): verified money on the course line reaching the admission token (₹1,000 or
    the whole line if smaller). payment_id is the payment that reached it (None until then)."""
    row = db.session.execute(text("SELECT * FROM invoice_line_token_payment(:id)"),
                             {"id": invoice_line_id}).mappings().one()
    return dict(row)
