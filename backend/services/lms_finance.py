"""BranchFinanceSnapshot for the Nipuna LMS dashboards (owner decision D4, db 029; LMS docs/CRM_INTEGRATION.md §3.13).

Job lms-finance-snapshot (cron runs the jobs every minute; a branch whose last snapshot is younger than 15 minutes is
skipped): one event per active branch in lms_outbox (record 'branch-finance:<id>'),
delivered by lms-sync like every other event. Each snapshot replaces the branch's previous one in the LMS, so a
snapshot still Pending when the next is written becomes Superseded and is never sent. The figures use the same rules
as the CRM dashboard:

| Figure                  | Source                                                                                      |
|-------------------------|---------------------------------------------------------------------------------------------|
| period                  | The Approved target version covering today; without one, the current calendar month         |
| targets                 | This branch's line in that version (null when there is none)                                |
| collections.verified    | Verified payments in the period by collecting branch, net of reversals                      |
| paid_admissions.count   | Admissions whose first verified payment falls in the period, by original branch             |
| overdue                 | installment_dues with due_position 'Overdue', by age band (collecting branch)               |
| verifications           | Payments in Pending Verification; overdue = their PAYMENT_VERIFICATION task is past due     |
| followups               | Open leads past their next follow-up; Broken promises on invoices with a balance            |

`period` is always the period the figures cover (LMS reply to the round 2 follow-up, A2); the LMS shows a target only
once the branch has one.
"""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import and_, delete, func, or_, select, update

from config.database import db
from models import (
    Branch, InstallmentDue, InvoiceBalance, LmsOutbox, Payment, PaymentPromise, Task, TaskType, TargetVersion,
    target_lines,
)
from repositories import reports as reports_repo
from services import lms_delivery, lms_sync
from services import reports as reports_service

EVENT_TYPE = "BranchFinanceSnapshot"
INTERVAL = timedelta(minutes=15)
SLACK = timedelta(seconds=30)       # cron start-time jitter: a run at minute 15 still counts as due
KEEP_DAYS = 7                       # delivered / superseded snapshots older than this are deleted
AGE_BANDS = ("1–3", "4–7", "8–15", "16–30", "31–60", "61–90", "91+")   # installment_dues.age_band (db 021)
ZERO = Decimal("0.00")


def _money(value) -> str:
    return f"{max(value or ZERO, ZERO):.2f}"   # the LMS takes money ≥ 0 (net collections can't go below)


def _period_label(start: date, end: date) -> str:
    if (start.year, start.month) == (end.year, end.month) and start.day == 1 and \
            (end + timedelta(days=1)).month != end.month:
        return f"{start:%b %Y}"
    return f"{start:%d %b %Y} – {end:%d %b %Y}"


def _target(branch_id: int, today: date):
    """(version, line) of the Approved target version covering today; line is None when the branch has none."""
    version = db.session.execute(select(TargetVersion).where(
        TargetVersion.status == "Approved", TargetVersion.period_start <= today,
        TargetVersion.period_end >= today)).scalar_one_or_none()
    if version is None:
        return None, None
    line = db.session.execute(select(target_lines).where(
        target_lines.c.target_version_id == version.target_version_id,
        target_lines.c.branch_id == branch_id)).first()
    return version, line


def snapshot_data(branch: Branch, now: datetime) -> dict:
    today = now.date()
    b = {branch.branch_id}
    version, line = _target(branch.branch_id, today)
    if version is not None:
        start, end = version.period_start, version.period_end
    else:
        start, end = reports_service.period_range("This Month")
    period = {"label": _period_label(start, end), "start": start.isoformat(), "end": end.isoformat()}
    collections_target, admissions_target = None, None
    if line is not None:
        collections_target, admissions_target = line.verified_collections_target, line.paid_admissions_target

    c = reports_repo.collections_by_branch(start, end, b).get(branch.branch_id, {})
    verified = c.get("gross_verified", ZERO) + c.get("reversals", ZERO)
    paid = reports_repo.paid_admissions_by_branch(start, end, b).get(branch.branch_id, 0)

    bands = dict((band, (amount, count)) for band, amount, count in db.session.execute(
        select(InstallmentDue.age_band, func.coalesce(func.sum(InstallmentDue.balance), 0), func.count())
        .where(InstallmentDue.due_position == "Overdue", InstallmentDue.collecting_branch_id == branch.branch_id)
        .group_by(InstallmentDue.age_band)).all())

    pending = and_(Payment.verification_status == "Pending Verification", Payment.amount > 0,
                   Payment.collecting_branch_id == branch.branch_id)
    pending_count, pending_amount, oldest_at = db.session.execute(select(
        func.count(), func.coalesce(func.sum(Payment.amount), 0), func.min(Payment.created_at)).where(pending)).one()
    verification_overdue = db.session.execute(
        select(func.count(func.distinct(Payment.payment_id)))
        .join(Task, Task.payment_id == Payment.payment_id)
        .join(TaskType, TaskType.task_type_id == Task.task_type_id)
        .where(pending, TaskType.code == "PAYMENT_VERIFICATION", Task.status.not_in(Task.CLOSED_STATUSES),
               func.coalesce(Task.revised_due_at, Task.original_due_at) < now)).scalar_one()

    follow_ups = reports_repo.overdue_follow_ups(b).get(branch.branch_id, 0)
    broken = db.session.execute(
        select(func.count()).select_from(PaymentPromise)
        .join(InvoiceBalance, InvoiceBalance.invoice_id == PaymentPromise.invoice_id)
        .where(PaymentPromise.status == "Broken", InvoiceBalance.collecting_branch_id == branch.branch_id,
               InvoiceBalance.status == "Issued", InvoiceBalance.outstanding > 0)).scalar_one()

    return {
        "branch_code": branch.branch_code,
        "as_of": now.isoformat(),
        "period": period,
        "collections": {"verified": _money(verified),
                        "target": _money(collections_target) if collections_target is not None else None},
        "paid_admissions": {"count": paid, "target": admissions_target},
        "overdue": {
            "amount": _money(sum((amount for amount, _ in bands.values()), ZERO)),
            "count": sum(count for _, count in bands.values()),
            "by_age_band": [{"band": f"{band} days", "amount": _money(bands[band][0]), "count": bands[band][1]}
                            for band in AGE_BANDS if band in bands],
        },
        "verifications": {"pending_count": pending_count, "pending_amount": _money(pending_amount),
                          "overdue_count": verification_overdue,
                          "oldest_at": oldest_at.astimezone(now.tzinfo).isoformat() if oldest_at else None},
        "followups": {"overdue_count": follow_ups, "broken_promises": broken},
    }


def send_snapshots(force: bool = False) -> dict:
    """Job lms-finance-snapshot: write one snapshot per active branch that is due (every INTERVAL, or now with force)
    to the outbox; lms-sync delivers it."""
    if not lms_delivery.configured():
        return {"skipped": "LMS_BASE_URL / LMS_SERVICE_KEY not set"}
    session = db.session
    now = datetime.now(lms_sync.business_tz())
    written = superseded = not_due = 0
    for branch in session.execute(select(Branch).where(Branch.is_active).order_by(Branch.branch_id)).scalars():
        key = f"branch-finance:{branch.branch_id}"
        last = session.execute(select(func.max(LmsOutbox.created_at)).where(LmsOutbox.record_key == key)).scalar()
        if not force and last is not None and now - last < INTERVAL - SLACK:
            not_due += 1
            continue
        superseded += session.execute(
            update(LmsOutbox).where(LmsOutbox.record_key == key, LmsOutbox.status == "Pending",
                                    or_(LmsOutbox.locked_until.is_(None), LmsOutbox.locked_until < func.now()))
            .values(status="Superseded", last_error="Replaced by a newer snapshot")).rowcount
        lms_sync.emit(session, EVENT_TYPE, key, key, snapshot_data(branch, now), now)
        written += 1
    pruned = session.execute(delete(LmsOutbox).where(
        LmsOutbox.event_type == EVENT_TYPE, LmsOutbox.status.in_(("Delivered", "Superseded")),
        LmsOutbox.created_at < datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS))).rowcount
    session.flush()
    return {"written": written, "not_due": not_due, "superseded": superseded, "pruned": pruned}
