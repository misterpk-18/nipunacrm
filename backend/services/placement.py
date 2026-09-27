"""Placement & Alumni: companies, Job Opening Master, placement profiles, consent, applications and events,
alumni, support extensions. Career assistance only — no placement is guaranteed.

The database requires explicit referral consent and an Open job to apply, allows one application per profile
per job, logs every stage change, needs a joined date for Joined, and restricts support extensions to
Founder / CEO or Super Admin (updating the admission's support window).
"""
from datetime import datetime, timezone

from sqlalchemy import select

from config.database import db
from models import Alumni, Company, JobApplication, JobOpening, PlacementProfile, SupportExtension
from repositories.common import paginate
from services import audit
from services import admissions as admissions_service
from services import persons as persons_service
from services.context import current_user
from services.errors import BusinessRule, NotFound, ValidationError

CLOSED_STAGES = ("Joined", "Rejected", "Withdrawn", "Offer Declined")


# ---------------------------------------------------------------- companies / jobs

def list_companies(q: str | None) -> list[Company]:
    stmt = select(Company).order_by(Company.company_name)
    if q:
        stmt = stmt.where(Company.company_name.ilike(f"%{q}%"))
    return list(db.session.execute(stmt).scalars())


def save_company(company_id: int | None, data: dict) -> Company:
    company = Company() if company_id is None else db.session.get(Company, company_id)
    if company is None:
        raise NotFound("Company not found")
    for field, value in data.items():
        setattr(company, field, value)
    db.session.add(company)
    db.session.flush()  # company names are unique (case-insensitive)
    return company


def list_jobs(filters: dict, page: int, per_page: int):
    stmt = select(JobOpening).order_by(JobOpening.created_at.desc())
    for field, column in (("status", JobOpening.status), ("company_id", JobOpening.company_id),
                          ("branch_id", JobOpening.branch_id), ("work_mode", JobOpening.work_mode)):
        if filters.get(field) is not None:
            stmt = stmt.where(column == filters[field])
    return paginate(stmt, page, per_page)


def save_job(job_id: int | None, data: dict) -> JobOpening:
    job = JobOpening(created_by=current_user().user_id) if job_id is None else db.session.get(JobOpening, job_id)
    if job is None:
        raise NotFound("Job opening not found")
    if data.get("company_id") and db.session.get(Company, data["company_id"]) is None:
        raise ValidationError("Unknown company", {"company_id": ["Not found"]})
    verified = data.pop("verified", False)
    for field, value in data.items():
        setattr(job, field, value)
    if verified or (data.get("status") == "Open" and job.last_verified_at is None):
        job.last_verified_at = datetime.now(timezone.utc)  # opening a job means someone checked it
    db.session.add(job)
    db.session.flush()
    db.session.refresh(job)
    return job


# ---------------------------------------------------------------- profiles / consent

def _profile_for(person_id: int) -> PlacementProfile | None:
    return db.session.execute(select(PlacementProfile).where(PlacementProfile.person_id == person_id)).scalar_one_or_none()


def get_profile(person_id: int) -> PlacementProfile | None:
    persons_service.get_person(person_id)
    return _profile_for(person_id)


def save_profile(person_id: int, data: dict) -> PlacementProfile:
    persons_service.get_person(person_id)
    profile = _profile_for(person_id) or PlacementProfile(person_id=person_id)
    if "cv_file_path" in data and data["cv_file_path"] != profile.cv_file_path and data["cv_file_path"]:
        profile.cv_version = (profile.cv_version or 0) + 1
        data.setdefault("cv_review_status", "Review Pending")
    for field, value in data.items():
        setattr(profile, field, value)
    db.session.add(profile)
    db.session.flush()
    return profile


def get_profile_by_id(profile_id: int) -> PlacementProfile:
    profile = db.session.get(PlacementProfile, profile_id)
    if profile is None:
        raise NotFound("Placement profile not found")
    persons_service.get_person(profile.person_id)
    return profile


def record_consent(profile_id: int, status: str) -> PlacementProfile:
    profile = get_profile_by_id(profile_id)
    profile.consent_status = status
    profile.consent_recorded_by = current_user().user_id
    profile.consent_recorded_at = datetime.now(timezone.utc)
    db.session.flush()
    audit.record("PLACEMENT_CONSENT", "person", profile.person_id, new={"consent_status": status})
    return profile


# ---------------------------------------------------------------- applications

def get_application(application_id: int) -> JobApplication:
    application = db.session.get(JobApplication, application_id)
    if application is None:
        raise NotFound("Application not found")
    persons_service.get_person(application.profile.person_id)
    return application


def list_applications(filters: dict) -> list[JobApplication]:
    stmt = select(JobApplication).order_by(JobApplication.created_at.desc())
    for field, column in (("profile_id", JobApplication.profile_id), ("job_opening_id", JobApplication.job_opening_id),
                          ("stage", JobApplication.stage)):
        if filters.get(field) is not None:
            stmt = stmt.where(column == filters[field])
    return list(db.session.execute(stmt).scalars())


def apply(data: dict) -> JobApplication:
    profile = get_profile_by_id(data["profile_id"])
    if db.session.get(JobOpening, data["job_opening_id"]) is None:
        raise ValidationError("Unknown job opening", {"job_opening_id": ["Not found"]})
    application = JobApplication(profile_id=profile.profile_id, job_opening_id=data["job_opening_id"],
                                 notes=data.get("notes"), created_by=current_user().user_id)
    db.session.add(application)
    db.session.flush()  # consent + open job checked; one application per job
    db.session.refresh(application)
    return application


def change_stage(application_id: int, data: dict) -> JobApplication:
    application = get_application(application_id)
    if application.stage in CLOSED_STAGES:
        raise BusinessRule(f"Application is {application.stage}")
    if data["stage"] == application.stage:
        raise BusinessRule(f"Application is already {application.stage}")
    for field in ("interview_at", "offer_ctc", "joined_date", "evidence_status", "notes"):
        if field in data:
            setattr(application, field, data[field])
    application.stage = data["stage"]  # the DB logs the change and requires joined_date for Joined
    db.session.flush()
    db.session.refresh(application)
    return application


def add_event(application_id: int, data: dict) -> JobApplication:
    """Interview scheduled / no-show / note / evidence — a no-show is an event, not a closure."""
    from models import ApplicationEvent

    application = get_application(application_id)
    if data["event_type"] == "Interview Scheduled":
        if not data.get("interview_at"):
            raise ValidationError("Give the interview time", {"interview_at": ["Required"]})
        application.interview_at = data["interview_at"]
    db.session.add(ApplicationEvent(application_id=application_id, event_type=data["event_type"],
                                    notes=data.get("notes"), recorded_by=current_user().user_id))
    db.session.flush()
    db.session.refresh(application)
    return application


# ---------------------------------------------------------------- alumni / support

def list_alumni(filters: dict, page: int, per_page: int):
    stmt = select(Alumni).order_by(Alumni.alumni_since.desc())
    if filters.get("support_active") is not None:
        stmt = stmt.where(Alumni.support_active == filters["support_active"])
    if filters.get("q"):
        stmt = stmt.where(Alumni.full_name.ilike(f"%{filters['q']}%"))
    branch_ids = current_user().branch_ids()
    if branch_ids is not None:
        from models import Admission

        stmt = stmt.where(Alumni.person_id.in_(select(Admission.person_id).where(
            Admission.service_branch_id.in_(branch_ids) | Admission.original_branch_id.in_(branch_ids))))
    return paginate(stmt, page, per_page)


def extend_support(admission_id: int, data: dict) -> SupportExtension:
    admission = admissions_service.get_admission(admission_id)
    if admission.support_until is None:
        raise BusinessRule("The admission has no support period yet (not completed)")
    if data["extended_until"] <= admission.support_until:
        raise ValidationError("Must be later than the current support end",
                              {"extended_until": [f"After {admission.support_until}"]})
    extension = SupportExtension(admission_id=admission_id, extended_until=data["extended_until"], reason=data["reason"],
                                 approved_by=current_user().user_id)
    db.session.add(extension)
    db.session.flush()
    db.session.refresh(extension)
    db.session.expire(admission)
    audit.record("SUPPORT_EXTENDED", "admission", admission_id, old={"support_until": extension.previous_until},
                 new={"support_until": extension.extended_until}, reason=data["reason"],
                 branch_id=admission.service_branch_id)
    return extension


def student_placement(person_id: int) -> dict:
    from services import students as students_service

    students_service.get_student(person_id)
    profile = _profile_for(person_id)
    return {"profile": profile.to_dict() if profile else None,
            "applications": [a.to_dict() for a in list_applications({"profile_id": profile.profile_id})] if profile else []}
