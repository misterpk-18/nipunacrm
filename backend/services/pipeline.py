"""Deal pipeline (V4): stage chips, board / list over person cards, header stats, next actions, and card stage /
owner / follow-up / expected close.

The database keeps the card and its open courses (leads) on one stage (db 017): moving the card moves them.
"""
from datetime import datetime, timezone
from decimal import Decimal

from config.database import db
from models import Lead, LostReason, PipelineEntry
from models.leads import user_summary
from repositories import pipeline as pipeline_repo
from repositories.common import paginate
from services import audit
from services import leads as leads_service
from services.context import COUNSELLOR_ROLES, current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError

# Open card stages (a card is never at New Enquiry, and leaves the board once Admitted / Lost)
PIPELINE_STAGES = ("Counselling", "Demo Scheduled", "Demo Attended", "Fee Discussion / Payment Awaited",
                   "Payment Pending Verification")
# Stages a card can be moved to by hand (Admitted comes from admitting its last course)
CARD_STAGES = PIPELINE_STAGES + ("Lost - closed",)
# The seven stage chips (V4): the five open stages, then Admitted and Closed lost (all-time per branch)
CHIP_STAGES = PIPELINE_STAGES + ("Admitted", "Lost - closed")
CHIP_LABELS = {"Counselling": "Counselling", "Demo Scheduled": "Demo scheduled", "Demo Attended": "Demo attended",
               "Fee Discussion / Payment Awaited": "Fee discussion", "Payment Pending Verification": "Payment review",
               "Admitted": "Admitted", "Lost - closed": "Closed lost"}
# Board columns: Demo groups both demo stages; Admitted / Lost columns appear only when their chip is chosen
COLUMNS = (("counselling", "Counselling", ("Counselling",)),
           ("demo", "Demo", ("Demo Scheduled", "Demo Attended")),
           ("fee_discussion", "Fee discussion", ("Fee Discussion / Payment Awaited",)),
           ("payment_review", "Payment review", ("Payment Pending Verification",)))
CLOSED_COLUMNS = {"Admitted": ("admitted", "Admitted"), "Lost - closed": ("lost", "Closed lost")}


def board(filters: dict, per_stage: int) -> dict:
    """Stage chips (counts for the selected branch / filters), header stats, and the board columns.
    A `stage` filter narrows the board to that chip; without it every open stage is shown."""
    branch_ids = current_user().branch_ids()
    stage = filters.pop("stage", None)
    counts = pipeline_repo.stage_counts(filters, branch_ids)
    counts.update(pipeline_repo.closed_counts(filters, branch_ids))
    chips = [{"stage": s, "label": CHIP_LABELS[s], "count": counts.get(s, 0)} for s in CHIP_STAGES]

    columns = []
    if stage in CLOSED_COLUMNS:
        key, label = CLOSED_COLUMNS[stage]
        entries = pipeline_repo.stage_cards(filters, branch_ids, (stage,), per_stage, closed=True)
        columns.append(_column(key, label, (stage,), counts.get(stage, 0), entries))
    else:
        for key, label, stages in COLUMNS:
            shown = tuple(s for s in stages if stage in (None, s))
            if not shown:
                continue
            count = sum(counts.get(s, 0) for s in shown)
            entries = pipeline_repo.stage_cards(filters, branch_ids, shown, per_stage) if count else []
            columns.append(_column(key, label, shown, count, entries))

    open_entries = pipeline_repo.open_entries(filters, branch_ids)
    details = card_details(open_entries)
    return {
        "chips": chips, "stage": stage, "columns": columns,
        "total": sum(counts.get(s, 0) for s in PIPELINE_STAGES),
        "stats": {"open_opportunities": len(open_entries),
                  "open_value": sum((d["value"] for d in details.values()), Decimal("0.00")),
                  "admitted": counts.get("Admitted", 0)},
    }


def _column(key: str, label: str, stages: tuple, count: int, entries: list[PipelineEntry]) -> dict:
    details = card_details(entries)
    rows = [card_row(entry, details[entry.pipeline_entry_id]) for entry in entries]
    return {"key": key, "label": label, "stages": list(stages), "count": count,
            "value": sum((details[e.pipeline_entry_id]["value"] for e in entries), Decimal("0.00")), "cards": rows}


def table(filters: dict, page: int, per_page: int):
    stage = filters.pop("stage", None)
    closed = stage in CLOSED_COLUMNS
    if stage:
        filters["stage"] = stage
    entries, meta = paginate(pipeline_repo.table_stmt(filters, current_user().branch_ids(), closed=closed), page, per_page)
    details = card_details(entries)
    return [card_row(entry, details[entry.pipeline_entry_id]) for entry in entries], meta


# ---------------------------------------------------------------- card details (value, delivery plan, invoice)

def _card_leads(entry: PipelineEntry) -> list[Lead]:
    return entry.open_leads if entry.is_open else [lead for lead in entry.leads if lead.stage == entry.stage] or entry.leads


def card_details(entries: list[PipelineEntry]) -> dict[int, dict]:
    """Per card: value (approved fee, else the course's standard fee; the admitted fee once admitted), delivery-plan
    status and the courses' live invoices — in a few batched queries."""
    leads = {entry.pipeline_entry_id: _card_leads(entry) for entry in entries}
    lead_ids = [lead.lead_id for rows in leads.values() for lead in rows]
    prices = pipeline_repo.lead_prices(lead_ids)
    plans = pipeline_repo.lead_plans(lead_ids)
    invoices = pipeline_repo.lead_invoices(lead_ids)
    result = {}
    for entry in entries:
        rows = leads[entry.pipeline_entry_id]
        courses, value, accepted = [], Decimal("0.00"), 0
        for lead in rows:
            price = prices.get(lead.lead_id)
            amount = price["amount"] if price else (lead.course.standard_fee if lead.course else Decimal("0.00"))
            plan = plans.get(lead.lead_id)
            invoice = invoices.get(lead.lead_id)
            accepted += 1 if plan and plan.accepted_at else 0
            value += amount or Decimal("0.00")
            courses.append({
                "lead_id": lead.lead_id, "lead_code": lead.lead_code, "stage": lead.stage,
                "course": lead.course.to_summary() if lead.course else None, "value": amount,
                "price_basis": price["basis"] if price else "Standard fee",
                "delivery_plan": {"plan_code": plan.plan_code, "status": plan.status} if plan else None,
                "invoice": invoice.to_summary() if invoice else None,
            })
        if not rows:
            plan_status = "No courses"
        elif accepted == len(rows):
            plan_status = "Delivery plan accepted"
        elif accepted:
            plan_status = f"Delivery plan {accepted} of {len(rows)} accepted"
        else:
            plan_status = "Delivery plan needed"
        result[entry.pipeline_entry_id] = {"courses": courses, "value": value, "delivery_plan_status": plan_status}
    return result


def card_row(entry: PipelineEntry, details: dict) -> dict:
    return {**entry.to_row(), "courses": details["courses"], "value": details["value"],
            "delivery_plan_status": details["delivery_plan_status"]}


# ---------------------------------------------------------------- next actions

NEXT_ACTIONS = {
    "review_payment": ("Review payment evidence", "A payment claim is waiting for Accounts to verify it."),
    "record_demo_outcome": ("Complete the scheduled demo", "Record attendance, outcome and the next follow-up."),
    "confirm_delivery_plan": ("Confirm the delivery plan", "Agree the branch, learning mode and start window."),
    "prepare_invoice": ("Prepare the invoice", "Approved fee and accepted plan: create the invoice."),
    "follow_up_balance": ("Follow up the balance", "Invoiced with a balance still to collect."),
}
ACTION_ORDER = tuple(NEXT_ACTIONS)


def next_actions(filters: dict) -> list[dict]:
    """One next step per open card in the branch scope, most urgent first (V4 order): pending payment evidence,
    demo outcome, missing accepted delivery plan, invoice preparation, balance follow-up."""
    branch_ids = current_user().branch_ids()
    entries = pipeline_repo.open_entries(filters, branch_ids)
    details = card_details(entries)
    lead_ids = [c["lead_id"] for d in details.values() for c in d["courses"]]
    pending = pipeline_repo.leads_with_pending_payments(lead_ids)
    demos = pipeline_repo.leads_with_open_demos(lead_ids)
    balances = pipeline_repo.invoice_outstanding({c["invoice"]["invoice_id"] for d in details.values()
                                                  for c in d["courses"] if c["invoice"]})
    approved = pipeline_repo.lead_prices(lead_ids)
    actions = []
    for entry in entries:
        courses = details[entry.pipeline_entry_id]["courses"]
        found = None
        for code in ACTION_ORDER:
            for course in courses:
                lead_id, invoice = course["lead_id"], course["invoice"]
                hit = {
                    "review_payment": lead_id in pending,
                    "record_demo_outcome": lead_id in demos,
                    "confirm_delivery_plan": not (course["delivery_plan"] and course["delivery_plan"]["status"] == "Accepted"),
                    "prepare_invoice": invoice is None and (approved.get(lead_id) or {}).get("basis") == "Approved fee",
                    "follow_up_balance": invoice is not None and balances.get(invoice["invoice_id"], 0) > 0,
                }[code]
                if hit:
                    found = (code, course)
                    break
            if found:
                break
        if found is None:
            continue
        code, course = found
        title, detail = NEXT_ACTIONS[code]
        actions.append({
            "action": code, "title": title, "detail": detail, "pipeline_entry_id": entry.pipeline_entry_id,
            "entry_code": entry.entry_code, "stage": entry.stage, "lead_id": course["lead_id"],
            "lead_code": course["lead_code"], "course": course["course"], "person": entry.person.to_summary(),
            "branch": entry.branch.to_summary(), "owner": user_summary(entry.owner),
            "invoice": course["invoice"], "next_follow_up_at": entry.next_follow_up_at,
        })
    far = datetime.max.replace(tzinfo=timezone.utc)
    actions.sort(key=lambda a: (ACTION_ORDER.index(a["action"]), a["next_follow_up_at"] or far, a["pipeline_entry_id"]))
    return actions


# ---------------------------------------------------------------- one card

def get_entry(entry_id: int) -> PipelineEntry:
    entry = db.session.get(PipelineEntry, entry_id)
    if entry is None or not current_user().can_access_branch(entry.branch_id):
        raise NotFound("Pipeline card not found")
    return entry


def _workable(entry_id: int) -> PipelineEntry:
    """Owner, branch manager, admin — or any counsellor of the branch while the card is unassigned."""
    entry = get_entry(entry_id)
    user = current_user()
    if not (user.is_manager_of(entry.branch_id) or entry.assigned_to == user.user_id
            or (entry.assigned_to is None and user.has_role(*COUNSELLOR_ROLES, branch_id=entry.branch_id))):
        raise Forbidden("Only the card's owner or a branch manager can do this")
    if not entry.is_open:
        raise BusinessRule(f"Pipeline card is closed ({entry.stage})")
    return entry


def _reload(entry: PipelineEntry) -> PipelineEntry:
    """Triggers changed the card and its leads in the database; drop the stale copies."""
    db.session.flush()
    for lead in entry.leads:
        db.session.expire(lead)
    db.session.refresh(entry)
    return entry


def change_stage(entry_id: int, data: dict) -> PipelineEntry:
    entry = _workable(entry_id)
    stage = data["stage"]
    old_stage = entry.stage
    if stage == "Payment Pending Verification":
        missing = [lead.lead_code for lead in entry.open_leads if lead.course_id is None]
        if missing:
            raise BusinessRule("Every course on the card needs a course first",
                               {"missing_fields": ["course_id"], "leads": missing})

    if stage == "Lost - closed":
        reason = db.session.get(LostReason, data.get("lost_reason_id") or 0)
        if reason is None or not reason.is_active:
            raise ValidationError("A lost reason is required", {"lost_reason_id": ["Not an active reason"]})
        entry.lost_reason_id = reason.lost_reason_id
        entry.lost_competitor = data.get("lost_competitor")
        entry.lost_notes = data.get("lost_notes")
        entry.reactivation_date = data.get("reactivation_date")
        entry.next_follow_up_at = None

    open_leads = entry.open_leads
    entry.stage = stage  # the DB moves every open course and blocks moving back from Payment Pending Verification
    if data.get("note"):
        for lead in open_leads:
            leads_service.log_activity(lead, "Note", data["note"])
    _reload(entry)
    audit.record("PIPELINE_STAGE_CHANGED", "pipeline_entry", entry_id, old={"stage": old_stage},
                 new={"stage": stage}, branch_id=entry.branch_id)
    return entry


def update_entry(entry_id: int, data: dict) -> PipelineEntry:
    """Owner (branch managers only), next follow-up (both copied to the card's open courses) and expected close."""
    entry = _workable(entry_id)
    if "assigned_to" in data and data["assigned_to"] != entry.assigned_to:
        if not current_user().is_manager_of(entry.branch_id):
            raise Forbidden("Only a branch manager can change the card's owner")
        leads_service.check_assignee(data["assigned_to"], entry.branch_id)
        audit.record("PIPELINE_ASSIGNED", "pipeline_entry", entry_id, old={"assigned_to": entry.assigned_to},
                     new={"assigned_to": data["assigned_to"]}, branch_id=entry.branch_id)
        entry.assigned_to = data["assigned_to"]
        for lead in entry.open_leads:
            leads_service.assign_to(lead, data["assigned_to"])
    if data.get("next_follow_up_at") is not None:
        if data["next_follow_up_at"] <= datetime.now(timezone.utc):
            raise ValidationError("Follow-up must be in the future", {"next_follow_up_at": ["Must be in the future"]})
        entry.next_follow_up_at = data["next_follow_up_at"]
        for lead in entry.open_leads:
            lead.next_follow_up_at = data["next_follow_up_at"]
    if "expected_close_date" in data:
        if data["expected_close_date"] and data["expected_close_date"] < datetime.now(timezone.utc).date():
            raise ValidationError("Expected close can't be in the past", {"expected_close_date": ["Today or later"]})
        entry.expected_close_date = data["expected_close_date"]
    return _reload(entry)
