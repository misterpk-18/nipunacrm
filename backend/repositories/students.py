"""Student 360 queries: people with admissions, their money, documents, cases, timeline and audit."""
from sqlalchemy import Select, and_, exists, or_, select

from config.database import db
from models import (
    Admission, AdmissionBalance, AuditLog, Certificate, Document, DocumentChecklist, Invoice, Lead, LeadActivity,
    Payment, Person, RefundCase, SupportCase,
)


def _in_scope(branch_ids: set[int] | None):
    if branch_ids is None:
        return True
    return or_(Admission.service_branch_id.in_(branch_ids), Admission.original_branch_id.in_(branch_ids))


def students_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    condition = and_(Admission.person_id == Person.person_id, _in_scope(branch_ids))
    if filters.get("branch_id"):
        condition = and_(condition, or_(Admission.service_branch_id == filters["branch_id"],
                                        Admission.original_branch_id == filters["branch_id"]))
    if filters.get("enrolment_status"):
        condition = and_(condition, Admission.enrolment_status == filters["enrolment_status"])
    if filters.get("lms_status"):
        condition = and_(condition, Admission.lms_status == filters["lms_status"])
    stmt = select(Person).where(exists().where(condition)).order_by(Person.full_name, Person.person_id)
    if filters.get("q"):
        pattern = f"%{filters['q']}%"
        stmt = stmt.where(or_(Person.full_name.ilike(pattern), Person.person_code.ilike(pattern),
                              Person.phone.ilike(pattern), Person.email.ilike(pattern)))
    return stmt


def is_student(person_id: int, branch_ids: set[int] | None) -> bool:
    stmt = select(Admission.admission_id).where(Admission.person_id == person_id, _in_scope(branch_ids)).limit(1)
    return db.session.execute(stmt).first() is not None


def admissions_of(person_id: int) -> list[Admission]:
    stmt = select(Admission).where(Admission.person_id == person_id).order_by(Admission.admission_date, Admission.admission_id)
    return list(db.session.execute(stmt).scalars())


def summaries(person_ids: list[int]) -> dict[int, dict]:
    """Per person: admissions count, active course titles, verified paid, outstanding, LMS statuses."""
    if not person_ids:
        return {}
    rows = db.session.execute(
        select(Admission.person_id, Admission.enrolment_status, Admission.lms_status, AdmissionBalance.verified_paid,
               AdmissionBalance.outstanding, Admission.course_id)
        .join(AdmissionBalance, AdmissionBalance.admission_id == Admission.admission_id)
        .where(Admission.person_id.in_(person_ids))
    ).all()
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
    return list(db.session.execute(select(Invoice).where(Invoice.person_id == person_id)
                                   .order_by(Invoice.issued_on, Invoice.invoice_id)).scalars())


def payments_of(person_id: int) -> list[Payment]:
    return list(db.session.execute(select(Payment).where(Payment.person_id == person_id)
                                   .order_by(Payment.created_at, Payment.payment_id)).scalars())


def documents_of(person_id: int) -> list[Document]:
    return list(db.session.execute(select(Document).where(Document.person_id == person_id)
                                   .order_by(Document.uploaded_at.desc())).scalars())


def checklist_of(person_id: int) -> list[DocumentChecklist]:
    return list(db.session.execute(select(DocumentChecklist).where(DocumentChecklist.person_id == person_id)
                                   .order_by(DocumentChecklist.document_type_id)).scalars())


def certificates_of(admission_ids: list[int]) -> list[Certificate]:
    if not admission_ids:
        return []
    return list(db.session.execute(select(Certificate).where(Certificate.admission_id.in_(admission_ids))
                                   .order_by(Certificate.certificate_id)).scalars())


def support_cases_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    stmt = select(SupportCase).order_by(SupportCase.opened_at.desc())
    if branch_ids is not None:
        stmt = stmt.where(SupportCase.branch_id.in_(branch_ids))
    for field, column in (("branch_id", SupportCase.branch_id), ("status", SupportCase.status),
                          ("person_id", SupportCase.person_id), ("owner_user_id", SupportCase.owner_user_id),
                          ("support_case_type_id", SupportCase.support_case_type_id)):
        if filters.get(field) is not None:
            stmt = stmt.where(column == filters[field])
    return stmt


def refund_cases_of(admission_ids: list[int]) -> list[RefundCase]:
    if not admission_ids:
        return []
    return list(db.session.execute(select(RefundCase).where(RefundCase.admission_id.in_(admission_ids))).scalars())


def lead_activities_of(person_id: int, limit: int = 200) -> list[LeadActivity]:
    stmt = (select(LeadActivity).join(Lead, Lead.lead_id == LeadActivity.lead_id)
            .where(Lead.person_id == person_id).order_by(LeadActivity.occurred_at.desc()).limit(limit))
    return list(db.session.execute(stmt).scalars())


def audit_of(person_id: int, admission_ids: list[int], payment_ids: list[int], limit: int = 200) -> list[AuditLog]:
    conditions = [and_(AuditLog.entity_type == "person", AuditLog.entity_id == str(person_id))]
    if admission_ids:
        conditions.append(and_(AuditLog.entity_type == "admission", AuditLog.entity_id.in_([str(i) for i in admission_ids])))
    if payment_ids:
        conditions.append(and_(AuditLog.entity_type == "payment", AuditLog.entity_id.in_([str(i) for i in payment_ids])))
    stmt = select(AuditLog).where(or_(*conditions)).order_by(AuditLog.occurred_at.desc()).limit(limit)
    return list(db.session.execute(stmt).scalars())


