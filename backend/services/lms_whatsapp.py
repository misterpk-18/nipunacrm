"""WhatsApp messages the LMS sends through the CRM (round 6, db 045): POST /lms/whatsapp.

One Pinbot number serves both systems, so the CRM is the only sender. The LMS posts a template name, the number (or the
student's lms_user_id) and the values; the CRM checks them against its copy of the nine LMS templates
(whatsapp_templates.LMS_TEMPLATES), writes a whatsapp_outbox row with source_type 'lms' and event key
`lms:<dedupe_key>`, and the usual sender posts it right after the request commits (whatsapp.push_soon; the
whatsapp-send job retries). The same key twice never sends twice: the second call gets the first call's answer.

| The LMS gets                         | When                                                                          |
|--------------------------------------|-------------------------------------------------------------------------------|
| 200 Queued                           | Accepted; the sender posts it in a moment                                     |
| 200 Sent (+ provider_message_id)     | A repeat of a message the provider already took                               |
| 200 Skipped (+ reason)               | Switched off, too old, no number, the person's WhatsApp switched off, or not  |
|                                      | on WHATSAPP_TEST_NUMBERS. Nothing is waiting, so switching on never floods    |
| 422                                  | Not an LMS template, wrong language, or a repeat of a message that Failed     |
| 400                                  | Wrong number of values, an empty value or one with a line break, a bad number |

Secret values (a reset code, an activation token) are kept in secret_params only while the row is Queued; body_text and
params hold "[hidden]", and the database clears secret_params once the row is Sent, Failed or Skipped.

Later status changes (Sent, Delivered, Read, Failed, Skipped) go back to the LMS as WhatsappStatusUpdated events in
lms_outbox (W3, option a) when LMS_WHATSAPP_STATUS_EVENTS is on; leave it off until the LMS has its handler.
"""
from datetime import datetime, timedelta, timezone

from flask import current_app, has_app_context
from sqlalchemy import event, inspect, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from config.database import db
from models import Admission, Person, WhatsappOutbox
from services import whatsapp
from services.errors import BusinessRule, ValidationError
from services.whatsapp_templates import HIDDEN, LMS_TEMPLATES, WhatsAppTemplate

SOURCE_TYPE = "lms"
KEY_PREFIX = "lms:"
MAX_AGE_HOURS = 48  # the LMS skips older news itself; the CRM holds the same line

SWITCHED_OFF = "WhatsApp sending is switched off in the CRM"
TOO_OLD = f"Not sent: it happened more than {MAX_AGE_HOURS} hours ago"
NOT_TEST_NUMBER = "Not sent: the number is not on the test list (WHATSAPP_TEST_NUMBERS)"


def _template(name: str, language: str) -> WhatsAppTemplate:
    template = LMS_TEMPLATES.get(name)
    if template is None:
        raise BusinessRule(f"{name} is not an LMS WhatsApp template the CRM knows. Add it to the CRM's list first")
    if language != template.language:
        raise BusinessRule(f"{name} is approved in '{template.language}' only, not '{language}'")
    return template


def _values(template: WhatsAppTemplate, params: list[str], button_params: list[str]) -> dict:
    """Name the LMS's ordered values; a button value that is also a body value (the reset code) may be left out."""
    errors = {}
    if len(params) != len(template.params):
        errors["params"] = [f"{template.name} takes {len(template.params)} value(s), not {len(params)}"]
    own_buttons = [key for key in template.buttons if key not in template.params]
    if button_params and len(button_params) != len(template.buttons) or not button_params and own_buttons:
        errors["button_params"] = [f"{template.name} takes {len(template.buttons)} button value(s), "
                                   f"not {len(button_params)}"]
    if errors:
        raise ValidationError("Invalid request data", errors)
    values = dict(zip(template.params, params))
    for key, value in zip(template.buttons, button_params):
        values[key] = value
    return values


def _latest_branch_id(person: Person) -> int:
    admission = db.session.execute(
        select(Admission).where(Admission.person_id == person.person_id, Admission.enrolment_status != "Cancelled")
        .order_by(Admission.admission_id.desc()).limit(1)).scalar_one_or_none()
    return admission.service_branch_id if admission else person.registered_branch_id


def _skip_reason(person: Person | None, phone: str | None, occurred_at: datetime | None) -> str | None:
    if not whatsapp.configured():
        return SWITCHED_OFF
    if occurred_at and datetime.now(timezone.utc) - occurred_at > timedelta(hours=MAX_AGE_HOURS):
        return TOO_OLD
    if not phone:
        return "No WhatsApp number on file"
    if person is not None and not person.whatsapp_notifications:
        return whatsapp.NOTIFICATIONS_OFF
    allowed = whatsapp.test_numbers()
    if allowed and phone not in allowed:
        return NOT_TEST_NUMBER
    return None


def answer(row: WhatsappOutbox) -> dict:
    """What the LMS records for a message: Queued, Sent or Skipped (a Failed one is a 422)."""
    if row.status == "Failed":
        raise BusinessRule(f"The CRM already tried this message and it failed: {row.last_error or 'no detail'}")
    if row.status in ("Sent", "Delivered", "Read"):
        return {"status": "Sent", "provider_message_id": row.provider_message_id, "delivery": row.status,
                "outbox_id": row.outbox_id}
    if row.status == "Skipped":
        return {"status": "Skipped", "reason": row.skip_reason, "outbox_id": row.outbox_id}
    return {"status": "Queued", "outbox_id": row.outbox_id}


def _existing(event_key: str) -> WhatsappOutbox | None:
    return db.session.execute(select(WhatsappOutbox).where(WhatsappOutbox.event_key == event_key)).scalar_one_or_none()


def receive(data: dict) -> dict:
    event_key = KEY_PREFIX + data["dedupe_key"]
    row = _existing(event_key)
    if row is not None:
        return answer(row)

    template = _template(data["template"], data.get("language") or "en")
    values = _values(template, data.get("params") or [], data.get("button_params") or [])
    person = None
    if data.get("lms_user_id"):
        person = db.session.execute(select(Person).where(Person.lms_user_id == data["lms_user_id"])).scalar_one_or_none()
    phone = data.get("to") or (whatsapp.recipient_phone(person) if person else None)
    skip_reason = _skip_reason(person, phone, data.get("occurred_at"))
    secret = {key: values[key] for key in template.secret}

    stmt = insert(WhatsappOutbox).values(
        event_key=event_key, template_name=template.name, language=template.language, category=template.category,
        person_id=person.person_id if person else None, branch_id=_latest_branch_id(person) if person else None,
        to_phone=phone, params={key: HIDDEN if key in secret else value for key, value in values.items()},
        secret_params=secret or None, body_text=template.render(values), source_type=SOURCE_TYPE, source_id=None,
        status="Skipped" if skip_reason else "Queued", skip_reason=skip_reason,
    ).on_conflict_do_nothing(index_elements=["event_key"]).returning(WhatsappOutbox.outbox_id)
    outbox_id = db.session.execute(stmt).scalar()
    if outbox_id is None:  # the LMS's retry raced its first call
        return answer(_existing(event_key))
    if not skip_reason:
        db.session.info.setdefault(whatsapp.PUSH_KEY, set()).add(outbox_id)  # sent right after the commit
    return answer(db.session.get(WhatsappOutbox, outbox_id))


# ---------------------------------------------------------------- status back to the LMS (W3 option a)

def status_data(row: WhatsappOutbox) -> dict:
    at = {"Sent": row.sent_at, "Delivered": row.delivered_at, "Read": row.read_at}.get(row.status)
    return {"dedupe_key": row.event_key.removeprefix(KEY_PREFIX), "crm_outbox_id": row.outbox_id,
            "status": row.status, "provider_message_id": row.provider_message_id,
            "reason": row.skip_reason if row.status == "Skipped" else row.last_error if row.status == "Failed" else None,
            "occurred_at": (at or datetime.now(timezone.utc)).isoformat()}


@event.listens_for(Session, "before_flush")
def _status_changed(session, flush_context, instances) -> None:
    """An LMS message moved on (sender, retry job or the provider's callback): tell the LMS, in the same transaction."""
    if not has_app_context() or not current_app.config.get("LMS_WHATSAPP_STATUS_EVENTS"):
        return
    changed = [row for row in session.dirty if isinstance(row, WhatsappOutbox) and row.source_type == SOURCE_TYPE
               and row.status != "Queued" and inspect(row).attrs.status.history.has_changes()]
    if not changed:
        return
    from services import lms_sync

    now = datetime.now(lms_sync.business_tz())
    for row in changed:
        key = f"whatsapp:{row.outbox_id}"
        lms_sync.emit(session, "WhatsappStatusUpdated", key, key, status_data(row), now)
