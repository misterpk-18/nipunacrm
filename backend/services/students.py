"""Student 360: people with admissions, one read per tab, documents, certificates and support cases."""
from config.database import db
from models import Admission, Certificate, ComboCourse, Course, Document, DocumentType, Person, SupportCase, SupportCaseType
from repositories import students as students_repo
from repositories.common import paginate
from services import audit, storage, tasks
from services import persons as persons_service
from services.context import ADMIN_ROLES, current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError

REVIEWER_ROLES = ADMIN_ROLES + ("BRANCH_MANAGER", "ACADEMIC_COORDINATOR", "FRONT_OFFICE")
CASE_FIELDS = ("status", "owner_user_id", "resolution_notes", "refund_case_id", "subject", "description")


# ---------------------------------------------------------------- students

def get_student(person_id: int) -> Person:
    person = db.session.get(Person, person_id)
    if person is None or not students_repo.is_student(person_id, current_user().branch_ids()):
        raise NotFound("Student not found")
    return person


def list_students(filters: dict, page: int, per_page: int):
    people, meta = paginate(students_repo.students_stmt(filters, current_user().branch_ids()), page, per_page)
    return people, meta, students_repo.summaries([p.person_id for p in people])


def course_titles(course_ids: list[int]) -> list[str]:
    return [db.session.get(Course, cid).course_title for cid in course_ids]


def header(person_id: int) -> dict:
    person = get_student(person_id)
    admissions = students_repo.admissions_of(person_id)
    summary = students_repo.summaries([person_id]).get(person_id, {})
    completed = [a for a in admissions if a.enrolment_status == "Completed"]
    return {"person": person, "admissions": admissions, "summary": summary,
            "is_alumni": bool(completed), "is_active": any(a.is_active for a in admissions)}


def tab(person_id: int, name: str) -> dict:
    get_student(person_id)
    admissions = students_repo.admissions_of(person_id)
    admission_ids = [a.admission_id for a in admissions]
    if name == "admissions":
        return {"admissions": admissions}
    if name == "finance":
        return {"invoices": students_repo.invoices_of(person_id), "payments": students_repo.payments_of(person_id),
                "admissions": admissions}
    if name == "academic":
        from repositories import admissions as admissions_repo

        return {"admissions": admissions,
                "allocations": [x for aid in admission_ids for x in admissions_repo.allocations_for(aid)],
                "curricula": [x for aid in admission_ids for x in admissions_repo.curricula_for(aid)],
                "certificates": students_repo.certificates_of(admission_ids)}
    if name == "documents":
        return {"documents": students_repo.documents_of(person_id), "checklist": students_repo.checklist_of(person_id)}
    if name == "cases":
        return {"support_cases": list(db.session.execute(
                    students_repo.support_cases_stmt({"person_id": person_id}, None)).scalars()),
                "refund_cases": students_repo.refund_cases_of(admission_ids)}
    if name == "timeline":
        return {"events": _timeline(person_id, admissions)}
    if name == "audit":
        payment_ids = [p.payment_id for p in students_repo.payments_of(person_id)]
        return {"entries": students_repo.audit_of(person_id, admission_ids, payment_ids)}
    raise NotFound("Unknown tab")


def _timeline(person_id: int, admissions: list[Admission]) -> list[dict]:
    events = [{"at": a.occurred_at, "kind": "lead_activity", "title": a.activity_type, "detail": a.summary}
              for a in students_repo.lead_activities_of(person_id)]
    events += [{"at": p.created_at, "kind": "payment", "title": f"{p.entry_type} {p.receipt_number}",
                "detail": f"₹{p.amount} · {p.verification_status}"} for p in students_repo.payments_of(person_id)]
    events += [{"at": a.created_at, "kind": "admission", "title": f"Admission {a.admission_code}",
                "detail": a.course.course_title} for a in admissions]
    events += [{"at": d.uploaded_at, "kind": "document", "title": f"{d.document_type.label} uploaded",
                "detail": d.status} for d in students_repo.documents_of(person_id)]
    return sorted(events, key=lambda e: e["at"], reverse=True)


# ---------------------------------------------------------------- documents

def upload_document(person_id: int, data: dict, upload) -> Document:
    person = persons_service.get_person(person_id)
    doc_type = db.session.get(DocumentType, data["document_type_id"])
    if doc_type is None or not doc_type.is_active:
        raise ValidationError("Unknown document type", {"document_type_id": ["Not an active type"]})
    admission = None
    if data.get("admission_id"):
        admission = db.session.get(Admission, data["admission_id"])
        if admission is None or admission.person_id != person_id:
            raise ValidationError("That admission isn't this person's", {"admission_id": ["Not found"]})
    if upload is None:
        raise ValidationError("Attach the file", {"file": ["Required"]})
    stored = storage.save_upload(upload, f"documents/{person.person_code}")
    document = Document(person_id=person_id, admission_id=data.get("admission_id"), document_type_id=doc_type.document_type_id,
                        uploaded_by=current_user().user_id, **stored)
    db.session.add(document)
    db.session.flush()  # one live file per type (re-upload only after rejection)
    db.session.refresh(document)
    branch_id = admission.service_branch_id if admission else person.registered_branch_id
    tasks.create_system_task("DOCUMENT_REVIEW", f"Review {doc_type.label} · {person.full_name}", branch_id,
                             document.uploaded_at, team_role_code="ACADEMIC_COORDINATOR",
                             dedupe_key=f"document-review:{document.document_id}", document_id=document.document_id)
    return document


def review_document(document_id: int, status: str, reason: str | None) -> Document:
    document = db.session.get(Document, document_id)
    if document is None:
        raise NotFound("Document not found")
    person = persons_service.get_person(document.person_id)
    user = current_user()
    branch_id = person.registered_branch_id
    if not (user.is_admin or user.has_role(*REVIEWER_ROLES, branch_id=branch_id)
            or (document.admission_id and user.has_role(*REVIEWER_ROLES,
                                                        branch_id=db.session.get(Admission, document.admission_id).service_branch_id))):
        raise Forbidden("You can't review documents here")
    if document.status != "Review Required":
        raise BusinessRule(f"Document is already {document.status}")
    if document.uploaded_by == user.user_id:
        raise Forbidden("Someone other than the uploader must review the document")
    document.status = status
    document.reviewed_by = user.user_id
    document.rejection_reason = reason if status == "Rejected" else None
    db.session.flush()  # reviewed_at stamped
    db.session.refresh(document)
    tasks.complete_system_task(f"document-review:{document_id}")
    audit.record("DOCUMENT_REVIEWED", "person", document.person_id,
                 new={"document_id": document_id, "status": status}, reason=reason)
    return document


# ---------------------------------------------------------------- certificates

def _academic_admission(admission_id: int) -> Admission:
    from services import admissions as admissions_service

    admission = admissions_service.get_admission(admission_id)
    user = current_user()
    if not (user.is_admin or user.has_role("ACADEMIC_COORDINATOR", branch_id=admission.service_branch_id)):
        raise Forbidden("Only an Academic Coordinator can manage certificates")
    return admission


def create_certificate(admission_id: int, data: dict) -> Certificate:
    admission = _academic_admission(admission_id)
    course_id = data.get("course_id") or admission.course_id
    if course_id != admission.course_id and db.session.get(ComboCourse, (admission.course_id, course_id)) is None:
        raise ValidationError("The course isn't part of this admission", {"course_id": ["Not in the admission"]})
    certificate = Certificate(admission_id=admission_id, course_id=course_id, status=data.get("status", "Eligibility Pending"),
                              eligibility_notes=data.get("eligibility_notes"))
    db.session.add(certificate)
    db.session.flush()  # one live certificate per admission per course
    return certificate


def get_certificate(certificate_id: int) -> Certificate:
    certificate = db.session.get(Certificate, certificate_id)
    if certificate is None:
        raise NotFound("Certificate not found")
    return certificate


def update_certificate(certificate_id: int, data: dict) -> Certificate:
    certificate = get_certificate(certificate_id)
    _academic_admission(certificate.admission_id)
    if certificate.status in ("Issued", "Revoked"):
        raise BusinessRule(f"Certificate is {certificate.status}")
    for field, value in data.items():
        setattr(certificate, field, value)
    db.session.flush()
    return certificate


def issue_certificate(certificate_id: int) -> Certificate:
    certificate = get_certificate(certificate_id)
    _academic_admission(certificate.admission_id)
    if certificate.status != "Eligible":
        raise BusinessRule(f"Only an Eligible certificate can be issued (it is {certificate.status})")
    certificate.status = "Issued"
    certificate.issued_by = current_user().user_id
    db.session.flush()  # number and issue time assigned by the DB
    db.session.refresh(certificate)
    audit.record("CERTIFICATE_ISSUED", "admission", certificate.admission_id,
                 new={"certificate_number": certificate.certificate_number})
    return certificate


def revoke_certificate(certificate_id: int, reason: str) -> Certificate:
    from datetime import datetime, timezone

    certificate = get_certificate(certificate_id)
    if not current_user().is_admin:
        raise Forbidden("Only an admin can revoke certificates")
    if certificate.status != "Issued":
        raise BusinessRule(f"Only an issued certificate can be revoked (it is {certificate.status})")
    certificate.status = "Revoked"
    certificate.revoked_by = current_user().user_id
    certificate.revoked_at = datetime.now(timezone.utc)
    certificate.revoke_reason = reason
    db.session.flush()
    audit.record("CERTIFICATE_REVOKED", "admission", certificate.admission_id,
                 new={"certificate_number": certificate.certificate_number}, reason=reason)
    return certificate


# ---------------------------------------------------------------- support cases

def list_cases(filters: dict, page: int, per_page: int):
    return paginate(students_repo.support_cases_stmt(filters, current_user().branch_ids()), page, per_page)


def get_case(case_id: int) -> SupportCase:
    case = db.session.get(SupportCase, case_id)
    if case is None or not current_user().can_access_branch(case.branch_id):
        raise NotFound("Support case not found")
    return case


def create_case(data: dict) -> SupportCase:
    person = persons_service.get_person(data["person_id"])
    admission = None
    if data.get("admission_id"):
        admission = db.session.get(Admission, data["admission_id"])
        if admission is None or admission.person_id != person.person_id:
            raise ValidationError("That admission isn't this person's", {"admission_id": ["Not found"]})
    branch_id = data.get("branch_id") or (admission.service_branch_id if admission else person.registered_branch_id)
    if not current_user().can_access_branch(branch_id):
        raise Forbidden("You can only open cases at your own branches")
    case_type = db.session.get(SupportCaseType, data["support_case_type_id"])
    if case_type is None or not case_type.is_active:
        raise ValidationError("Unknown case type", {"support_case_type_id": ["Not an active type"]})
    case = SupportCase(person_id=person.person_id, admission_id=data.get("admission_id"), branch_id=branch_id,
                       support_case_type_id=case_type.support_case_type_id, subject=data["subject"],
                       description=data.get("description"), owner_user_id=data.get("owner_user_id"),
                       opened_by=current_user().user_id)
    db.session.add(case)
    db.session.flush()
    db.session.refresh(case)
    return case


def update_case(case_id: int, data: dict) -> SupportCase:
    case = get_case(case_id)
    if case.status in SupportCase.CLOSED_STATUSES and data.get("status") not in (None, "Closed"):
        raise BusinessRule(f"Case {case.case_code} is {case.status}")
    if data.get("status") in SupportCase.CLOSED_STATUSES and not (data.get("resolution_notes") or case.resolution_notes):
        raise ValidationError("Add resolution notes to resolve the case", {"resolution_notes": ["Required"]})
    for field, value in data.items():
        setattr(case, field, value)
    db.session.flush()  # resolved_at stamped by the DB
    db.session.refresh(case)
    return case


