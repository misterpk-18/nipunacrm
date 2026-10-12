"""Recovery lists, manager cohort tasks and the playbook measures (spec pages 12, 18).

A recovery list is a narrow, evidence-backed list with a reason to contact. Stop-contact people are never listed and
nothing here sends a message: a manager reviews the list (with its exclusions) and creates named follow-up tasks.
Measures keep AI suggestions, messages, deals and verified admissions as separate counts.
"""
from datetime import datetime, time, timedelta, timezone

from sqlalchemy import func, or_, select

from config.database import db
from models import (
    AiAction, Admission, Branch, Demo, FeeDiscussion, Lead, LeadContactCounter, LeadResponseClock, LeadSource, LostReason,
    Person, Task,
)
from models.enums import CLOSED_STAGES
from repositories import leads as leads_repo
from repositories import settings as settings_repo
from services import knowledge, reports, tasks
from services.context import current_user
from services.errors import BusinessRule, Forbidden, ValidationError
from services.playbook import OPEN_TASK, _lead_row

LISTS = {
    "no_first_attempt": ("No first staff attempt", "Immediate named callback / response; escalate under the service rule"),
    "callback_missed": ("Callback promise missed", "Apologise briefly, ask for a convenient time and resolve the specific question"),
    "demo_no_next_action": ("Demo attended, no next action", "Ask what remains unclear; schedule counselling or a fee discussion"),
    "fee_shared_silent": ("Fee shared, learner silent", "Clarify value, timing or a payment-plan question; don't assume affordability"),
    "waiting_batch": ("Waiting for a batch / exam / salary date", "Contact at the agreed time or when a suitable batch is published"),
    "never_reached": ("Never reached", "Review: the attempt ceiling or window is used up; nurture or close correctly"),
    "lost_recoverable": ("Lost: issue may be resolved", "Review the original reason and any new fact before suggesting recovery"),
    "referred": ("Referred prospect", "Make the referred person's own first contact; keep the referrer attribution separate"),
    "existing_student": ("Existing student: useful next course", "Optional next-course counselling; no automatic promotional send"),
}
RECOVERABLE_LOST = ("TIMING", "LOCATION", "FEE_TOO_HIGH")
CLOSING_STATES = ("Not interested", "Invalid contact", "Stop contact")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _scope(stmt, filters: dict):
    branch_ids = current_user().branch_ids()
    if branch_ids is not None:
        stmt = stmt.where(Lead.branch_id.in_(branch_ids))
    if filters.get("branch_id"):
        stmt = stmt.where(Lead.branch_id == filters["branch_id"])
    if filters.get("course_id"):
        stmt = stmt.where(Lead.course_id == filters["course_id"])
    if filters.get("owner_id"):
        stmt = stmt.where(Lead.assigned_to == filters["owner_id"])
    return stmt


def _list_stmt(name: str):
    open_ = Lead.stage.not_in(CLOSED_STAGES)
    base = select(Lead).join(Person, Person.person_id == Lead.person_id)
    now = _now()
    if name == "no_first_attempt":
        return (base.join(LeadResponseClock, LeadResponseClock.lead_id == Lead.lead_id)
                .where(open_, LeadResponseClock.is_eligible, LeadResponseClock.attempted_at.is_(None),
                       Lead.converted_at.is_(None)))
    if name == "callback_missed":
        return base.where(open_, Lead.lead_id.in_(select(Task.lead_id).where(
            Task.status.in_(OPEN_TASK), Task.dedupe_key.startswith("lead-callback:"),
            func.coalesce(Task.revised_due_at, Task.original_due_at) < now)))
    if name == "demo_no_next_action":
        return base.where(Lead.stage == "Demo Attended", or_(Lead.next_follow_up_at.is_(None), Lead.next_follow_up_at < now))
    if name == "fee_shared_silent":
        return base.where(open_, Lead.lead_id.in_(select(FeeDiscussion.lead_id).where(FeeDiscussion.milestone == "Fee Shared")),
                          or_(Lead.last_contacted_at.is_(None), Lead.last_contacted_at < now - timedelta(days=3)),
                          or_(Lead.next_follow_up_at.is_(None), Lead.next_follow_up_at < now))
    if name == "waiting_batch":
        return base.where(open_, or_(Lead.ai_priority == "Waiting for Batch / Future Joining", Lead.contact_state == "Later"))
    if name == "never_reached":
        window = settings_repo.get_int("unanswered_window_days", 7)
        return (base.join(LeadContactCounter, LeadContactCounter.lead_id == Lead.lead_id)
                .where(open_, LeadContactCounter.never_reached, LeadContactCounter.outbound_attempts > 0,
                       Lead.created_at < now - timedelta(days=window)))
    if name == "lost_recoverable":
        return (base.outerjoin(LostReason, LostReason.lost_reason_id == Lead.lost_reason_id)
                .where(Lead.stage == "Lost - closed",
                       or_(LostReason.code.in_(RECOVERABLE_LOST), Lead.reactivation_date <= reports.business_now().date())))
    if name == "referred":
        return (base.join(LeadSource, LeadSource.lead_source_id == Lead.original_source_id)
                .where(open_, LeadSource.code == "REFERRAL", Lead.stage == "New Enquiry"))
    raise ValidationError("Unknown recovery list", {"list": [f"One of {', '.join(LISTS)}"]})


def _evidence(name: str, lead: Lead) -> str:
    if name == "no_first_attempt":
        return f"Captured {lead.created_at:%d %b %H:%M}; first attempt due {lead.first_attempt_due_at:%d %b %H:%M}"
    if name == "callback_missed":
        return f"Callback agreed for {lead.next_follow_up_at:%d %b %H:%M}" if lead.next_follow_up_at else "Callback overdue"
    if name == "lost_recoverable":
        return (f"Lost: {lead.lost_reason.label if lead.lost_reason else 'no reason'}"
                + (f" · reactivate from {lead.reactivation_date:%d %b %Y}" if lead.reactivation_date else "")
                + (f" · {lead.lost_notes}" if lead.lost_notes else ""))
    if name == "waiting_batch":
        from services.playbook import batches_for

        ready = [b for b in batches_for(lead.course_id, lead.branch_id) if b.is_offerable]
        wanted = f"wants {lead.preferred_timing}" if lead.preferred_timing else "timing preference not recorded"
        if ready:
            b = ready[0]
            return (f"Suitable batch published: {b.batch_code} from {b.start_date:%d %b} · {b.timing()} · "
                    f"{b.seats_left} seat(s) left ({wanted})")
        return f"No offerable batch yet for this course ({wanted})" + (f" · {lead.next_action}" if lead.next_action else "")
    contacted = f"last contact {lead.last_contacted_at:%d %b}" if lead.last_contacted_at else "never contacted"
    return f"{lead.stage} · {contacted}" + (f" · {lead.next_action}" if lead.next_action else "")


def recovery_list(filters: dict) -> dict:
    name = filters["list"]
    if name == "existing_student":
        return _students_list(filters)
    stmt = _scope(_list_stmt(name), filters)
    leads = list(db.session.execute(stmt.order_by(Lead.created_at).limit(500)).scalars().unique())
    rows, excluded = [], {}
    for lead in leads:
        reason = ("Stop contact" if lead.person.stop_contact_at else
                  lead.contact_state if lead.contact_state in CLOSING_STATES and name != "lost_recoverable" else
                  "Open lead for this course already exists" if name == "lost_recoverable"
                  and leads_repo.find_open_lead(lead.person_id, lead.course_id, lead.branch_id) else None)
        if reason:
            excluded[reason] = excluded.get(reason, 0) + 1
            continue
        open_recovery = db.session.execute(select(Task.task_id).where(
            Task.lead_id == lead.lead_id, Task.status.in_(OPEN_TASK), Task.dedupe_key.startswith("recovery:"))).first()
        rows.append({"lead": _lead_row(lead), "evidence": _evidence(name, lead), "suggested_action": LISTS[name][1],
                     "recovery_task_open": open_recovery is not None})
    return {"list": name, "label": LISTS[name][0], "rows": rows,
            "excluded": [{"reason": r, "count": c} for r, c in excluded.items()]}


def _students_list(filters: dict) -> dict:
    branch_ids = current_user().branch_ids()
    stmt = select(Person).join(Admission, Admission.person_id == Person.person_id).where(Admission.cancelled_at.is_(None))
    if branch_ids is not None:
        stmt = stmt.where(Admission.original_branch_id.in_(branch_ids))
    if filters.get("branch_id"):
        stmt = stmt.where(Admission.original_branch_id == filters["branch_id"])
    rows, excluded = [], {}
    for person in db.session.execute(stmt.distinct().limit(300)).scalars():
        if person.stop_contact_at:
            excluded["Stop contact"] = excluded.get("Stop contact", 0) + 1
            continue
        result = knowledge.course_suggestions(person.person_id)
        for card in result["suggestions"]:
            if filters.get("course_id") and card["course"]["course_id"] != filters["course_id"]:
                continue
            rows.append({"person": person.to_summary(), "course": card["course"], "from_course": card["from_course"],
                         "evidence": card["learner_benefit"], "suggested_action": card["suggested_question"]})
    return {"list": "existing_student", "label": LISTS["existing_student"][0], "rows": rows,
            "excluded": [{"reason": r, "count": c} for r, c in excluded.items()]}


def list_counts(filters: dict) -> list[dict]:
    out = []
    for name, (label, action) in LISTS.items():
        if name == "existing_student":
            continue
        count = db.session.execute(select(func.count()).select_from(
            _scope(_list_stmt(name), filters).where(Person.stop_contact_at.is_(None)).subquery())).scalar()
        out.append({"list": name, "label": label, "suggested_action": action, "count": count})
    out.append({"list": "existing_student", "label": LISTS["existing_student"][0],
                "suggested_action": LISTS["existing_student"][1], "count": None})
    return out


def create_tasks(data: dict) -> dict:
    """Managers turn reviewed list rows into named follow-up tasks (no message is sent)."""
    user = current_user()
    name = data["list"]
    if name in ("existing_student",):
        raise BusinessRule("Existing-student suggestions are reviewed one by one on the person's page")
    if not (user.is_admin or user.has_role("BRANCH_MANAGER")):
        raise Forbidden("Only a Branch Manager or an admin can create recovery tasks")
    members = {lead.lead_id: lead for lead in db.session.execute(
        _scope(_list_stmt(name), {}).where(Lead.lead_id.in_(data["lead_ids"]), Person.stop_contact_at.is_(None))).scalars().unique()}
    due = data.get("due_at") or _now() + timedelta(hours=2)
    stamp = reports.business_now().date().isoformat()
    created, skipped = [], []
    for lead_id in data["lead_ids"]:
        lead = members.get(lead_id)
        if lead is None:
            skipped.append({"lead_id": lead_id, "reason": "No longer on this list (or stop contact)"})
            continue
        if not user.is_manager_of(lead.branch_id):
            skipped.append({"lead_id": lead_id, "reason": "Outside your branches"})
            continue
        task = tasks.create_system_task(
            "FOLLOW_UP", f"Recovery · {LISTS[name][0]} · {lead.person.full_name}", lead.branch_id, due,
            owner_user_id=lead.assigned_to, team_role_code=None if lead.assigned_to else "SALES",
            description=f"{_evidence(name, lead)}. Suggested: {LISTS[name][1]}",
            dedupe_key=f"recovery:{name}:{lead.lead_id}:{stamp}", lead_id=lead.lead_id)
        created.append({"lead_id": lead_id, "task_id": task.task_id})
    return {"created": created, "skipped": skipped}


# ---------------------------------------------------------------- measures

def _pct(part: int, whole: int) -> float | None:
    return round(100 * part / whole, 1) if whole else None


def measures(filters: dict) -> dict:
    start, end = reports.period_range(filters.get("period", "This Month"), filters.get("from"), filters.get("to"))
    tz = reports.business_now().tzinfo
    t0 = datetime.combine(start, time.min, tzinfo=tz)
    t1 = datetime.combine(end + timedelta(days=1), time.min, tzinfo=tz)
    now = _now()
    branch_ids = current_user().branch_ids()
    if filters.get("branch_id"):
        branch_ids = {filters["branch_id"]} if branch_ids is None or filters["branch_id"] in branch_ids else set()

    def in_branch(column):
        return True if branch_ids is None else column.in_(branch_ids or {-1})

    # 1. first staff attempt within SLA (genuine enquiries; bot activity never counts)
    clock = db.session.execute(select(LeadResponseClock).where(
        LeadResponseClock.is_eligible, LeadResponseClock.captured_at >= t0, LeadResponseClock.captured_at < t1,
        in_branch(LeadResponseClock.branch_id))).scalars().all()
    first = {"eligible": len(clock), "met": sum(c.sla_state == "Met" for c in clock),
             "met_late": sum(c.sla_state == "Met Late" for c in clock),
             "breached_no_attempt": sum(c.sla_state in ("Breached", "Closed Without Attempt") for c in clock),
             "pending": sum(c.sla_state in ("Pending", "At Risk") for c in clock)}
    first["pct_within_sla"] = _pct(first["met"], first["eligible"] - first["pending"])

    # 2. due callbacks completed as agreed (30-minute grace)
    due_expr = func.coalesce(Task.revised_due_at, Task.original_due_at)
    callbacks = db.session.execute(select(Task).where(Task.dedupe_key.startswith("lead-callback:"), due_expr >= t0,
                                                      due_expr < t1, due_expr <= now, in_branch(Task.branch_id))).scalars().all()
    on_time = sum(1 for t in callbacks if t.status == "Completed" and t.completed_at
                  and t.completed_at <= (t.revised_due_at or t.original_due_at) + timedelta(minutes=30))
    missed = [t for t in callbacks if t.status in OPEN_TASK]
    cb = {"due": len(callbacks), "completed_on_time": on_time, "missed_open": len(missed),
          "pct_completed": _pct(on_time, len(callbacks))}

    # 3. demo attendance (cancellations / reschedules shown separately, not double-counted)
    demos = db.session.execute(select(Demo.status, func.count()).where(
        Demo.scheduled_at >= t0, Demo.scheduled_at < t1, Demo.scheduled_at <= now, in_branch(Demo.branch_id))
        .group_by(Demo.status)).all()
    d = dict(demos)
    due_demos = d.get("Attended", 0) + d.get("No Show", 0) + d.get("Scheduled", 0) + d.get("Confirmed", 0)
    demo = {"due": due_demos, "attended": d.get("Attended", 0), "no_show": d.get("No Show", 0),
            "outcome_missing": d.get("Scheduled", 0) + d.get("Confirmed", 0), "cancelled": d.get("Cancelled", 0),
            "rescheduled": d.get("Rescheduled", 0), "pct_attended": _pct(d.get("Attended", 0), due_demos)}

    # 4. qualified-to-paid conversion for the cohort qualified in the period (30-day observation window)
    window = 30
    cohort = db.session.execute(select(Lead.lead_id).where(Lead.qualified_at >= t0, Lead.qualified_at < t1,
                                                           in_branch(Lead.branch_id))).scalars().all()
    paid = db.session.execute(select(func.count(func.distinct(Admission.lead_id))).where(
        Admission.lead_id.in_(cohort or [-1]), Admission.first_verified_payment_at.is_not(None),
        Admission.complimentary_of_admission_id.is_(None))).scalar()
    q2p = {"qualified": len(cohort), "paid": paid, "pct": _pct(paid, len(cohort)), "observation_days": window,
           "immature": end > reports.business_now().date() - timedelta(days=window)}

    # 5. recovered paid opportunities (recovery task, then a verified paid admission on that lead)
    rec_tasks = db.session.execute(select(Task.lead_id, func.min(Task.created_at)).where(
        Task.dedupe_key.startswith("recovery:"), Task.created_at >= t0, Task.created_at < t1, in_branch(Task.branch_id))
        .group_by(Task.lead_id)).all()
    recovered = sum(1 for lead_id, at in rec_tasks if db.session.execute(select(Admission.admission_id).where(
        Admission.lead_id == lead_id, Admission.first_verified_payment_at > at)).first())
    rec = {"recovery_actions": len(rec_tasks), "recovered_paid": recovered}

    # 6. useful cross-course conversion: reviewed → used → interested deal → verified paid (no complimentary)
    sugg = db.session.execute(select(AiAction).where(AiAction.action_type == "Course suggestion", AiAction.created_at >= t0,
                                                     AiAction.created_at < t1, in_branch(AiAction.branch_id))).scalars().all()
    used = [a for a in sugg if a.status in ("Used", "Edited")]
    interested = [a for a in used if db.session.execute(select(Lead.lead_id).where(
        Lead.person_id == a.person_id, Lead.course_id == a.course_id, Lead.created_at >= a.created_at)).first()]
    cross_paid = sum(1 for a in interested if db.session.execute(select(Admission.admission_id).where(
        Admission.person_id == a.person_id, Admission.course_id == a.course_id, Admission.complimentary_of_admission_id.is_(None),
        Admission.first_verified_payment_at > a.created_at)).first())
    cross = {"reviewed": len(sugg), "used": len(used), "ignored": sum(a.status == "Ignored" for a in sugg),
             "snoozed": sum(a.status == "Snoozed" for a in sugg), "interested_leads": len(interested), "paid": cross_paid}

    # 7. source and branch quality (genuine leads, qualified deals, verified paid — per lead, not per receipt)
    paid_lead = select(Admission.lead_id).where(Admission.first_verified_payment_at.is_not(None)).scalar_subquery()
    src = db.session.execute(
        select(LeadSource.label, Branch.branch_name, func.count(), func.count().filter(Lead.converted_at.is_not(None)),
               func.count().filter(Lead.lead_id.in_(paid_lead)))
        .join(LeadSource, LeadSource.lead_source_id == Lead.original_source_id)
        .join(Branch, Branch.branch_id == Lead.branch_id)
        .where(Lead.created_at >= t0, Lead.created_at < t1, in_branch(Lead.branch_id),
               Lead.intake_status.not_in(("Outreach Prospect", "Invalid-Spam", "Test")))
        .group_by(LeadSource.label, Branch.branch_name).order_by(LeadSource.label, Branch.branch_name)).all()
    sources = [{"source": s, "branch": b, "genuine_leads": g, "deals": c, "verified_paid": p} for s, b, g, c, p in src]

    # 8. quality and effort of assistance
    acts = db.session.execute(select(AiAction.action_type, AiAction.status, func.count()).where(
        AiAction.created_at >= t0, AiAction.created_at < t1, in_branch(AiAction.branch_id))
        .group_by(AiAction.action_type, AiAction.status)).all()
    quality = [{"action_type": t, "status": s, "count": n} for t, s, n in acts]
    fallback = db.session.execute(select(func.count()).where(
        AiAction.action_type == "Counselling brief", AiAction.model == "rules-fallback", AiAction.created_at >= t0,
        AiAction.created_at < t1, in_branch(AiAction.branch_id))).scalar()

    return {"period": {"from": start, "to": end}, "first_attempt": first, "callbacks": cb, "demos": demo,
            "qualified_to_paid": q2p, "recovery": rec, "cross_course": cross, "sources": sources,
            "assistance": {"by_status": quality, "model_fallbacks": fallback},
            "notes": ["AI suggestions, messages, deals and verified admissions are separate counts; assistance alone "
                      "does not prove AI caused a sale.",
                      "Pending verification never counts; multiple receipts for one purchase count once."]}
