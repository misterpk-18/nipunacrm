"""WhatsApp template messages to learners through Pinbot (db 033).

A service queues a message with queue() inside the transaction of the change it reports, so the learner is never told
about something that rolled back. The sender (job `whatsapp-send`, and push_soon() right after the request commits)
posts Queued rows to {WHATSAPP_API_URL} and records the answer. The database transaction is never held open during the
HTTP call: rows are claimed (committed), posted, and each answer is recorded and committed on its own.

Queueing never breaks the business change: a message that can't be built or stored is logged, and a message that can't
be sent (no number, a missing value) is saved as Skipped with the reason.

| Provider answer           | Row                                                                              |
|---------------------------|----------------------------------------------------------------------------------|
| 200 with a message id     | Sent                                                                             |
| 401 / 403                 | Configuration problem: the run stops, the row stays Queued                        |
| 429 / 5xx                 | Queued again with backoff; Failed after MAX_ATTEMPTS                              |
| any other 4xx             | Failed with the provider's message (wrong template / values / number)             |
| connection refused        | Queued again with backoff (the provider never saw it); the run stops              |
| timed out with no answer  | Failed, "may have been delivered": check before sending it again (never resent    |
|                           | on its own, so a learner doesn't get the same message twice)                      |

Gates at send time: switched off or not configured -> the row waits; not on WHATSAPP_TEST_NUMBERS (when that is set) or
older than WHATSAPP_MAX_AGE_HOURS -> Skipped. The API key is never logged or stored.
"""
import json
import logging
import socket
import threading
import urllib.error
import urllib.request
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from flask import current_app, has_request_context
from sqlalchemy import event, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from config.database import db
from models import Person, WhatsappOutbox
from services import persons as persons_service
from services.context import actor_id
from services.whatsapp_templates import HIDDEN, TEMPLATES, WhatsAppTemplate

logger = logging.getLogger(__name__)

NOTIFICATIONS_OFF = "WhatsApp notifications are switched off for this person"
MAX_ATTEMPTS = 5
BACKOFF_BASE_SECONDS = 60
BACKOFF_MAX_SECONDS = 1800
CLAIM_SECONDS = 120
PUSH_KEY = "whatsapp_push"
_local = threading.local()  # a push uses its own shorter timeout


@dataclass
class Answer:
    status: int | None          # HTTP status; None when there was no answer
    body: dict | None
    error: str | None = None    # transport error
    maybe_accepted: bool = False  # timed out after the request went out: the provider may have taken it


def configured() -> bool:
    config = current_app.config
    return bool(config.get("WHATSAPP_ENABLED") and config.get("WHATSAPP_API_URL") and config.get("WHATSAPP_API_KEY"))


def test_numbers() -> set[str]:
    raw = current_app.config.get("WHATSAPP_TEST_NUMBERS") or ""
    return {phone for phone in (digits(persons_service.normalise_phone(n.strip())) for n in raw.split(",") if n.strip())
            if phone}


def digits(phone: str | None) -> str | None:
    return phone.lstrip("+") if phone else None


def recipient_phone(person: Person) -> str | None:
    """The WhatsApp number (the mobile when none is set) as digits with the country code: 919876543210."""
    raw = person.whatsapp_number or person.phone
    return digits(persons_service.normalise_phone(raw)) if raw else None


# ---------------------------------------------------------------- queueing

_TO_PERSON = object()  # queue(): the default recipient is the person's own number


def queue(template: WhatsAppTemplate, *, person: Person, branch_id: int, source_type: str, source_id: int,
          event_key: str, values: dict, to_phone: str | None | object = _TO_PERSON,
          recipient_user_id: int | None = None) -> WhatsappOutbox | None:
    """Write the message in the caller's transaction. None if this event already has one, or it couldn't be stored.
    to_phone (digits, country code; None = no number on file) sends it to someone other than the person: a staff alert
    about the learner; recipient_user_id marks it as a staff message (kept out of the learner's conversation)."""
    missing = [key for key in template.params if values.get(key) in (None, "")]
    phone = recipient_phone(person) if to_phone is _TO_PERSON else to_phone
    muted = to_phone is _TO_PERSON and not person.whatsapp_notifications  # staff alerts are not the learner's to mute
    skip_reason = (f"Missing value(s): {', '.join(missing)}" if missing
                   else NOTIFICATIONS_OFF if muted
                   else None if phone else "No WhatsApp number on file")
    stmt = insert(WhatsappOutbox).values(
        event_key=event_key, template_name=template.name, language=template.language, category=template.category,
        person_id=person.person_id, branch_id=branch_id, to_phone=phone, recipient_user_id=recipient_user_id,
        params={key: str(values[key]) for key in template.params if key in values and values[key] is not None},
        body_text=template.body if missing else template.render(values),
        source_type=source_type, source_id=source_id, queued_by=actor_id(),
        status="Skipped" if skip_reason else "Queued", skip_reason=skip_reason,
    ).on_conflict_do_nothing(index_elements=["event_key"]).returning(WhatsappOutbox.outbox_id)
    try:
        with db.session.begin_nested():
            outbox_id = db.session.execute(stmt).scalar()
    except Exception:  # never break the change this message reports
        logger.exception("Could not queue WhatsApp message %s", event_key)
        return None
    if outbox_id is None:
        return None
    if not skip_reason:
        db.session.info.setdefault(PUSH_KEY, set()).add(outbox_id)
    return db.session.get(WhatsappOutbox, outbox_id)


# ---------------------------------------------------------------- the provider

def _post(payload: dict) -> Answer:
    """One HTTP call to Pinbot. Tests replace this function."""
    config = current_app.config
    request = urllib.request.Request(
        config["WHATSAPP_API_URL"], method="POST", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json", "apikey": config["WHATSAPP_API_KEY"]})
    timeout = getattr(_local, "timeout", None) or config.get("WHATSAPP_TIMEOUT_SECONDS", 10)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return Answer(response.status, _json(response.read()))
    except urllib.error.HTTPError as exc:
        return Answer(exc.code, _json(exc.read()))
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            return Answer(None, None, "Provider did not answer in time", maybe_accepted=True)
        return Answer(None, None, f"Provider unreachable: {exc.reason}")
    except (TimeoutError, socket.timeout):
        return Answer(None, None, "Provider did not answer in time", maybe_accepted=True)
    except OSError as exc:
        return Answer(None, None, f"Provider unreachable: {exc}")


def _json(raw: bytes) -> dict | None:
    try:
        value = json.loads(raw or b"null")
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def request_body(row: WhatsappOutbox) -> dict:
    template = TEMPLATES[row.template_name]
    values = {**row.params, **(row.secret_params or {})}  # an LMS reset code / token is kept apart until sent (db 045)
    if any(values.get(key) == HIDDEN for key in template.secret):
        raise ValueError("its hidden values were already cleared; the LMS must send a new message")
    components = [{"type": "body", "parameters": template.body_parameters(values)}] + template.button_components(values)
    return {"messaging_product": "whatsapp", "recipient_type": "individual", "to": row.to_phone, "type": "template",
            "template": {"name": template.name, "language": {"code": template.language}, "components": components}}


def provider_message_id(answer: Answer) -> str | None:
    messages = (answer.body or {}).get("messages")
    if isinstance(messages, list) and messages and isinstance(messages[0], dict):
        return messages[0].get("id")
    return None


def error_text(answer: Answer) -> str:
    if answer.error:
        return answer.error
    body = answer.body or {}
    detail = body.get("message") or body.get("error")
    if isinstance(detail, dict):
        detail = detail.get("message")
    return f"Provider answered HTTP {answer.status}" + (f": {detail}" if detail else "")


# ---------------------------------------------------------------- the sender

def _claim(limit: int, outbox_ids: list[int] | None) -> list[int]:
    """Due Queued rows not claimed by another run (oldest first), claimed for CLAIM_SECONDS."""
    ids = db.session.execute(text("""
        UPDATE whatsapp_outbox SET locked_until = now() + make_interval(secs => :claim)
        WHERE outbox_id IN (
            SELECT outbox_id FROM whatsapp_outbox
            WHERE status = 'Queued' AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())
              AND (CAST(:ids AS BIGINT[]) IS NULL OR outbox_id = ANY(CAST(:ids AS BIGINT[])))
            ORDER BY outbox_id LIMIT :limit FOR UPDATE SKIP LOCKED)
        RETURNING outbox_id
    """), {"claim": CLAIM_SECONDS, "limit": limit, "ids": outbox_ids}).scalars().all()
    db.session.commit()
    return sorted(ids)


def _skip(row: WhatsappOutbox, reason: str) -> None:
    row.status, row.skip_reason, row.locked_until = "Skipped", reason, None


def _fail(row: WhatsappOutbox, answer: Answer) -> None:
    row.status, row.last_error, row.last_http_status, row.locked_until = "Failed", error_text(answer), answer.status, None


def _retry_later(row: WhatsappOutbox, answer: Answer) -> str:
    row.attempts += 1
    row.last_error, row.last_http_status = error_text(answer), answer.status
    if row.attempts >= MAX_ATTEMPTS:
        row.status, row.locked_until = "Failed", None
        return "failed"
    delay = min(BACKOFF_BASE_SECONDS * 2 ** (row.attempts - 1), BACKOFF_MAX_SECONDS)
    row.next_attempt_at = datetime.now(timezone.utc) + timedelta(seconds=delay)
    row.locked_until = None
    return "retry"


def _send_one(row: WhatsappOutbox, totals: Counter, allowed: set[str]) -> bool:
    """False when the run should stop (the provider or its key is not usable)."""
    max_age = timedelta(hours=current_app.config.get("WHATSAPP_MAX_AGE_HOURS", 24))
    if datetime.now(timezone.utc) - row.next_attempt_at > max_age:  # due since (a requeue or retry moves it)
        _skip(row, f"Not sent: it was still waiting after {max_age.total_seconds() / 3600:g} hours")
        totals["skipped"] += 1
        return True
    if allowed and row.to_phone not in allowed:
        _skip(row, "Not sent: the number is not on the test list (WHATSAPP_TEST_NUMBERS)")
        totals["skipped"] += 1
        return True
    answer = _post(request_body(row))
    row.last_http_status = answer.status
    if answer.status in (200, 201) and provider_message_id(answer):
        row.status, row.provider_message_id = "Sent", provider_message_id(answer)
        row.sent_at, row.locked_until, row.last_error = datetime.now(timezone.utc), None, None
        row.attempts += 1
        totals["sent"] += 1
        return True
    if answer.status in (401, 403):
        row.locked_until, row.last_error = None, error_text(answer)
        totals["config_error"] += 1
        return False
    if answer.maybe_accepted or answer.status in (200, 201):  # no answer, or an answer without a message id
        _fail(row, answer)
        row.last_error = ("The provider's answer was unclear: the message may have been delivered. Check the "
                          "learner's WhatsApp or the provider's report before sending it again")
        totals["failed"] += 1
        return True
    if answer.status is None:  # refused / unreachable: the provider never saw it
        outcome = _retry_later(row, answer)
        totals[outcome] += 1
        return False
    if answer.status == 429 or answer.status >= 500:
        totals[_retry_later(row, answer)] += 1
        return True
    _fail(row, answer)
    totals["failed"] += 1
    return True


def deliver(limit: int = 100, outbox_ids: list[int] | None = None) -> dict:
    """Post due Queued rows (job whatsapp-send; or only the given ones, for push_soon). Commits each row."""
    if not configured():
        waiting = db.session.execute(text("SELECT count(*) FROM whatsapp_outbox WHERE status = 'Queued'")).scalar()
        return {"held": waiting, "reason": "WhatsApp sending is switched off or not configured"}
    totals: Counter = Counter()
    allowed = test_numbers()
    for outbox_id in _claim(limit, outbox_ids):
        row = db.session.get(WhatsappOutbox, outbox_id, populate_existing=True)
        keep_going = True
        try:
            keep_going = _send_one(row, totals, allowed)
        except Exception as exc:  # e.g. a template that no longer exists: don't stop the others
            logger.exception("WhatsApp message %s could not be sent", outbox_id)
            row.status, row.last_error, row.locked_until = "Failed", f"Could not build the request: {exc}", None
            totals["failed"] += 1
        db.session.commit()
        if not keep_going:
            break
    return dict(totals)


def push_soon(outbox_ids: list[int]) -> None:
    """After a request commits: send its messages in a background thread, so the request never waits for the provider."""
    if not configured():
        return
    app = current_app._get_current_object()

    def run():
        with app.app_context():
            _local.timeout = app.config.get("WHATSAPP_PUSH_TIMEOUT_SECONDS", 3)
            try:
                deliver(outbox_ids=outbox_ids)
            except Exception:
                logger.exception("WhatsApp push failed")
            finally:
                _local.timeout = None
                db.session.remove()

    threading.Thread(target=run, name="whatsapp-push", daemon=True).start()


@event.listens_for(Session, "after_commit")
def _after_commit(session) -> None:
    ids = session.info.pop(PUSH_KEY, None)
    if ids and has_request_context() and current_app.config.get("WHATSAPP_PUSH_ON_COMMIT", True):
        push_soon(sorted(ids))


@event.listens_for(Session, "after_soft_rollback")
def _after_rollback(session, previous_transaction) -> None:
    if previous_transaction.parent is None:  # the change never happened, so neither does the message
        session.info.pop(PUSH_KEY, None)


# ---------------------------------------------------------------- reading and recovery

def summary() -> dict:
    counts = dict(db.session.execute(text("SELECT status::text, count(*) FROM whatsapp_outbox GROUP BY status")).all())
    return {"counts": counts, "configured": configured(), "test_numbers_only": bool(test_numbers())}


def requeue(outbox_ids: list[int]) -> int:
    """Failed / Skipped rows with a number go back to Queued (a Failed row whose answer was lost: check first).
    LMS messages are never requeued here: the LMS sends a new one (its codes and tokens are gone once a row is final)."""
    rows = db.session.execute(select(WhatsappOutbox).where(
        WhatsappOutbox.outbox_id.in_(outbox_ids), WhatsappOutbox.status.in_(("Failed", "Skipped")),
        WhatsappOutbox.to_phone.is_not(None), WhatsappOutbox.source_type != "lms")).scalars().all()
    for row in rows:
        row.status, row.attempts, row.skip_reason, row.last_error, row.locked_until = "Queued", 0, None, None, None
        row.next_attempt_at = db.func.now()  # due now; restarts the "too old" clock
    db.session.flush()
    return len(rows)
