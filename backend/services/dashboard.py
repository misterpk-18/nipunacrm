"""Role-aware dashboards. Founder / Admin: company totals + branch comparison. Branch Manager: KPI tiles,
funnel, approval queues, targets, top staff. Counsellor workspace summary."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import and_, func, or_, select

from config.database import db
from models import (
    Admission, AdmissionFeeChange, Demo, InvoiceBalance, Lead, Payment, PaymentCorrectionRequest, PipelineEntry,
    RefundCase, SpecialClosingRequest, TaskBoard,
)
from models.enums import CLOSED_STAGES
from repositories import fees as fees_repo
from repositories import leads as leads_repo
from repositories import reports as reports_repo
from repositories import users as users_repo
from services import fees as fees_service
from services import reports as reports_service
from services.context import COUNSELLOR_ROLES, current_user

ZERO = Decimal("0.00")


def _kpis(branch_ids: set[int] | None, start, end) -> dict[int, dict]:
    collections = reports_repo.collections_by_branch(start, end, branch_ids)
    paid = reports_repo.paid_admissions_by_branch(start, end, branch_ids)
    enquiries = reports_repo.genuine_enquiries(start, end, branch_ids)
    overdue = reports_repo.overdue_follow_ups(branch_ids)
    at_risk = reports_repo.sla_at_risk(branch_ids)
    demos = reports_repo.demo_counts(start, end, branch_ids)
    dues = reports_repo.overdue_dues(branch_ids)
    gaps = reports_repo.long_gap_plans(branch_ids)
    result = {}
    for branch in reports_repo.branches(branch_ids):
        b = branch.branch_id
        c = collections.get(b, {})
        counsellors = users_repo.user_ids_with_any_role(COUNSELLOR_ROLES, b)
        unassigned = db.session.execute(select(func.count()).where(
            Lead.branch_id == b, Lead.assigned_to.is_(None), Lead.stage.not_in(("Admitted", "Lost - closed")))).scalar_one()
        result[b] = {
            "branch": branch.to_summary(),
            "genuine_enquiries": enquiries.get(b, 0),
            "sla_at_risk": at_risk.get(b, 0),
            "overdue_follow_ups": overdue.get(b, 0),
            "demos": demos.get(b, {"scheduled": 0, "attended": 0, "no_show": 0}),
            "paid_admissions": paid.get(b, 0),
            "verified_collections": c.get("gross_verified", ZERO) + c.get("reversals", ZERO),
            "pending_verification_excluded": c.get("pending_verification", ZERO),
            "overdue_dues": dues.get(b, ZERO),
            "long_gap_plans": gaps.get(b, {"count": 0, "outstanding": ZERO}),
            "staff_coverage": {"active_counsellors": len(counsellors), "unassigned_open_leads": unassigned},
        }
    return result


def _sum(tiles: list[dict]) -> dict:
    total = {"genuine_enquiries": 0, "sla_at_risk": 0, "overdue_follow_ups": 0, "paid_admissions": 0,
             "verified_collections": ZERO, "pending_verification_excluded": ZERO, "overdue_dues": ZERO,
             "demos": {"scheduled": 0, "attended": 0, "no_show": 0},
             "long_gap_plans": {"count": 0, "outstanding": ZERO}}
    for tile in tiles:
        for key in total:
            if key in ("demos", "long_gap_plans"):
                for k in total[key]:
                    total[key][k] += tile[key][k]
            else:
                total[key] += tile[key]
    return total


def approval_queues(branch_ids: set[int] | None) -> dict:
    user = current_user()
    pending = list(db.session.execute(fees_repo.scr_stmt({"status": "Pending"}, branch_ids)).scalars())
    can = [s for s in pending if fees_service._can_decide(s, user.user_id)]
    def scoped(stmt, branch_column):
        return stmt if branch_ids is None else stmt.where(branch_column.in_(branch_ids))

    fee_changes = db.session.execute(scoped(
        select(func.count()).select_from(AdmissionFeeChange).join(Admission).where(AdmissionFeeChange.status == "Approved"),
        Admission.service_branch_id)).scalar_one()
    payouts = db.session.execute(scoped(
        select(func.count()).select_from(RefundCase).join(Admission).where(
            RefundCase.payout_status.in_(("Approved", "Processing")), RefundCase.status != "Withdrawn"),
        Admission.service_branch_id)).scalar_one()
    corrections = db.session.execute(scoped(
        select(func.count()).select_from(PaymentCorrectionRequest)
        .join(Payment, Payment.payment_id == PaymentCorrectionRequest.payment_id)
        .where(PaymentCorrectionRequest.status == "Pending Approval"), Payment.collecting_branch_id)).scalar_one()
    return {"can_approve": len(can), "higher_approval": len(pending) - len(can),
            "awaiting_execution": {"fee_changes_to_apply": fee_changes, "refund_payouts": payouts,
                                   "corrections_pending": corrections}}


def dashboard(filters: dict) -> dict:
    user = current_user()
    start, end = reports_service.period_range(filters.get("period", "This Month"), filters.get("from"), filters.get("to"))
    branch_ids = reports_service._scope(filters)
    tiles = _kpis(branch_ids, start, end)
    period = {"period": filters.get("period", "This Month"), "from": start, "to": end}
    today = reports_service.business_now().date()
    targets = [t.to_dict() for t in reports_service.achievement(today, filters.get("branch_id"))]

    if user.is_admin:
        return {"view": "company", **period, "company": _sum(list(tiles.values())), "branches": list(tiles.values()),
                "targets": targets, "approval_queues": approval_queues(branch_ids)}
    if user.has_role("BRANCH_MANAGER"):
        return {"view": "branch_manager", **period, "tiles": _sum(list(tiles.values())), "branches": list(tiles.values()),
                "funnel": reports_service.funnel(start, end, filters), "approval_queues": approval_queues(branch_ids),
                "targets": targets, "top_staff": reports_repo.top_staff(start, end, branch_ids)}
    return {"view": "staff", **period, "tiles": _sum(list(tiles.values()))}


def counsellor() -> dict:
    user = current_user()
    now = datetime.now(timezone.utc)
    today = reports_service.business_now().date()
    my_leads = select(Lead.lead_id).where(Lead.assigned_to == user.user_id)
    demos = list(db.session.execute(
        select(Demo).where(Demo.lead_id.in_(my_leads), reports_repo.local_date(Demo.scheduled_at) == today,
                           Demo.status.in_(Demo.OPEN_STATUSES)).order_by(Demo.scheduled_at)).scalars())
    tasks = db.session.execute(select(
        func.count().filter(TaskBoard.is_due_today), func.count().filter(TaskBoard.is_overdue))
        .where(TaskBoard.owner_user_id == user.user_id, TaskBoard.status.not_in(("Completed", "Cancelled")))).one()
    pending = db.session.execute(select(func.count(), func.coalesce(func.sum(Payment.amount), 0)).where(
        Payment.collected_by == user.user_id, Payment.verification_status == "Pending Verification")).one()
    my_scrs = db.session.execute(select(func.count()).select_from(SpecialClosingRequest).where(
        SpecialClosingRequest.requested_by == user.user_id, SpecialClosingRequest.status == "Pending")).scalar_one()
    return {"as_of": now, "queues": leads_repo.queue_counts(user.user_id), "demos_today": demos,
            "tasks": {"due_today": tasks[0], "overdue": tasks[1]},
            "payments_pending_verification": {"count": pending[0], "amount": pending[1]},
            "special_closing_pending": my_scrs}


# ---------------------------------------------------------------- V4 overview

# Admission pipeline bars: V4 label → the pipeline-card stages it counts.
PIPELINE_BARS = (
    ("Counselling", ("Counselling",)),
    ("Demo", ("Demo Scheduled", "Demo Attended")),
    ("Fee discussion", ("Fee Discussion / Payment Awaited",)),
    ("Verification", ("Payment Pending Verification",)),
    ("Admitted", ("Admitted",)),
)
NOT_ENQUIRIES = ("Invalid-Spam", "Test")


def overview(filters: dict) -> dict:
    """Overview dashboard (V4): four KPI cards, verified collections per day for the last 7 days, admission
    pipeline bars, attention counts and branch pulse. Read-only; branch-scoped like GET /dashboard.

    Period figures (admissions, verified collections, branch pulse) use the period; the rest are current positions.
    """
    start, end = reports_service.period_range(filters.get("period", "This Month"), filters.get("from"), filters.get("to"))
    branch_ids = reports_service._scope(filters)
    today = reports_service.business_now().date()
    week_start = today - timedelta(days=6)

    def scoped(column):
        return True if branch_ids is None else column.in_(branch_ids)

    open_lead = and_(Lead.stage.not_in(CLOSED_STAGES), Lead.intake_status.not_in(NOT_ENQUIRIES), scoped(Lead.branch_id))
    open_enquiries, new_enquiries, follow_ups_due = db.session.execute(select(
        func.count(), func.count().filter(Lead.stage == "New Enquiry"),
        func.count().filter(reports_repo.local_date(Lead.next_follow_up_at) <= today),
    ).where(open_lead)).one()

    collections = reports_repo.collections_by_branch(start, end, branch_ids)
    paid = reports_repo.paid_admissions_by_branch(start, end, branch_ids)
    verified_payments = db.session.execute(select(func.count()).where(
        Payment.entry_type == "Payment", Payment.verification_status == "Verified",
        Payment.payment_date.between(start, end), scoped(Payment.collecting_branch_id))).scalar_one()
    pending_count, pending_amount = db.session.execute(select(func.count(), func.coalesce(func.sum(Payment.amount), 0)).where(
        Payment.verification_status == "Pending Verification", Payment.amount > 0,
        scoped(Payment.collecting_branch_id))).one()
    outstanding = db.session.execute(select(func.coalesce(func.sum(InvoiceBalance.outstanding), 0)).where(
        InvoiceBalance.status == "Issued", scoped(InvoiceBalance.collecting_branch_id))).scalar_one()
    awaiting_batch = db.session.execute(select(func.count()).where(
        Admission.enrolment_status == "Awaiting Batch Allocation", scoped(Admission.service_branch_id))).scalar_one()

    # Verified payments per payment date, net of reversals (the same rule as collections_by_branch).
    daily = dict(db.session.execute(
        select(Payment.payment_date, func.coalesce(func.sum(Payment.amount), 0))
        .where(or_(and_(Payment.entry_type == "Payment", Payment.verification_status == "Verified"),
                   Payment.entry_type == "Reversal"),
               Payment.payment_date.between(week_start, today), scoped(Payment.collecting_branch_id))
        .group_by(Payment.payment_date)).all())

    stages = dict(db.session.execute(
        select(PipelineEntry.stage, func.count()).where(scoped(PipelineEntry.branch_id)).group_by(PipelineEntry.stage)).all())
    open_cards = [stage for stage in stages if stage not in CLOSED_STAGES]
    # Open opportunity value: the same rule as the pipeline header (approved fee, else the course's standard fee)
    from repositories import pipeline as pipeline_repo
    from services import pipeline as pipeline_service

    details = pipeline_service.card_details(pipeline_repo.open_entries({}, branch_ids))
    open_value = sum((d["value"] for d in details.values()), ZERO)

    def net(branch_id):
        c = collections.get(branch_id, {})
        return c.get("gross_verified", ZERO) + c.get("reversals", ZERO)

    branches = [{"branch": b.to_summary(), "admissions": paid.get(b.branch_id, 0), "net_verified": net(b.branch_id)}
                for b in reports_repo.branches(branch_ids)]
    return {
        "period": filters.get("period", "This Month"), "from": start, "to": end, "as_of": today,
        "kpis": {
            "open_enquiries": open_enquiries, "new_enquiries": new_enquiries,
            "admissions": sum(paid.values()), "awaiting_batch": awaiting_batch,
            "verified_collections": sum((b["net_verified"] for b in branches), ZERO), "verified_payments": verified_payments,
            "outstanding_balance": outstanding,
            "pending_verification": {"count": pending_count, "amount": pending_amount},
        },
        "collections_daily": [{"date": day, "amount": daily.get(day, ZERO)}
                              for day in (week_start + timedelta(days=i) for i in range(7))],
        "pipeline": {
            "bars": [{"label": label, "stages": list(names), "count": sum(stages.get(s, 0) for s in names)}
                     for label, names in PIPELINE_BARS],
            "open_opportunities": sum(stages[s] for s in open_cards), "open_value": open_value,
        },
        "attention": {"follow_ups": follow_ups_due, "payments": pending_count, "admissions": awaiting_batch},
        "branches": branches,
    }
