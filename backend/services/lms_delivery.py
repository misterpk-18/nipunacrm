"""Delivery of lms_outbox rows to the Nipuna LMS: POST {LMS_BASE_URL}/api/v1/integrations/crm/events (db 026).

Rows go oldest first, one at a time per record (a course, or an admission with its finance summary), so a row that is
waiting never blocks other admissions. The database transaction is never held open during the HTTP call: rows are
claimed (committed), posted, and each answer is recorded and committed on its own — this job commits, unlike the
others.

| LMS answer        | Row                                                                           |
|-------------------|-------------------------------------------------------------------------------|
| 201 / 200         | Delivered (200 = the LMS already had this event_id)                           |
| 400 / 409         | Failed: the payload or event_id is wrong on the CRM side — fix, then resend   |
| 422               | Pending, retried with backoff (e.g. its course has not been applied yet)      |
| 5xx / no answer   | Pending, retried with backoff; no answer at all stops this run                |
| 401 / 403 / 404   | Configuration problem: the run stops, the row stays Pending                   |

A row that is still not delivered after MAX_ATTEMPTS becomes Failed, with a task for Super Admin. The service key and
the activation token the LMS returns for a new student login are never logged or stored.
"""
import json
import logging
import urllib.error
import urllib.request
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from flask import current_app
from sqlalchemy import func, select, text

from config.database import db
from models import Admission, Branch, LmsOutbox
from services import tasks
from services.lms_sync import business_tz

logger = logging.getLogger(__name__)

EVENTS_PATH = "/api/v1/integrations/crm/events"
STATUS_PATH = "/api/v1/integrations/crm/status"
MAX_ATTEMPTS = 12
BACKOFF_BASE_SECONDS = 30
BACKOFF_MAX_SECONDS = 3600
CLAIM_SECONDS = 300
TOKEN_FIELDS = ("activation_token",)


@dataclass
class Answer:
    status: int | None         # HTTP status; None when the LMS could not be reached
    body: dict | None
    error: str | None = None   # transport error


def configured() -> bool:
    return bool(current_app.config.get("LMS_BASE_URL") and current_app.config.get("LMS_SERVICE_KEY"))


def _request(method: str, path: str, body: dict | None = None) -> Answer:
    """One HTTP call to the LMS. Tests replace this function."""
    config = current_app.config
    request = urllib.request.Request(
        config["LMS_BASE_URL"].rstrip("/") + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", "Accept": "application/json",
                 "X-Service-Key": config["LMS_SERVICE_KEY"]},
    )
    try:
        with urllib.request.urlopen(request, timeout=config.get("LMS_TIMEOUT_SECONDS", 10)) as response:
            return Answer(response.status, _json(response.read()))
    except urllib.error.HTTPError as exc:
        return Answer(exc.code, _json(exc.read()))
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return Answer(None, None, f"LMS unreachable: {getattr(exc, 'reason', exc)}")


def _json(raw: bytes) -> dict | None:
    try:
        value = json.loads(raw or b"null")
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def post_event(envelope: dict) -> Answer:
    return _request("POST", EVENTS_PATH, envelope)


def pull_status(since: str) -> Answer:
    from urllib.parse import quote

    return _request("GET", f"{STATUS_PATH}?since={quote(since)}")


# ---------------------------------------------------------------- the worker

def _claim(limit: int) -> list[int]:
    """The oldest pending row of each record that is due and not claimed by another run; claimed for CLAIM_SECONDS."""
    ids = db.session.execute(text("""
        WITH heads AS (
            SELECT DISTINCT ON (record_key) outbox_id, next_attempt_at, locked_until
            FROM lms_outbox WHERE status = 'Pending' ORDER BY record_key, outbox_id
        )
        UPDATE lms_outbox o SET locked_until = now() + make_interval(secs => :claim)
        WHERE o.outbox_id IN (SELECT outbox_id FROM heads
                              WHERE next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())
                              ORDER BY outbox_id LIMIT :limit)
          AND o.status = 'Pending' AND (o.locked_until IS NULL OR o.locked_until < now())
        RETURNING o.outbox_id
    """), {"claim": CLAIM_SECONDS, "limit": limit}).scalars().all()
    db.session.commit()
    return sorted(ids)


def _envelope(row: LmsOutbox) -> dict:
    envelope = row.envelope()
    envelope["occurred_at"] = row.occurred_at.astimezone(business_tz()).isoformat()
    return envelope


def error_text(answer: Answer) -> str:
    if answer.error:
        return answer.error
    error = (answer.body or {}).get("error") or {}
    message = error.get("message") or f"HTTP {answer.status}"
    return f"{message}: {json.dumps(error['details'], ensure_ascii=False)}" if error.get("details") else message


def _retry_later(row: LmsOutbox, answer: Answer) -> None:
    row.attempts += 1
    row.last_error = error_text(answer)
    if row.attempts >= MAX_ATTEMPTS:
        _fail(row, f"Not delivered after {row.attempts} attempts: {row.last_error}")
        return
    delay = min(BACKOFF_BASE_SECONDS * 2 ** (row.attempts - 1), BACKOFF_MAX_SECONDS)
    row.next_attempt_at = datetime.now(timezone.utc) + timedelta(seconds=delay)


def _fail(row: LmsOutbox, error: str) -> None:
    row.status = "Failed"
    row.last_error = error
    branch_id = None
    if row.record_key.startswith("admission:"):
        admission = db.session.get(Admission, int(row.record_key.split(":", 1)[1]))
        branch_id = admission.service_branch_id if admission else None
    elif row.record_key.startswith(("branch:", "branch-finance:")):
        branch_id = int(row.record_key.split(":", 1)[1])
    if branch_id is None:
        branch_id = db.session.execute(select(func.min(Branch.branch_id))).scalar_one()
    tasks.create_system_task(
        "GENERAL", f"LMS sync failed: {row.event_type} for {row.record_key}", branch_id, datetime.now(timezone.utc),
        team_role_code="SUPER_ADMIN", description=f"Outbox row {row.outbox_id} (event {row.event_id}): {error}",
        dedupe_key=f"lms-sync-failed:{row.outbox_id}",
    )
    logger.warning("LMS event %s (%s, %s) failed: %s", row.event_id, row.event_type, row.record_key, error)


def _record(row: LmsOutbox, answer: Answer) -> str:
    """Store the LMS's answer on the row. Returns 'delivered', 'failed', 'retry' or 'stop'."""
    row.locked_until = None
    row.last_http_status = answer.status
    if answer.status in (200, 201):
        data = dict((answer.body or {}).get("data") or {})
        row.activation_token_issued = row.activation_token_issued or bool(data.get("activation_token"))
        for field in TOKEN_FIELDS:
            data.pop(field, None)
        row.status = "Delivered"
        row.attempts += 1
        row.delivered_at = datetime.now(timezone.utc)
        row.response_status = data.get("status")
        row.response_result = data.get("result")
        row.last_error = None
        return "delivered"
    if answer.status in (400, 409):
        row.attempts += 1
        _fail(row, f"HTTP {answer.status} · {error_text(answer)}")
        return "failed"
    if answer.status in (401, 403, 404, 405):
        row.last_error = f"HTTP {answer.status} · {error_text(answer)} — check LMS_BASE_URL / LMS_SERVICE_KEY"
        return "stop"
    _retry_later(row, answer)  # 422, 5xx, other statuses, no answer
    if row.status == "Failed":
        return "failed"
    return "stop" if answer.status is None else "retry"


def deliver(limit: int = 200) -> dict:
    """Post due Pending rows to the LMS (job lms-sync)."""
    if not configured():
        pending = db.session.execute(select(func.count()).where(LmsOutbox.status == "Pending")).scalar_one()
        return {"skipped": "LMS_BASE_URL / LMS_SERVICE_KEY not set", "pending": pending}
    claimed = _claim(limit)
    counts: Counter = Counter()
    for n, outbox_id in enumerate(claimed):
        row = db.session.get(LmsOutbox, outbox_id)
        envelope = _envelope(row)
        db.session.commit()                   # nothing held open while the LMS answers
        answer = post_event(envelope)
        row = db.session.get(LmsOutbox, outbox_id)
        outcome = _record(row, answer)
        db.session.commit()
        counts[outcome] += 1
        if outcome == "stop":
            logger.error("LMS sync stopped at %s: %s", row.event_id, row.last_error)
            rest = claimed[n + 1:]
            _release(rest)
            if rest:
                counts["not_attempted"] = len(rest)
            break
    return dict(counts) or {"delivered": 0}


def _release(outbox_ids: list[int]) -> None:
    if outbox_ids:
        db.session.execute(text("UPDATE lms_outbox SET locked_until = NULL WHERE outbox_id = ANY(:ids)"),
                           {"ids": outbox_ids})
        db.session.commit()


def requeue(outbox_ids: list[int] | None = None) -> int:
    """Failed rows (all, or the given ones) → Pending with a fresh attempt count. The event is sent unchanged, so
    use this after an LMS-side fix or outage; after a CRM mapping fix, resend the record instead (new event)."""
    stmt = select(LmsOutbox).where(LmsOutbox.status == "Failed")
    if outbox_ids:
        stmt = stmt.where(LmsOutbox.outbox_id.in_(outbox_ids))
    rows = db.session.execute(stmt).scalars().all()
    for row in rows:
        row.status, row.attempts, row.locked_until = "Pending", 0, None
        row.next_attempt_at = datetime.now(timezone.utc)
        tasks.complete_system_task(f"lms-sync-failed:{row.outbox_id}")
    db.session.flush()
    return len(rows)


def summary() -> dict:
    """Row counts by status and event type."""
    rows = db.session.execute(select(LmsOutbox.status, LmsOutbox.event_type, func.count())
                              .group_by(LmsOutbox.status, LmsOutbox.event_type)).all()
    result: dict = {}
    for status, event_type, count in rows:
        result.setdefault(status, {})[event_type] = count
    return result
