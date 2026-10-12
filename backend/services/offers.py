"""Offer Master: versioned campaigns. Draft / Configured versions are editable; Active ones are replaced by a new version."""
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import func, select

from config.database import db
from models import Admission, Branch, Course, Offer, OfferBranch, OfferComplimentaryCourse, OfferCourse
from repositories import fees as fees_repo
from services import audit
from services.context import current_user
from services.errors import BusinessRule, Conflict, NotFound, ValidationError

BASE_FIELDS = ("offer_name", "description", "benefit_type", "discount_amount", "discount_percent",
               "allows_stacking", "qualifying_payment_rule", "valid_from", "valid_to", "status")


def list_offers(filters: dict) -> list[Offer]:
    stmt = select(Offer).order_by(Offer.offer_code, Offer.version.desc())
    if filters.get("status"):
        stmt = stmt.where(Offer.status == filters["status"])
    if filters.get("offer_code"):
        stmt = stmt.where(Offer.offer_code == filters["offer_code"])
    return list(db.session.execute(stmt).scalars())


def get_offer(offer_id: int) -> Offer:
    offer = db.session.get(Offer, offer_id)
    if offer is None:
        raise NotFound("Offer not found")
    return offer


def _editable(offer_id: int) -> Offer:
    offer = get_offer(offer_id)
    if offer.status not in Offer.EDITABLE_STATUSES:
        raise BusinessRule(f"Offer is {offer.status}; create a new version to change it")
    return offer


def create_offer(data: dict) -> Offer:
    exists = db.session.execute(select(Offer.offer_id).where(Offer.offer_code == data["offer_code"])).first()
    if exists:
        raise Conflict("This offer code already exists; create a new version of it instead")

    offer = Offer(offer_code=data["offer_code"], version=1, created_by=current_user().user_id,
                  applies_to_all_branches=data.get("applies_to_all_branches", True),
                  applies_to_all_courses=data.get("applies_to_all_courses", False),
                  **{f: data[f] for f in BASE_FIELDS if f in data})
    db.session.add(offer)
    _apply_scope(offer, data)
    if "complimentary_courses" in data:
        _apply_complimentary(offer, data["complimentary_courses"])
    db.session.flush()  # DB checks benefit amount / percent and date order
    audit.record("OFFER_CREATED", "offer", offer.offer_id, new=offer.to_dict())
    return offer


def update_offer(offer_id: int, data: dict) -> Offer:
    offer = _editable(offer_id)
    old = offer.to_dict()
    for field in BASE_FIELDS:
        if field in data:
            setattr(offer, field, data[field])
    db.session.flush()
    audit.record("OFFER_UPDATED", "offer", offer_id, old=old, new=offer.to_dict())
    return offer


def new_version(offer_id: int) -> Offer:
    """Copy an offer into the next Draft version (the way to change an Active offer)."""
    source = get_offer(offer_id)
    next_version = db.session.execute(
        select(func.max(Offer.version)).where(Offer.offer_code == source.offer_code)
    ).scalar() + 1

    copy = Offer(offer_code=source.offer_code, version=next_version, status="Draft", created_by=current_user().user_id,
                 applies_to_all_branches=source.applies_to_all_branches,
                 applies_to_all_courses=source.applies_to_all_courses,
                 **{f: getattr(source, f) for f in BASE_FIELDS if f != "status"})
    copy.branch_links = [OfferBranch(branch_id=link.branch_id) for link in source.branch_links]
    copy.course_links = [OfferCourse(course_id=link.course_id) for link in source.course_links]
    copy.complimentary_courses = [
        OfferComplimentaryCourse(course_id=c.course_id, min_final_fee=c.min_final_fee, access_period_days=c.access_period_days)
        for c in source.complimentary_courses
    ]
    db.session.add(copy)
    db.session.flush()
    audit.record("OFFER_VERSION_CREATED", "offer", copy.offer_id, new={"from_offer_id": offer_id, "version": next_version})
    return copy


def activate(offer_id: int) -> Offer:
    offer = get_offer(offer_id)
    if offer.status == "Active":
        raise BusinessRule("Offer is already active")
    if offer.status == "Expired":
        raise BusinessRule("Expired offers can't be reactivated; create a new version")
    if offer.valid_from is None or offer.valid_to is None:
        raise ValidationError("Set valid_from and valid_to before activating")
    if offer.valid_to < date.today():
        raise BusinessRule("The offer's end date has passed")
    if offer.benefit_type == "Complimentary Course" and not offer.complimentary_courses:
        raise ValidationError("Add at least one complimentary course before activating")
    if not offer.applies_to_all_courses and not offer.course_links and offer.benefit_type != "Complimentary Course":
        raise ValidationError("Choose the courses this offer applies to, or apply it to all courses")

    # The new version replaces any other active version of the same offer
    for other in db.session.execute(
        select(Offer).where(Offer.offer_code == offer.offer_code, Offer.status == "Active", Offer.offer_id != offer_id)
    ).scalars():
        other.status = "Inactive"
        audit.record("OFFER_DEACTIVATED", "offer", other.offer_id, reason=f"Replaced by version {offer.version}")

    offer.status = "Active"
    offer.approved_by = current_user().user_id
    offer.approved_at = datetime.now(timezone.utc)
    db.session.flush()
    audit.record("OFFER_ACTIVATED", "offer", offer_id, new={"version": offer.version})
    return offer


def deactivate(offer_id: int) -> Offer:
    offer = get_offer(offer_id)
    if offer.status != "Active":
        raise BusinessRule("Only an active offer can be deactivated")
    offer.status = "Inactive"
    db.session.flush()
    audit.record("OFFER_DEACTIVATED", "offer", offer_id)
    return offer


def set_scope(offer_id: int, data: dict) -> Offer:
    offer = _editable(offer_id)
    old = offer.to_dict()
    _apply_scope(offer, data)
    db.session.flush()
    audit.record("OFFER_SCOPE_SET", "offer", offer_id,
                 old={k: old[k] for k in ("applies_to_all_branches", "branch_ids", "applies_to_all_courses")},
                 new={k: offer.to_dict()[k] for k in ("applies_to_all_branches", "branch_ids", "applies_to_all_courses")})
    return offer


def set_complimentary(offer_id: int, courses: list[dict]) -> Offer:
    offer = _editable(offer_id)
    _apply_complimentary(offer, courses)
    db.session.flush()
    audit.record("OFFER_COMPLIMENTARY_SET", "offer", offer_id, new={"complimentary_courses": courses})
    return offer


def _apply_scope(offer: Offer, data: dict) -> None:
    if "applies_to_all_branches" in data:
        offer.applies_to_all_branches = data["applies_to_all_branches"]
    if "applies_to_all_courses" in data:
        offer.applies_to_all_courses = data["applies_to_all_courses"]

    if offer.applies_to_all_branches:
        offer.branch_links = []
    elif "branch_ids" in data:
        _require_ids(Branch, Branch.branch_id, data["branch_ids"], "branch_ids")
        offer.branch_links = [OfferBranch(branch_id=i) for i in data["branch_ids"]]
    if not offer.applies_to_all_branches and not offer.branch_links:
        raise ValidationError("Choose at least one branch, or apply the offer to all branches", {"branch_ids": ["Required"]})

    if offer.applies_to_all_courses:
        offer.course_links = []
    elif "course_ids" in data:
        _require_ids(Course, Course.course_id, data["course_ids"], "course_ids")
        offer.course_links = [OfferCourse(course_id=i) for i in data["course_ids"]]


def _apply_complimentary(offer: Offer, courses: list[dict]) -> None:
    course_ids = [c["course_id"] for c in courses]
    if len(course_ids) != len(set(course_ids)):
        raise ValidationError("A course can appear only once", {"complimentary_courses": ["Duplicate course_id"]})
    _require_ids(Course, Course.course_id, course_ids, "complimentary_courses")
    offer.complimentary_courses = [
        OfferComplimentaryCourse(course_id=c["course_id"], min_final_fee=c["min_final_fee"],
                                 access_period_days=c.get("access_period_days"))
        for c in courses
    ]


def _require_ids(model, column, ids: list[int], field: str) -> None:
    found = set(db.session.execute(select(column).where(column.in_(ids))).scalars())
    missing = set(ids) - found
    if missing:
        raise ValidationError(f"Unknown {field}", {field: [f"Not found: {sorted(missing)}"]})


# ---------------------------------------------------------------- eligibility for a fee discussion

CENT = Decimal("0.01")


def discount_for(offer: Offer, standard_fee: Decimal) -> Decimal:
    """Rupees an offer takes off the standard fee (a complimentary course takes nothing off this fee)."""
    if offer.benefit_type == "Discount Amount":
        return min(offer.discount_amount, standard_fee)
    if offer.benefit_type == "Discount Percent":
        return (standard_fee * offer.discount_percent / 100).quantize(CENT)
    return Decimal("0.00")


def _held_course_ids(person_id: int) -> set[int]:
    """Courses the person already has an admission for (cancelled ones don't count — same rule as the database)."""
    return set(db.session.execute(select(Admission.course_id).where(
        Admission.person_id == person_id, Admission.enrolment_status != "Cancelled")).scalars())


def _why_not(offer: Offer, branch_id: int, course_id: int, on_date: date, used: dict[str, dict]) -> str | None:
    """Plain-words reason the offer can't be applied to this deal today, or None if it can."""
    if offer.valid_from and offer.valid_from > on_date:
        return f"Starts on {offer.valid_from:%d %b %Y}"
    if offer.valid_to and offer.valid_to < on_date:
        return f"Ended on {offer.valid_to:%d %b %Y}"
    if not offer.applies_to_all_branches and branch_id not in {link.branch_id for link in offer.branch_links}:
        return "Not offered at this branch"
    if not offer.applies_to_all_courses and course_id not in {link.course_id for link in offer.course_links}:
        return "Doesn't apply to this course"
    if offer.offer_code in used:
        return (f"Already used by this learner on {used[offer.offer_code]['admission_code']} "
                "(an offer can be used only once per person)")
    return None


def options_for(branch_id: int, course_id: int, person_id: int, standard_fee: Decimal, on_date: date) -> dict:
    """Every Active offer sorted into eligible (with its saving and the final price) and unavailable (with the reason).

    The best offer is the eligible discount with the largest saving that still leaves the learner at or above the
    70% floor (an offer below the floor would need a special closing, so it is never auto-picked). Complimentary-course
    offers save nothing on this fee, so they are listed but never auto-picked; one is eligible only while the learner
    lacks at least one of its courses.
    """
    used = {u["offer_code"]: u for u in fees_repo.used_offers(person_id)}
    held = _held_course_ids(person_id)
    floor = (standard_fee * Decimal("0.70")).quantize(CENT)
    active = db.session.execute(select(Offer).where(Offer.status == "Active").order_by(Offer.offer_code)).scalars()

    eligible, unavailable = [], []
    for offer in active:
        reason = _why_not(offer, branch_id, course_id, on_date, used)
        compl = []
        if reason is None and offer.benefit_type == "Complimentary Course":
            compl = [c for c in offer.complimentary_courses if c.course_id not in held]
            if not compl:
                reason = "The learner already has every complimentary course this offer gives"
        if reason is not None:
            unavailable.append({"offer_id": offer.offer_id, "offer_code": offer.offer_code,
                                "offer_name": offer.offer_name, "reason": reason})
            continue
        saving = discount_for(offer, standard_fee)
        final = standard_fee - saving
        eligible.append({
            "offer_id": offer.offer_id, "offer_code": offer.offer_code, "offer_name": offer.offer_name,
            "benefit_type": offer.benefit_type, "discount_amount": offer.discount_amount,
            "discount_percent": offer.discount_percent, "valid_to": offer.valid_to,
            "saving": saving, "final_price": final, "below_floor": final < floor, "is_best": False,
            "complimentary_courses": [{"course_id": c.course_id, "course_title": c.course.course_title,
                                       "min_final_fee": c.min_final_fee} for c in compl],
        })

    eligible.sort(key=lambda o: (-o["saving"], o["offer_code"]))
    best = next((o for o in eligible if o["saving"] > 0 and not o["below_floor"]), None)
    if best is not None:
        best["is_best"] = True
    return {"eligible": eligible, "unavailable": unavailable, "best_offer_id": best["offer_id"] if best else None}
