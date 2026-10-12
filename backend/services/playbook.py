"""Front Office sales playbook (CRM AI v2.0, release 1): the lead workbench, quick outcomes, objections, stop contact,
reply drafts from approved templates, the ordered "My work today" queue and the shift handover list.

Suggestions here are deterministic CRM rules over recorded facts; the language model is only used for the optional
counselling brief (services/ai.py). Nothing here sends a message, creates a payment, receipt or admission, or changes
ownership: staff press Send / Save, and every business action goes through its existing validated endpoint.
"""
import hashlib
import json
import re
from datetime import datetime, time, timedelta, timezone

from sqlalchemy import and_, func, or_, select

from config.database import db
from models import (
    AiAction, AiBranchControl, Admission, CommunicationInbox, DeliveryPlan, Demo, Enquiry, FeeDiscussion, Invoice,
    InvoiceLine, Lead, LeadActivity, LeadObjection, LeadQualificationReview, LeadResponseClock, OfferableBatch, Payment,
    PaymentAllocation, Person, PipelineEntry, SalesKnowledge, Task,
)
from models.enums import CLOSED_STAGES
from repositories import leads as leads_repo
from services import audit, contact_policy, qualification, tasks
from services import leads as leads_service
from services.context import COUNSELLOR_ROLES, current_user
from services.errors import BusinessRule, Conflict, Forbidden, NotFound, ValidationError
from services.reports import business_now

POLICY_VERSION = "playbook-2.0"
OPEN_TASK = ("Open", "In Progress", "Waiting/Blocked")
NEXT_ACTION_KEYS = ("lead-next:", "lead-callback:", "lead-follow-up:")
CLOSING_STATES = ("Not interested", "Invalid contact", "Stop contact")
CHANNEL_ACTIVITY = {"Call": "Call", "WhatsApp": "WhatsApp", "Email": "Email", "SMS": "SMS", "Meeting": "Meeting"}

# Counselling (spec page 6): ask only what is missing, one question at a time
NEED_QUESTIONS = {
    "learner_goal": "What would you like to do with this skill: improve your work, prepare for a role, study further "
                    "or complete a project?",
    "course": "Is there a specific course you want, or would a short comparison help?",
    "prior_experience": "What have you already learned or used?",
    "preferred_timing": "Which branch, mode and times are practical for you?",
    "joining_window": "When would you like to start?",
}
NEED_LABELS = {"learner_goal": "Goal", "course": "Course interest", "prior_experience": "Starting point",
               "preferred_timing": "Branch / mode / timing", "joining_window": "Joining window"}

# Objection handling (spec page 7): what to ask or explain, and one useful next action
OBJECTION_GUIDE = {
    "Fee is high": ("Is the concern the total fee, payment timing or uncertainty about course value? Explain the "
                    "approved content and support.",
                    "Share the approved fee breakdown or an eligible instalment plan; request an exception only when needed."),
    "Another institute is cheaper": ("What matters most in your comparison: syllabus, timing, projects, mode or "
                                     "support? Use verified Nipuna facts.",
                                     "Offer a factual comparison or a demo. Do not invent competitor weaknesses."),
    "Need to ask parents": ("What information would help that discussion? Involve a parent only with the learner's "
                            "permission.", "Share the syllabus / fee summary or arrange a consented joint call."),
    "Cannot attend timings": ("Which days and times are workable? Check actual available branch / mode options.",
                              "Request a scheduling review or waitlist contact; do not promise an unpublished batch."),
    "Job guarantee": ("Explain placement assistance and the relevant skills / projects. There is no employment or "
                      "salary guarantee.", "Offer approved placement-support information and academic counselling."),
    "Weak in basics": ("Which topics are unfamiliar? Identify prerequisites and a suitable starting point.",
                       "Arrange foundational counselling or a demo; do not push an unsuitable advanced course."),
    "Will decide later": ("Is the delay about exams, work, timing or a question we haven't answered? Accept the "
                          "response.", "Record the reason and the requested contact date; avoid repeated generic reminders."),
    "Bad experience / refund concern": ("Acknowledge the concern and use the current approved policy. Do not debate or "
                                        "improvise a promise.",
                                        "Route to the responsible manager and pause promotional contact until it is addressed."),
    "Other": ("Ask what would help them decide.", "Record the concern and agree one next step."),
}

PLACEHOLDER = re.compile(r"\{(\w+)\}")


# ---------------------------------------------------------------- helpers

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _local(at: datetime | None) -> str | None:
    return at.astimezone(business_now().tzinfo).strftime("%d %b %Y, %I:%M %p") if at else None


def _end_of_today() -> datetime:
    now = business_now()
    return datetime.combine(now.date(), time.max, tzinfo=now.tzinfo)


def fingerprint(*parts) -> str:
    return hashlib.sha256(json.dumps(parts, default=str, sort_keys=True).encode()).hexdigest()[:32]


def ai_control(branch_id: int) -> AiBranchControl:
    return db.session.get(AiBranchControl, branch_id)


def assistance(branch_id: int) -> dict:
    control = ai_control(branch_id)
    return {"execution_profile": control.execution_profile, "is_paused": control.is_paused,
            "pause_reason": control.pause_reason, "drafts_allowed": not control.is_paused and control.execution_profile != "Observe"}


def require_drafts(branch_id: int) -> None:
    """Drafts (replies, counselling briefs) need the Assist profile and no pause. Manual work never stops."""
    control = ai_control(branch_id)
    if control.is_paused:
        raise BusinessRule(f"AI assistance is paused for {control.branch.branch_name}: {control.pause_reason}. "
                           "Work the lead manually; calls, notes and deals are not affected")
    if control.execution_profile == "Observe":
        raise BusinessRule(f"{control.branch.branch_name} is in Observe mode: suggestions are shown but no drafts are "
                           "prepared. A manager can switch it to Assist")


def can_contact(lead: Lead) -> bool:
    """Owner, branch manager, unassigned-lead counsellors, or Front Office cover at the branch (cover helps without
    taking ownership)."""
    return leads_service.can_work(lead) or current_user().has_role("FRONT_OFFICE", branch_id=lead.branch_id)


def _contactable(lead_id: int) -> Lead:
    lead = leads_service.get_lead(lead_id)
    if not can_contact(lead):
        raise Forbidden("Only the lead's owner, Front Office cover or a branch manager can record contact")
    return lead


def _open_objections(lead_id: int) -> list[LeadObjection]:
    return list(db.session.execute(select(LeadObjection).where(LeadObjection.lead_id == lead_id, LeadObjection.status == "Open")
                                   .order_by(LeadObjection.created_at.desc())).scalars())


def _open_next_tasks(lead_id: int) -> list[Task]:
    return list(db.session.execute(
        select(Task).where(Task.lead_id == lead_id, Task.status.in_(OPEN_TASK),
                           or_(*[Task.dedupe_key.startswith(k) for k in NEXT_ACTION_KEYS]))
        .order_by(func.coalesce(Task.revised_due_at, Task.original_due_at))).scalars())


def _task_due(task: Task) -> datetime:
    return task.revised_due_at or task.original_due_at


def _upcoming_demo(lead_id: int) -> Demo | None:
    return db.session.execute(select(Demo).where(Demo.lead_id == lead_id, Demo.status.in_(Demo.OPEN_STATUSES),
                                                 Demo.scheduled_at >= _now() - timedelta(hours=1))
                              .order_by(Demo.scheduled_at)).scalars().first()


def missing_need(lead: Lead) -> list[str]:
    missing = [f for f in ("learner_goal", "prior_experience", "preferred_timing", "joining_window") if not getattr(lead, f)]
    if lead.course_id is None:
        missing.insert(1, "course")
    return missing


# ---------------------------------------------------------------- the 30-second brief

def brief(lead: Lead) -> dict:
    last = db.session.execute(leads_repo.activities_stmt(lead.lead_id)
                              .where(LeadActivity.activity_type.not_in(("Stage Change", "Assignment Change")))
                              .limit(1)).scalars().first()
    enquiry = db.session.get(Enquiry, lead.original_enquiry_id) if lead.original_enquiry_id else None
    interests = db.session.execute(select(Lead).where(Lead.person_id == lead.person_id, Lead.branch_id == lead.branch_id,
                                                      Lead.stage.not_in(CLOSED_STAGES))).scalars()
    objections = _open_objections(lead.lead_id)
    return {
        "need": {"learner_goal": lead.learner_goal, "prior_experience": lead.prior_experience,
                 "preferred_timing": lead.preferred_timing, "joining_window": lead.joining_window,
                 "open_question": lead.open_question},
        "preferred_language": lead.person.preferred_language,
        "preferred_contact_time": lead.person.preferred_contact_time,
        "course_interests": [{"lead_id": x.lead_id, "lead_code": x.lead_code,
                              "course": x.course.to_summary() if x.course else None, "stage": x.stage} for x in interests],
        "branch": lead.branch.to_summary(),
        "enquiry_message": enquiry.message if enquiry else None,
        "enquiry_received_at": enquiry.received_at if enquiry else None,
        "last_discussion": {"activity_type": last.activity_type, "outcome": last.outcome, "summary": last.summary,
                            "occurred_at": last.occurred_at,
                            "by": last.performer.full_name if last.performer else None} if last else None,
        "unresolved_objection": objections[0].to_dict() if objections else None,
        "promised_next_action": {"next_action": lead.next_action, "at": lead.next_follow_up_at} if lead.next_follow_up_at
        or lead.next_action else None,
        "contact_state": lead.contact_state,
        "missing": [{"field": f, "label": NEED_LABELS[f], "question": NEED_QUESTIONS[f]} for f in missing_need(lead)],
    }


# ---------------------------------------------------------------- one recommended next action

def _card(code: str, text: str, reason: str, evidence: list, *, action: str | None = None, **extra) -> dict:
    return {"action_code": code, "suggestion": text, "reason": reason, "evidence": evidence, "primary_action": action,
            "fingerprint": fingerprint(code, evidence), **extra}


def recommend(lead: Lead, clock: LeadResponseClock | None = None) -> dict | None:
    """The single most useful next step for this lead, with the facts it is based on. Rules, in playbook order."""
    if not lead.is_open:
        return None
    name = lead.person.full_name
    stopped = contact_policy.stop_contact_reason(lead)
    if stopped:
        return _card("stop_contact", "Do not contact: the learner asked to stop. Answer only if they get in touch.",
                     stopped, [{"type": "person", "id": lead.person_id, "stop_contact_at": lead.person.stop_contact_at}])
    clock = clock or db.session.get(LeadResponseClock, lead.lead_id, populate_existing=True)
    if clock.is_eligible and clock.attempted_at is None and lead.converted_at is None:
        return _card("first_attempt", f"Call {name} now: the first staff attempt is due {_local(clock.due_at)}",
                     f"Captured {_local(clock.captured_at)}; no staff attempt yet ({clock.sla_state})",
                     [{"type": "lead_response_clock", "lead_id": lead.lead_id, "due_at": clock.due_at}], action="call")
    callback = next((t for t in _open_next_tasks(lead.lead_id)
                     if t.dedupe_key.startswith("lead-callback:") and _task_due(t) <= _now() + timedelta(minutes=30)), None)
    if callback:
        question = f" about {lead.open_question}" if lead.open_question else ""
        return _card("callback_due", f"Call back as promised at {_local(_task_due(callback))}{question}",
                     "A callback was agreed with the learner", [{"type": "task", "id": callback.task_id,
                                                                 "due_at": _task_due(callback)}], action="call")
    if lead.stage == "Payment Pending Verification":
        return _card("await_verification", "Payment proof is with Accounts. Don't ask the learner to pay again; tell "
                     "them it is pending verification", "Payment submitted and Payment verified are different states",
                     [{"type": "lead", "id": lead.lead_id, "stage": lead.stage}])
    objections = _open_objections(lead.lead_id)
    if objections:
        o = objections[0]
        ask, step = OBJECTION_GUIDE[o.category or "Other"]
        return _card("objection", f"Respond to “{o.learner_words}”: {step}", ask,
                     [{"type": "lead_objection", "id": o.objection_id, "category": o.category}], action="outcome")
    if lead.stage in ("New Enquiry", "Counselling"):
        missing = missing_need(lead)
        if missing:
            field = missing[0]
            return _card(f"ask:{field}", f"Ask: {NEED_QUESTIONS[field]}", f"{NEED_LABELS[field]} is not recorded yet",
                         [{"type": "lead", "id": lead.lead_id, "missing": missing}], action="outcome")
    if lead.stage == "New Enquiry":
        if lead.qualified_at is None:
            return _card("qualify", "Complete the qualification review (all six checks) before converting",
                         "Convert to deal needs a qualified lead", [{"type": "lead", "id": lead.lead_id}], action="qualify")
        return _card("convert", "Convert to deal and agree the next step with a date",
                     "The lead is qualified", [{"type": "lead", "id": lead.lead_id, "qualified_at": lead.qualified_at}],
                     action="convert")
    if lead.stage == "Demo Scheduled":
        demo = _upcoming_demo(lead.lead_id)
        if demo and demo.status == "Scheduled":
            return _card("confirm_demo", f"Confirm the demo on {_local(demo.scheduled_at)} with {name}",
                         "The demo is booked but not confirmed",
                         [{"type": "demo", "id": demo.demo_id, "status": demo.status}], action="draft:Demo reminder")
        if demo:
            return _card("prepare_demo", "Check directions, the online link or what to prepare before the demo",
                         f"Confirmed demo on {_local(demo.scheduled_at)}", [{"type": "demo", "id": demo.demo_id}])
        return _card("book_demo", "The demo date has passed: record attendance or offer the next permitted slot",
                     "No upcoming demo", [{"type": "lead", "id": lead.lead_id, "stage": lead.stage}])
    if lead.stage == "Demo Attended":
        return _card("post_demo", "Ask: what did you find useful, and what would you still need to know before deciding?",
                     "After the demo, ask for the real concern", [{"type": "lead", "id": lead.lead_id, "stage": lead.stage}],
                     action="draft:Post-demo discussion")
    if lead.stage == "Fee Discussion / Payment Awaited":
        checklist = closing_checklist(lead)
        gap = next((i for i in checklist["items"] if not i["done"]), None)
        if gap:
            return _card(f"close:{gap['key']}", gap["next_action"], f"Ready-to-close check: {gap['label']}",
                         [{"type": "closing_check", "key": gap["key"]}])
    if lead.stage == "Counselling":
        return _card("counsel", "Agree a counselling call, a demo or a syllabus share, with a date",
                     "Close the conversation with a commitment", [{"type": "lead", "id": lead.lead_id}], action="outcome")
    return _card("agree_next_step", "Agree one next step with a date and save the outcome",
                 "Every contact ends with a dated next action or a clear status", [{"type": "lead", "id": lead.lead_id}],
                 action="outcome")


def _disposition(lead_id: int, card: dict) -> AiAction | None:
    return db.session.execute(select(AiAction).where(AiAction.lead_id == lead_id, AiAction.action_code == card["action_code"],
                                                     AiAction.fingerprint == card["fingerprint"])
                              .order_by(AiAction.ai_action_id.desc())).scalars().first()


def next_action_card(lead: Lead) -> dict | None:
    if ai_control(lead.branch_id).is_paused:
        return None
    card = recommend(lead)
    if card is None:
        return None
    previous = _disposition(lead.lead_id, card)
    hidden = previous is not None and (previous.status == "Ignored" or (previous.status == "Snoozed" and previous.remind_at > _now()))
    return {**card, "owner": lead.owner.full_name if lead.owner else None,
            "disposition": {"status": previous.status, "at": previous.disposition_at, "remind_at": previous.remind_at,
                            "note": previous.disposition_note} if previous else None,
            "hidden": hidden}


def dispose_next_action(lead_id: int, data: dict) -> AiAction:
    """Use / Edit / Ignore / Remind later on the current card. Ignoring never cancels a real task or promise."""
    lead = _contactable(lead_id)
    card = recommend(lead)
    if card is None or card["action_code"] != data["action_code"]:
        raise Conflict("The suggested action has changed since you opened the lead; reload it")
    status = data["status"]
    if status == "Snoozed" and (data.get("remind_at") is None or data["remind_at"] <= _now()):
        raise ValidationError("Remind later needs a future date", {"remind_at": ["Must be in the future"]})
    if status == "Edited" and not data.get("final_text"):
        raise ValidationError("Edit needs the reviewed wording", {"final_text": ["Required"]})
    user = current_user()
    action = AiAction(action_type="Next action", action_code=card["action_code"], fingerprint=card["fingerprint"],
                      lead_id=lead.lead_id, person_id=lead.person_id, branch_id=lead.branch_id,
                      owner_user_id=lead.assigned_to, suggestion=card["suggestion"], reason=card["reason"],
                      evidence=json.loads(json.dumps(card["evidence"], default=str)), record_version=lead.updated_at,
                      status=status, final_text=data.get("final_text"), disposition_note=data.get("note"),
                      remind_at=data.get("remind_at") if status == "Snoozed" else None, disposition_by=user.user_id,
                      disposition_at=_now(), model="rules", policy_version=POLICY_VERSION, created_by=user.user_id)
    db.session.add(action)
    db.session.flush()
    return action


# ---------------------------------------------------------------- ready-to-close checklist (spec page 11)

def closing_checklist(lead: Lead) -> dict:
    qualified_identity = lead.qualified_at is not None and db.session.execute(
        select(LeadQualificationReview).where(LeadQualificationReview.lead_id == lead.lead_id,
                                              LeadQualificationReview.check_code == "Possible identity match reviewed")
    ).first() is not None
    plan = db.session.execute(select(DeliveryPlan).where(DeliveryPlan.lead_id == lead.lead_id)).scalars().first()
    fee = db.session.execute(select(FeeDiscussion).where(FeeDiscussion.lead_id == lead.lead_id)
                             .order_by(FeeDiscussion.fee_discussion_id.desc())).scalars().first()
    version = fee.current_version if fee else None
    line = db.session.execute(select(InvoiceLine).join(Invoice, Invoice.invoice_id == InvoiceLine.invoice_id)
                              .where(InvoiceLine.lead_id == lead.lead_id, Invoice.status == "Issued")).scalars().first()
    payments = list(db.session.execute(
        select(Payment.verification_status).join(PaymentAllocation, PaymentAllocation.payment_id == Payment.payment_id)
        .where(PaymentAllocation.invoice_line_id == line.invoice_line_id, Payment.entry_type == "Payment")).scalars()) if line else []
    admission = db.session.execute(select(Admission).where(Admission.lead_id == lead.lead_id,
                                                           Admission.cancelled_at.is_(None))).scalars().first()
    open_objections = _open_objections(lead.lead_id)
    items = [
        ("right_learner_course", "Right learner and course", qualified_identity and lead.course_id is not None,
         "Qualified with identity reviewed" if qualified_identity else None,
         "Finish the qualification review, including the identity check"),
        ("delivery_agreed", "Delivery agreed", bool(plan and plan.accepted_at),
         f"{plan.plan_code} · {plan.delivery_mode} · {plan.seat_type}" if plan else None,
         "Confirm the delivery plan (branch, mode, start) and record the learner's acceptance"),
        ("fee_understood", "Fee understood", bool(version and version.status == "Approved" and fee.fee_shared_at),
         f"{fee.discussion_code} · v{version.version_no} {version.status} · ₹{version.final_payable}" if version else None,
         "Share the current approved fee, benefits and payment schedule"),
        ("concern_resolved", "Remaining concern resolved", not open_objections,
         None if not open_objections else f"Open: “{open_objections[0].learner_words}”",
         "Record the answer to the learner's open concern (a considered decline is fine)"),
        ("invoice", "Invoice issued", line is not None, line.line_code if line else None,
         "Create the invoice through the deal's invoice action (correct issuing branch, accepted terms)"),
        ("payment_claim", "Payment claim with Accounts", any(p in ("Pending Verification", "Verified") for p in payments),
         ", ".join(payments) or None, "Capture the actual payment proof / reference and hand it to Accounts"),
        ("verified_outcome", "Verified outcome", admission is not None and admission.first_verified_payment_at is not None,
         admission.admission_code if admission else None,
         "Wait for Accounts to verify; the admission and receipt follow automatically"),
    ]
    rows = [{"key": k, "label": label, "done": bool(done), "evidence": ev, "next_action": nxt}
            for k, label, done, ev, nxt in items]
    return {"items": rows, "complete": all(r["done"] for r in rows)}


# ---------------------------------------------------------------- workbench

def approved_content(lead: Lead) -> list[SalesKnowledge]:
    course_ids = [lid for lid in db.session.execute(
        select(Lead.course_id).where(Lead.person_id == lead.person_id, Lead.branch_id == lead.branch_id,
                                     Lead.course_id.is_not(None))).scalars()]
    return list(db.session.execute(
        select(SalesKnowledge).where(SalesKnowledge.status == "Approved", SalesKnowledge.kind != "Reply template",
                                     or_(SalesKnowledge.course_id.is_(None), SalesKnowledge.course_id.in_(course_ids or [-1])),
                                     or_(SalesKnowledge.branch_id.is_(None), SalesKnowledge.branch_id == lead.branch_id))
        .order_by(SalesKnowledge.kind, SalesKnowledge.title)).scalars())


def batches_for(course_id: int | None, branch_id: int) -> list[OfferableBatch]:
    """Upcoming batches for the course at the branch: offerable first (soonest start), then the rest with the reason
    they can't be offered (staff only). Never promise a batch that isn't offerable or whose timing isn't confirmed."""
    if course_id is None:
        return []
    return list(db.session.execute(
        select(OfferableBatch).where(OfferableBatch.course_id == course_id, OfferableBatch.branch_id == branch_id,
                                     OfferableBatch.status.in_(("Planned", "Open")))
        .order_by(OfferableBatch.is_offerable.desc(), OfferableBatch.start_date)).scalars())


def workbench(lead_id: int) -> dict:
    lead = leads_service.get_lead(lead_id)
    clock = db.session.get(LeadResponseClock, lead.lead_id, populate_existing=True)
    today = business_now().date()
    return {
        "lead_id": lead.lead_id,
        "brief": brief(lead),
        "response_clock": clock.to_dict(),
        "contact_policy": contact_policy.summary(lead),
        "next_action": next_action_card(lead),
        "assistance": assistance(lead.branch_id),
        "objections": [o.to_dict() for o in db.session.execute(
            select(LeadObjection).where(LeadObjection.lead_id == lead.lead_id)
            .order_by(LeadObjection.status != "Open", LeadObjection.created_at.desc())).scalars()],
        "content": [k.to_dict(today) for k in approved_content(lead)],
        "batches": [b.to_dict() for b in batches_for(lead.course_id, lead.branch_id)],
        "closing_checklist": closing_checklist(lead) if lead.converted_at else None,
        "can_contact": can_contact(lead),
        "as_of": _now(),
    }


# ---------------------------------------------------------------- quick outcome

def save_outcome(lead_id: int, data: dict) -> dict:
    """Save the actual outcome and the agreed next action together (one press). Rules:
    - outbound contact obeys stop contact and the shared ceilings; inbound contact can always be recorded;
    - Callback requested and Later need the agreed date; Demo booked needs a booked demo (no AI booking);
    - without a dated next action the lead gets a clear state, or is flagged Next action missing — never lost.
    """
    lead = _contactable(lead_id)
    if not lead.is_open:
        raise BusinessRule(f"Lead is {lead.stage}")
    user = current_user()
    now = _now()
    outcome, channel = data["outcome"], data["channel"]
    direction = data.get("direction") or "Outbound"
    if direction == "Outbound":
        if outcome == "Stop contact" and lead.person.stop_contact_at is None:
            pass  # recording the learner's request to stop is always allowed
        else:
            contact_policy.require(lead, channel)
    next_at = data.get("next_action_at")
    if next_at is not None and next_at <= now:
        raise ValidationError("The next action must be in the future", {"next_action_at": ["Must be in the future"]})
    if outcome in ("Callback requested", "Later") and next_at is None:
        raise ValidationError(f"{outcome} needs the agreed date and time", {"next_action_at": ["Required"]})
    if outcome == "Demo booked" and _upcoming_demo(lead.lead_id) is None:
        raise BusinessRule("Book the demo first (Schedule demo validates the slot, trainer and demo limit); "
                           "a conversation alone is not a booking")
    if outcome in ("Not interested", "Wrong number", "Stop contact"):
        next_at = None

    need = data.get("need") or {}
    for field, value in need.items():
        setattr(lead, field, value)
    note = data.get("note")
    activity = leads_service.log_activity(lead, CHANNEL_ACTIVITY[channel], note or outcome, direction=direction,
                                          outcome=outcome, purpose="Contact outcome", occurred_at=now)
    lead.last_contacted_at = now

    # Earlier next-action tasks are fulfilled by this contact; a new dated action replaces them
    for task in _open_next_tasks(lead.lead_id):
        task.status, task.completed_by, task.completed_at = "Completed", user.user_id, now

    if outcome == "Stop contact":
        _stop(lead.person, note or "Learner asked to stop contact")
        state = "Stop contact"
    elif outcome == "Wrong number":
        state = "Invalid contact"
    elif outcome == "Not interested":
        state = "Not interested"
    elif next_at is not None:
        state = "Later" if outcome == "Later" else None
    else:
        state = data.get("contact_state") or ("Awaiting reply" if outcome == "No answer" else "Next action missing")
    lead.contact_state = state
    lead.next_follow_up_at = next_at
    lead.next_action = data.get("next_action") or (None if next_at is None else lead.next_action)
    if lead.pipeline_entry_id:
        entry = db.session.get(PipelineEntry, lead.pipeline_entry_id)
        if entry and entry.closed_at is None:
            entry.next_follow_up_at = next_at
    db.session.flush()
    db.session.refresh(activity)

    task = None
    if next_at is not None:
        callback = outcome == "Callback requested"
        title = f"{'Callback promised' if callback else 'Next action'} · {lead.person.full_name}"
        task = tasks.create_system_task(
            "CALL" if callback or outcome == "No answer" else "FOLLOW_UP", title, lead.branch_id, next_at,
            owner_user_id=lead.assigned_to or user.user_id, description=lead.next_action,
            dedupe_key=f"{'lead-callback' if callback else 'lead-next'}:{activity.activity_id}", lead_id=lead.lead_id)

    objection = None
    if data.get("objection"):
        objection = LeadObjection(lead_id=lead.lead_id, learner_words=data["objection"]["learner_words"],
                                  category=data["objection"].get("category"), action_taken=data["objection"].get("action_taken"),
                                  created_by=user.user_id)
        db.session.add(objection)

    if data.get("ai_action_id"):
        _mark_used(data["ai_action_id"], lead, result=f"Outcome saved as activity {activity.activity_id}")
    db.session.flush()
    qualification.auto_tick(lead)  # a reached-contact outcome and a dated next action tick their qualification checks
    db.session.refresh(lead)
    return {"lead": lead.to_dict(), "activity": activity.to_dict(), "task": task.to_dict() if task else None,
            "objection": objection.to_dict() if objection else None}


def _mark_used(ai_action_id: int, lead: Lead, *, result: str, final_text: str | None = None) -> AiAction:
    action = db.session.get(AiAction, ai_action_id)
    if action is None or action.lead_id != lead.lead_id:
        raise NotFound("Suggestion not found")
    if action.status in ("Suggested", "Snoozed"):
        edited = final_text is not None and (action.draft_text or "").strip() != final_text.strip()
        action.status = "Edited" if edited else "Used"
        action.final_text = final_text if edited else action.final_text
        action.execution_result = result
    return action


# ---------------------------------------------------------------- objections

def add_objection(lead_id: int, data: dict) -> LeadObjection:
    lead = _contactable(lead_id)
    objection = LeadObjection(lead_id=lead.lead_id, created_by=current_user().user_id, **data)
    db.session.add(objection)
    db.session.flush()
    return objection


def update_objection(objection_id: int, data: dict) -> LeadObjection:
    objection = db.session.get(LeadObjection, objection_id)
    if objection is None:
        raise NotFound("Objection not found")
    _contactable(objection.lead_id)
    if objection.status != "Open":
        raise BusinessRule(f"This objection is already {objection.status.lower()}; record a new one instead")
    if data.get("status", "Open") != "Open" and not data.get("resolution"):
        raise ValidationError("Closing an objection needs the answer given", {"resolution": ["Required"]})
    for field, value in data.items():
        setattr(objection, field, value)
    if "category" in data:
        objection.category_suggested = False
    db.session.flush()
    db.session.refresh(objection)
    return objection


def objection_guide() -> list[dict]:
    return [{"category": c, "ask": a, "next_action": n} for c, (a, n) in OBJECTION_GUIDE.items()]


# ---------------------------------------------------------------- stop contact

def _stop(person: Person, reason: str) -> None:
    if person.stop_contact_at is not None:
        return
    user = current_user()
    person.stop_contact_at, person.stop_contact_by, person.stop_contact_reason = _now(), user.user_id, reason
    # Suppress outreach: open follow-up tasks on the person's leads are cancelled (history kept)
    open_tasks = db.session.execute(select(Task).join(Lead, Lead.lead_id == Task.lead_id).where(
        Lead.person_id == person.person_id, Task.status.in_(OPEN_TASK),
        or_(*[Task.dedupe_key.startswith(k) for k in NEXT_ACTION_KEYS + ("lead-handover:", "recovery:")]))).scalars()
    for task in open_tasks:
        task.status, task.cancel_reason = "Cancelled", "Stop contact recorded"
    db.session.execute(Lead.__table__.update().where(Lead.person_id == person.person_id,
                                                     Lead.stage.not_in(CLOSED_STAGES))
                       .values(next_follow_up_at=None, contact_state="Stop contact"))
    audit.record("PERSON_STOP_CONTACT", "person", person.person_id, new={"reason": reason},
                 branch_id=person.registered_branch_id)


def _person_for_contact(person_id: int) -> Person:
    person = db.session.get(Person, person_id)
    if person is None or not leads_repo.person_visible(person_id, current_user().branch_ids()):
        raise NotFound("Person not found")
    return person


def stop_contact(person_id: int, reason: str) -> Person:
    person = _person_for_contact(person_id)
    user = current_user()
    if not user.has_role("FOUNDER_CEO", "SUPER_ADMIN", "BRANCH_MANAGER", *COUNSELLOR_ROLES):
        raise Forbidden("Only sales staff or managers can record stop contact")
    if person.stop_contact_at is not None:
        raise BusinessRule("Stop contact is already recorded for this person")
    _stop(person, reason)
    db.session.flush()
    return person


def clear_stop_contact(person_id: int, reason: str) -> Person:
    """Only a manager clears suppression, with a reason (e.g. the learner asked to be contacted again)."""
    person = _person_for_contact(person_id)
    user = current_user()
    if not (user.is_admin or user.has_role("BRANCH_MANAGER", branch_id=person.registered_branch_id)):
        raise Forbidden("Only a Branch Manager or admin can clear stop contact")
    if person.stop_contact_at is None:
        raise BusinessRule("Stop contact is not recorded for this person")
    old = {"at": person.stop_contact_at, "reason": person.stop_contact_reason}
    person.stop_contact_at = person.stop_contact_by = person.stop_contact_reason = None
    db.session.execute(Lead.__table__.update().where(Lead.person_id == person.person_id, Lead.contact_state == "Stop contact")
                       .values(contact_state="Next action missing"))
    audit.record("PERSON_STOP_CONTACT_CLEARED", "person", person.person_id, old=old, new={"reason": reason},
                 branch_id=person.registered_branch_id)
    db.session.flush()
    return person


# ---------------------------------------------------------------- reply drafts (approved templates only)

def _template(situation: str, language: str, course_id: int | None, branch_id: int) -> tuple[SalesKnowledge | None, bool]:
    def find(lang: str):
        return db.session.execute(
            select(SalesKnowledge).where(SalesKnowledge.kind == "Reply template", SalesKnowledge.status == "Approved",
                                         SalesKnowledge.situation == situation, SalesKnowledge.language == lang,
                                         or_(SalesKnowledge.course_id.is_(None), SalesKnowledge.course_id == course_id),
                                         or_(SalesKnowledge.branch_id.is_(None), SalesKnowledge.branch_id == branch_id))
            .order_by(SalesKnowledge.course_id.is_(None), SalesKnowledge.branch_id.is_(None))).scalars().first()
    found = find(language)
    if found or language == "English":
        return found, False
    return find("English"), True


def _approved_link(lead: Lead) -> SalesKnowledge | None:
    if lead.course_id is None:
        return None
    return db.session.execute(
        select(SalesKnowledge).where(SalesKnowledge.kind.in_(("Syllabus", "Brochure")), SalesKnowledge.status == "Approved",
                                     SalesKnowledge.course_id == lead.course_id,
                                     or_(SalesKnowledge.branch_id.is_(None), SalesKnowledge.branch_id == lead.branch_id))
        .order_by(SalesKnowledge.kind != "Syllabus", SalesKnowledge.branch_id.is_(None))).scalars().first()


def _location(lead: Lead) -> SalesKnowledge | None:
    return db.session.execute(select(SalesKnowledge).where(
        SalesKnowledge.kind == "Branch location", SalesKnowledge.status == "Approved",
        SalesKnowledge.branch_id == lead.branch_id)).scalars().first()


def _placeholder_values(lead: Lead) -> tuple[dict, list[dict]]:
    """Only recorded, approved facts. A fact we don't have stays a visible {placeholder}."""
    evidence = []
    values = {"name": lead.person.full_name, "branch": lead.branch.branch_name}
    if lead.course:
        values["course"] = lead.course.course_title
    link = _approved_link(lead)
    if link:
        values["approved_link"] = link.link_url
        evidence.append({"type": "sales_knowledge", "id": link.knowledge_id, "version": link.version})
    if lead.next_follow_up_at:
        values["time"] = _local(lead.next_follow_up_at)
    if lead.open_question:
        values["specific_question"] = lead.open_question
    demo = _upcoming_demo(lead.lead_id)
    if demo and demo.status == "Confirmed":
        values["date_time"] = _local(demo.scheduled_at)
        values["branch_or_mode"] = "online" if demo.mode == "Online" else f"Nipuna {lead.branch.branch_name}"
        evidence.append({"type": "demo", "id": demo.demo_id, "status": demo.status})
        if demo.mode == "Online" and demo.meeting_link:
            values["approved_location_or_link"] = f"Join here: {demo.meeting_link}"
        else:
            location = _location(lead)
            if location:
                values["approved_location_or_link"] = location.body + (f" ({location.link_url})" if location.link_url else "")
                evidence.append({"type": "sales_knowledge", "id": location.knowledge_id, "version": location.version})
    return values, evidence


def reply_draft(lead_id: int, situation: str, language: str | None) -> dict:
    lead = _contactable(lead_id)
    require_drafts(lead.branch_id)
    language = language or lead.person.preferred_language
    template, fell_back = _template(situation, language, lead.course_id, lead.branch_id)
    if template is None:
        raise BusinessRule(f"There is no approved reply template for “{situation}”; ask the sales-knowledge owner to add one")
    values, evidence = _placeholder_values(lead)
    missing = sorted({m for m in PLACEHOLDER.findall(template.body) if m not in values})
    text = PLACEHOLDER.sub(lambda m: values.get(m.group(1), m.group(0)), template.body)
    evidence.insert(0, {"type": "sales_knowledge", "id": template.knowledge_id, "version": template.version})
    blocked = contact_policy.check(lead, "WhatsApp")
    user = current_user()
    action = AiAction(action_type="Reply draft", action_code=f"reply:{situation}", fingerprint=fingerprint(text),
                      lead_id=lead.lead_id, person_id=lead.person_id, branch_id=lead.branch_id,
                      owner_user_id=lead.assigned_to, suggestion=f"{situation} reply", draft_text=text,
                      reason=f"Approved template “{template.title}” v{template.version}", evidence=evidence,
                      payload={"situation": situation, "language": template.language, "requested_language": language,
                               "missing": missing, "language_fallback": fell_back},
                      record_version=lead.updated_at, model="template", prompt_version=f"template-{template.knowledge_id}-v{template.version}",
                      policy_version=POLICY_VERSION, expires_at=_now() + timedelta(hours=24), created_by=user.user_id)
    db.session.add(action)
    db.session.flush()
    reasons = ([blocked] if blocked else []) + ([f"Missing approved facts: {', '.join(missing)}. Fill them in or ask the "
                                                 "responsible reviewer"] if missing else [])
    return {"draft": action.to_dict(), "text": text, "missing": missing, "language": template.language,
            "language_fallback": fell_back, "can_send": not reasons, "blocked_reasons": reasons,
            "whatsapp_number": lead.person.whatsapp_number or lead.person.phone}


def record_message(lead_id: int, data: dict) -> dict:
    """Staff sent a message themselves (no provider is connected): recheck the rules now, then record it as
    "Manually recorded" — never as Delivered."""
    lead = _contactable(lead_id)
    contact_policy.require(lead, data["channel"])
    text = data["text"].strip()
    left = PLACEHOLDER.findall(text)
    if left:
        raise BusinessRule(f"The message still has unfilled facts: {', '.join(sorted(set(left)))}")
    action = None
    if data.get("ai_action_id"):
        action = db.session.get(AiAction, data["ai_action_id"])
        if action is None or action.lead_id != lead.lead_id or action.action_type != "Reply draft":
            raise NotFound("Draft not found")
        if action.status != "Suggested":
            raise Conflict("This draft was already used; make a new one")
        if action.expires_at and action.expires_at < _now():
            raise BusinessRule("This draft is more than 24 hours old; make a new one so it uses current facts")
    now = _now()
    activity = leads_service.log_activity(lead, data["channel"], text, direction="Outbound", outcome="Manually recorded",
                                          purpose="Message", occurred_at=now)
    lead.last_contacted_at = now
    db.session.flush()
    db.session.refresh(activity)
    if action:
        _mark_used(action.ai_action_id, lead, result=f"Manually recorded as activity {activity.activity_id}", final_text=text)
    db.session.flush()
    return {"activity": activity.to_dict(), "draft": action.to_dict() if action else None}


# ---------------------------------------------------------------- My work today (spec page 2)

TIER_LABELS = {1: "Now: service deadlines and promised callbacks", 2: "Then: new enquiries, near-term demos, replies",
               3: "Then: post-demo decisions and agreed follow-ups", 4: "Finally: future joining and reactivation"}


def _scope(stmt, user, owner: str | None, branch_id: int | None, owner_col, branch_col):
    branch_ids = user.branch_ids()
    if branch_ids is not None:
        stmt = stmt.where(branch_col.in_(branch_ids))
    if branch_id:
        stmt = stmt.where(branch_col == branch_id)
    managed = user.is_admin or user.has_role("BRANCH_MANAGER")
    if owner == "me" or (owner is None and not managed):
        # a counsellor's own work, plus unassigned leads their branch's Front Office / Sales can pick up
        stmt = stmt.where(or_(owner_col == user.user_id, owner_col.is_(None)))
    elif owner not in (None, "all"):
        stmt = stmt.where(owner_col == int(owner))
    return stmt


def _lead_row(lead: Lead) -> dict:
    return {"lead_id": lead.lead_id, "lead_code": lead.lead_code, "name": lead.person.full_name,
            "phone": lead.person.phone, "course": lead.course.to_summary() if lead.course else None,
            "branch": lead.branch.to_summary(), "stage": lead.stage, "ai_priority": lead.ai_priority,
            "owner": lead.owner.full_name if lead.owner else None, "contact_state": lead.contact_state}


def my_work_today(filters: dict) -> dict:
    user = current_user()
    owner, branch_id = filters.get("owner"), filters.get("branch_id")
    now, end_today = _now(), _end_of_today()
    soon = now + timedelta(minutes=30)
    items: dict[int | str, dict] = {}

    def add(key, tier, kind, title, reason, due_at, lead: Lead | None = None, **links):
        item = items.get(key)
        entry = {"kind": kind, "title": title, "reason": reason}
        if item is None or tier < item["tier"]:
            items[key] = {"key": str(key), "tier": tier, "kind": kind, "title": title, "reason": reason, "due_at": due_at,
                          "overdue": bool(due_at and due_at < now), "lead": _lead_row(lead) if lead else None,
                          **links, "also": (item["also"] + [{k: item[k] for k in ("kind", "title")}]) if item else []}
        else:
            item["also"].append({k: entry[k] for k in ("kind", "title")})

    open_lead = and_(Lead.stage.not_in(CLOSED_STAGES), Person.stop_contact_at.is_(None))
    base = _scope(select(Lead).join(Person, Person.person_id == Lead.person_id), user, owner, branch_id,
                  Lead.assigned_to, Lead.branch_id)

    # 1. first staff attempt pending
    for lead, clock in db.session.execute(
            base.add_columns(LeadResponseClock).join(LeadResponseClock, LeadResponseClock.lead_id == Lead.lead_id)
            .where(open_lead, LeadResponseClock.attempted_at.is_(None), LeadResponseClock.is_eligible,
                   Lead.converted_at.is_(None))).all():
        add(lead.lead_id, 1, "first_attempt", f"First staff attempt · {lead.person.full_name}",
            f"Captured {_local(clock.captured_at)} · {clock.sla_state}", clock.due_at, lead)

    # 1/2. promised callbacks and agreed next actions (tasks)
    task_stmt = _scope(select(Task, Lead).join(Lead, Lead.lead_id == Task.lead_id).join(Person, Person.person_id == Lead.person_id),
                       user, owner, branch_id, Task.owner_user_id, Task.branch_id)
    for task, lead in db.session.execute(task_stmt.where(
            Task.status.in_(OPEN_TASK), open_lead, func.coalesce(Task.revised_due_at, Task.original_due_at) <= end_today,
            or_(*[Task.dedupe_key.startswith(k) for k in NEXT_ACTION_KEYS]))).all():
        due = _task_due(task)
        callback = task.dedupe_key.startswith("lead-callback:")
        tier = 1 if callback and due <= soon else (2 if callback else (4 if lead.ai_priority == "Waiting for Batch / Future Joining"
                                                                     or lead.contact_state == "Later" else 3))
        label = "Promised callback" if callback else ("Agreed payment-date follow-up" if lead.stage == "Fee Discussion / Payment Awaited"
                                                      else "Agreed next action")
        add(lead.lead_id, tier, "callback" if callback else "follow_up", f"{label} · {lead.person.full_name}",
            task.description or lead.next_action or task.title, due, lead, task_id=task.task_id)

    # 2. replies awaiting staff (inbox)
    inbox = select(CommunicationInbox).where(CommunicationInbox.needs_response, CommunicationInbox.sla_state.in_(("Within SLA", "At Risk", "Breached")))
    branch_ids = user.branch_ids()
    if branch_ids is not None:
        inbox = inbox.where(CommunicationInbox.branch_id.in_(branch_ids))
    if branch_id:
        inbox = inbox.where(CommunicationInbox.branch_id == branch_id)
    for row in db.session.execute(inbox).scalars():
        comm = row.communication
        lead = db.session.get(Lead, comm.lead_id) if comm.lead_id else None
        if lead is not None and owner not in (None, "all") and lead.assigned_to not in (None, user.user_id if owner == "me" else int(owner)):
            continue
        if lead is None and (owner == "me" or not (user.is_admin or user.has_role("BRANCH_MANAGER", "FRONT_OFFICE"))):
            continue
        tier = 1 if row.sla_state in ("At Risk", "Breached") else 2
        add(lead.lead_id if lead else f"comm:{comm.communication_id}", tier, "reply",
            f"Reply awaited · {lead.person.full_name if lead else (comm.from_address or 'unmatched contact')}",
            f"Inbound message · {row.sla_state}", comm.response_due_at, lead, communication_id=comm.communication_id)

    # 2. near-term demos (next 24h)
    for demo, lead in db.session.execute(
            _scope(select(Demo, Lead).join(Lead, Lead.lead_id == Demo.lead_id).join(Person, Person.person_id == Lead.person_id),
                   user, owner, branch_id, Lead.assigned_to, Lead.branch_id)
            .where(open_lead, Demo.status.in_(Demo.OPEN_STATUSES), Demo.scheduled_at.between(now, now + timedelta(hours=24)))).all():
        add(lead.lead_id, 2, "demo", f"{'Confirm demo' if demo.status == 'Scheduled' else 'Demo today'} · {lead.person.full_name}",
            f"{demo.demo_code} at {_local(demo.scheduled_at)} · {demo.status}", demo.scheduled_at, lead, demo_id=demo.demo_id)

    # 2/3/4. lead states without a task
    for lead in db.session.execute(base.where(open_lead)).scalars():
        if lead.lead_id in items:
            continue
        due = lead.next_follow_up_at
        if lead.stage == "Demo Attended" and (due is None or due <= now):
            add(lead.lead_id, 3, "post_demo", f"Post-demo decision · {lead.person.full_name}",
                "Demo attended; agree counselling, a fee discussion or a valid decline", due, lead)
        elif due is not None and due <= end_today:
            future = lead.ai_priority == "Waiting for Batch / Future Joining" or lead.contact_state == "Later"
            add(lead.lead_id, 4 if future else 3, "future_joining" if future else "follow_up",
                f"{'Future joining' if future else 'Follow-up due'} · {lead.person.full_name}",
                lead.next_action or f"{lead.stage}", due, lead)
        elif due is None and lead.contact_state == "Next action missing":
            add(lead.lead_id, 3, "next_action_missing", f"Next action missing · {lead.person.full_name}",
                "Contact was saved without a dated next action or a closing state", None, lead)
        elif due is None and lead.contact_state is None and lead.first_staff_attempt_at and lead.stage != "Payment Pending Verification":
            add(lead.lead_id, 3, "next_action_missing", f"No next action · {lead.person.full_name}",
                "No dated next action or status recorded", None, lead)
        elif lead.stage == "New Enquiry" and due is None and lead.contact_state is None:
            add(lead.lead_id, 2, "new_enquiry", f"New enquiry · {lead.person.full_name}", "Understand the need and qualify", None, lead)

    # 4. reactivation due
    for lead in db.session.execute(base.where(Lead.stage == "Lost - closed", Person.stop_contact_at.is_(None),
                                              Lead.reactivation_date <= business_now().date())).scalars():
        if leads_repo.find_open_lead(lead.person_id, lead.course_id, lead.branch_id) is None:
            add(lead.lead_id, 4, "reactivation", f"Reactivation due · {lead.person.full_name}",
                f"Lost: {lead.lost_reason.label if lead.lost_reason else 'no reason'} · review before contacting", None, lead)

    # 4. course suggestions the staff asked to be reminded about
    reminders = select(AiAction).where(AiAction.action_type == "Course suggestion", AiAction.status == "Snoozed",
                                       AiAction.remind_at <= now)
    if branch_ids is not None:
        reminders = reminders.where(AiAction.branch_id.in_(branch_ids))
    if owner == "me" or (owner is None and not (user.is_admin or user.has_role("BRANCH_MANAGER"))):
        reminders = reminders.where(AiAction.disposition_by == user.user_id)
    for action in db.session.execute(reminders).scalars():
        person = db.session.get(Person, action.person_id)
        if person.stop_contact_at is None:
            add(f"course:{action.ai_action_id}", 4, "course_suggestion", f"Course suggestion review · {person.full_name}",
                action.suggestion, action.remind_at, None, person_id=person.person_id, ai_action_id=action.ai_action_id)

    rows = sorted(items.values(), key=lambda i: (i["tier"], i["due_at"] is None, i["due_at"] or now))
    counts = {t: sum(1 for i in rows if i["tier"] == t) for t in TIER_LABELS}
    return {"as_of": now, "tiers": [{"tier": t, "label": label, "count": counts[t]} for t, label in TIER_LABELS.items()],
            "items": rows}


# ---------------------------------------------------------------- shift handover

def handover(filters: dict) -> list[dict]:
    """Before shift end: my open leads with something due today (or overdue), promises and pending first attempts —
    last contact, promise, unresolved question, next time and owner, so the cover person can continue."""
    user = current_user()
    end_today = _end_of_today()
    stmt = (select(Lead).join(Person, Person.person_id == Lead.person_id)
            .where(Lead.stage.not_in(CLOSED_STAGES), Person.stop_contact_at.is_(None),
                   or_(Lead.next_follow_up_at <= end_today,
                       and_(Lead.first_staff_attempt_at.is_(None), Lead.converted_at.is_(None),
                            Lead.intake_status.not_in(("Outreach Prospect", "Invalid-Spam", "Test"))),
                       Lead.contact_state == "Next action missing")))
    stmt = _scope(stmt, user, filters.get("owner") or "me", filters.get("branch_id"), Lead.assigned_to, Lead.branch_id)
    rows = []
    for lead in db.session.execute(stmt.order_by(Lead.next_follow_up_at.asc().nulls_first())).scalars():
        b = brief(lead)
        rows.append({"lead": _lead_row(lead), "last_contact": b["last_discussion"], "promise": b["promised_next_action"],
                     "unresolved": (b["unresolved_objection"] or {}).get("learner_words") or lead.open_question,
                     "next_at": lead.next_follow_up_at,
                     "first_attempt_pending": lead.first_staff_attempt_at is None and lead.converted_at is None})
    return rows


def handover_note(lead_id: int, data: dict) -> dict:
    """A usable note for the authorised cover person. A cover task helps without changing ownership."""
    lead = _contactable(lead_id)
    activity = leads_service.log_activity(lead, "Note", data["note"], purpose="Shift handover", occurred_at=_now())
    db.session.flush()
    db.session.refresh(activity)
    task = None
    if data.get("cover_user_id"):
        leads_service.check_assignee(data["cover_user_id"], lead.branch_id, "cover_user_id")
        due = lead.next_follow_up_at if lead.next_follow_up_at and lead.next_follow_up_at > _now() else _now() + timedelta(minutes=30)
        task = tasks.create_system_task("FOLLOW_UP", f"Cover · {lead.person.full_name}", lead.branch_id, due,
                                        owner_user_id=data["cover_user_id"], description=data["note"],
                                        dedupe_key=f"lead-handover:{activity.activity_id}", lead_id=lead.lead_id)
    return {"activity": activity.to_dict(), "task": task.to_dict() if task else None}
