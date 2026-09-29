"""Fee discussions, frozen versions and special closing requests (SCR). The delivery plan is per course deal
(services/delivery_plans.py) and the payment schedule is set on the invoice (db 020–021).

The database computes version numbers, the 70% advisory floor, validity and final payable; it freezes amounts,
refuses an Approved version with extra concession / below floor unless a matching SCR is Approved, checks the
approver's concession limit, blocks self-approval and requires an independent approval below the floor.
"""
from datetime import date
from decimal import Decimal

from sqlalchemy import select

from config.database import db
from models import (
    Course, FeeDiscussion, FeeDiscussionVersion, Offer, PaymentPlan, SpecialClosingRequest,
)
from repositories import fees as fees_repo
from services import audit, notifications, tasks
from services import leads as leads_service
from services.context import ADMIN_ROLES, COUNSELLOR_ROLES, current_user
from services.errors import BusinessRule, Conflict, Forbidden, NotFound, ValidationError

EDITABLE_VERSION_STATUSES = ("Discussion Saved", "Counteroffered", "Pending Approval")
EARLY_STAGES = ("New Enquiry", "Counselling", "Demo Scheduled", "Demo Attended")
CENT = Decimal("0.01")


# ---------------------------------------------------------------- access

def _sales_side(branch_id: int) -> bool:
    user = current_user()
    return user.is_manager_of(branch_id) or user.has_role(*COUNSELLOR_ROLES, branch_id=branch_id)


def get_discussion(discussion_id: int) -> FeeDiscussion:
    discussion = db.session.get(FeeDiscussion, discussion_id)
    if discussion is None or not current_user().can_access_branch(discussion.branch_id):
        raise NotFound("Fee discussion not found")
    return discussion


def get_version(version_id: int) -> FeeDiscussionVersion:
    version = db.session.get(FeeDiscussionVersion, version_id)
    if version is None or not current_user().can_access_branch(version.discussion.branch_id):
        raise NotFound("Fee version not found")
    return version


def get_scr(scr_id: int) -> SpecialClosingRequest:
    scr = db.session.get(SpecialClosingRequest, scr_id)
    if scr is None or not current_user().can_access_branch(scr.version.discussion.branch_id):
        raise NotFound("Special closing request not found")
    return scr


def _workable_discussion(discussion_id: int) -> FeeDiscussion:
    discussion = get_discussion(discussion_id)
    if not _sales_side(discussion.branch_id):
        raise Forbidden("Only counsellors or a branch manager can work on fee discussions")
    if discussion.milestone in FeeDiscussion.CLOSED_MILESTONES:
        raise BusinessRule(f"Fee discussion {discussion.discussion_code} is {discussion.milestone}")
    return discussion


# ---------------------------------------------------------------- discussions

def list_for_lead(lead_id: int) -> list[FeeDiscussion]:
    leads_service.get_lead(lead_id)
    return fees_repo.discussions_for_lead(lead_id)


def start_discussion(lead_id: int, data: dict) -> FeeDiscussion:
    lead = leads_service.get_lead(lead_id)
    if not _sales_side(lead.branch_id):
        raise Forbidden("Only counsellors or a branch manager can start a fee discussion")
    if not lead.is_open:
        raise BusinessRule(f"Lead is {lead.stage}")
    leads_service.require_converted(lead, "starting a fee discussion")
    course_id = data.get("course_id") or lead.course_id
    if course_id is None:
        raise ValidationError("Choose the course being priced", {"course_id": ["Required (the lead has no course)"]})
    course = db.session.get(Course, course_id)
    if course is None or course.status != "Active":
        raise ValidationError("Unknown or inactive course", {"course_id": ["Not an active course"]})
    existing = fees_repo.open_discussion(lead.lead_id, course_id)
    if existing is not None:
        raise Conflict(f"There is already an open fee discussion for this course: {existing.discussion_code}",
                       {"fee_discussion_id": existing.fee_discussion_id})

    counsellor_id = data.get("counsellor_id") or lead.assigned_to
    if counsellor_id is not None:
        leads_service.check_assignee(counsellor_id, lead.branch_id, field="counsellor_id")
    discussion = FeeDiscussion(lead_id=lead.lead_id, course_id=course_id, branch_id=lead.branch_id,
                               counsellor_id=counsellor_id)
    db.session.add(discussion)
    db.session.flush()
    db.session.refresh(discussion)
    if lead.stage in EARLY_STAGES:
        lead.stage = "Fee Discussion / Payment Awaited"
    db.session.flush()
    return discussion


def used_offers(discussion: FeeDiscussion) -> list[dict]:
    """Offers this discussion's person has already used — each offer can be used only once per person."""
    return fees_repo.used_offers(discussion.lead.person_id)


def applicable_offers(discussion: FeeDiscussion) -> list[Offer]:
    """Active offers for the course and branch today, minus offers the person has already used."""
    used = {u["offer_code"] for u in used_offers(discussion)}
    offers = fees_repo.applicable_offers(discussion.branch_id, discussion.course_id, date.today())
    return [o for o in offers if o.offer_code not in used]


def check_offer_not_used(discussion: FeeDiscussion, offer: Offer | None) -> None:
    if offer is None:
        return
    used = next((u for u in used_offers(discussion) if u["offer_code"] == offer.offer_code), None)
    if used:
        raise BusinessRule(f"Offer {offer.offer_code} has already been used by this person (admission "
                           f"{used['admission_code']}); an offer can be used only once per person",
                           {"offer_id": ["Already used by this person"]})


def _offer_discount(offer: Offer, standard_fee: Decimal) -> Decimal:
    if offer.benefit_type == "Discount Amount":
        return min(offer.discount_amount, standard_fee)
    if offer.benefit_type == "Discount Percent":
        return (standard_fee * offer.discount_percent / 100).quantize(CENT)
    return Decimal("0.00")  # complimentary course: no discount on this fee


def _plan_for(data: dict) -> PaymentPlan:
    """The version's plan is informational now (db 021): the invoice carries the real 1–3 instalment schedule."""
    plan_id = data.get("payment_plan_id")
    if plan_id:
        plan = db.session.get(PaymentPlan, plan_id)
    else:
        plan = db.session.execute(select(PaymentPlan).where(PaymentPlan.plan_code == "FULL")).scalar_one_or_none()
    if plan is None or not plan.is_active:
        raise ValidationError("Unknown or inactive payment plan", {"payment_plan_id": ["Not an active plan"]})
    return plan


def add_version(discussion_id: int, data: dict) -> FeeDiscussionVersion:
    """New version with the course's standard fee, the chosen offer and any extra concession. Earlier open
    versions are superseded; amounts on this one are frozen once saved."""
    discussion = _workable_discussion(discussion_id)
    if discussion.milestone == "Invoice Issued":
        raise BusinessRule("The course is invoiced; cancel the unpaid invoice to change its price, or request a "
                           "fee change after admission")

    standard_fee = discussion.course.standard_fee
    offer_discount = Decimal("0.00")
    if data.get("offer_id"):
        check_offer_not_used(discussion, db.session.get(Offer, data["offer_id"]))
        offer = next((o for o in applicable_offers(discussion) if o.offer_id == data["offer_id"]), None)
        if offer is None:
            raise ValidationError("That offer isn't active for this course and branch today",
                                  {"offer_id": ["Not applicable"]})
        offer_discount = _offer_discount(offer, standard_fee)
    extra = data.get("extra_concession", Decimal("0.00"))
    if standard_fee - offer_discount - extra < 0:
        raise ValidationError("Discounts can't exceed the standard fee", {"extra_concession": ["Too large"]})

    plan = _plan_for(data)
    if data.get("valid_until") and data["valid_until"] < date.today():
        raise ValidationError("Validity can't be in the past", {"valid_until": ["Must be today or later"]})

    for old in discussion.versions:
        if old.status in EDITABLE_VERSION_STATUSES or old.status == "Approved":
            old.status = "Superseded"
    version = FeeDiscussionVersion(
        fee_discussion_id=discussion.fee_discussion_id, standard_fee=standard_fee, offer_id=data.get("offer_id"),
        offer_discount=offer_discount, extra_concession=extra, payment_plan_id=plan.payment_plan_id,
        valid_until=data.get("valid_until"), notes=data.get("notes"), created_by=current_user().user_id,
    )
    db.session.add(version)
    if discussion.milestone != "In Discussion":
        discussion.milestone = "In Discussion"  # a new price reopens the discussion
    db.session.flush()
    db.session.refresh(version)  # version_no, floor, final payable and validity come from a trigger
    db.session.refresh(discussion)
    return version


def share(discussion_id: int) -> FeeDiscussion:
    discussion = _workable_discussion(discussion_id)
    current = discussion.current_version
    if current is None or current.status != "Approved":
        raise BusinessRule("Share the fee once the current version is Approved")
    if discussion.milestone not in ("Approved", "Fee Shared"):
        raise BusinessRule(f"Fee discussion is at {discussion.milestone}")
    discussion.milestone = "Fee Shared"  # trigger stamps fee_shared_at
    db.session.flush()
    db.session.refresh(discussion)
    return discussion


# ---------------------------------------------------------------- version approval

def approve_version(version_id: int) -> FeeDiscussionVersion:
    """Standard-price versions can be approved by the counsellor; one with extra concession or below the floor
    needs its special closing request Approved first (the DB checks this)."""
    version = get_version(version_id)
    discussion = version.discussion
    if not _sales_side(discussion.branch_id):
        raise Forbidden("Only counsellors or a branch manager can approve fee versions")
    if version.status not in EDITABLE_VERSION_STATUSES:
        raise BusinessRule(f"Version {version.version_no} is {version.status}")
    if version.valid_until < date.today():
        raise BusinessRule(f"Version {version.version_no} expired on {version.valid_until}")
    _approve(version)
    return version


def _approve(version: FeeDiscussionVersion) -> None:
    discussion = version.discussion
    version.status = "Approved"
    if discussion.milestone == "In Discussion":
        discussion.milestone = "Approved"
    db.session.flush()
    audit.record("FEE_VERSION_APPROVED", "fee_version", version.version_id,
                 new={"version_no": version.version_no, "final_payable": version.final_payable,
                      "extra_concession": version.extra_concession}, branch_id=discussion.branch_id)


# ---------------------------------------------------------------- special closing requests

def approver_limit(user_id: int, branch_id: int, standard_fee: Decimal) -> Decimal | None:
    """Highest extra the user may approve here: None = unlimited; Decimal(-1) = no authority."""
    limits = fees_repo.approver_limits(user_id, branch_id)
    if not limits:
        return Decimal(-1)
    best = Decimal(-1)
    for limit in limits:
        if limit.max_amount is None and limit.max_percent is None:
            return None
        candidates = [x for x in (limit.max_amount,
                                  (standard_fee * limit.max_percent / 100).quantize(CENT)
                                  if limit.max_percent is not None else None) if x is not None]
        best = max(best, min(candidates))
    return best


def request_special_closing(version_id: int, data: dict) -> SpecialClosingRequest:
    version = get_version(version_id)
    discussion = version.discussion
    if not _sales_side(discussion.branch_id):
        raise Forbidden("Only counsellors or a branch manager can request special closing")
    if version.status not in ("Discussion Saved", "Counteroffered"):
        raise BusinessRule(f"Version {version.version_no} is {version.status}")
    if discussion.current_version.version_id != version.version_id:
        raise BusinessRule("Only the current version can go for approval")
    if not version.needs_special_closing:
        raise BusinessRule("This version has no extra concession and isn't below the floor; approve it directly")
    requested = data.get("requested_extra", version.extra_concession)
    if requested < version.extra_concession:
        raise ValidationError("Request at least the version's extra concession",
                              {"requested_extra": [f"Must be {version.extra_concession} or more"]})

    scr = SpecialClosingRequest(version_id=version.version_id, requested_extra=requested,
                                request_reason=data["request_reason"], requested_by=current_user().user_id)
    db.session.add(scr)
    version.status = "Pending Approval"
    db.session.flush()
    db.session.refresh(scr)  # code and 5-staffed-minute decision due time come from triggers

    title = f"Approve special closing {scr.scr_code} · {discussion.lead.person.full_name} · ₹{requested}"
    notifications.notify("SCR_PENDING", event_key=f"scr.created:{scr.scr_code}", entity_type="special_closing_request",
                         entity_id=scr.scr_id, branch_id=discussion.branch_id, title=title)
    tasks.create_system_task("APPROVAL", title, discussion.branch_id, scr.decision_due_at,
                             team_role_code="BRANCH_MANAGER", dedupe_key=f"scr:{scr.scr_id}", scr_id=scr.scr_id)
    audit.record("SCR_REQUESTED", "special_closing_request", scr.scr_id,
                 new={"version_id": version.version_id, "requested_extra": requested}, branch_id=discussion.branch_id)
    return scr


def list_scrs(filters: dict, page: int, per_page: int):
    """Queues: can_approve (pending, within my limit), higher_approval (pending, beyond it), all."""
    user = current_user()
    queue = filters.pop("queue", "all")
    if queue != "all":
        filters["status"] = "Pending"
    scrs = list(db.session.execute(fees_repo.scr_stmt(filters, user.branch_ids())).scalars())
    if queue in ("can_approve", "higher_approval"):
        scrs = [s for s in scrs if (queue == "can_approve") == _can_decide(s, user.user_id)]
    total = len(scrs)
    start = (page - 1) * per_page
    return scrs[start:start + per_page], {"page": page, "per_page": per_page, "total": total,
                                          "pages": (total + per_page - 1) // per_page}


def _can_decide(scr: SpecialClosingRequest, user_id: int) -> bool:
    if scr.requested_by == user_id:
        return False
    version = scr.version
    branch_id = version.discussion.branch_id
    if version.is_below_floor and not current_user().has_role(*ADMIN_ROLES, branch_id=branch_id):
        return False
    limit = approver_limit(user_id, branch_id, version.standard_fee)
    return limit is None or scr.requested_extra <= limit


def _pending(scr_id: int) -> SpecialClosingRequest:
    scr = get_scr(scr_id)
    if scr.status != "Pending":
        raise BusinessRule(f"{scr.scr_code} is {scr.status}")
    if scr.requested_by == current_user().user_id:
        raise Forbidden("You can't decide your own special closing request")
    return scr


def _close_scr_work(scr: SpecialClosingRequest) -> None:
    tasks.complete_system_task(f"scr:{scr.scr_id}")
    notifications.complete_for("special_closing_request", scr.scr_id)


def approve_scr(scr_id: int, data: dict) -> SpecialClosingRequest:
    """Approving applies the concession: the version becomes Approved in the same step."""
    scr = _pending(scr_id)
    user = current_user()
    scr.status = "Approved"
    scr.decided_by = user.user_id
    scr.decision_reason = data.get("decision_reason")
    scr.independent_approved_by = data.get("independent_approved_by")
    db.session.flush()  # DB checks the approver's limit and the below-floor independent approval
    _approve(scr.version)
    _close_scr_work(scr)
    audit.record("SCR_APPROVED", "special_closing_request", scr.scr_id,
                 new={"requested_extra": scr.requested_extra, "independent_approved_by": scr.independent_approved_by},
                 branch_id=scr.version.discussion.branch_id)
    db.session.refresh(scr)
    return scr


def counteroffer_scr(scr_id: int, data: dict) -> SpecialClosingRequest:
    scr = _pending(scr_id)
    if data["counter_extra"] >= scr.requested_extra:
        raise ValidationError("A counteroffer must be lower than the request", {"counter_extra": ["Too high"]})
    scr.status = "Counteroffered"
    scr.counter_extra = data["counter_extra"]
    scr.decided_by = current_user().user_id
    scr.decision_reason = data.get("decision_reason")
    scr.version.status = "Counteroffered"
    db.session.flush()  # DB checks the counter amount against the approver's limit
    _close_scr_work(scr)
    audit.record("SCR_COUNTEROFFERED", "special_closing_request", scr.scr_id,
                 new={"counter_extra": scr.counter_extra}, branch_id=scr.version.discussion.branch_id)
    db.session.refresh(scr)
    return scr


def reject_scr(scr_id: int, reason: str) -> SpecialClosingRequest:
    scr = _pending(scr_id)
    scr.status = "Rejected"
    scr.decided_by = current_user().user_id
    scr.decision_reason = reason
    scr.version.status = "Rejected"
    db.session.flush()
    _close_scr_work(scr)
    audit.record("SCR_REJECTED", "special_closing_request", scr.scr_id, reason=reason,
                 branch_id=scr.version.discussion.branch_id)
    db.session.refresh(scr)
    return scr

