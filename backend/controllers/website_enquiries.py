"""The website enquiry form (server-to-server). The reply never says whether the person is already known."""
from controllers.common import Validator, created, json_body, ok
from services import website_enquiries as website_service

SUBMISSION_ID = r"^[A-Za-z0-9._:-]{1,100}$"


def _utm_rules(v: Validator) -> None:
    for field in ("source", "medium", "campaign", "term", "content"):
        v.string(field, nullable=True, max_length=200)


def submit_enquiry():
    v = Validator(json_body())
    v.string("submission_id", required=True, max_length=100, pattern=SUBMISSION_ID,
             pattern_message="Letters, digits and . _ : - only")
    v.string("name", required=True, min_length=2, max_length=150)
    v.phone("phone", required=True)
    v.email("email", nullable=True)
    v.string("branch_code", required=True, max_length=20)
    v.choice("enquiry_type", tuple(website_service.CHANNEL_BY_TYPE), required=True)
    v.choice("marketing_source", tuple(website_service.SOURCE_BY_MARKETING), default="organic")
    v.datetime("submitted_at", nullable=True)
    v.string("course_code", nullable=True, max_length=100)
    v.string("message", nullable=True, max_length=2000)
    v.boolean("whatsapp_consent")
    v.nested("utm", _utm_rules, nullable=True)
    v.string("page_url", nullable=True, max_length=500)
    v.string("referrer", nullable=True, max_length=500)
    data = v.validate()
    if data.get("utm"):
        data["utm"] = {key: value for key, value in data["utm"].items() if value}

    enquiry, is_new = website_service.submit(data)
    body = {"enquiry_code": enquiry.enquiry_code, "status": "received" if is_new else "duplicate_submission"}
    return created(body) if is_new else ok(body)
