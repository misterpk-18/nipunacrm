"""Leads: create, list, workspace, assign, stage, follow-up, lost / reactivate, activities."""
from datetime import datetime, timezone

from config.database import db
from models import Course, Enquiry, Lead, LeadActivity, LostReason, Person
from repositories import leads as leads_repo
from repositories import users as users_repo
from repositories.common import paginate
from services import audit, sla, tasks
from services import persons as persons_service
from services.context import COUNSELLOR_ROLES, current_user
from services.errors import BusinessRule, Conflict, Forbidden, NotFound, ValidationError

# Staff who can own a lead at a branch
OWNER_ROLES = COUNSELLOR_ROLES + ("BRANCH_MANAGER",)
# Activity types staff record by hand (the rest are written by the system)
MANUAL_ACTIVITY_TYPES = ("Call", "WhatsApp", "Email", "SMS", "Meeting", "Note")
CONTACT_ACTIVITY_TYPES = ("Call", "WhatsApp", "Email", "SMS", "Meeting")
# Stages a lead can be moved to directly (Admitted comes from the admission; Lost from /lost)
MOVABLE_STAGES = ("New Enquiry", "Counselling", "Demo Scheduled", "Demo Attended",
                  "Fee Discussion / Payment Awaited", "Payment Pending Verification")
# Unassigned new leads create a task for the branch manager, due within this many staffed minutes
ASSIGNMENT_DUE_STAFFED_MINUTES = 60


# ---------------------------------------------------------------- access helpers

def get_lead(lead_id: int) -> Lead:
    lead = db.session.get(Lead, lead_id)
    if lead is None or not current_user().can_access_branch(lead.branch_id):
        raise NotFound("Lead not found")
    return lead


def can_work(lead: Lead) -> bool:
    """Owner, branch manager, admin — or any counsellor of the branch while the lead is unassigned."""
    user = current_user()
    return (user.is_manager_of(lead.branch_id)
            or lead.assigned_to == user.user_id
            or (lead.assigned_to is None and user.has_role(*COUNSELLOR_ROLES, branch_id=lead.branch_id)))


def _workable(lead_id: int) -> Lead:
    lead = get_lead(lead_id)
    if not can_work(lead):
        raise Forbidden("Only the lead's owner or a branch manager can do this")
    return lead


def _managed(lead_id: int) -> Lead:
    lead = get_lead(lead_id)
    if not current_user().is_manager_of(lead.branch_id):
        raise Forbidden("Only a branch manager can do this")
    return lead


def check_assignee(user_id: int, branch_id: int, field: str = "assigned_to") -> None:
    if user_id not in users_repo.user_ids_with_any_role(OWNER_ROLES, branch_id):
        raise ValidationError("Assignee must be active Sales, Front Office or Branch Manager staff at this branch",
                              {field: ["Not eligible for this branch"]})


def check_course(course_id: int, branch_id: int) -> None:
    course = db.session.get(Course, course_id)
    if course is None or course.status != "Active":
        raise ValidationError("Unknown or inactive course", {"course_id": ["Not an active course"]})
    if not any(link.branch.branch_id == branch_id for link in course.branch_links):
        raise ValidationError("This course isn't offered at the lead's branch", {"course_id": ["Not offered at this branch"]})


def require_converted(lead: Lead, action: str) -> None:
    """Demos and fee discussions happen on deals: the lead must be qualified and converted first (db 019)."""
    if lead.converted_at is None:
        raise BusinessRule(f"Qualify and convert {lead.lead_code} to a deal before {action}",
                           {"missing_fields": ["qualified_at" if lead.qualified_at is None else "converted_at"]})


def log_activity(lead: Lead, activity_type: str, summary: str | None, **fields) -> LeadActivity:
    activity = LeadActivity(lead_id=lead.lead_id, activity_type=activity_type, summary=summary,
                            performed_by=current_user().user_id, **fields)
    db.session.add(activity)
    return activity


# ---------------------------------------------------------------- create

def create_lead(data: dict) -> Lead:
    """Person (existing or new) + enquiry + lead, in one transaction."""
    branch_id = data["branch_id"]
    if not current_user().can_access_branch(branch_id):
        raise Forbidden("You can only add leads at your own branches")

    person = _resolve_person(data, branch_id)
    enquiry = Enquiry(
        branch_id=branch_id, course_id=data.get("course_id"), person_id=person.person_id,
        lead_source_id=data["lead_source_id"], contact_channel_id=data["contact_channel_id"],
        entry_method_id=data["entry_method_id"], intake_status=data.get("intake_status", "New"),
        raw_name=person.full_name, raw_phone=person.phone, raw_email=person.email, message=data.get("message"),
        created_by=current_user().user_id,
    )
    db.session.add(enquiry)
    db.session.flush()
    return create_from_enquiry(enquiry, person, data)


def _resolve_person(data: dict, branch_id: int) -> Person:
    if data.get("person_id"):
        person = db.session.get(Person, data["person_id"])
        if person is None:
            raise ValidationError("Unknown person", {"person_id": ["Not found"]})
        return person
    if not data.get("person"):
        raise ValidationError("Give person_id or person details", {"person": ["Required"]})
    return persons_service.create_person({**data["person"], "registered_branch_id": branch_id})


def create_from_enquiry(enquiry: Enquiry, person: Person, data: dict) -> Lead:
    """Shared by POST /leads and POST /enquiries/{id}/convert."""
    user = current_user()
    course_id = data.get("course_id", enquiry.course_id)
    if course_id is not None:
        check_course(course_id, enquiry.branch_id)

    existing = leads_repo.find_open_lead(person.person_id, course_id, enquiry.branch_id)
    if existing is not None:
        raise Conflict(f"{person.full_name} already has an open lead for this course here: {existing.lead_code}",
                       {"lead_id": existing.lead_id, "lead_code": existing.lead_code})

    assigned_to = data.get("assigned_to")
    if assigned_to is None and user.has_role(*COUNSELLOR_ROLES, branch_id=enquiry.branch_id):
        assigned_to = user.user_id  # staff-entered leads belong to whoever entered them
    if assigned_to is not None:
        check_assignee(assigned_to, enquiry.branch_id)

    lead = Lead(
        person_id=person.person_id, course_id=course_id, branch_id=enquiry.branch_id,
        original_source_id=enquiry.lead_source_id, original_channel_id=enquiry.contact_channel_id,
        original_entry_method_id=enquiry.entry_method_id, original_enquiry_id=enquiry.enquiry_id,
        intake_status=data.get("intake_status", enquiry.intake_status if enquiry.intake_status != "Duplicate Review" else "New"),
        assigned_to=assigned_to, next_follow_up_at=data.get("next_follow_up_at"), created_by=user.user_id,
        campaign=data.get("campaign"), remarks=data.get("remarks"),
    )
    db.session.add(lead)
    db.session.flush()
    db.session.refresh(lead)  # lead_code comes from a trigger

    enquiry.lead_id = lead.lead_id
    enquiry.person_id = person.person_id
    enquiry.owner_user_id = assigned_to
    if enquiry.intake_status == "Duplicate Review":
        enquiry.intake_status = "New"

    if assigned_to is None:
        tasks.create_system_task(
            "GENERAL", f"Assign new lead {lead.lead_code} · {person.full_name}", lead.branch_id,
            sla.staffed_deadline(lead.branch_id, datetime.now(timezone.utc), ASSIGNMENT_DUE_STAFFED_MINUTES),
            team_role_code="BRANCH_MANAGER", dedupe_key=f"lead-unassigned:{lead.lead_id}", lead_id=lead.lead_id,
        )
    audit.record("LEAD_CREATED", "lead", lead.lead_id, new={"lead_code": lead.lead_code, "person_id": person.person_id,
                 "assigned_to": assigned_to}, branch_id=lead.branch_id)
    return lead


# ---------------------------------------------------------------- read

def list_leads(filters: dict, page: int, per_page: int):
    return paginate(leads_repo.leads_stmt(filters, current_user().branch_ids()), page, per_page)


def workspace(page: int, per_page: int):
    user_id = current_user().user_id
    leads, meta = paginate(leads_repo.workspace_stmt(user_id), page, per_page)
    return leads, meta, leads_repo.queue_counts(user_id)


def list_enquiries(lead_id: int) -> list[Enquiry]:
    get_lead(lead_id)
    return leads_repo.enquiries_for_lead(lead_id)


# ---------------------------------------------------------------- update / assign

def update_lead(lead_id: int, data: dict) -> Lead:
    lead = _workable(lead_id)
    if data.get("course_id") is not None:
        check_course(data["course_id"], lead.branch_id)
    old = {field: getattr(lead, field) for field in data}
    for field, value in data.items():
        setattr(lead, field, value)
    db.session.flush()
    db.session.refresh(lead)
    audit.record("LEAD_UPDATED", "lead", lead_id, old=old, new=data, branch_id=lead.branch_id)
    return lead


def assign(lead_id: int, assigned_to: int) -> Lead:
    lead = _managed(lead_id)
    assign_to(lead, assigned_to)
    db.session.flush()
    return lead


def bulk_assign(lead_ids: list[int], assigned_to: int) -> list[Lead]:
    """All or nothing: every lead must be visible and managed by the caller."""
    leads = [_managed(lead_id) for lead_id in lead_ids]
    for lead in leads:
        assign_to(lead, assigned_to)
    db.session.flush()
    return leads


def assign_to(lead: Lead, assigned_to: int) -> None:
    check_assignee(assigned_to, lead.branch_id)
    if lead.assigned_to == assigned_to:
        return
    previous = lead.owner.full_name if lead.owner else "unassigned"
    lead.assigned_to = assigned_to
    db.session.flush()
    db.session.refresh(lead)
    log_activity(lead, "Assignment Change", f"Assigned to {lead.owner.full_name} (was {previous})")
    tasks.complete_system_task(f"lead-unassigned:{lead.lead_id}")
    audit.record("LEAD_ASSIGNED", "lead", lead.lead_id, new={"assigned_to": assigned_to}, branch_id=lead.branch_id)


# ---------------------------------------------------------------- stage / follow-up / lost

def change_stage(lead_id: int, stage: str, note: str | None) -> Lead:
    lead = _workable(lead_id)
    if stage == "Lost - closed":
        raise BusinessRule("Use Mark Lost to close a lead (it needs a reason)")
    if stage == "Admitted":
        raise BusinessRule("A lead becomes Admitted when its admission is created",
                           {"missing_fields": ["admission"]})
    if stage != "New Enquiry":
        require_converted(lead, f"moving it to {stage}")
    if stage == "Payment Pending Verification":
        missing = [field for field in ("course_id",) if getattr(lead, field) is None]
        if missing:
            raise BusinessRule("Fill in the required fields first", {"missing_fields": missing})
        others = [other.lead_code for other in leads_repo.open_leads_on_card(lead) if other.course_id is None]
        if others:
            raise BusinessRule("Every course on the person's pipeline card needs a course first",
                               {"missing_fields": ["course_id"], "leads": others})

    # The DB logs the change, moves the person's pipeline card (and its other open courses) with it,
    # and blocks moving back from Payment Pending Verification or back to New Enquiry
    lead.stage = stage
    if note:
        log_activity(lead, "Note", note)
    db.session.flush()
    db.session.refresh(lead)
    return lead


def schedule_follow_up(lead_id: int, at: datetime, note: str | None) -> Lead:
    lead = _workable(lead_id)
    if not lead.is_open:
        raise BusinessRule(f"Lead is {lead.stage}")
    if at <= datetime.now(timezone.utc):
        raise ValidationError("Follow-up must be in the future", {"next_follow_up_at": ["Must be in the future"]})
    lead.next_follow_up_at = at
    log_activity(lead, "Follow-up Scheduled", note)
    db.session.flush()
    return lead


def log_follow_up(lead_id: int, data: dict):
    """Log a follow-up call (purpose + response), move the next follow-up and create the Call task.

    The task keeps the lead's previous follow-up as its original deadline; the new time is the revised one.
    """
    lead = get_lead(lead_id)
    user = current_user()
    if not (can_work(lead) or user.has_role("FRONT_OFFICE", branch_id=lead.branch_id)):
        raise Forbidden("Only the lead's owner, front office or a branch manager can log follow-ups")
    if not lead.is_open:
        raise BusinessRule(f"Lead is {lead.stage}")
    now = datetime.now(timezone.utc)
    next_at = data["next_follow_up_at"]
    if next_at <= now:
        raise ValidationError("Next follow-up must be in the future", {"next_follow_up_at": ["Must be in the future"]})

    original_due = lead.next_follow_up_at or now
    summary = data["response"] + (f" · {data['notes']}" if data.get("notes") else "")
    activity = log_activity(lead, "Call", summary, purpose=data["purpose"], outcome=data["response"],
                            direction="Outbound", occurred_at=now)
    lead.next_follow_up_at = next_at
    lead.last_contacted_at = now
    db.session.flush()
    db.session.refresh(activity)

    task = tasks.create_system_task(
        "CALL", f"{data['purpose']} · {lead.person.full_name}", lead.branch_id, original_due,
        owner_user_id=lead.assigned_to, dedupe_key=f"lead-follow-up:{activity.activity_id}", lead_id=lead.lead_id,
    )
    if next_at != original_due:
        task.revised_due_at = next_at
        task.revision_reason = f"Follow-up logged: {data['response']}"
    db.session.flush()
    return lead, activity, task


def mark_lost(lead_id: int, data: dict) -> Lead:
    lead = _workable(lead_id)
    if lead.stage == "Lost - closed":
        raise BusinessRule("Lead is already lost")
    reason = db.session.get(LostReason, data["lost_reason_id"])
    if reason is None or not reason.is_active:
        raise ValidationError("Unknown lost reason", {"lost_reason_id": ["Not an active reason"]})

    lead.lost_reason_id = reason.lost_reason_id
    lead.lost_competitor = data.get("lost_competitor")
    lead.lost_notes = data.get("lost_notes")
    lead.reactivation_date = data.get("reactivation_date")
    lead.next_follow_up_at = None
    lead.stage = "Lost - closed"  # the DB blocks this for admitted leads
    db.session.flush()
    db.session.refresh(lead)
    audit.record("LEAD_LOST", "lead", lead_id, new={"reason": reason.label}, branch_id=lead.branch_id)
    return lead


def reactivate(lead_id: int, stage: str, next_follow_up_at: datetime | None) -> Lead:
    lead = _managed(lead_id)
    if lead.stage != "Lost - closed":
        raise BusinessRule("Only lost leads can be reactivated")
    existing = leads_repo.find_open_lead(lead.person_id, lead.course_id, lead.branch_id)
    if existing is not None:
        raise Conflict(f"There is already an open lead for this person and course: {existing.lead_code}")

    lead.stage = stage
    lead.lost_reason_id = lead.lost_competitor = lead.lost_notes = lead.reactivation_date = None
    lead.next_follow_up_at = next_follow_up_at
    log_activity(lead, "Note", "Lead reactivated")
    db.session.flush()
    db.session.refresh(lead)
    audit.record("LEAD_REACTIVATED", "lead", lead_id, new={"stage": stage}, branch_id=lead.branch_id)
    return lead


# ---------------------------------------------------------------- activities

def list_activities(lead_id: int, page: int, per_page: int):
    get_lead(lead_id)
    return paginate(leads_repo.activities_stmt(lead_id), page, per_page)


def add_activity(lead_id: int, data: dict) -> LeadActivity:
    lead = get_lead(lead_id)  # any lead role at the branch can log contact (e.g. front office)
    occurred_at = data.pop("occurred_at", None) or datetime.now(timezone.utc)
    if occurred_at > datetime.now(timezone.utc):
        raise ValidationError("An activity can't be in the future", {"occurred_at": ["Must not be in the future"]})

    activity = log_activity(lead, data.pop("activity_type"), data.pop("summary", None), occurred_at=occurred_at, **data)
    if activity.activity_type in CONTACT_ACTIVITY_TYPES and (lead.last_contacted_at is None or occurred_at > lead.last_contacted_at):
        lead.last_contacted_at = occurred_at
    db.session.flush()
    db.session.refresh(activity)
    return activity
