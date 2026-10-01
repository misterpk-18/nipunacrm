"""The LMS status pull (round 2, db 028): GET {LMS_BASE_URL}/api/v1/integrations/crm/status?since=<watermark>.

The LMS owns the student's login and LMS status, enrolment and curriculum status, batches, batch allocations,
academic completion and the certificate register; the CRM mirrors them (LMS docs/CRM_INTEGRATION.md §2.2, answers in
nipuna crm-docs/CRM_ROUND2_LMS_REPLY.md).

Rules from the LMS:
- Every entry is the record's whole current state; a later copy wins. Applying one twice changes nothing.
- `as_of` is stored exactly as returned and sent as the next `since`. It can repeat a row, never skip one.
- Nothing is deleted in the LMS: removals arrive as statuses. An admission's `allocations` are its complete history.
- A failed pull (LMS down, 5xx, 401) keeps the old watermark.

Each record is written in its own transaction with app.sync_source = 'LMS', which lets the CRM's academic triggers
accept the LMS's facts (allocation checks, combo batches, certificate numbers, enrolment moves). A record that can't be
applied yet — e.g. an allocation to a batch the pull never sent — is kept in lms_pull_holds and retried on every pull;
the watermark still moves. Records the CRM doesn't know (LMS-only IDs) are ignored.
"""
import logging
from collections import Counter
from datetime import date, datetime, time, timezone

from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import SQLAlchemyError

from config.database import db
from models import (
    Admission, AdmissionCurriculum, Batch, BatchAllocation, Branch, Certificate, Course, CurriculumVersion,
    LmsPullHold, LmsPullState, Person,
)
from repositories import settings as settings_repo
from repositories import users as users_repo
from services import lms_delivery, tasks
from services.errors import ManagedInLms
from services.lms_sync import business_tz

logger = logging.getLogger(__name__)

CLAIM_MINUTES = 10
FULL_PULL_SINCE = "1970-01-01T00:00:00+00:00"
HOLD_TASK_AFTER = 12            # pulls (about an hour at the suggested 5-minute interval)
KINDS = ("batches", "persons", "admissions", "academics", "certificates")  # batches before the allocations naming them


class Held(Exception):
    """The record can't be applied yet; keep it and retry on the next pull."""


def lms_owns_academics() -> bool:
    return bool(settings_repo.get("academics_managed_in_lms", False))


def require_crm_academics(what: str) -> None:
    """Refuse academic writes that belong to the LMS (batches, allocation, joining, curriculum, completion,
    certificates); they reach the CRM through the pull."""
    if lms_owns_academics():
        raise ManagedInLms(f"{what} are managed in the Nipuna LMS and shown read-only here")


def sync_status() -> dict:
    """For the LMS access screen: who owns academics, when the CRM last pulled, and what is waiting."""
    current = state()
    return {"academics_managed_in_lms": lms_owns_academics(), "configured": lms_delivery.configured(),
            "pull": current.to_dict(), "held": len(holds())}


# ---------------------------------------------------------------- value helpers

def _int(value) -> int | None:
    return int(value) if value not in (None, "") else None


def _datetime(value) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def _date(value) -> date | None:
    return date.fromisoformat(value[:10]) if value else None


def _start_of(day: date | None) -> datetime | None:
    """A date the LMS sends (allocated_on, issue_date) as the start of that business day."""
    return datetime.combine(day, time.min, tzinfo=business_tz()) if day else None


def _user_id(email: str | None) -> int | None:
    user = users_repo.get_by_email(email) if email else None
    return user.user_id if user else None


def _set(obj, **values) -> bool:
    """Assign only what differs; True when something changed."""
    changed = False
    for field, value in values.items():
        if getattr(obj, field) != value:
            setattr(obj, field, value)
            changed = True
    return changed


def _course(code: str | None) -> Course:
    course = db.session.execute(select(Course).where(Course.course_code == code)).scalar_one_or_none()
    if course is None:
        raise Held(f"Course {code} is not in the CRM course master")
    return course


def _mirror_version(course_id: int, label: str) -> CurriculumVersion:
    """The CRM row for an LMS curriculum version (course + label), created as a mirrored Published version."""
    version = db.session.execute(select(CurriculumVersion).where(
        CurriculumVersion.course_id == course_id, CurriculumVersion.version_label == label)).scalar_one_or_none()
    if version is None:
        version = CurriculumVersion(course_id=course_id, version_label=label, status="Published", lms_mirrored=True,
                                    published_at=datetime.now(timezone.utc), notes="Mirrored from the LMS")
        db.session.add(version)
        db.session.flush()
    return version


# ---------------------------------------------------------------- one record of each kind

def apply_person(entry: dict) -> str:
    person = db.session.get(Person, _int(entry.get("crm_person_id")))
    if person is None:
        return "ignored"
    changed = _set(person, lms_user_id=entry.get("lms_user_id"),
                   lms_provisioned_at=_datetime(entry.get("lms_provisioned_at")))
    return "applied" if changed else "unchanged"


def apply_admission(entry: dict) -> str:
    admission = db.session.get(Admission, _int(entry.get("crm_admission_id")))
    if admission is None:
        return "ignored"
    changed = _set(admission, lms_status=entry["lms_status"],
                   lms_last_activity_at=_datetime(entry.get("lms_last_activity_at")))
    if changed:
        admission.lms_last_synced_at = datetime.now(timezone.utc)
    return "applied" if changed else "unchanged"


def apply_batch(entry: dict) -> str:
    code = entry["lms_course_id"]
    course = _course(entry.get("course_code"))
    branch = db.session.execute(select(Branch).where(Branch.branch_code == entry.get("branch_code"))).scalar_one_or_none()
    if branch is None:
        raise Held(f"Branch {entry.get('branch_code')} is not in the CRM")
    label = entry.get("curriculum_version_label")
    lead_email = entry.get("lead_trainer_email")
    values = dict(
        lms_mirrored=True, course_id=course.course_id, branch_id=branch.branch_id,
        delivery_mode=entry.get("delivery_mode") or "Classroom", status=entry["status"],
        capacity=entry["capacity"], start_date=_date(entry.get("start_date")) or date.today(),
        end_date=_date(entry.get("end_date")),
        curriculum_version_id=_mirror_version(course.course_id, label).curriculum_version_id if label else None,
        lead_trainer_email=lead_email, trainer_emails=list(entry.get("trainer_emails") or []),
        trainer_user_id=_user_id(lead_email),
    )
    batch = db.session.execute(select(Batch).where(Batch.lms_course_id == code)).scalar_one_or_none()
    created = batch is None
    if created:
        batch = Batch(lms_course_id=code, batch_name=f"{course.course_title} · {code}", **values)
        db.session.add(batch)
    changed = _set(batch, **values)
    db.session.flush()
    return "applied" if created or changed else "unchanged"


def _apply_curriculum(admission: Admission, entry: dict) -> bool:
    label = entry.get("curriculum_version_label")
    mapped = entry.get("curriculum_status") == "Mapped" and label
    keep = _mirror_version(admission.course_id, label).curriculum_version_id if mapped else None
    changed = False
    for mapping in db.session.execute(select(AdmissionCurriculum).where(
            AdmissionCurriculum.admission_id == admission.admission_id)).scalars().all():
        if mapping.curriculum_version_id != keep:
            db.session.delete(mapping)
            changed = True
    if keep is not None and db.session.get(AdmissionCurriculum, (admission.admission_id, keep)) is None:
        db.session.add(AdmissionCurriculum(admission_id=admission.admission_id, curriculum_version_id=keep))
        changed = True
    db.session.flush()  # the mapping exists before curriculum_status says Mapped (trigger)
    return _set(admission, curriculum_status="Mapped" if mapped else "Mapping Pending") or changed


def _apply_allocations(admission: Admission, items: list[dict]) -> bool:
    """Replace the admission's allocations with the LMS's complete history."""
    wanted = []
    for item in items:
        batch = db.session.execute(select(Batch).where(Batch.lms_course_id == item.get("lms_course_id"))).scalar_one_or_none()
        if batch is None:
            raise Held(f"Batch {item.get('lms_course_id')} has not come from the LMS yet")
        wanted.append((batch, _course(item.get("course_code")), item))

    existing = {(a.course_id, a.track_code or "", a.batch_id, a.lms_allocated_on): a
                for a in db.session.execute(select(BatchAllocation).where(
                    BatchAllocation.admission_id == admission.admission_id)).scalars().all()}
    keys = {(course.course_id, item.get("track_code") or "", batch.batch_id, _date(item.get("allocated_on")))
            for batch, course, item in wanted}
    changed = False
    for key, allocation in existing.items():
        if key not in keys or not allocation.lms_mirrored:   # the CRM's own rows give way to the LMS's history
            db.session.delete(allocation)
            changed = True
    db.session.flush()

    # Closed rows first, so a move (old closed, new active) never has two active rows on one track
    for batch, course, item in sorted(wanted, key=lambda w: w[2].get("status") == "Active"):
        on = _date(item.get("allocated_on"))
        key = (course.course_id, item.get("track_code") or "", batch.batch_id, on)
        allocation = existing.get(key)
        if allocation is None or not allocation.lms_mirrored:
            allocation = BatchAllocation(admission_id=admission.admission_id, batch_id=batch.batch_id,
                                         course_id=course.course_id, track_code=item.get("track_code"),
                                         lms_allocated_on=on, lms_mirrored=True, allocated_at=_start_of(on))
            db.session.add(allocation)
            changed = True
        status = item["status"]
        ended = _start_of(_date(item.get("ended_on")))
        changed |= _set(allocation, status=status, joining_date=_date(item.get("joining_date")),
                        ended_at=None if status == "Active" else ended or allocation.ended_at or datetime.now(timezone.utc),
                        end_reason=item.get("end_reason"))
        db.session.flush()
    return changed


def _apply_enrolment(admission: Admission, entry: dict) -> bool:
    status = entry["enrolment_status"]
    if admission.enrolment_status == "Cancelled":
        return False                     # cancellation is the CRM's; the LMS answers with Withdrawn
    if status == "Cancelled":
        # The LMS withdrew a student the CRM hasn't cancelled: cancelling (and any refund) is a CRM decision
        tasks.create_system_task(
            "ACADEMIC", f"LMS withdrew {admission.admission_code}: cancel the admission if the student has left",
            admission.service_branch_id, datetime.now(timezone.utc), team_role_code="BRANCH_MANAGER",
            dedupe_key=f"lms-withdrawn:{admission.admission_id}", admission_id=admission.admission_id)
        return False
    changed = False
    if status == "Completed":
        email = entry.get("completion_authorised_by_email")
        changed = _set(admission, academic_completed_at=_datetime(entry.get("academic_completed_at")),
                       completion_authorised_by_email=email or "LMS",
                       completion_authorised_by=_user_id(email))
    return _set(admission, enrolment_status=status) or changed


def apply_academics(entry: dict) -> str:
    admission = db.session.get(Admission, _int(entry.get("crm_admission_id")))
    if admission is None:
        return "ignored"
    changed = _apply_curriculum(admission, entry)
    changed |= _apply_allocations(admission, entry.get("allocations") or [])
    changed |= _apply_enrolment(admission, entry)
    if changed:
        admission.lms_last_synced_at = datetime.now(timezone.utc)
    db.session.flush()
    return "applied" if changed else "unchanged"


def apply_certificate(entry: dict) -> str:
    admission = db.session.get(Admission, _int(entry.get("crm_admission_id")))
    if admission is None:
        return "ignored"
    course = _course(entry.get("course_code"))
    number, version = entry["certificate_number"], int(entry["version"])
    certificate = db.session.execute(select(Certificate).where(
        Certificate.certificate_number == number, Certificate.version == version)).scalar_one_or_none()
    created = certificate is None
    if created:
        certificate = Certificate(certificate_number=number, version=version, admission_id=admission.admission_id,
                                  course_id=course.course_id, lms_mirrored=True)
        db.session.add(certificate)
    elif not certificate.lms_mirrored:
        raise Held(f"Certificate {number} v{version} already exists as a CRM certificate")
    status, reason = entry["status"], entry.get("reason")
    revoked = status == "Revoked"
    changed = _set(
        certificate, status=status, admission_id=admission.admission_id, course_id=course.course_id,
        certificate_type=entry.get("certificate_type"), holder_name=entry.get("holder_name"),
        enrolment_code=entry.get("enrolment_code"), issued_at=_start_of(_date(entry.get("issue_date"))),
        issued_by_email=entry.get("issued_by_email"), issued_by=_user_id(entry.get("issued_by_email")),
        revoked_at=_datetime(entry.get("revoked_at")), revoked_by_email=entry.get("revoked_by_email"),
        revoked_by=_user_id(entry.get("revoked_by_email")),
        revoke_reason=(reason or "Revoked in the LMS") if revoked else None,
        reissue_reason=None if revoked else reason,
        supersedes_version=_int(entry.get("supersedes_version")), lms_changed_at=_datetime(entry.get("changed_at")),
    )
    db.session.flush()
    return "applied" if created or changed else "unchanged"


APPLY = {"persons": apply_person, "admissions": apply_admission, "batches": apply_batch,
         "academics": apply_academics, "certificates": apply_certificate}


def record_key(kind: str, entry: dict) -> str:
    if kind == "batches":
        return f"batches:{entry.get('lms_course_id')}"
    if kind == "persons":
        return f"persons:{entry.get('crm_person_id')}"
    if kind == "certificates":
        return f"certificates:{entry.get('certificate_number')}/{entry.get('version')}"
    return f"{kind}:{entry.get('crm_admission_id')}"


def _entries(kind: str, data: dict) -> list[dict]:
    entries = list(data.get(kind) or [])
    if kind == "certificates":   # a reissue: v1 Superseded before v2 Issued
        entries.sort(key=lambda e: (e.get("certificate_number") or "", int(e.get("version") or 0)))
    return entries


# ---------------------------------------------------------------- applying, holding

def _apply_one(kind: str, key: str, entry: dict) -> str:
    """Apply one record in its own transaction. Returns applied / unchanged / ignored / held."""
    try:
        db.session.execute(text("SELECT set_config('app.sync_source', 'LMS', TRUE)"))
        outcome = APPLY[kind](entry)
        db.session.execute(delete(LmsPullHold).where(LmsPullHold.record_key == key))
        db.session.execute(text("SELECT set_config('app.sync_source', '', TRUE)"))  # never outlives this record
        db.session.commit()
        tasks.complete_system_task(f"lms-pull-held:{key}")
        db.session.commit()
        return outcome
    except (Held, SQLAlchemyError, KeyError, ValueError, TypeError) as exc:
        db.session.rollback()
        reason = str(exc) if isinstance(exc, Held) else f"{type(exc).__name__}: {getattr(exc, 'orig', None) or exc}"
        _hold(key, entry, reason.strip()[:2000])
        db.session.commit()
        return "held"


def _hold(key: str, entry: dict, reason: str) -> None:
    hold = db.session.get(LmsPullHold, key)
    now = datetime.now(timezone.utc)
    if hold is None:
        hold = LmsPullHold(record_key=key, payload=entry, reason=reason, attempts=1, last_tried_at=now)
        db.session.add(hold)
    else:
        hold.payload, hold.reason, hold.attempts, hold.last_tried_at = entry, reason, hold.attempts + 1, now
    db.session.flush()
    if hold.attempts >= HOLD_TASK_AFTER:
        branch_id = db.session.execute(select(func.min(Branch.branch_id))).scalar_one()
        tasks.create_system_task(
            "GENERAL", f"LMS pull: {key} not applied", branch_id, now, team_role_code="SUPER_ADMIN",
            description=f"Held for {hold.attempts} pulls: {reason}", dedupe_key=f"lms-pull-held:{key}")
    logger.warning("LMS pull held %s: %s", key, reason)


# ---------------------------------------------------------------- the pull

def state() -> LmsPullState:
    return db.session.get(LmsPullState, 1, populate_existing=True)


def _claim() -> bool:
    claimed = db.session.execute(text(
        "UPDATE lms_pull_state SET locked_until = now() + make_interval(mins => :mins), last_attempt_at = now() "
        "WHERE pull_state_id = 1 AND (locked_until IS NULL OR locked_until < now()) RETURNING pull_state_id"
    ), {"mins": CLAIM_MINUTES}).first() is not None
    db.session.commit()
    return claimed


def pull() -> dict:
    """One pull: fetch everything changed since the watermark, apply it, retry held records, move the watermark."""
    if not lms_delivery.configured():
        return {"skipped": "LMS_BASE_URL / LMS_SERVICE_KEY not set"}
    if not _claim():
        return {"skipped": "another pull is running"}
    since = state().since
    db.session.commit()                                  # nothing held open while the LMS answers
    answer = lms_delivery.pull_status(since)
    current = state()
    data = (answer.body or {}).get("data") if answer.status == 200 else None
    if not isinstance(data, dict) or not data.get("as_of"):
        current.last_http_status = answer.status
        current.last_error = lms_delivery.error_text(answer) if answer.status != 200 else "No as_of in the answer"
        current.locked_until = None
        db.session.commit()
        logger.error("LMS status pull failed (%s): %s", answer.status, current.last_error)
        return {"error": current.last_error, "http": answer.status}

    counts: Counter = Counter()
    seen = set()
    for kind in KINDS:
        for entry in _entries(kind, data):
            key = record_key(kind, entry)
            seen.add(key)
            counts[f"{kind}_{_apply_one(kind, key, entry)}"] += 1
    for hold in db.session.execute(select(LmsPullHold).order_by(LmsPullHold.first_held_at)).scalars().all():
        if hold.record_key not in seen:                   # still waiting: try the held copy again
            key, payload = hold.record_key, hold.payload
            counts[f"retried_{_apply_one(key.split(':', 1)[0], key, payload)}"] += 1

    current = state()
    current.since = data["as_of"]                        # exactly as returned
    current.last_success_at = datetime.now(timezone.utc)
    current.last_http_status, current.last_error = 200, None
    current.last_counts = dict(counts)
    current.locked_until = None
    db.session.commit()
    return dict(counts) or {"unchanged": 0}


def reset_watermark() -> None:
    """The next pull asks for everything again (e.g. after dropping the CRM's own batches)."""
    current = state()
    current.since = FULL_PULL_SINCE
    db.session.flush()


def holds() -> list[LmsPullHold]:
    return list(db.session.execute(select(LmsPullHold).order_by(LmsPullHold.first_held_at)).scalars())


def drop_crm_batches() -> dict:
    """Q5 'drop and mirror': delete the CRM's own (not mirrored) batches and every allocation, then reset the watermark
    so the next pull brings the LMS's batches and allocations. Dev data only."""
    allocations = db.session.execute(delete(BatchAllocation)).rowcount
    batches = db.session.execute(delete(Batch).where(Batch.lms_mirrored.is_(False))).rowcount
    reset_watermark()
    return {"allocations_deleted": allocations, "batches_deleted": batches}
