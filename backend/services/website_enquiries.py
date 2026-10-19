"""Enquiries posted by the nipunatechnologies.com server (db 047). They land in Enquiries for staff to review,
convert or link; nothing becomes a lead or is merged automatically.

The website says the marketing source (google_ads / meta_ads / organic → Google Ads / Meta Ads / Website) and the
enquiry type (form / call_request / whatsapp_request → channel Web form / Phone call / WhatsApp); the entry method
is always Website. UTM values are stored as sent and never change the source. The website's submitted_at becomes the
enquiry time when it is in the past and under SUBMITTED_AT_MAX_AGE old.
A repeated submission_id returns the first enquiry. The same phone or email as an unconverted enquiry inside
website_repeat_window_hours puts the new one in Duplicate Review.
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from config.database import db
from models import Branch, ContactChannel, Course, Enquiry, EntryMethod, LeadSource
from repositories import leads as leads_repo
from repositories import settings as settings_repo
from services import enquiries as enquiries_service
from services import notifications
from services.errors import TooManyAttempts, ValidationError

ENTRY_METHOD_CODE = "WEBSITE"
SOURCE_BY_MARKETING = {"organic": "WEBSITE", "google_ads": "GOOGLE_ADS", "meta_ads": "META_ADS"}
CHANNEL_BY_TYPE = {"form": "WEB_FORM", "call_request": "PHONE_CALL", "whatsapp_request": "WHATSAPP"}
TYPE_LABELS = {"form": "Website enquiry", "call_request": "Website call request", "whatsapp_request": "Website WhatsApp request"}
SUBMITTED_AT_MAX_AGE = timedelta(hours=48)
CLOCK_SKEW = timedelta(minutes=5)


def _lookup_id(model, code: str) -> int:
    return db.session.execute(select(model).where(model.code == code)).scalar_one().id


def submit(data: dict) -> tuple[Enquiry, bool]:
    """Returns (enquiry, created). created is False when this submission_id was already received."""
    entry_method_id = _lookup_id(EntryMethod, ENTRY_METHOD_CODE)
    existing = leads_repo.enquiry_by_external_ref(entry_method_id, data["submission_id"])
    if existing is not None:
        return existing, False

    _check_limits(entry_method_id, data["phone"])
    branch = _branch(data["branch_code"])
    course_id, message = _course(data.get("course_code"), branch, data.get("message"))

    attribution = {**(data.get("utm") or {})}
    for field in ("page_url", "referrer"):
        if data.get(field):
            attribution[field] = data[field]
    attribution["enquiry_type"] = data["enquiry_type"]
    attribution["marketing_source"] = data["marketing_source"]
    fields = {
        "branch_id": branch.branch_id, "course_id": course_id,
        "lead_source_id": _lookup_id(LeadSource, SOURCE_BY_MARKETING[data["marketing_source"]]),
        "contact_channel_id": _lookup_id(ContactChannel, CHANNEL_BY_TYPE[data["enquiry_type"]]),
        "entry_method_id": entry_method_id,
        "raw_name": data["name"], "raw_phone": data["phone"], "raw_email": data.get("email"), "message": message,
        "external_ref": data["submission_id"], "attribution": attribution,
        "whatsapp_consent": data.get("whatsapp_consent"),
    }
    if data.get("submitted_at"):
        attribution["submitted_at"] = data["submitted_at"].isoformat()
        if _usable_submission_time(data["submitted_at"]):
            fields["received_at"] = min(data["submitted_at"], datetime.now(timezone.utc))

    enquiry, _, _ = enquiries_service.record(
        fields, created_by=None, repeat_window_hours=settings_repo.get_int("website_repeat_window_hours", 24), via="website")

    course = enquiry.course.course_title if enquiry.course else "course not chosen"
    review = " Possible duplicate: check Duplicate Review." if enquiry.intake_status == "Duplicate Review" else ""
    notifications.notify(
        "WEBSITE_ENQUIRY_RECEIVED", event_key="website-enquiry", entity_type="enquiry", entity_id=enquiry.enquiry_id,
        branch_id=branch.branch_id, title=f"{TYPE_LABELS[data['enquiry_type']]}: {enquiry.raw_name} · {course}",
        body=f"{enquiry.enquiry_code} at {branch.branch_name}.{review} Convert it to a lead or link it in Enquiries.")
    return enquiry, True


def _usable_submission_time(submitted_at: datetime) -> bool:
    """The website's own time counts (and starts the first-contact clock) only if it is recent and not in the future."""
    now = datetime.now(timezone.utc)
    return now - SUBMITTED_AT_MAX_AGE <= submitted_at <= now + CLOCK_SKEW


def _check_limits(entry_method_id: int, phone: str) -> None:
    if leads_repo.count_enquiries_since(entry_method_id, 3600, phone) >= settings_repo.get_int(
            "website_max_per_phone_per_hour", 5):
        raise TooManyAttempts("Too many enquiries from this number. Please try again later.")
    if leads_repo.count_enquiries_since(entry_method_id, 60) >= settings_repo.get_int("website_max_per_minute", 30):
        raise TooManyAttempts("Too many enquiries right now. Please try again in a minute.")


def _branch(code: str) -> Branch:
    branch = db.session.execute(select(Branch).where(
        func.upper(Branch.branch_code) == code.upper(), Branch.is_active)).scalar_one_or_none()
    if branch is None:
        raise ValidationError("Unknown branch", {"branch_code": ["Not an active branch code"]})
    return branch


def _course(code: str | None, branch: Branch, message: str | None) -> tuple[int | None, str | None]:
    """An active course offered at the branch, else no course and the website's text kept in the message."""
    if not code:
        return None, message
    course = db.session.execute(select(Course).where(
        func.upper(Course.course_code) == code.upper(), Course.status == "Active")).scalar_one_or_none()
    if course is not None and any(link.branch.branch_id == branch.branch_id for link in course.branch_links):
        return course.course_id, message
    note = f"Course asked on website: {code}"
    return None, f"{note}\n\n{message}" if message else note
