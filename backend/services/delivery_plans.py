"""Delivery plan per course deal (db 020): draft → accepted, reopen until invoiced.

The database numbers plans (DP-00001), refuses plans for unconverted or closed deals, freezes an accepted plan and
requires a start date for a Future Plan. Invoicing a course needs its accepted plan; the admission copies it.
"""
from datetime import date, datetime, timezone

from sqlalchemy import select

from config.database import db
from models import Branch, DeliveryPlan, Invoice, InvoiceLine, Lead
from services import audit
from services import leads as leads_service
from services.context import COUNSELLOR_ROLES, current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError

PLAN_FIELDS = ("service_branch_id", "delivery_mode", "seat_type", "planned_start_date", "capacity_review", "notes")


def plan_for(lead_id: int) -> DeliveryPlan | None:
    return db.session.execute(select(DeliveryPlan).where(DeliveryPlan.lead_id == lead_id)).scalar_one_or_none()


def live_invoice_for(lead_id: int) -> Invoice | None:
    stmt = (select(Invoice).join(InvoiceLine, InvoiceLine.invoice_id == Invoice.invoice_id)
            .where(InvoiceLine.lead_id == lead_id, Invoice.status == "Issued"))
    return db.session.execute(stmt).scalars().first()


def get(lead_id: int) -> dict:
    lead = leads_service.get_lead(lead_id)
    plan = plan_for(lead_id)
    invoice = live_invoice_for(lead_id)
    return {"lead_id": lead.lead_id, "plan": plan.to_dict() if plan else None,
            "invoice": invoice.to_summary() if invoice else None,
            "can_edit": _can_plan(lead) and lead.converted_at is not None and lead.is_open and invoice is None}


def _can_plan(lead: Lead) -> bool:
    """Sales side (owner / counsellors), the branch manager or the academic coordinator."""
    user = current_user()
    return (leads_service.can_work(lead) or user.is_manager_of(lead.branch_id)
            or user.has_role(*COUNSELLOR_ROLES, "ACADEMIC_COORDINATOR", branch_id=lead.branch_id))


def _editable(lead_id: int) -> tuple[Lead, DeliveryPlan | None]:
    lead = leads_service.get_lead(lead_id)
    if not _can_plan(lead):
        raise Forbidden("Only the deal's owner, a branch manager or the academic coordinator can plan delivery")
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


def save(lead_id: int, data: dict) -> dict:
    """Create or edit the draft (an accepted plan must be reopened first)."""
    lead, plan = _editable(lead_id)
    _check(data)
    if plan is not None and plan.accepted_at is not None:
        raise BusinessRule(f"Delivery plan {plan.plan_code} is accepted; reopen it to change it")
    if plan is None:
        if not data.get("delivery_mode"):
            raise ValidationError("Choose the delivery mode", {"delivery_mode": ["Required"]})
        plan = DeliveryPlan(lead_id=lead.lead_id, service_branch_id=data.get("service_branch_id") or lead.branch_id,
                            delivery_mode=data["delivery_mode"], seat_type=data.get("seat_type") or "Confirmed Seat",
                            planned_start_date=data.get("planned_start_date"),
                            capacity_review=data.get("capacity_review") or "Waiting", notes=data.get("notes"),
                            created_by=current_user().user_id)
        db.session.add(plan)
    else:
        for field in PLAN_FIELDS:
            if field in data and (data[field] is not None or field in ("planned_start_date", "notes")):
                setattr(plan, field, data[field])
    if plan.seat_type == "Future Plan" and plan.planned_start_date is None:
        raise ValidationError("A future plan needs a planned start date", {"planned_start_date": ["Required"]})
    db.session.flush()
    db.session.refresh(plan)
    return get(lead_id)


def accept(lead_id: int, data: dict) -> dict:
    """Student acceptance captured: the plan is fixed (the course can now be invoiced)."""
    changes = {field: data[field] for field in PLAN_FIELDS if field in data}
    if changes or plan_for(lead_id) is None:
        save(lead_id, changes)
    lead, plan = _editable(lead_id)
    if plan is None:
        raise BusinessRule("Save the delivery plan first")
    if plan.accepted_at is not None:
        raise BusinessRule(f"Delivery plan {plan.plan_code} is already accepted")
    if not data.get("student_accepted"):
        raise ValidationError("Capture the student's acceptance of this plan", {"student_accepted": ["Must be ticked"]})
    plan.student_accepted = True
    plan.accepted_by = current_user().user_id
    plan.accepted_at = datetime.now(timezone.utc)
    db.session.flush()
    db.session.refresh(plan)
    leads_service.log_activity(lead, "Note", f"Delivery plan {plan.plan_code} accepted: {plan.delivery_mode}, "
                                             f"{plan.seat_type} at {plan.service_branch.branch_name}")
    audit.record("DELIVERY_PLAN_ACCEPTED", "lead", lead.lead_id,
                 new={"plan_code": plan.plan_code, "delivery_mode": plan.delivery_mode, "seat_type": plan.seat_type,
                      "service_branch_id": plan.service_branch_id}, branch_id=lead.branch_id)
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
