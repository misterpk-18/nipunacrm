"""Student 360 queries: people with admissions, their money, documents, cases, timeline and audit."""
from sqlalchemy import Select, select

from config.database import db
from models import (
    Admission, AuditLog, Certificate, Document, DocumentChecklist, Invoice, LeadActivity, Payment, Person, RefundCase,
    SupportCase,
)
from repositories.common import text


def students_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    """Kept as a Select (paginated with db.paginate, which needs limit/offset): the filter is raw SQL."""
    admission = ["admissions.person_id = persons.person_id"]
    params: dict = {}
    if branch_ids is not None:
        admission.append("(admissions.service_branch_id = ANY(:branch_ids) OR admissions.original_branch_id = ANY(:branch_ids))")
        params["branch_ids"] = list(branch_ids)
    if filters.get("branch_id"):
        admission.append("(admissions.service_branch_id = :branch_id OR admissions.original_branch_id = :branch_id)")
        params["branch_id"] = filters["branch_id"]
    if filters.get("enrolment_status"):
        admission.append("admissions.enrolment_status = :enrolment_status")
        params["enrolment_status"] = filters["enrolment_status"]
    if filters.get("lms_status"):
        admission.append("admissions.lms_status = :lms_status")
        params["lms_status"] = filters["lms_status"]
    where = ["EXISTS (SELECT 1 FROM admissions WHERE " + " AND ".join(admission) + ")"]
    if filters.get("q"):
        where.append("(persons.full_name ILIKE :pattern OR persons.person_code ILIKE :pattern "
                     "OR persons.phone ILIKE :pattern OR persons.email ILIKE :pattern)")
        params["pattern"] = f"%{filters['q']}%"
    return (select(Person).where(text(" AND ".join(where)).bindparams(**params))
            .order_by(text("persons.full_name, persons.person_id")))


def is_student(person_id: int, branch_ids: set[int] | None) -> bool:
    where = ["person_id = :person_id"]
    params: dict = {"person_id": person_id}
    if branch_ids is not None:
        where.append("(service_branch_id = ANY(:branch_ids) OR original_branch_id = ANY(:branch_ids))")
        params["branch_ids"] = list(branch_ids)
    sql = "SELECT admission_id FROM admissions WHERE " + " AND ".join(where) + " LIMIT 1"
    return db.session.execute(text(sql), params).first() is not None


def admissions_of(person_id: int) -> list[Admission]:
    return list(db.session.execute(select(Admission).from_statement(text("""
        SELECT * FROM admissions WHERE person_id = :person_id ORDER BY admission_date, admission_id
    """)), {"person_id": person_id}).scalars())


def summaries(person_ids: list[int]) -> dict[int, dict]:
    """Per person: admissions count, active course titles, verified paid, outstanding, LMS statuses."""
    if not person_ids:
        return {}
    rows = db.session.execute(text("""
        SELECT admissions.person_id, admissions.enrolment_status::text, admissions.lms_status,
               admission_balances.verified_paid, admission_balances.outstanding, admissions.course_id
        FROM admissions
        JOIN admission_balances ON admission_balances.admission_id = admissions.admission_id
        WHERE admissions.person_id = ANY(:person_ids)
    """), {"person_ids": person_ids}).all()
    result: dict[int, dict] = {}
    for person_id, status, lms, paid, outstanding, course_id in rows:
        entry = result.setdefault(person_id, {"admissions": 0, "active_course_ids": [], "verified_paid": 0,
                                              "outstanding": 0, "lms_statuses": set()})
        entry["admissions"] += 1
        if status in Admission.ACTIVE_STATUSES:
            entry["active_course_ids"].append(course_id)
        entry["verified_paid"] += paid
        entry["outstanding"] += outstanding
        entry["lms_statuses"].add(lms)
    return result


def invoices_of(person_id: int) -> list[Invoice]:
    return list(db.session.execute(select(Invoice).from_statement(text("""
        SELECT * FROM invoices WHERE person_id = :person_id ORDER BY issued_on, invoice_id
    """)), {"person_id": person_id}).scalars())


def payments_of(person_id: int) -> list[Payment]:
    return list(db.session.execute(select(Payment).from_statement(text("""
        SELECT * FROM payments WHERE person_id = :person_id ORDER BY created_at, payment_id
    """)), {"person_id": person_id}).scalars())


def documents_of(person_id: int) -> list[Document]:
    return list(db.session.execute(select(Document).from_statement(text("""
        SELECT * FROM documents WHERE person_id = :person_id ORDER BY uploaded_at DESC
    """)), {"person_id": person_id}).scalars())


def checklist_of(person_id: int) -> list[DocumentChecklist]:
    return list(db.session.execute(select(DocumentChecklist).from_statement(text("""
        SELECT * FROM document_checklist WHERE person_id = :person_id ORDER BY document_type_id
    """)), {"person_id": person_id}).scalars())


def certificates_of(admission_ids: list[int]) -> list[Certificate]:
    if not admission_ids:
        return []
    return list(db.session.execute(select(Certificate).from_statement(text("""
        SELECT * FROM certificates WHERE admission_id = ANY(:admission_ids) ORDER BY certificate_id
    """)), {"admission_ids": admission_ids}).scalars())


def support_cases_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    """Kept as a Select (paginated with db.paginate, and executed directly): the filter is raw SQL."""
    where = ["TRUE"]
    params: dict = {}
    if branch_ids is not None:
        where.append("support_cases.branch_id = ANY(:branch_ids)")
        params["branch_ids"] = list(branch_ids)
    for field, fragment in (("branch_id", "support_cases.branch_id = :branch_id"),
                            ("status", "support_cases.status = :status"),
                            ("person_id", "support_cases.person_id = :person_id"),
                            ("owner_user_id", "support_cases.owner_user_id = :owner_user_id"),
                            ("support_case_type_id", "support_cases.support_case_type_id = :support_case_type_id")):
        if filters.get(field) is not None:
            where.append(fragment)
            params[field] = filters[field]
    return (select(SupportCase).where(text(" AND ".join(where)).bindparams(**params))
            .order_by(text("support_cases.opened_at DESC")))


def refund_cases_of(admission_ids: list[int]) -> list[RefundCase]:
    if not admission_ids:
        return []
    return list(db.session.execute(select(RefundCase).from_statement(
        text("SELECT * FROM refund_cases WHERE admission_id = ANY(:admission_ids)")),
        {"admission_ids": admission_ids}).scalars())


def lead_activities_of(person_id: int, limit: int = 200) -> list[LeadActivity]:
    return list(db.session.execute(select(LeadActivity).from_statement(text("""
        SELECT lead_activities.*
        FROM lead_activities
        JOIN leads ON leads.lead_id = lead_activities.lead_id
        WHERE leads.person_id = :person_id
        ORDER BY lead_activities.occurred_at DESC
        LIMIT :limit
    """)), {"person_id": person_id, "limit": limit}).scalars())


def audit_of(person_id: int, admission_ids: list[int], payment_ids: list[int], limit: int = 200) -> list[AuditLog]:
    conditions = ["(entity_type = :person_type AND entity_id = :person_id)"]
    params: dict = {"person_type": "person", "person_id": str(person_id), "limit": limit}
    if admission_ids:
        conditions.append("(entity_type = :admission_type AND entity_id = ANY(:admission_ids))")
        params["admission_type"] = "admission"
        params["admission_ids"] = [str(i) for i in admission_ids]
    if payment_ids:
        conditions.append("(entity_type = :payment_type AND entity_id = ANY(:payment_ids))")
        params["payment_type"] = "payment"
        params["payment_ids"] = [str(i) for i in payment_ids]
    sql = ("SELECT * FROM audit_log WHERE " + " OR ".join(conditions)
           + " ORDER BY occurred_at DESC LIMIT :limit")
    return list(db.session.execute(select(AuditLog).from_statement(text(sql)), params).scalars())
