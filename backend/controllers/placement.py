"""Placement & Alumni."""
from flask import request

from controllers.common import Validator, created, get_page_params, json_body, ok, paginated, require_changes
from models.enums import (
    APPLICATION_STAGES, CV_REVIEW_STATUSES, EMPLOYMENT_TYPES, EVIDENCE_STATUSES, JOB_STATUSES, PLACEMENT_READINESS,
    WORK_MODES,
)
from services import placement as placement_service


def _company_rules(v: Validator, creating: bool) -> None:
    v.string("company_name", required=creating, max_length=200)
    for field, length in (("industry", 100), ("website", 255), ("city", 100), ("contact_name", 150)):
        v.string(field, nullable=True, max_length=length)
    v.email("contact_email", nullable=True)
    v.phone("contact_phone", nullable=True)
    v.string("notes", nullable=True)
    v.boolean("is_active")


def list_companies():
    v = Validator(request.args.to_dict())
    v.string("q", max_length=100)
    return ok([c.to_dict() for c in placement_service.list_companies(v.validate().get("q"))])


def save_company(company_id: int | None = None):
    v = Validator(json_body())
    _company_rules(v, company_id is None)
    data = v.validate() if company_id is None else require_changes(v.validate())
    company = placement_service.save_company(company_id, data)
    return created(company.to_dict()) if company_id is None else ok(company.to_dict())


def _job_rules(v: Validator, creating: bool) -> None:
    v.integer("company_id", required=creating, min_value=1)
    v.string("job_title", required=creating, max_length=200)
    v.choice("employment_type", EMPLOYMENT_TYPES)
    v.string("location", nullable=True, max_length=150)
    v.choice("work_mode", WORK_MODES)
    v.integer("branch_id", nullable=True, min_value=1)
    v.string("required_skills", nullable=True)
    v.string("salary_ctc", nullable=True, max_length=100)
    v.integer("openings_count", nullable=True, min_value=1)
    v.date("closing_date", nullable=True)
    v.string("source", nullable=True, max_length=150)
    v.choice("status", JOB_STATUSES)
    v.integer("placement_owner_id", nullable=True, min_value=1)
    v.boolean("verified")


def list_jobs():
    v = Validator(request.args.to_dict())
    v.choice("status", JOB_STATUSES)
    v.choice("work_mode", WORK_MODES)
    v.integer("company_id", min_value=1)
    v.integer("branch_id", min_value=1)
    page, per_page = get_page_params()
    rows, meta = placement_service.list_jobs(v.validate(), page, per_page)
    return paginated([r.to_dict() for r in rows], meta)


def save_job(job_id: int | None = None):
    v = Validator(json_body())
    _job_rules(v, job_id is None)
    data = v.validate() if job_id is None else require_changes(v.validate())
    job = placement_service.save_job(job_id, data)
    return created(job.to_dict()) if job_id is None else ok(job.to_dict())


def get_profile(person_id: int):
    profile = placement_service.get_profile(person_id)
    return ok(profile.to_dict() if profile else None)


def save_profile(person_id: int):
    v = Validator(json_body())
    v.choice("readiness", PLACEMENT_READINESS)
    v.string("cv_file_path", nullable=True, max_length=500)
    v.choice("cv_review_status", CV_REVIEW_STATUSES)
    for field in ("skills", "projects", "career_gap_notes"):
        v.string(field, nullable=True)
    for field, length in (("qualification", 150), ("expected_salary", 100), ("preferred_location", 150),
                          ("preferred_role", 150)):
        v.string(field, nullable=True, max_length=length)
    v.choice("preferred_mode", WORK_MODES, nullable=True)
    v.choice("evidence_status", EVIDENCE_STATUSES)
    v.integer("placement_owner_id", nullable=True, min_value=1)
    return ok(placement_service.save_profile(person_id, v.validate()).to_dict())


def record_consent(profile_id: int):
    v = Validator(json_body())
    v.choice("consent_status", ("Explicit Consent", "Withdrawn"), required=True)
    return ok(placement_service.record_consent(profile_id, v.validate()["consent_status"]).to_dict())


def list_applications():
    v = Validator(request.args.to_dict())
    v.integer("profile_id", min_value=1)
    v.integer("job_opening_id", min_value=1)
    v.choice("stage", APPLICATION_STAGES)
    return ok([a.to_dict() for a in placement_service.list_applications(v.validate())])


def apply():
    v = Validator(json_body())
    v.integer("profile_id", required=True, min_value=1)
    v.integer("job_opening_id", required=True, min_value=1)
    v.string("notes", nullable=True)
    return created(placement_service.apply(v.validate()).to_dict())


def change_stage(application_id: int):
    v = Validator(json_body())
    v.choice("stage", APPLICATION_STAGES, required=True)
    v.datetime("interview_at", nullable=True)
    v.string("offer_ctc", nullable=True, max_length=100)
    v.date("joined_date", nullable=True)
    v.choice("evidence_status", EVIDENCE_STATUSES)
    v.string("notes", nullable=True)
    return ok(placement_service.change_stage(application_id, v.validate()).to_dict())


def add_event(application_id: int):
    v = Validator(json_body())
    v.choice("event_type", ("Interview Scheduled", "Interview No-show", "Note", "Evidence Added"), required=True)
    v.datetime("interview_at", nullable=True)
    v.string("notes", nullable=True)
    return created(placement_service.add_event(application_id, v.validate()).to_dict())


def list_alumni():
    v = Validator(request.args.to_dict())
    v.boolean("support_active")
    v.string("q", max_length=100)
    page, per_page = get_page_params()
    rows, meta = placement_service.list_alumni(v.validate(), page, per_page)
    return paginated([r.to_dict() for r in rows], meta)


def extend_support(admission_id: int):
    v = Validator(json_body())
    v.date("extended_until", required=True)
    v.string("reason", required=True)
    return created(placement_service.extend_support(admission_id, v.validate()).to_dict())


