"""Admissions, batches and allocation queries."""
from sqlalchemy import Select, select

from config.database import db
from models import (
    Admission, AdmissionBalance, AdmissionFeeChange, Batch, BatchAllocation, BatchAllocationQueue, Invoice, InvoiceLine,
    Person,
)
from repositories.common import text


def _equals(where: list[str], params: dict, filters: dict, fields: tuple[tuple[str, str], ...]) -> None:
    """Add `column = :field` for each filter present; columns are fixed literals from the caller."""
    for field, column in fields:
        if filters.get(field) is not None:
            where.append(f"{column} = :{field}")
            params[field] = filters[field]


def admissions_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    """Kept as a Select (paginated with db.paginate, which needs limit/offset): the filter is raw SQL."""
    where = ["TRUE"]
    params: dict = {}
    if branch_ids is not None:
        where.append("(admissions.service_branch_id = ANY(:branch_ids) OR admissions.original_branch_id = ANY(:branch_ids))")
        params["branch_ids"] = list(branch_ids)
    if filters.get("branch_id"):
        where.append("(admissions.service_branch_id = :branch_id OR admissions.original_branch_id = :branch_id)")
        params["branch_id"] = filters["branch_id"]
    _equals(where, params, filters, (
        ("service_branch_id", "admissions.service_branch_id"), ("original_branch_id", "admissions.original_branch_id"),
        ("enrolment_status", "admissions.enrolment_status"), ("handover_status", "admissions.handover_status"),
        ("lms_status", "admissions.lms_status"), ("seat_type", "admissions.seat_type"),
        ("person_id", "admissions.person_id"), ("course_id", "admissions.course_id"),
        ("payment_completion", "admission_balances.payment_completion")))
    if filters.get("q"):
        where.append("(admissions.admission_code ILIKE :pattern OR persons.full_name ILIKE :pattern "
                     "OR persons.phone ILIKE :pattern)")
        params["pattern"] = f"%{filters['q']}%"
    return (select(Admission).join(Person, Person.person_id == Admission.person_id)
            .join(AdmissionBalance, AdmissionBalance.admission_id == Admission.admission_id)
            .where(text(" AND ".join(where)).bindparams(**params))
            .order_by(text("admissions.created_at DESC, admissions.admission_id DESC")))


def admission_for_line(invoice_line_id: int) -> Admission | None:
    return db.session.execute(select(Admission).from_statement(
        text("SELECT * FROM admissions WHERE invoice_line_id = :invoice_line_id")),
        {"invoice_line_id": invoice_line_id}).scalar_one_or_none()


def unadmitted_lines_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    """Courses on Issued invoices with no admission yet (the New Admission review).
    Kept as a Select (paginated with db.paginate, which needs limit/offset): the filter is raw SQL."""
    where = ["invoices.status = :status",
             "NOT EXISTS (SELECT 1 FROM admissions WHERE admissions.invoice_line_id = invoice_lines.invoice_line_id)"]
    params: dict = {"status": "Issued"}
    if branch_ids is not None:
        where.append("invoices.collecting_branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    if filters.get("branch_id"):
        where.append("invoices.collecting_branch_id = :branch_id")
        params["branch_id"] = filters["branch_id"]
    if filters.get("invoice_id"):
        where.append("invoices.invoice_id = :invoice_id")
        params["invoice_id"] = filters["invoice_id"]
    if filters.get("q"):
        where.append("(invoices.invoice_number ILIKE :pattern OR persons.full_name ILIKE :pattern)")
        params["pattern"] = f"%{filters['q']}%"
    return (select(InvoiceLine).join(Invoice, Invoice.invoice_id == InvoiceLine.invoice_id)
            .join(Person, Person.person_id == Invoice.person_id)
            .where(text(" AND ".join(where)).bindparams(**params))
            .order_by(text("invoices.issued_on DESC, invoice_lines.invoice_line_id DESC")))


def active_allocations(admission_id: int) -> list[BatchAllocation]:
    return list(db.session.execute(select(BatchAllocation).from_statement(text("""
        SELECT * FROM batch_allocations WHERE admission_id = :admission_id AND status = :status
    """)), {"admission_id": admission_id, "status": "Active"}).scalars())


def allocations_for(admission_id: int) -> list[BatchAllocation]:
    return list(db.session.execute(select(BatchAllocation).from_statement(text("""
        SELECT * FROM batch_allocations WHERE admission_id = :admission_id ORDER BY allocation_id
    """)), {"admission_id": admission_id}).scalars())


def fee_changes_for(admission_id: int) -> list[AdmissionFeeChange]:
    return list(db.session.execute(select(AdmissionFeeChange).from_statement(text("""
        SELECT * FROM admission_fee_changes WHERE admission_id = :admission_id ORDER BY fee_change_id
    """)), {"admission_id": admission_id}).scalars())


def batches_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    """Kept as a Select (paginated with db.paginate, which needs limit/offset): the filter is raw SQL."""
    where = ["TRUE"]
    params: dict = {}
    if branch_ids is not None:
        where.append("batches.branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    _equals(where, params, filters, (("branch_id", "batches.branch_id"), ("course_id", "batches.course_id"),
                                     ("status", "batches.status"), ("trainer_id", "batches.trainer_user_id")))
    return (select(Batch).where(text(" AND ".join(where)).bindparams(**params))
            .order_by(text("batches.start_date, batches.batch_id")))


def batch_allocations(batch_id: int) -> list[BatchAllocation]:
    return list(db.session.execute(select(BatchAllocation).from_statement(text("""
        SELECT * FROM batch_allocations WHERE batch_id = :batch_id ORDER BY status, allocation_id
    """)), {"batch_id": batch_id}).scalars())


def queue_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    """Kept as a Select (paginated with db.paginate, and executed directly): the filter is raw SQL."""
    where = ["TRUE"]
    params: dict = {}
    if branch_ids is not None:
        where.append("batch_allocation_queue.service_branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    if filters.get("branch_id"):
        where.append("batch_allocation_queue.service_branch_id = :branch_id")
        params["branch_id"] = filters["branch_id"]
    if filters.get("course_id"):
        where.append("batch_allocation_queue.admission_id IN (SELECT admission_id FROM admissions "
                     "WHERE course_id = :course_id)")
        params["course_id"] = filters["course_id"]
    return (select(BatchAllocationQueue).where(text(" AND ".join(where)).bindparams(**params))
            .order_by(text("batch_allocation_queue.allocate_by ASC NULLS LAST")))
