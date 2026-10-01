"""Events for the Nipuna LMS (LMS docs/CRM_INTEGRATION.md §2.1), written to lms_outbox in the same transaction as the
change (db 026). The CRM owns admissions and money; the LMS keeps a read-only projection built from these events.

Services only say what changed — branch_changed(), course_changed(), admission_qualified(), admission_updated(),
admission_cancelled(), finance_changed(), person_changed(). The marks collect on the session, and just before the
transaction commits one event per record is built from the final state and written with the next source_version of
that record. A rolled-back transaction writes nothing; several changes in one request (verify → two admissions → their
balances) give one event each, in the order branches → courses → admissions → finance.

Delivery to the LMS is services/lms_delivery.py; the branch finance snapshot job is services/lms_finance.py.
"""
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import event, select, text
from sqlalchemy.orm import Session

from models import Admission, AdmissionBalance, Branch, Course, InstallmentDue, LmsOutbox, Payment, PaymentAllocation
from repositories import settings as settings_repo

PENDING_KEY = "lms_pending"

EVENT_TYPES = ("CourseUpserted", "AdmissionQualified", "AdmissionUpdated", "AdmissionCancelled", "FinanceSummaryUpdated",
               "BranchUpserted", "BranchFinanceSnapshot")
PERSON_FIELDS = ("full_name", "phone", "email", "preferred_language")  # what the LMS keeps about the student
BRANCH_FIELDS = ("branch_name", "city", "receipt_prefix", "email", "is_active")  # what the LMS keeps about a branch


def business_tz() -> ZoneInfo:
    return ZoneInfo(settings_repo.get("business_timezone", "Asia/Kolkata"))


# ---------------------------------------------------------------- marks (called by the services)

def _pending(session=None) -> dict:
    from config.database import db

    info = (session or db.session).info
    if PENDING_KEY not in info:
        info[PENDING_KEY] = {"branches": set(), "courses": set(), "qualified": set(), "updated": {}, "cancelled": {},
                             "finance": set(), "finance_invoices": set(), "persons": set()}
    return info[PENDING_KEY]


def branch_changed(branch_id: int, changed_fields) -> None:
    """Branch details edited: name, city or email (the LMS keeps them; address, phone and invoice details it ignores)."""
    if set(changed_fields) & set(BRANCH_FIELDS):
        _pending()["branches"].add(branch_id)


def course_changed(course_id: int) -> None:
    """Course Master create / update, combo components set."""
    _pending()["courses"].add(course_id)


def admission_qualified(admission_id: int) -> None:
    """A new admission — or a full refresh of one already sent (planned start, person details)."""
    _pending()["qualified"].add(admission_id)


def admission_updated(admission_id: int, *fields: str) -> None:
    """Service branch transfer ('service_branch_code'), delivery mode change ('delivery_mode') or pause / resume
    ('status')."""
    _pending()["updated"].setdefault(admission_id, set()).update(fields)


def admission_cancelled(admission_id: int, reason: str | None) -> None:
    _pending()["cancelled"][admission_id] = reason


def finance_changed(*, admission_id: int | None = None, invoice_id: int | None = None) -> None:
    """Money changed for one admission, or for every admission on an invoice (payments and instalments are per
    invoice, so all its courses change together)."""
    pending = _pending()
    if admission_id is not None:
        pending["finance"].add(admission_id)
    if invoice_id is not None:
        pending["finance_invoices"].add(invoice_id)


def person_changed(person_id: int, changed_fields) -> None:
    """Name / phone / email / language edited: the person's admissions are sent again as a full refresh."""
    if set(changed_fields) & set(PERSON_FIELDS):
        _pending()["persons"].add(person_id)


# ---------------------------------------------------------------- payloads (the CRM's own names and values)

def _money(value) -> str:
    return f"{value or 0:.2f}"


def _iso(value):
    return value.isoformat() if value is not None else None


def branch_data(branch: Branch) -> dict:
    # The LMS maps receipt_prefix → its short code (inside batch codes) and email → the branch's shared mailbox
    return {"branch_code": branch.branch_code, "branch_name": branch.branch_name, "city": branch.city,
            "receipt_prefix": branch.receipt_prefix, "email": branch.email, "is_active": branch.is_active}


def course_data(course: Course) -> dict:
    data = {"course_code": course.course_code, "course_title": course.course_title, "category": course.category,
            "is_combo": course.is_combo, "status": course.status}
    if course.is_combo:
        data["components"] = [{"component_course_code": link.component.course_code, "is_bonus": link.is_bonus,
                               "sort_order": link.sort_order} for link in course.component_links]
    return data


def _collecting_branch_code(session, admission: Admission) -> str:
    """The branch that collected the qualifying payment: the invoice's; a complimentary admission uses its paid one's."""
    if admission.invoice is not None:
        return admission.invoice.collecting_branch.branch_code
    if admission.complimentary_of_admission_id:
        parent = session.get(Admission, admission.complimentary_of_admission_id)
        if parent is not None and parent.invoice is not None:
            return parent.invoice.collecting_branch.branch_code
    return admission.original_branch.branch_code


def admission_data(session, admission: Admission) -> dict:
    person = admission.person
    return {
        "person": {"crm_person_id": person.person_id, "person_code": person.person_code,
                   "full_name": person.full_name, "phone": person.phone, "email": person.email,
                   "preferred_language": person.preferred_language},
        "admission": {
            "crm_admission_id": admission.admission_id, "admission_code": admission.admission_code,
            "course_code": admission.course.course_code,
            "original_branch_code": admission.original_branch.branch_code,
            "service_branch_code": admission.service_branch.branch_code,
            "collecting_branch_code": _collecting_branch_code(session, admission),
            "delivery_mode": admission.delivery_mode, "seat_type": admission.seat_type,
            "planned_start_date": _iso(admission.planned_start_date), "admission_date": _iso(admission.admission_date),
            "complimentary_of_crm_admission_id": admission.complimentary_of_admission_id,
            "access_until": _iso(admission.access_until),
        },
    }


def updated_data(admission: Admission, fields: set[str]) -> dict:
    data = {"crm_admission_id": admission.admission_id}
    if "service_branch_code" in fields:
        data["service_branch_code"] = admission.service_branch.branch_code
    if "delivery_mode" in fields:
        data["delivery_mode"] = admission.delivery_mode
    if "status" in fields:
        data["status"] = "Paused" if admission.enrolment_status == "Paused" else "Active"
    return data


def _receipts(session, admission: Admission) -> list[dict]:
    """Verified, not reversed payments on this admission's course line (the part allocated to it)."""
    if admission.invoice_line_id is None:
        return []
    rows = session.execute(
        select(Payment, PaymentAllocation.amount)
        .join(PaymentAllocation, PaymentAllocation.payment_id == Payment.payment_id)
        .where(PaymentAllocation.invoice_line_id == admission.invoice_line_id, Payment.entry_type == "Payment",
               Payment.verification_status == "Verified")
        .order_by(Payment.payment_date, Payment.payment_id)
    ).all()
    return [{"receipt_number": payment.receipt_number, "date": _iso(payment.payment_date), "amount": _money(amount)}
            for payment, amount in rows if payment.receipt_number and not payment.is_reversed and amount > 0]


def finance_data(session, admission: Admission, now: datetime) -> dict:
    balance = session.get(AdmissionBalance, admission.admission_id, populate_existing=True)
    installments = []
    if admission.invoice_id is not None:
        installments = session.execute(
            select(InstallmentDue).where(InstallmentDue.invoice_id == admission.invoice_id,
                                         InstallmentDue.due_position != "Cancelled")
            .order_by(InstallmentDue.installment_no)
        ).scalars().all()
    next_due = next((i for i in installments if i.balance > 0), None)
    return {
        "crm_admission_id": admission.admission_id,
        "fee_total": _money(balance.final_fee), "verified_paid": _money(balance.verified_paid),
        "pending_verification": _money(balance.pending_verification), "waived": _money(balance.waived),
        "refunded": _money(balance.refunded), "balance": _money(balance.outstanding),
        "payment_completion": balance.payment_completion,
        "invoice_numbers": [admission.invoice.invoice_number] if admission.invoice is not None else [],
        # Instalments belong to the invoice: on a multi-course invoice every admission carries the same schedule
        "installments": [{"installment_no": i.installment_no, "due_date": _iso(i.due_date), "amount": _money(i.amount_due),
                          "covered": _money(i.amount_covered), "balance": _money(i.balance),
                          "due_position": i.due_position} for i in installments],
        "installments_scope": "invoice",
        "invoice_course_count": len(admission.invoice.lines) if admission.invoice is not None else 0,
        "next_due_date": _iso(next_due.due_date) if next_due else None,
        "next_due_amount": _money(next_due.balance) if next_due else None,
        "receipts": _receipts(session, admission),
        "as_of": now.isoformat(),
    }


# ---------------------------------------------------------------- writing rows

def next_version(session, version_key: str) -> int:
    return session.execute(text(
        "INSERT INTO lms_sync_versions (version_key, version) VALUES (:key, 1) "
        "ON CONFLICT (version_key) DO UPDATE SET version = lms_sync_versions.version + 1 RETURNING version"
    ), {"key": version_key}).scalar_one()


def emit(session, event_type: str, record_key: str, version_key: str, data: dict, now: datetime) -> LmsOutbox:
    row = LmsOutbox(event_id=uuid.uuid4(), event_type=event_type, record_key=record_key,
                    source_version=next_version(session, version_key), occurred_at=now, payload=data)
    session.add(row)
    return row


def emit_branch(session, branch: Branch, now: datetime) -> LmsOutbox:
    key = f"branch:{branch.branch_id}"
    return emit(session, "BranchUpserted", key, key, branch_data(branch), now)


def emit_course(session, course: Course, now: datetime) -> LmsOutbox:
    key = f"course:{course.course_id}"
    return emit(session, "CourseUpserted", key, key, course_data(course), now)


def emit_admission(session, event_type: str, admission: Admission, data: dict, now: datetime) -> LmsOutbox:
    # Admission and finance events share one delivery queue per admission (qualified before its balance),
    # but each has its own source_version, as the LMS versions the admission and its finance summary separately
    key = f"admission:{admission.admission_id}"
    version_key = f"finance:{admission.admission_id}" if event_type == "FinanceSummaryUpdated" else key
    return emit(session, event_type, key, version_key, data, now)


def write_pending(session) -> int:
    """Build and write the marked events from the current state. Returns how many were written."""
    pending = session.info.pop(PENDING_KEY, None)
    if not pending or not any(pending.values()):
        return 0
    now = datetime.now(business_tz())
    written = 0

    for branch_id in sorted(pending["branches"]):
        branch = session.get(Branch, branch_id)
        if branch is not None:
            emit_branch(session, branch, now)
            written += 1

    for course_id in sorted(pending["courses"], key=lambda cid: _combo_last(session, cid)):
        course = session.get(Course, course_id)
        if course is not None:
            emit_course(session, course, now)
            written += 1

    qualified = set(pending["qualified"])
    if pending["persons"]:
        qualified |= set(session.execute(select(Admission.admission_id).where(
            Admission.person_id.in_(pending["persons"]), Admission.enrolment_status != "Cancelled")).scalars())
    finance = set(pending["finance"])
    if pending["finance_invoices"]:
        finance |= set(session.execute(select(Admission.admission_id).where(
            Admission.invoice_id.in_(pending["finance_invoices"]))).scalars())

    def admissions(ids):
        rows = [session.get(Admission, admission_id, populate_existing=True) for admission_id in sorted(ids)]
        # A paid admission before its complimentary one
        return sorted((a for a in rows if a is not None), key=lambda a: (a.complimentary_of_admission_id is not None,
                                                                         a.admission_id))

    for admission in admissions(qualified):
        if admission.enrolment_status == "Cancelled" and admission.admission_id not in pending["cancelled"]:
            continue  # a refresh of an admission the LMS already withdrew
        emit_admission(session, "AdmissionQualified", admission, admission_data(session, admission), now)
        written += 1
    for admission in admissions(set(pending["updated"]) - qualified):
        if admission.enrolment_status != "Cancelled":
            emit_admission(session, "AdmissionUpdated", admission,
                           updated_data(admission, pending["updated"][admission.admission_id]), now)
            written += 1
    for admission in admissions(pending["cancelled"]):
        emit_admission(session, "AdmissionCancelled", admission,
                       {"crm_admission_id": admission.admission_id, "reason": pending["cancelled"][admission.admission_id]},
                       now)
        written += 1
    for admission in admissions(finance):
        emit_admission(session, "FinanceSummaryUpdated", admission, finance_data(session, admission, now), now)
        written += 1
    return written


def _combo_last(session, course_id: int) -> tuple:
    course = session.get(Course, course_id)
    return (bool(course and course.is_combo), course_id)


# ---------------------------------------------------------------- session hooks

@event.listens_for(Session, "before_commit")
def _before_commit(session) -> None:
    if session.in_nested_transaction() or not session.info.get(PENDING_KEY):
        return
    write_pending(session)


@event.listens_for(Session, "after_soft_rollback")
def _after_rollback(session, previous_transaction) -> None:
    if previous_transaction.parent is None:  # the whole transaction was rolled back: its changes never happened
        session.info.pop(PENDING_KEY, None)


# ---------------------------------------------------------------- backfill

def _already_sent(session, record_key: str, event_type: str) -> bool:
    return session.execute(select(LmsOutbox.outbox_id).where(
        LmsOutbox.record_key == record_key, LmsOutbox.event_type == event_type,
        LmsOutbox.status.in_(("Pending", "Delivered"))).limit(1)).first() is not None


def backfill(*, include_cancelled: bool = False, force: bool = False, course_ids=None, admission_ids=None,
             branches_only: bool = False) -> dict:
    """Events for what already exists: BranchUpserted for every branch, CourseUpserted for every course (components
    before combos), then per admission AdmissionQualified + FinanceSummaryUpdated (+ AdmissionCancelled for cancelled
    ones when included). Commits after each record, and skips a record whose event is already Pending / Delivered
    (unless force), so a re-run resumes — and a branch added later (there is no create screen) is sent by a re-run."""
    from config.database import db

    session = db.session
    counts = {"BranchUpserted": 0, "CourseUpserted": 0, "AdmissionQualified": 0, "AdmissionCancelled": 0, "FinanceSummaryUpdated": 0,
              "skipped": 0}

    def send(event_type, record_key, build):
        if not force and _already_sent(session, record_key, event_type):
            counts["skipped"] += 1
            return
        build(datetime.now(business_tz()))
        counts[event_type] += 1

    if (course_ids is None and admission_ids is None) or branches_only:
        for branch in session.execute(select(Branch).order_by(Branch.branch_id)).scalars().all():
            send("BranchUpserted", f"branch:{branch.branch_id}", lambda now, b=branch: emit_branch(session, b, now))
            session.commit()
        if branches_only:
            return counts

    if admission_ids is None or course_ids is not None:
        stmt = select(Course).order_by(Course.is_combo, Course.course_id)
        if course_ids:
            stmt = stmt.where(Course.course_id.in_(course_ids))
        for course in session.execute(stmt).scalars().all():
            send("CourseUpserted", f"course:{course.course_id}", lambda now, c=course: emit_course(session, c, now))
            session.commit()

    if course_ids is None or admission_ids is not None:
        stmt = select(Admission).order_by(Admission.complimentary_of_admission_id.is_not(None), Admission.admission_id)
        if admission_ids:
            stmt = stmt.where(Admission.admission_id.in_(admission_ids))
        elif not include_cancelled:
            stmt = stmt.where(Admission.enrolment_status != "Cancelled")
        for admission in session.execute(stmt).scalars().all():
            key = f"admission:{admission.admission_id}"
            send("AdmissionQualified", key, lambda now, a=admission: emit_admission(
                session, "AdmissionQualified", a, admission_data(session, a), now))
            if admission.enrolment_status == "Cancelled":
                send("AdmissionCancelled", key, lambda now, a=admission: emit_admission(
                    session, "AdmissionCancelled", a,
                    {"crm_admission_id": a.admission_id, "reason": a.cancellation_reason}, now))
            send("FinanceSummaryUpdated", key, lambda now, a=admission: emit_admission(
                session, "FinanceSummaryUpdated", a, finance_data(session, a, now), now))
            session.commit()
    return counts
