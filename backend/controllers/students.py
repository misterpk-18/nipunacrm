"""Student 360, documents, certificates and support cases."""
from flask import request

from controllers.common import Validator, created, get_page_params, json_body, ok, paginated, require_changes
from models.enums import ENROLMENT_STATUSES, LMS_STATUSES, SUPPORT_CASE_STATUSES
from services import students as students_service

TABS = ("admissions", "finance", "academic", "documents", "timeline", "cases", "placement", "audit")


def _row(person, summary: dict) -> dict:
    s = summary.get(person.person_id, {})
    return {**person.to_summary(), "registered_branch": person.registered_branch.to_summary(),
            "admissions": s.get("admissions", 0), "active_courses": students_service.course_titles(s.get("active_course_ids", [])),
            "verified_paid": s.get("verified_paid", 0), "outstanding": s.get("outstanding", 0),
            "lms_statuses": sorted(s.get("lms_statuses", []))}


def list_students():
    v = Validator(request.args.to_dict())
    v.integer("branch_id", min_value=1)
    v.choice("enrolment_status", ENROLMENT_STATUSES)
    v.choice("lms_status", LMS_STATUSES)
    v.string("q", max_length=100)
    page, per_page = get_page_params()
    people, meta, summary = students_service.list_students(v.validate(), page, per_page)
    return paginated([_row(p, summary) for p in people], meta)


def get_student(person_id: int):
    h = students_service.header(person_id)
    return ok({**_row(h["person"], {person_id: h["summary"]}), "person": h["person"].to_dict(),
               "is_alumni": h["is_alumni"], "is_active": h["is_active"],
               "admission_summaries": [a.to_summary() for a in h["admissions"]]})


def student_tab(person_id: int, tab: str):
    if tab == "placement":
        from services import placement as placement_service

        return ok(placement_service.student_placement(person_id))
    data = students_service.tab(person_id, tab)
    shaped = {
        "admissions": lambda d: [a.to_dict() for a in d["admissions"]],
        "finance": lambda d: {"invoices": [i.to_row() for i in d["invoices"]],
                              "payments": [p.to_row() for p in d["payments"]],
                              "balances": [{"admission_id": a.admission_id, "admission_code": a.admission_code,
                                            **a.to_dict()["balance"]} for a in d["admissions"]]},
        "academic": lambda d: {"admissions": [a.to_summary() for a in d["admissions"]],
                               "allocations": [x.to_dict() for x in d["allocations"]],
                               "curricula": [x.to_dict() for x in d["curricula"]],
                               "certificates": [x.to_dict() for x in d["certificates"]]},
        "documents": lambda d: {"documents": [x.to_dict() for x in d["documents"]],
                                "checklist": [x.to_dict() for x in d["checklist"]]},
        "cases": lambda d: {"support_cases": [x.to_dict() for x in d["support_cases"]],
                            "refund_cases": [x.to_row() for x in d["refund_cases"]]},
        "timeline": lambda d: d["events"],
        "audit": lambda d: [x.to_dict() for x in d["entries"]],
    }
    return ok(shaped[tab](data))


def upload_document(person_id: int):
    v = Validator(request.form.to_dict())
    v.integer("document_type_id", required=True, min_value=1)
    v.integer("admission_id", min_value=1)
    document = students_service.upload_document(person_id, v.validate(), request.files.get("file"))
    return created(document.to_dict())


def review_document(document_id: int):
    v = Validator(json_body())
    v.choice("status", ("Verified", "Rejected"), required=True)
    v.string("rejection_reason", nullable=True)
    data = v.validate()
    if data["status"] == "Rejected" and not data.get("rejection_reason"):
        v._error("rejection_reason", "Required when rejecting")
        v.validate()
    return ok(students_service.review_document(document_id, data["status"], data.get("rejection_reason")).to_dict())


def create_certificate(admission_id: int):
    v = Validator(json_body())
    v.integer("course_id", min_value=1)
    v.choice("status", ("Eligibility Pending", "Eligible", "Not Eligible"))
    v.string("eligibility_notes", nullable=True)
    return created(students_service.create_certificate(admission_id, v.validate()).to_dict())


def update_certificate(certificate_id: int):
    v = Validator(json_body())
    v.choice("status", ("Eligibility Pending", "Eligible", "Not Eligible"))
    v.string("eligibility_notes", nullable=True)
    return ok(students_service.update_certificate(certificate_id, require_changes(v.validate())).to_dict())


def issue_certificate(certificate_id: int):
    return ok(students_service.issue_certificate(certificate_id).to_dict())


def revoke_certificate(certificate_id: int):
    v = Validator(json_body())
    v.string("reason", required=True)
    return ok(students_service.revoke_certificate(certificate_id, v.validate()["reason"]).to_dict())


def list_cases():
    v = Validator(request.args.to_dict())
    for field in ("branch_id", "person_id", "owner_user_id", "support_case_type_id"):
        v.integer(field, min_value=1)
    v.choice("status", SUPPORT_CASE_STATUSES)
    page, per_page = get_page_params()
    cases, meta = students_service.list_cases(v.validate(), page, per_page)
    return paginated([c.to_dict() for c in cases], meta)


def create_case():
    v = Validator(json_body())
    v.integer("person_id", required=True, min_value=1)
    v.integer("admission_id", nullable=True, min_value=1)
    v.integer("branch_id", nullable=True, min_value=1)
    v.integer("support_case_type_id", required=True, min_value=1)
    v.string("subject", required=True, max_length=255)
    v.string("description", nullable=True)
    v.integer("owner_user_id", nullable=True, min_value=1)
    return created(students_service.create_case(v.validate()).to_dict())


def get_case(case_id: int):
    return ok(students_service.get_case(case_id).to_dict())


def update_case(case_id: int):
    v = Validator(json_body())
    v.choice("status", SUPPORT_CASE_STATUSES)
    v.integer("owner_user_id", nullable=True, min_value=1)
    v.string("resolution_notes", nullable=True)
    v.integer("refund_case_id", nullable=True, min_value=1)
    v.string("subject", max_length=255)
    v.string("description", nullable=True)
    return ok(students_service.update_case(case_id, require_changes(v.validate())).to_dict())
