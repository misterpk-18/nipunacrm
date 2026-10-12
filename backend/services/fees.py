"""Fee discussions, frozen versions and special closing requests (SCR). The delivery plan is per course deal
(services/delivery_plans.py) and the payment schedule is set on the invoice (db 020–021).

The database computes version numbers, the 70% advisory floor, validity and final payable; it freezes amounts,
refuses an Approved version with extra concession / below floor unless a matching SCR is Approved, checks the
approver's concession limit, blocks self-approval and requires an independent approval below the floor.
"""
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, select

from config.database import db
from models import (
    Course, FeeDiscussion, FeeDiscussionVersion, Offer, PaymentPlan, SpecialClosingRequest, Task,
)
from repositories import fees as fees_repo
from services import audit, notifications, sla, staff_alerts, tasks
from services import leads as leads_service
from services import offers as offers_service
from services import reports as reports_service
from services.context import ADMIN_ROLES, COUNSELLOR_ROLES, current_user
from services.errors import BusinessRule, Conflict, Forbidden, NotFound, ValidationError

EDITABLE_VERSION_STATUSES = ("Discussion Saved", "Counteroffered", "Pending Approval")
LIVE_VERSION_STATUSES = EDITABLE_VERSION_STATUSES + ("Approved",)  # versions whose 7-day validity still matters
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


def offer_options(discussion: FeeDiscussion) -> dict:
    """Eligible offers (with saving and final price, best one flagged) and the unavailable ones with their reason."""
    return offers_service.options_for(discussion.branch_id, discussion.course_id, discussion.lead.person_id,
                                      discussion.course.standard_fee, date.today())


def applicable_offers(discussion: FeeDiscussion) -> list[Offer]:
    """Active offers for the course and branch today, minus offers the person has already used or can't take."""
    ids = [o["offer_id"] for o in offer_options(discussion)["eligible"]]
    offers = fees_repo.offers_by_ids(ids)
    return sorted(offers, key=lambda o: o.offer_code)


def check_offer_not_used(discussion: FeeDiscussion, offer: Offer | None) -> None:
    if offer is None:
        return
    used = next((u for u in used_offers(discussion) if u["offer_code"] == offer.offer_code), None)
    if used:
        raise BusinessRule(f"Offer {offer.offer_code} has already been used by this person (admission "
                           f"{used['admission_code']}); an offer can be used only once per person",
                           {"offer_id": ["Already used by this person"]})


def _offer_discount(offer: Offer, standard_fee: Decimal) -> Decimal:
    return offers_service.discount_for(offer, standard_fee)


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
        if old.status in LIVE_VERSION_STATUSES:
            old.status = "Superseded"
            tasks.complete_system_task(f"fee-expiry:{old.version_id}")
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
    if data.get("request_reason") and version.needs_special_closing:
        # Save and ask for approval in one step (the counsellor never leaves the fee screen)
        request_special_closing(version.version_id, {"request_reason": data["request_reason"],
                                                     "requested_extra": version.extra_concession})
        db.session.refresh(version)
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
    staff_alerts.approval_waiting(scr)  # WhatsApp to the approvers who may decide it
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



# ---------------------------------------------------------------- 7-day validity, expiry reminders, re-issue

def business_today() -> date:
    return reports_service.business_now().date()


def validity(version: FeeDiscussionVersion, discussion: FeeDiscussion | None = None) -> dict:
    """The countdown shown on the fee discussion and the deal. state: valid | expiring (≤ 1 day) | expired | closed."""
    discussion = discussion or version.discussion
    days = (version.valid_until - business_today()).days
    superseded = version.status in ("Superseded", "Rejected")
    closed = superseded or discussion.milestone in ("Invoice Issued", "Converted", "Cancelled")
    expired = version.status == "Expired" or (version.status in LIVE_VERSION_STATUSES and days < 0)
    if expired and not closed:
        label = "Expired today" if days == 0 else f"Expired {abs(days)} day{'s' if abs(days) != 1 else ''} ago"
        state = "expired"
    elif closed:
        label, state = None, "closed"
    elif days == 0:
        label, state = "Valid until today", "expiring"
    else:
        label, state = f"Valid {days} more day{'s' if days != 1 else ''}", "expiring" if days == 1 else "valid"
    return {"valid_until": version.valid_until, "days_left": max(days, 0) if state != "expired" else 0,
            "state": state, "label": label}


def discussion_payload(discussion: FeeDiscussion) -> dict:
    """discussion.to_dict() with each version's validity countdown added."""
    data = discussion.to_dict()
    by_id = {v.version_id: validity(v, discussion) for v in discussion.versions}
    for v in data["versions"]:
        v["validity"] = by_id[v["version_id"]]
    if data["current_version"]:
        data["current_version"]["validity"] = by_id[data["current_version"]["version_id"]]
    return data


def expiry_reminders() -> int:
    """One task per fee version for its owner the day before it expires (or on the day, if the job missed a run)."""
    today = business_today()
    rows = db.session.execute(
        select(FeeDiscussionVersion).where(FeeDiscussionVersion.valid_until.in_((today, today + timedelta(days=1))),
                                           FeeDiscussionVersion.status.in_(LIVE_VERSION_STATUSES))
    ).scalars().all()
    created = 0
    for version in rows:
        discussion = version.discussion
        if (discussion.current_version.version_id != version.version_id
                or discussion.milestone in FeeDiscussion.CLOSED_MILESTONES + ("Invoice Issued",)):
            continue
        owner = discussion.counsellor_id or discussion.lead.assigned_to
        remind_day = max(version.valid_until - timedelta(days=1), today)
        when = "today" if version.valid_until == today else "tomorrow"
        key = f"fee-expiry:{version.version_id}"
        before = db.session.execute(select(func.count()).select_from(Task).where(Task.dedupe_key == key)).scalar_one()
        tasks.create_system_task(
            "FEE_DISCUSSION",
            f"Fee for {discussion.lead.person.full_name} expires {when} · {discussion.discussion_code} "
            f"v{version.version_no} · ₹{version.final_payable}: close it or re-issue",
            discussion.branch_id, sla.working_day_end(discussion.branch_id, remind_day), owner_user_id=owner,
            team_role_code=None if owner else "BRANCH_MANAGER", dedupe_key=key, fee_discussion_id=discussion.fee_discussion_id)
        created += 0 if before else 1
    db.session.flush()
    return created


def reissue_info(discussion: FeeDiscussion) -> dict:
    """Whether the lapsed current version can be re-issued at the same price, or what changed since."""
    info = {"available": False, "same_price": False, "changes": [], "new_final_payable": None, "offer_id": None}
    version = discussion.current_version
    if (version is None or discussion.milestone in FeeDiscussion.CLOSED_MILESTONES + ("Invoice Issued",)
            or validity(version, discussion)["state"] != "expired"):
        return info
    standard = discussion.course.standard_fee
    changes, offer_discount, offer_id = [], Decimal("0.00"), None
    if standard != version.standard_fee:
        changes.append(f"The course's standard fee is now ₹{standard} (it was ₹{version.standard_fee})")
    if version.offer is not None:
        options = offer_options(discussion)
        code = version.offer.offer_code
        match = next((o for o in options["eligible"] if o["offer_code"] == code), None)
        if match is None:
            reason = next((u["reason"] for u in options["unavailable"] if u["offer_code"] == code),
                          "it is no longer active")
            changes.append(f"Offer {version.offer.offer_name} is no longer available: {reason}")
        else:
            offer_id, offer_discount = match["offer_id"], match["saving"]
            if offer_discount != version.offer_discount:
                changes.append(f"Offer {version.offer.offer_name} now saves ₹{offer_discount} (it saved ₹{version.offer_discount})")
    new_final = standard - offer_discount - version.extra_concession
    if new_final != version.final_payable:
        changes.append(f"The price would now be ₹{new_final} (it was ₹{version.final_payable})")
    return {"available": True, "same_price": not changes, "changes": changes,
            "new_final_payable": new_final, "offer_id": offer_id}


def reissue(discussion_id: int) -> FeeDiscussionVersion:
    """One-click: a new version with the lapsed one's offer and extra concession, if that gives the same price."""
    discussion = _workable_discussion(discussion_id)
    info = reissue_info(discussion)
    if not info["available"]:
        raise BusinessRule("The current fee version is still valid, so there is nothing to re-issue")
    if not info["same_price"]:
        raise BusinessRule("The same price is no longer available: " + "; ".join(info["changes"]))
    old = discussion.current_version
    version = add_version(discussion_id, {
        "offer_id": info["offer_id"], "extra_concession": old.extra_concession,
        "payment_plan_id": old.payment_plan_id, "notes": f"Re-issued from v{old.version_no} at the same price",
    })
    audit.record("FEE_VERSION_REISSUED", "fee_version", version.version_id,
                 new={"from_version_no": old.version_no, "version_no": version.version_no,
                      "final_payable": version.final_payable}, branch_id=discussion.branch_id)
    return version


# ---------------------------------------------------------------- inline concession check

def _inr(amount: Decimal) -> str:
    whole = f"{int(amount):d}"
    head, tail = whole[:-3], whole[-3:]
    while len(head) > 2:
        head, tail = head[:-2], head[-2:] + "," + tail
    return "₹" + (f"{head},{tail}" if head else tail)


def price_preview(discussion_id: int, offer_id: int | None, extra: Decimal) -> dict:
    """Live check while the counsellor types a concession: the price, whether it needs approval, from which role, and
    the caller's own limit. Uses the same limits and floor the approval itself is checked against."""
    discussion = get_discussion(discussion_id)
    standard = discussion.course.standard_fee
    offer_discount = Decimal("0.00")
    if offer_id:
        match = next((o for o in offer_options(discussion)["eligible"] if o["offer_id"] == offer_id), None)
        if match is None:
            raise ValidationError("That offer isn't available for this deal", {"offer_id": ["Not applicable"]})
        offer_discount = match["saving"]
    final = standard - offer_discount - extra
    if final < 0:
        raise ValidationError("Discounts can't exceed the standard fee", {"extra_concession": ["Too large"]})
    floor = (standard * Decimal("0.70")).quantize(CENT)
    below_floor = final < floor
    needs = extra > 0 or below_floor

    mine = approver_limit(current_user().user_id, discussion.branch_id, standard)
    my_label = "unlimited" if mine is None else _inr(max(mine, Decimal(0)))
    within = mine is None or (mine >= 0 and extra <= mine and not below_floor)

    # the lowest-limit role that could approve this amount (below the floor: only Founder / CEO or Super Admin)
    candidates = []
    for limit in fees_repo.concession_limits():
        unlimited = limit.max_amount is None and limit.max_percent is None
        caps = [x for x in (limit.max_amount, (standard * limit.max_percent / 100).quantize(CENT)
                            if limit.max_percent is not None else None) if x is not None]
        cap = None if unlimited else min(caps)
        if (cap is None or extra <= cap) and (not below_floor or limit.role.role_code in ADMIN_ROLES):
            candidates.append((cap is None, cap or Decimal(0), limit.role))
    candidates.sort(key=lambda c: (c[0], c[1]))
    role = candidates[0][2] if candidates else None

    if not needs:
        message = "No approval needed"
    elif below_floor:
        message = (f"Below the 70% floor ({_inr(floor)}): needs Founder / CEO or Super Admin plus a second "
                   f"approver (your limit {my_label})")
    elif role is None:
        message = f"Beyond every approver's limit (your limit {my_label})"
    else:
        message = f"Needs approval from {role.role_name} (your limit {my_label})"
    return {
        "standard_fee": standard, "offer_discount": offer_discount, "extra_concession": extra, "final_payable": final,
        "minimum_floor": floor, "below_floor": below_floor, "needs_approval": needs,
        "my_limit": None if mine is None else max(mine, Decimal(0)), "my_limit_unlimited": mine is None,
        "within_my_limit": within and needs, "approver_role": role.role_code if role and needs else None,
        "approver_role_name": role.role_name if role and needs else None,
        "second_approver_required": below_floor, "message": message,
    }
