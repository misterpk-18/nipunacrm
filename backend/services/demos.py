"""Demos: booking, confirmation, reschedule, cancellation, attendance / outcome, extra-demo approval.

The database creates and settles reminders, enforces durations by demo type and the "3rd demo after 2 attended
needs approval" rule, and sets the commercial follow-up due time (2 staffed hours) when an outcome is recorded.
"""
from datetime import datetime, timezone

from config.database import db
from models import Course, Demo
from models.enums import PROTECTED_STAGES
from repositories import demos as demos_repo
from repositories import settings as settings_repo
from repositories import users as users_repo
from repositories.common import paginate
from services import audit, tasks
from services import leads as leads_service
from services.context import COUNSELLOR_ROLES, current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError

EXTRA_APPROVER_ROLES = ("ACADEMIC_COORDINATOR", "BRANCH_MANAGER")
DEFAULT_DURATION = {"Standard": 45, "Practical": 60}


# ---------------------------------------------------------------- access

def get_demo(demo_id: int) -> Demo:
    demo = db.session.get(Demo, demo_id)
    if demo is None or not current_user().can_access_branch(demo.branch_id):
        raise NotFound("Demo not found")
    return demo


def _is_sales_side(branch_id: int) -> bool:
    user = current_user()
    return user.is_manager_of(branch_id) or user.has_role(*COUNSELLOR_ROLES, branch_id=branch_id)


def _bookable(demo_id: int) -> Demo:
    demo = get_demo(demo_id)
    if not _is_sales_side(demo.branch_id):
        raise Forbidden("Only counsellors or a branch manager can change demos")
    if not demo.is_open:
        raise BusinessRule(f"Demo {demo.demo_code} is {demo.status}")
    return demo


def _check_trainer(trainer_id: int, branch_id: int) -> None:
    if trainer_id not in users_repo.user_ids_with_any_role(("TRAINER",), branch_id):
        raise ValidationError("Trainer must be an active trainer at the lead's branch",
                              {"trainer_user_id": ["Not a trainer at this branch"]})


def attended_label(counts: dict[int, int], lead_id: int) -> str:
    """'1 of 2' — attended demos out of the free limit."""
    return f"{counts.get(lead_id, 0)} of {settings_repo.get_int('demo_max_attended', 2)}"


# ---------------------------------------------------------------- read

def list_demos(filters: dict, page: int, per_page: int):
    demos, meta = paginate(demos_repo.demos_stmt(filters, current_user().branch_ids()), page, per_page)
    return demos, meta, demos_repo.attended_counts(list({d.lead_id for d in demos}))


def reminders(demo_id: int):
    return get_demo(demo_id).reminders


# ---------------------------------------------------------------- book / change

def schedule(lead_id: int, data: dict) -> Demo:
    lead = leads_service.get_lead(lead_id)
    user = current_user()
    if not _is_sales_side(lead.branch_id):
        raise Forbidden("Only counsellors or a branch manager can book demos")
    if not lead.is_open:
        raise BusinessRule(f"Lead is {lead.stage}")
    if data["scheduled_at"] <= datetime.now(timezone.utc):
        raise ValidationError("A demo must be in the future", {"scheduled_at": ["Must be in the future"]})

    course_id = data.get("course_id") or lead.course_id  # optional: a lead can attend a demo before choosing a course
    if course_id is not None:
        course = db.session.get(Course, course_id)
        if course is None or course.status != "Active":
            raise ValidationError("Unknown or inactive course", {"course_id": ["Not an active course"]})
    if data.get("trainer_user_id"):
        _check_trainer(data["trainer_user_id"], lead.branch_id)

    demo_type = data.get("demo_type", "Standard")
    approved_by = data.get("extra_demo_approved_by")
    if approved_by is None and user.has_role(*EXTRA_APPROVER_ROLES, branch_id=lead.branch_id):
        attended = demos_repo.attended_counts([lead.lead_id]).get(lead.lead_id, 0)
        if attended >= settings_repo.get_int("demo_max_attended", 2):
            approved_by = user.user_id  # the approver is booking it themselves

    demo = Demo(
        lead_id=lead.lead_id, course_id=course_id, branch_id=lead.branch_id, scheduled_at=data["scheduled_at"],
        duration_minutes=data.get("duration_minutes") or DEFAULT_DURATION[demo_type], demo_type=demo_type,
        mode=data.get("mode", "In-person"), meeting_link=data.get("meeting_link"),
        trainer_user_id=data.get("trainer_user_id"), extra_demo_approved_by=approved_by, created_by=user.user_id,
    )
    db.session.add(demo)
    db.session.flush()  # the DB checks duration and the extra-demo rule, and creates the reminders
    db.session.refresh(demo)

    if lead.stage not in PROTECTED_STAGES and lead.stage != "Demo Scheduled":
        lead.stage = "Demo Scheduled"
    leads_service.log_activity(lead, "Note", f"Demo {demo.demo_code} scheduled", demo_id=demo.demo_id)
    db.session.flush()
    if approved_by:
        audit.record("EXTRA_DEMO_APPROVED", "demo", demo.demo_id, new={"approved_by": approved_by},
                     branch_id=demo.branch_id)
    return demo


def update(demo_id: int, data: dict) -> Demo:
    demo = _bookable(demo_id)
    if data.get("trainer_user_id"):
        _check_trainer(data["trainer_user_id"], demo.branch_id)
    for field, value in data.items():
        setattr(demo, field, value)
    db.session.flush()
    db.session.refresh(demo)
    return demo


def confirm(demo_id: int) -> Demo:
    demo = _bookable(demo_id)
    if demo.status == "Confirmed":
        raise BusinessRule(f"Demo {demo.demo_code} is already confirmed")
    demo.status = "Confirmed"
    db.session.flush()
    return demo


def reschedule(demo_id: int, scheduled_at: datetime, reason: str) -> Demo:
    """Old demo → Rescheduled (its pending reminders Superseded); a new demo carries the booking forward."""
    old = _bookable(demo_id)
    if scheduled_at <= datetime.now(timezone.utc):
        raise ValidationError("A demo must be in the future", {"scheduled_at": ["Must be in the future"]})
    old.status = "Rescheduled"
    old.reschedule_reason = reason
    db.session.flush()

    new = Demo(
        lead_id=old.lead_id, course_id=old.course_id, branch_id=old.branch_id, scheduled_at=scheduled_at,
        duration_minutes=old.duration_minutes, demo_type=old.demo_type, mode=old.mode, meeting_link=old.meeting_link,
        trainer_user_id=old.trainer_user_id, extra_demo_approved_by=old.extra_demo_approved_by,
        rescheduled_from_demo_id=old.demo_id, created_by=current_user().user_id,
    )
    db.session.add(new)
    db.session.flush()
    db.session.refresh(new)
    leads_service.log_activity(old.lead, "Note", f"Demo {old.demo_code} rescheduled to {new.demo_code} · {reason}",
                               demo_id=new.demo_id)
    db.session.flush()
    return new


def cancel(demo_id: int, reason: str) -> Demo:
    demo = _bookable(demo_id)
    demo.status = "Cancelled"
    demo.cancel_reason = reason
    leads_service.log_activity(demo.lead, "Note", f"Demo {demo.demo_code} cancelled · {reason}", demo_id=demo.demo_id)
    db.session.flush()
    db.session.refresh(demo)
    return demo


# ---------------------------------------------------------------- outcome / approval

def record_outcome(demo_id: int, data: dict) -> Demo:
    """Attended / No Show + feedback. Moves the lead to Demo Attended (never out of a protected stage),
    sets the next follow-up and creates the commercial follow-up Call task (due in 2 staffed hours)."""
    demo = get_demo(demo_id)
    user = current_user()
    if not (_is_sales_side(demo.branch_id) or user.has_role("TRAINER", branch_id=demo.branch_id)):
        raise Forbidden("Only the trainer, counsellors or a branch manager can record the outcome")
    if not demo.is_open:
        raise BusinessRule(f"Demo {demo.demo_code} is {demo.status}")
    if demo.scheduled_at > datetime.now(timezone.utc):
        raise BusinessRule("The demo hasn't started yet")
    if data["next_follow_up_at"] <= datetime.now(timezone.utc):
        raise ValidationError("Next follow-up must be in the future", {"next_follow_up_at": ["Must be in the future"]})

    lead = demo.lead
    owner_id = data.get("commercial_owner_id") or lead.assigned_to
    if owner_id is not None:
        leads_service.check_assignee(owner_id, lead.branch_id, field="commercial_owner_id")
    if data.get("recommended_course_id") and db.session.get(Course, data["recommended_course_id"]) is None:
        raise ValidationError("Unknown course", {"recommended_course_id": ["Not found"]})

    for field in ("status", "student_feedback", "trainer_feedback", "rating", "outcome", "recommended_course_id",
                  "next_action", "next_follow_up_at"):
        if field in data:
            setattr(demo, field, data[field])
    demo.commercial_owner_id = owner_id
    db.session.flush()  # trigger sets commercial_follow_up_due_at and settles reminders
    db.session.refresh(demo)

    if demo.status == "Attended" and lead.stage not in PROTECTED_STAGES and lead.stage != "Demo Attended":
        lead.stage = "Demo Attended"
    lead.next_follow_up_at = data["next_follow_up_at"]
    summary = f"Demo {demo.demo_code} {demo.status.lower()}" + (f" · {demo.outcome}" if demo.outcome else "")
    if demo.next_action:
        summary += f" · next: {demo.next_action}"
    leads_service.log_activity(lead, "Meeting", summary, outcome=demo.outcome, demo_id=demo.demo_id)

    task = tasks.create_system_task(
        "CALL", f"Commercial follow-up after demo · {lead.person.full_name}", lead.branch_id,
        demo.commercial_follow_up_due_at, owner_user_id=owner_id, dedupe_key=f"demo-follow-up:{demo.demo_id}",
        lead_id=lead.lead_id,
    )
    if data["next_follow_up_at"] != demo.commercial_follow_up_due_at and task.revised_due_at is None:
        task.revised_due_at = data["next_follow_up_at"]
        task.revision_reason = "Next follow-up agreed at the demo"
    db.session.flush()
    return demo


def approve_extra(demo_id: int) -> Demo:
    demo = get_demo(demo_id)
    user = current_user()
    if not user.has_role(*EXTRA_APPROVER_ROLES, branch_id=demo.branch_id):
        raise Forbidden("Only an Academic Coordinator or Branch Manager of this branch can approve extra demos")
    if not demo.is_open:
        raise BusinessRule(f"Demo {demo.demo_code} is {demo.status}")
    demo.extra_demo_approved_by = user.user_id
    db.session.flush()
    audit.record("EXTRA_DEMO_APPROVED", "demo", demo.demo_id, new={"approved_by": user.user_id}, branch_id=demo.branch_id)
    return demo
