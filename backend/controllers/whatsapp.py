"""WhatsApp: the message list, a person's conversation, retry, marketing consent, marketing sends, and the provider's
public callback (db 033/034)."""
import re

from flask import Response, request

from controllers.common import Validator, created, get_page_params, json_body, ok, paginated
from models.enums import WHATSAPP_STATUSES
from services import lms_whatsapp, whatsapp_inbound, whatsapp_marketing, whatsapp_messages
from services.errors import NotFound, Unauthenticated, ValidationError


def list_messages():
    v = Validator(request.args.to_dict())
    v.choice("status", WHATSAPP_STATUSES)
    v.choice("category", ("Utility", "Marketing", "Authentication"))
    v.choice("sent_by", ("CRM", "LMS"))
    v.integer("branch_id", min_value=1)
    v.integer("person_id", min_value=1)
    v.string("template", max_length=80)
    v.string("q", max_length=100)
    filters = v.validate()
    page, per_page = get_page_params()
    rows, meta = whatsapp_messages.list_messages(filters, page, per_page)
    return paginated([row.to_dict() for row in rows], meta)


def summary():
    v = Validator(request.args.to_dict())
    v.integer("branch_id", min_value=1)
    return ok(whatsapp_messages.summary(v.validate().get("branch_id")))


def person_conversation(person_id: int):
    return ok(whatsapp_messages.person_conversation(person_id))


def retry(outbox_id: int):
    v = Validator(json_body())
    v.boolean("confirm_not_delivered", default=False)
    data = v.validate()
    return ok(whatsapp_messages.retry(outbox_id, data["confirm_not_delivered"]).to_dict())


def record_consent(person_id: int):
    v = Validator(json_body())
    v.choice("status", whatsapp_messages.CONSENT_STATUSES, required=True)
    v.string("source", nullable=True, max_length=100)
    data = v.validate()
    return ok(whatsapp_messages.record_consent(person_id, data["status"], data.get("source")))


def set_notifications(person_id: int):
    v = Validator(json_body())
    v.boolean("enabled", required=True)
    return ok(whatsapp_messages.set_notifications(person_id, v.validate()["enabled"]))


def marketing_templates():
    return ok(whatsapp_marketing.catalogue())


def send_marketing(lead_id: int):
    v = Validator(json_body())
    v.choice("template", tuple(whatsapp_marketing.CATALOGUE), required=True)
    v.integer("course_id", nullable=True, min_value=1)
    v.string("interest", nullable=True, max_length=200)
    return created(whatsapp_marketing.send(lead_id, v.validate()).to_dict())


def send_to_person(person_id: int):
    v = Validator(json_body())
    v.choice("template", tuple(whatsapp_marketing.CATALOGUE), required=True)
    v.integer("course_id", nullable=True, min_value=1)
    v.string("interest", nullable=True, max_length=200)
    return created(whatsapp_marketing.send_to_person(person_id, v.validate()).to_dict())


# ---------------------------------------------------------------- the provider's callback (no login: a shared token)

def _token() -> str | None:
    return request.headers.get("X-Webhook-Token") or request.args.get("token")


def webhook_verify():
    challenge = whatsapp_inbound.verification(request.args.get("hub.mode"), request.args.get("hub.verify_token") or _token(),
                                              request.args.get("hub.challenge"))
    if challenge is None:
        raise NotFound("Not found")
    return Response(challenge, mimetype="text/plain")


def webhook_receive():
    if not whatsapp_inbound.authorised(_token()):
        raise Unauthenticated("Invalid webhook token")
    payload = request.get_json(silent=True)
    return ok(whatsapp_inbound.handle(payload if payload is not None else {}))


PHONE_DIGITS = re.compile(r"^[1-9][0-9]{9,14}$")


def _text_list(body: dict, field: str, errors: dict) -> list[str]:
    """A list of non-empty single-line strings (Meta refuses empty values and line breaks)."""
    value = body.get(field)
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, (str, int, float)) for item in value):
        errors[field] = ["Must be a list of text values"]
        return []
    items = [str(item).strip() for item in value]
    bad = [i + 1 for i, item in enumerate(items) if not item or "\n" in item or "\t" in item or len(item) > 1000]
    if bad:
        errors[field] = [f"Value(s) {', '.join(map(str, bad))} are empty, too long or contain a line break or tab"]
    return items


def lms_send():
    body = json_body()
    v = Validator(body)
    v.string("template", required=True, max_length=80)
    v.string("language", max_length=10)
    v.string("to", nullable=True, max_length=20)
    v.string("lms_user_id", nullable=True, max_length=100)
    v.string("dedupe_key", required=True, max_length=115)
    v.datetime("occurred_at", nullable=True)
    errors = {}
    try:
        data = v.validate()
    except ValidationError as exc:
        errors.update(exc.details or {})
        data = {}
    data["params"] = _text_list(body, "params", errors)
    data["button_params"] = _text_list(body, "button_params", errors)
    if data.get("to"):
        data["to"] = data["to"].lstrip("+")
        if not PHONE_DIGITS.match(data["to"]):
            errors["to"] = ["Digits with the country code, no + or spaces (for example 919876543210)"]
    if not data.get("to") and not data.get("lms_user_id") and "to" not in errors:
        errors["to"] = ["Send the number, or the student's lms_user_id so the CRM can find it"]
    if errors:
        raise ValidationError("Invalid request data", errors)
    return ok(lms_whatsapp.receive(data))
