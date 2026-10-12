"""Delivery plan per course deal (db 020): draft → accepted, reopen until invoiced.

The database numbers plans (DP-00001), refuses plans for unconverted or closed deals, freezes an accepted plan and
requires a start date for a Future Plan. Invoicing a course needs its accepted plan; the admission copies it.
"""
import logging
from datetime import date, datetime, timezone

from sqlalchemy import func, select

from config.database import db
from models import Branch, DeliveryPlan, Invoice, InvoiceLine, Lead, LeadActivity, OfferableBatch, WhatsappOutbox
from models.leads import CLOSED_STAGES
from services import audit, playbook, whatsapp, whatsapp_events
from services import leads as leads_service
from services.context import COUNSELLOR_ROLES, current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError

PLAN_FIELDS = ("service_branch_id", "delivery_mode", "seat_type", "planned_start_date", "capacity_review", "notes",
               "preferred_lms_batch_code", "preferred_lms_batch_label")
NULLABLE_FIELDS = ("planned_start_date", "notes", "preferred_lms_batch_code", "preferred_lms_batch_label")
ACCEPTANCE_METHODS = ("in_person", "call", "whatsapp")
METHOD_LABELS = {"in_person": "in person", "call": "on a call", "whatsapp": "on WhatsApp"}
CONFIRM_SOURCE = "delivery_plan_confirm"
logger = logging.getLogger(__name__)


def plan_for(lead_id: int) -> DeliveryPlan | None:
    return db.session.execute(select(DeliveryPlan).where(DeliveryPlan.lead_id == lead_id)).scalar_one_or_none()


def live_invoice_for(lead_id: int) -> Invoice | None:
    stmt = (select(Invoice).join(InvoiceLine, InvoiceLine.invoice_id == Invoice.invoice_id)
            .where(InvoiceLine.lead_id == lead_id, Invoice.status == "Issued"))
    return db.session.execute(stmt).scalars().first()


def _last_confirmation(plan: DeliveryPlan) -> WhatsappOutbox | None:
    return db.session.execute(select(WhatsappOutbox).where(
        WhatsappOutbox.source_type == CONFIRM_SOURCE, WhatsappOutbox.source_id == plan.delivery_plan_id)
        .order_by(WhatsappOutbox.outbox_id.desc()).limit(1)).scalar_one_or_none()


def _confirmation(plan: DeliveryPlan | None) -> dict | None:
    """The latest "Reply YES" message for the plan: awaiting the learner's reply, or why it never went out."""
    row = _last_confirmation(plan) if plan is not None else None
    if row is None:
        return None
    return {"outbox_id": row.outbox_id, "status": row.status, "requested_at": row.created_at, "sent_at": row.sent_at,
            "problem": row.skip_reason or row.last_error, "awaiting_reply": plan.confirmation_requested_at is not None}


def get(lead_id: int) -> dict:
    lead = leads_service.get_lead(lead_id)
    plan = plan_for(lead_id)
    invoice = live_invoice_for(lead_id)
    return {"lead_id": lead.lead_id, "plan": plan.to_dict() if plan else None,
            "invoice": invoice.to_summary() if invoice else None,
            "can_edit": _can_plan(lead) and lead.converted_at is not None and lead.is_open and invoice is None,
            "confirmation": _confirmation(plan),
            "whatsapp": {"sending": whatsapp.configured(),
                         "has_number": whatsapp.recipient_phone(lead.person) is not None}}


def batch_hints(lead_id: int, branch_id: int | None = None) -> dict:
    """Upcoming LMS batches of the deal's course at the service branch (the Lead 360 batch list): the start-date hints."""
    lead = leads_service.get_lead(lead_id)
    if not _can_plan(lead):
        raise Forbidden("Only the deal's owner or a branch manager can plan delivery")
    branch = branch_id or (plan_for(lead_id).service_branch_id if plan_for(lead_id) else lead.branch_id)
    return {"lead_id": lead.lead_id, "branch_id": branch,
            "batches": [b.to_dict() for b in playbook.batches_for(lead.course_id, branch)]}


def _can_plan(lead: Lead) -> bool:
    """Sales side (owner / counsellors) or the branch manager."""
    user = current_user()
    return (leads_service.can_work(lead) or user.is_manager_of(lead.branch_id)
            or user.has_role(*COUNSELLOR_ROLES, branch_id=lead.branch_id))


def _editable(lead_id: int) -> tuple[Lead, DeliveryPlan | None]:
    lead = leads_service.get_lead(lead_id)
    if not _can_plan(lead):
        raise Forbidden("Only the deal's owner or a branch manager can plan delivery")
    if lead.converted_at is None:
        raise BusinessRule(f"Convert {lead.lead_code} to a deal before planning delivery",
                           {"missing_fields": ["converted_at"]})
    if not lead.is_open:
        raise BusinessRule(f"Deal {lead.lead_code} is {lead.stage}")
    invoice = live_invoice_for(lead_id)
    if invoice is not None:
        raise BusinessRule(f"The course is invoiced on {invoice.invoice_number}; its delivery plan is fixed",
                           {"invoice_id": invoice.invoice_id})
    return lead, plan_for(lead_id)


def _check(data: dict) -> None:
    if data.get("service_branch_id") is not None:
        branch = db.session.get(Branch, data["service_branch_id"])
        if branch is None or not branch.is_active:
            raise ValidationError("Unknown branch", {"service_branch_id": ["Not an active branch"]})
    if data.get("planned_start_date") and data["planned_start_date"] < date.today():
        raise ValidationError("The planned start can't be in the past", {"planned_start_date": ["Today or later"]})


def _check_preferred_batch(lead: Lead, plan: DeliveryPlan | None, data: dict) -> None:
    """A newly preferred batch must be an offerable LMS batch of this course at the service branch."""
    code = data.get("preferred_lms_batch_code")
    if not code or (plan is not None and plan.preferred_lms_batch_code == code):
        return
    branch_id = data.get("service_branch_id") or (plan.service_branch_id if plan else lead.branch_id)
    batch = db.session.execute(select(OfferableBatch).where(
        OfferableBatch.lms_course_id == code, OfferableBatch.course_id == lead.course_id,
        OfferableBatch.branch_id == branch_id)).scalar_one_or_none()
    if batch is None:
        raise ValidationError("That batch isn't an upcoming batch of this course at the service branch",
                              {"preferred_lms_batch_code": ["Unknown batch"]})
    if not batch.is_offerable:
        raise ValidationError(f"{code} can't be offered: {batch.not_offerable_reason}",
                              {"preferred_lms_batch_code": [batch.not_offerable_reason or "Not offerable"]})
    if not data.get("preferred_lms_batch_label"):
        data["preferred_lms_batch_label"] = f"{batch.timing()} · from {batch.start_date:%d %b %Y}"


def _snapshot(plan: DeliveryPlan | None) -> tuple | None:
    return None if plan is None else tuple(getattr(plan, field) for field in PLAN_FIELDS)


def ready_for_confirmation(plan: DeliveryPlan) -> bool:
    """Complete enough to put to the learner: mode, seat, service branch and start date set, not accepted, and no
    request waiting for the learner's reply."""
    return (plan.accepted_at is None and plan.confirmation_requested_at is None and bool(plan.delivery_mode)
            and bool(plan.seat_type) and plan.service_branch_id is not None and plan.planned_start_date is not None)


def _confirm_automatically(lead: Lead, plan: DeliveryPlan) -> None:
    """A saved plan that is ready goes to the learner for their YES by itself: the first time it is ready, or after an
    edit withdrew the earlier request. Staff can still press "Send for confirmation" to resend. Never breaks the save."""
    if not ready_for_confirmation(plan) or whatsapp.recipient_phone(lead.person) is None:
        return
    try:
        with db.session.begin_nested():
            send_for_confirmation(lead.lead_id)
    except Exception:
        logger.exception("Could not send delivery plan %s for confirmation automatically", plan.plan_code)


def save(lead_id: int, data: dict, *, auto_confirm: bool = True) -> dict:
    """Create or edit the draft (an accepted plan must be reopened first). A plan that is then ready for the learner
    is sent for their WhatsApp confirmation automatically."""
    lead, plan = _editable(lead_id)
    _check(data)
    if plan is not None and plan.accepted_at is not None:
        raise BusinessRule(f"Delivery plan {plan.plan_code} is accepted; reopen it to change it")
    if "preferred_lms_batch_code" in data and not data["preferred_lms_batch_code"]:
        data["preferred_lms_batch_code"] = data["preferred_lms_batch_label"] = None  # clearing the preference
    _check_preferred_batch(lead, plan, data)
    before = _snapshot(plan)
    if plan is None:
        if not data.get("delivery_mode"):
            raise ValidationError("Choose the delivery mode", {"delivery_mode": ["Required"]})
        plan = DeliveryPlan(lead_id=lead.lead_id, service_branch_id=data.get("service_branch_id") or lead.branch_id,
                            delivery_mode=data["delivery_mode"], seat_type=data.get("seat_type") or "Confirmed Seat",
                            planned_start_date=data.get("planned_start_date"),
                            capacity_review=data.get("capacity_review") or "Waiting", notes=data.get("notes"),
                            preferred_lms_batch_code=data.get("preferred_lms_batch_code"),
                            preferred_lms_batch_label=data.get("preferred_lms_batch_label"),
                            created_by=current_user().user_id)
        db.session.add(plan)
    else:
        for field in PLAN_FIELDS:
            if field in data and (data[field] is not None or field in NULLABLE_FIELDS):
                setattr(plan, field, data[field])
        if plan.confirmation_requested_at is not None and _snapshot(plan) != before:
            plan.confirmation_requested_at = None  # the learner was asked about an older version of the plan
    if plan.seat_type == "Future Plan" and plan.planned_start_date is None:
        raise ValidationError("A future plan needs a planned start date", {"planned_start_date": ["Required"]})
    db.session.flush()
    db.session.refresh(plan)
    if auto_confirm:
        _confirm_automatically(lead, plan)
    return get(lead_id)


def accept(lead_id: int, data: dict) -> dict:
    """Student acceptance captured: the plan is fixed (the course can now be invoiced)."""
    method = data.get("acceptance_method")
    if method not in (None, "in_person", "call"):
        raise ValidationError("Staff can record an in-person or on-call acceptance; WhatsApp acceptance comes from the "
                              "learner's reply", {"acceptance_method": ["in_person or call"]})
    changes = {field: data[field] for field in PLAN_FIELDS if field in data}
    if changes or plan_for(lead_id) is None:
        save(lead_id, changes, auto_confirm=False)
    lead, plan = _editable(lead_id)
    if plan is None:
        raise BusinessRule("Save the delivery plan first")
    if plan.accepted_at is not None:
        raise BusinessRule(f"Delivery plan {plan.plan_code} is already accepted")
    if not data.get("student_accepted"):
        raise ValidationError("Capture the student's acceptance of this plan", {"student_accepted": ["Must be ticked"]})
    plan.student_accepted = True
    plan.accepted_by = current_user().user_id
    plan.acceptance_method = method
    plan.accepted_at = datetime.now(timezone.utc)
    db.session.flush()
    db.session.refresh(plan)
    how = f" ({METHOD_LABELS[method]})" if method else ""
    leads_service.log_activity(lead, "Note", f"Delivery plan {plan.plan_code} accepted{how}: {plan.delivery_mode}, "
                                             f"{plan.seat_type} at {plan.service_branch.branch_name}")
    audit.record("DELIVERY_PLAN_ACCEPTED", "lead", lead.lead_id,
                 new={"plan_code": plan.plan_code, "delivery_mode": plan.delivery_mode, "seat_type": plan.seat_type,
                      "service_branch_id": plan.service_branch_id, "acceptance_method": method},
                 branch_id=lead.branch_id)
    whatsapp_events.delivery_plan_accepted(lead, plan)
    return get(lead_id)


def reopen(lead_id: int, reason: str) -> dict:
    lead, plan = _editable(lead_id)
    if plan is None or plan.accepted_at is None:
        raise NotFound("No accepted delivery plan to reopen")
    plan.accepted_at = None  # the DB clears the acceptance
    db.session.flush()
    db.session.refresh(plan)
    audit.record("DELIVERY_PLAN_REOPENED", "lead", lead.lead_id, reason=reason, new={"plan_code": plan.plan_code},
                 branch_id=lead.branch_id)
    return get(lead_id)


# ---------------------------------------------------------------- learner confirmation on WhatsApp

def send_for_confirmation(lead_id: int) -> dict:
    """Queue the "Reply YES to confirm" message (nipuna_delivery_plan_confirm_v1). The learner's YES reply then accepts
    the plan (accept_by_whatsapp). Editing the plan afterwards withdraws the request."""
    lead, plan = _editable(lead_id)
    if plan is None:
        raise BusinessRule("Save the delivery plan first")
    if plan.accepted_at is not None:
        raise BusinessRule(f"Delivery plan {plan.plan_code} is already accepted")
    if whatsapp.recipient_phone(lead.person) is None:
        raise BusinessRule(f"{lead.person.full_name} has no WhatsApp number on file; add one, or record the "
                           "acceptance as given in person or on a call")
    attempt = db.session.execute(select(func.count()).select_from(WhatsappOutbox).where(
        WhatsappOutbox.source_type == CONFIRM_SOURCE, WhatsappOutbox.source_id == plan.delivery_plan_id)).scalar() + 1
    row = whatsapp_events.delivery_plan_confirmation(lead, plan, attempt)
    if row is None:
        raise BusinessRule("The confirmation message could not be queued; record the acceptance manually instead")
    plan.confirmation_requested_at = datetime.now(timezone.utc)
    db.session.flush()
    db.session.refresh(plan)
    leads_service.log_activity(lead, "Note", f"Delivery plan {plan.plan_code} sent to the learner on WhatsApp for "
                                             "confirmation (reply YES)")
    audit.record("DELIVERY_PLAN_CONFIRMATION_SENT", "lead", lead.lead_id, new={"plan_code": plan.plan_code, "attempt": attempt},
                 branch_id=lead.branch_id)
    return get(lead_id)


def awaiting_confirmation(person_id: int) -> DeliveryPlan | None:
    """The person's latest plan that was sent for confirmation and is still waiting for the learner's YES."""
    stmt = (select(DeliveryPlan).join(Lead, Lead.lead_id == DeliveryPlan.lead_id)
            .where(Lead.person_id == person_id, Lead.converted_at.is_not(None), Lead.stage.not_in(CLOSED_STAGES),
                   DeliveryPlan.accepted_at.is_(None), DeliveryPlan.confirmation_requested_at.is_not(None))
            .order_by(DeliveryPlan.confirmation_requested_at.desc(), DeliveryPlan.delivery_plan_id.desc()).limit(1))
    return db.session.execute(stmt).scalar_one_or_none()


def accept_by_whatsapp(person_id: int, replied_at: datetime | None = None, communication_id: int | None = None) -> DeliveryPlan | None:
    """The learner replied YES: capture the acceptance of their latest plan awaiting confirmation (no staff user).
    None when there is nothing to confirm, or the reply is older than the request."""
    plan = awaiting_confirmation(person_id)
    if plan is None:
        return None
    if replied_at is not None and replied_at < plan.confirmation_requested_at:
        return None  # a YES sent before the plan was put to the learner
    if live_invoice_for(plan.lead_id) is not None:
        return None
    lead = db.session.get(Lead, plan.lead_id)
    plan.student_accepted = True
    plan.accepted_by = None
    plan.acceptance_method = "whatsapp"
    plan.accepted_at = datetime.now(timezone.utc)
    db.session.flush()
    db.session.refresh(plan)
    db.session.add(LeadActivity(
        lead_id=lead.lead_id, activity_type="Note", communication_id=communication_id,
        summary=f"Delivery plan {plan.plan_code} accepted on WhatsApp: the learner replied YES "
                f"({plan.delivery_mode}, {plan.seat_type} at {plan.service_branch.branch_name})"))
    audit.record("DELIVERY_PLAN_ACCEPTED", "lead", lead.lead_id,
                 new={"plan_code": plan.plan_code, "delivery_mode": plan.delivery_mode, "seat_type": plan.seat_type,
                      "service_branch_id": plan.service_branch_id, "acceptance_method": "whatsapp"},
                 branch_id=lead.branch_id, actor_user_id=None)
    return plan
