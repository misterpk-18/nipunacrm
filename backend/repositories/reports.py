"""Aggregate queries behind reports and dashboards. Business dates are IST (business_tz()).

Attribution: collections by collecting branch and payment date; paid admissions by original branch and first
verified payment date; refunds by service branch and payout completion date.
"""
from datetime import date

from sqlalchemy import and_, func, or_, select

from config.database import db
from models import (
    Admission, Branch, CommunicationInbox, Demo, Enquiry, InstallmentDue, Lead, LeadActivity, Payment, RefundCase,
    TaskBoard, User,
)
from models.enums import LEAD_STAGES


def local_date(column):
    return func.date(func.timezone(func.business_tz(), column))


def _in(column, branch_ids: set[int] | None):
    return True if branch_ids is None else column.in_(branch_ids)


def branches(branch_ids: set[int] | None) -> list[Branch]:
    stmt = select(Branch).where(Branch.is_active).order_by(Branch.branch_id)
    if branch_ids is not None:
        stmt = stmt.where(Branch.branch_id.in_(branch_ids))
    return list(db.session.execute(stmt).scalars())


# ---------------------------------------------------------------- money

def collections_by_branch(start: date, end: date, branch_ids) -> dict[int, dict]:
    rows = db.session.execute(
        select(Payment.collecting_branch_id,
               func.coalesce(func.sum(Payment.amount).filter(Payment.entry_type == "Payment",
                                                             Payment.verification_status == "Verified"), 0),
               func.coalesce(func.sum(Payment.amount).filter(Payment.entry_type == "Reversal"), 0),
               func.coalesce(func.sum(Payment.amount).filter(Payment.verification_status == "Pending Verification",
                                                             Payment.amount > 0), 0))
        .where(Payment.payment_date.between(start, end), _in(Payment.collecting_branch_id, branch_ids))
        .group_by(Payment.collecting_branch_id)
    ).all()
    return {b: {"gross_verified": g, "reversals": r, "pending_verification": p} for b, g, r, p in rows}


def dues_recovery_by_branch(start: date, end: date, branch_ids) -> dict[int, object]:
    """Verified collections in the period on admissions whose first paid date was before the period."""
    rows = db.session.execute(
        select(Payment.collecting_branch_id, func.coalesce(func.sum(Payment.amount), 0))
        .join(Admission, Admission.admission_id == Payment.admission_id)
        .where(Payment.entry_type == "Payment", Payment.verification_status == "Verified",
               Payment.payment_date.between(start, end), local_date(Admission.first_verified_payment_at) < start,
               _in(Payment.collecting_branch_id, branch_ids))
        .group_by(Payment.collecting_branch_id)
    ).all()
    return dict(rows)


def refunds_by_branch(start: date, end: date, branch_ids) -> dict[int, object]:
    rows = db.session.execute(
        select(Admission.service_branch_id, func.coalesce(func.sum(RefundCase.payout_amount), 0))
        .join(Admission, Admission.admission_id == RefundCase.admission_id)
        .where(RefundCase.payout_status == "Completed", local_date(RefundCase.payout_completed_at).between(start, end),
               _in(Admission.service_branch_id, branch_ids))
        .group_by(Admission.service_branch_id)
    ).all()
    return dict(rows)


def paid_admissions_by_branch(start: date, end: date, branch_ids, course_id=None) -> dict[int, int]:
    stmt = (select(Admission.original_branch_id, func.count())
            .where(local_date(Admission.first_verified_payment_at).between(start, end),
                   _in(Admission.original_branch_id, branch_ids))
            .group_by(Admission.original_branch_id))
    if course_id:
        stmt = stmt.where(Admission.course_id == course_id)
    return dict(db.session.execute(stmt).all())


def overdue_dues(branch_ids) -> dict[int, object]:
    rows = db.session.execute(
        select(InstallmentDue.collecting_branch_id, func.coalesce(func.sum(InstallmentDue.balance), 0))
        .where(InstallmentDue.due_position == "Overdue", _in(InstallmentDue.collecting_branch_id, branch_ids))
        .group_by(InstallmentDue.collecting_branch_id)
    ).all()
    return dict(rows)


# ---------------------------------------------------------------- funnel / performance

def _lead_filters(stmt, filters: dict, branch_ids):
    stmt = stmt.where(_in(Lead.branch_id, branch_ids))
    for field, column in (("branch_id", Lead.branch_id), ("course_id", Lead.course_id),
                          ("source_id", Lead.original_source_id), ("staff_id", Lead.assigned_to)):
        if filters.get(field):
            stmt = stmt.where(column == filters[field])
    return stmt


def funnel(start: date, end: date, filters: dict, branch_ids) -> dict:
    """Leads created in the period, counted cumulatively: a lead counts for every stage up to the furthest one it
    has reached (now or at any point). Lost is counted on its own."""
    lead_ids = _lead_filters(select(Lead.lead_id).where(local_date(Lead.created_at).between(start, end)),
                             filters, branch_ids).subquery()
    reached = db.session.execute(
        select(Lead.lead_id, Lead.stage).where(Lead.lead_id.in_(select(lead_ids.c.lead_id)))
        .union(select(LeadActivity.lead_id, LeadActivity.to_stage)
               .where(LeadActivity.lead_id.in_(select(lead_ids.c.lead_id)), LeadActivity.to_stage.is_not(None)))
    ).all()
    progress = [s for s in LEAD_STAGES if s != "Lost - closed"]
    furthest: dict[int, int] = {}
    lost: set[int] = set()
    for lead_id, stage in reached:
        if stage == "Lost - closed":
            lost.add(lead_id)
        else:
            furthest[lead_id] = max(furthest.get(lead_id, 0), progress.index(stage))
    counts = {stage: sum(1 for f in furthest.values() if f >= i) for i, stage in enumerate(progress)}
    counts["Lost - closed"] = len(lost)
    return {"total": len(furthest), "counts": counts}


def performance(by: str, start: date, end: date, filters: dict, branch_ids) -> list[dict]:
    """Enquiries, leads, paid admissions and conversion grouped by course, source or staff."""
    lead_key = {"course": Lead.course_id, "source": Lead.original_source_id, "staff": Lead.assigned_to}[by]
    enquiry_key = {"course": Enquiry.course_id, "source": Enquiry.lead_source_id, "staff": Enquiry.owner_user_id}[by]

    enquiry_stmt = (select(enquiry_key, func.count()).where(local_date(Enquiry.received_at).between(start, end),
                                                            _in(Enquiry.branch_id, branch_ids)).group_by(enquiry_key))
    if filters.get("branch_id"):
        enquiry_stmt = enquiry_stmt.where(Enquiry.branch_id == filters["branch_id"])
    lead_stmt = _lead_filters(select(lead_key, func.count()).where(local_date(Lead.created_at).between(start, end)),
                              filters, branch_ids).group_by(lead_key)
    admission_stmt = _lead_filters(
        select(lead_key, func.count()).join(Admission, Admission.lead_id == Lead.lead_id)
        .where(local_date(Admission.first_verified_payment_at).between(start, end)), filters, branch_ids
    ).group_by(lead_key)

    enquiries = dict(db.session.execute(enquiry_stmt).all())
    leads = dict(db.session.execute(lead_stmt).all())
    admissions = dict(db.session.execute(admission_stmt).all())
    keys = [k for k in dict.fromkeys([*enquiries, *leads, *admissions])]
    return [{"key": k, "enquiries": enquiries.get(k, 0), "leads": leads.get(k, 0), "paid_admissions": admissions.get(k, 0),
             "conversion_pct": round(100 * admissions.get(k, 0) / leads[k], 1) if leads.get(k) else None} for k in keys]


# ---------------------------------------------------------------- SLA

def task_sla(start: date, end: date, branch_ids, branch_id=None) -> list[dict]:
    from models import Task

    on_time = and_(TaskBoard.status == "Completed", Task.completed_at <= TaskBoard.due_at)
    stmt = (select(TaskBoard.owner_user_id, func.count(),
                   func.count().filter(on_time),
                   func.count().filter(TaskBoard.status == "Completed", ~on_time),
                   func.count().filter(TaskBoard.is_overdue),
                   func.count().filter(TaskBoard.status.not_in(("Completed", "Cancelled")), ~TaskBoard.is_overdue))
            .join(Task, Task.task_id == TaskBoard.task_id)
            .where(local_date(TaskBoard.due_at).between(start, end), TaskBoard.status != "Cancelled",
                   _in(TaskBoard.branch_id, branch_ids))
            .group_by(TaskBoard.owner_user_id))
    if branch_id:
        stmt = stmt.where(TaskBoard.branch_id == branch_id)
    rows = db.session.execute(stmt).all()
    names = dict(db.session.execute(select(User.user_id, User.full_name).where(
        User.user_id.in_([r[0] for r in rows if r[0]]))).all())
    return [{"owner_user_id": o, "owner": names.get(o, "Unassigned"), "tasks": t, "completed_on_time": ok,
             "completed_late": late, "overdue_open": overdue, "open": open_,
             "completion_pct": round(100 * (ok + late) / t, 1) if t else None} for o, t, ok, late, overdue, open_ in rows]


def response_sla(start: date, end: date, branch_ids, branch_id=None) -> dict[str, int]:
    stmt = (select(CommunicationInbox.sla_state, func.count())
            .where(CommunicationInbox.needs_response, local_date(CommunicationInbox.occurred_at).between(start, end),
                   _in(CommunicationInbox.branch_id, branch_ids))
            .group_by(CommunicationInbox.sla_state))
    if branch_id:
        stmt = stmt.where(CommunicationInbox.branch_id == branch_id)
    found = dict(db.session.execute(stmt).all())
    return {state: found.get(state, 0) for state in ("Within SLA", "At Risk", "Breached", "Met", "Met Late")}


# ---------------------------------------------------------------- dashboard tiles

def genuine_enquiries(start: date, end: date, branch_ids) -> dict[int, int]:
    genuine = or_(Enquiry.is_genuine.is_(True),
                  and_(Enquiry.is_genuine.is_(None), Enquiry.intake_status.not_in(("Invalid-Spam", "Test"))))
    return dict(db.session.execute(
        select(Enquiry.branch_id, func.count()).where(local_date(Enquiry.received_at).between(start, end), genuine,
                                                     _in(Enquiry.branch_id, branch_ids)).group_by(Enquiry.branch_id)
    ).all())


def overdue_follow_ups(branch_ids) -> dict[int, int]:
    return dict(db.session.execute(
        select(Lead.branch_id, func.count()).where(Lead.stage.not_in(("Admitted", "Lost - closed")),
                                                  Lead.next_follow_up_at < func.now(), _in(Lead.branch_id, branch_ids))
        .group_by(Lead.branch_id)).all())


def sla_at_risk(branch_ids) -> dict[int, int]:
    return dict(db.session.execute(
        select(CommunicationInbox.branch_id, func.count())
        .where(CommunicationInbox.sla_state.in_(("At Risk", "Breached")), _in(CommunicationInbox.branch_id, branch_ids))
        .group_by(CommunicationInbox.branch_id)).all())


def demo_counts(start: date, end: date, branch_ids) -> dict[int, dict]:
    rows = db.session.execute(
        select(Demo.branch_id,
               func.count().filter(Demo.status.in_(("Scheduled", "Confirmed", "Attended", "No Show"))),
               func.count().filter(Demo.status == "Attended"), func.count().filter(Demo.status == "No Show"))
        .where(local_date(Demo.scheduled_at).between(start, end), _in(Demo.branch_id, branch_ids))
        .group_by(Demo.branch_id)).all()
    return {b: {"scheduled": s, "attended": a, "no_show": n} for b, s, a, n in rows}


def top_staff(start: date, end: date, branch_ids, limit: int = 5) -> list[dict]:
    rows = db.session.execute(
        select(User.user_id, User.full_name, func.count(Admission.admission_id).label("paid"))
        .join(Admission, Admission.counsellor_id == User.user_id)
        .where(local_date(Admission.first_verified_payment_at).between(start, end),
               _in(Admission.original_branch_id, branch_ids))
        .group_by(User.user_id, User.full_name).order_by(func.count(Admission.admission_id).desc()).limit(limit)
    ).all()
    return [{"user_id": u, "full_name": n, "paid_admissions": p} for u, n, p in rows]

