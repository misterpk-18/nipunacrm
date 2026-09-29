"""Qualification checklist and Convert to deal (db 019).

A lead reaches the pipeline only through conversion: all six checks reviewed → Mark Qualified → Convert, which
moves the chosen courses (the lead's own plus any others) to Counselling on the person's card at that branch.
Conversion creates no admission, receipt or LMS access. The database refuses pipeline stages for unconverted
leads, freezes the checklist once qualified and keeps one open card per person per branch.
"""
from datetime import date, datetime, timezone

from sqlalchemy import select, text

from config.database import db
from models import Lead, LeadQualificationReview, PipelineEntry
from models.enums import QUALIFICATION_CHECKS
from repositories import leads as leads_repo
from services import audit
from services import leads as leads_service
from services.context import current_user
from services.errors import BusinessRule, Conflict, Forbidden, ValidationError

# What each check means (shown under the tick)
CHECK_HINTS = {
    "Genuine intent confirmed": "The person really wants to study, not only asking for information",
    "Reachable contact confirmed": "Phone / WhatsApp answered or verified",
    "Intended course(s) understood": "Which course or courses they want",
    "Branch and delivery mode discussed": "Where and how they will study",
    "Exact next action agreed": "The next step and its date are agreed with the person",
    "Possible identity match reviewed": "Similar persons checked by hand — never merged automatically",
}


def _reviews(lead_id: int) -> dict[str, LeadQualificationReview]:
    rows = db.session.execute(select(LeadQualificationReview).where(LeadQualificationReview.lead_id == lead_id)).scalars()
    return {row.check_code: row for row in rows}


def checklist(lead_id: int) -> dict:
    lead = leads_service.get_lead(lead_id)
    reviews = _reviews(lead_id)
    checks = []
    for code in QUALIFICATION_CHECKS:
        row = reviews.get(code)
        checks.append({
            "check": code, "hint": CHECK_HINTS[code], "reviewed": row is not None,
            "reviewed_by": {"user_id": row.reviewer.user_id, "full_name": row.reviewer.full_name} if row else None,
            "reviewed_at": row.reviewed_at if row else None, "notes": row.notes if row else None,
        })
    backfilled = lead.qualified_at is not None and not reviews
    return {
        "lead_id": lead.lead_id, "checks": checks,
        "complete": all(c["reviewed"] for c in checks) or backfilled,
        "qualified_at": lead.qualified_at, "qualified_by": lead.qualified_by,
        "converted_at": lead.converted_at, "pipeline_entry_id": lead.pipeline_entry_id,
        "can_convert": lead.qualified_at is not None and lead.converted_at is None and lead.stage == "New Enquiry",
    }


def _workable_unqualified(lead_id: int) -> Lead:
    lead = leads_service.get_lead(lead_id)
    if not leads_service.can_work(lead):
        raise Forbidden("Only the lead's owner or a branch manager can review qualification")
    if lead.qualified_at is not None:
        raise BusinessRule(f"Lead {lead.lead_code} is already qualified")
    if not lead.is_open:
        raise BusinessRule(f"Lead is {lead.stage}")
    return lead


def set_check(lead_id: int, check: str, reviewed: bool, notes: str | None) -> dict:
    lead = _workable_unqualified(lead_id)
    existing = _reviews(lead_id).get(check)
    if reviewed and existing is None:
        db.session.add(LeadQualificationReview(lead_id=lead.lead_id, check_code=check,
                                               reviewed_by=current_user().user_id, notes=notes))
    elif reviewed and existing is not None:
        existing.notes = notes
    elif not reviewed and existing is not None:
        db.session.delete(existing)
    db.session.flush()
    return checklist(lead_id)


def qualify(lead_id: int) -> dict:
    lead = _workable_unqualified(lead_id)
    missing = [c for c in QUALIFICATION_CHECKS if c not in _reviews(lead_id)]
    if missing:
        raise BusinessRule("Complete every qualification check first", {"missing_checks": missing})
    lead.qualified_at = datetime.now(timezone.utc)
    lead.qualified_by = current_user().user_id
    db.session.flush()  # the DB checks all six again
    leads_service.log_activity(lead, "Note", "Marked Qualified (all six checks reviewed)")
    audit.record("LEAD_QUALIFIED", "lead", lead.lead_id, branch_id=lead.branch_id)
    return checklist(lead_id)


# ---------------------------------------------------------------- convert

def convert(lead_id: int, data: dict) -> dict:
    """Convert a qualified lead: its course plus any others become open courses on the person's card.

    A course the person already has open at the branch is converted if still a New Enquiry lead, or returned
    as it is if it's already in the pipeline — never duplicated. Returns the card and what happened per course.
    """
    lead = leads_service.get_lead(lead_id)
    user = current_user()
    if not leads_service.can_work(lead):
        raise Forbidden("Only the lead's owner or a branch manager can convert it")
    if lead.qualified_at is None:
        raise BusinessRule("Complete the qualification review and Mark Qualified before converting",
                           {"missing_fields": ["qualified_at"]})
    if lead.stage != "New Enquiry" or lead.converted_at is not None:
        raise BusinessRule(f"Lead {lead.lead_code} is already a deal ({lead.stage})")

    branch_id = data.get("branch_id") or lead.branch_id
    if not user.can_access_branch(branch_id):
        raise Forbidden("You can only convert into your own branches")
    course_ids = list(dict.fromkeys(data["course_ids"]))
    if lead.course_id is not None and lead.course_id not in course_ids:
        raise ValidationError("Include the lead's own course, or change the lead's course first",
                              {"course_ids": [f"Must include {lead.course.course_title}"]})
    for course_id in course_ids:
        leads_service.check_course(course_id, branch_id)
    if data.get("expected_close_date") and data["expected_close_date"] < date.today():
        raise ValidationError("Expected close can't be in the past", {"expected_close_date": ["Must be today or later"]})
    owner_id = data.get("assigned_to") or lead.assigned_to or (
        user.user_id if user.has_role("SALES", "FRONT_OFFICE", branch_id=branch_id) else None)
    if owner_id is not None:
        leads_service.check_assignee(owner_id, branch_id)

    if branch_id != lead.branch_id:
        # Moving the enquiry to the branch that will serve the deal, before it becomes one
        clash = leads_repo.find_open_lead(lead.person_id, lead.course_id, branch_id)
        if clash is not None:
            raise Conflict(f"{lead.person.full_name} already has this course open at that branch: {clash.lead_code}",
                           {"lead_id": clash.lead_id})
        audit.record("LEAD_BRANCH_CHANGED", "lead", lead.lead_id, old={"branch_id": lead.branch_id},
                     new={"branch_id": branch_id}, branch_id=lead.branch_id)
        lead.branch_id = branch_id
    if lead.course_id is None:
        clash = leads_repo.find_open_lead(lead.person_id, course_ids[0], branch_id)
        if clash is not None:
            raise Conflict(f"{lead.person.full_name} already has {clash.course.course_title} open here: "
                           f"{clash.lead_code}; convert that lead instead", {"lead_id": clash.lead_id})
        lead.course_id = course_ids[0]

    now = datetime.now(timezone.utc)
    results: list[tuple[Lead, str]] = []
    db.session.execute(text("SELECT set_config('app.converting_leads', 'on', TRUE)"))
    for course_id in course_ids:
        target = lead if course_id == lead.course_id else leads_repo.find_open_lead(lead.person_id, course_id, branch_id)
        if target is not None and target.lead_id != lead.lead_id and target.converted_at is not None:
            results.append((target, "existing"))  # already a deal: returned, never recreated
            continue
        if target is None:
            target = Lead(
                person_id=lead.person_id, course_id=course_id, branch_id=branch_id,
                original_source_id=lead.original_source_id, original_channel_id=lead.original_channel_id,
                original_entry_method_id=lead.original_entry_method_id, original_enquiry_id=lead.original_enquiry_id,
                intake_status=lead.intake_status, campaign=lead.campaign, created_by=user.user_id,
                remarks=f"Added when converting {lead.lead_code}",
            )
            db.session.add(target)
            outcome = "created"
        else:
            outcome = "converted"
        target.assigned_to = target.assigned_to or owner_id
        target.next_follow_up_at = target.next_follow_up_at or lead.next_follow_up_at
        target.ai_priority = target.ai_priority or lead.ai_priority
        target.qualified_at = target.qualified_at or lead.qualified_at
        target.qualified_by = target.qualified_by or lead.qualified_by
        target.converted_at, target.converted_by = now, user.user_id
        target.stage = "Counselling"  # the DB joins the person's open card here (taking its stage) or opens one
        db.session.flush()
        results.append((target, outcome))
    db.session.execute(text("SELECT set_config('app.converting_leads', 'off', TRUE)"))

    for target, _ in results:
        db.session.refresh(target)
    entry = db.session.get(PipelineEntry, lead.pipeline_entry_id)
    db.session.refresh(entry)
    if data.get("expected_close_date"):
        entry.expected_close_date = data["expected_close_date"]
    if entry.assigned_to is None and owner_id is not None:
        entry.assigned_to = owner_id
    db.session.flush()
    for target, outcome in results:
        if outcome != "existing":
            leads_service.log_activity(target, "Note", f"Converted to deal on {entry.entry_code}")
    audit.record("LEAD_CONVERTED", "lead", lead.lead_id,
                 new={"pipeline_entry_id": entry.pipeline_entry_id, "course_ids": course_ids,
                      "expected_close_date": data.get("expected_close_date")}, branch_id=branch_id)
    return {"pipeline_entry": entry, "courses": [
        {"lead": target.to_summary(), "course": target.course.to_summary() if target.course else None,
         "result": outcome} for target, outcome in results]}

