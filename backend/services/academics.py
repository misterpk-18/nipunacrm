"""Batches, allocation (with a pre-check that names the recovery owner), joining dates and authorised completion.

The database blocks allocations to another service branch, a full batch, combo batches, cancelled / paused / completed enrolments, and a second active allocation per course; it moves
enrolment to Scheduled / In Progress, and stamps completion and the support window.
"""
from datetime import date, datetime, timezone

from config.database import db
from models import Admission, Batch, BatchAllocation, ComboCourse, Course
from repositories import admissions as admissions_repo
from repositories import users as users_repo
from repositories.common import paginate
from services import audit, whatsapp_events
from services import admissions as admissions_service
from services.lms_pull import require_crm_academics
from services.context import current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError

BATCH_FIELDS = ("batch_name", "delivery_mode", "trainer_user_id", "schedule_days",
                "start_time", "end_time", "start_date", "end_date", "capacity", "min_students", "location", "status",
                "lms_course_id")


def _academic(branch_id: int) -> bool:
    return current_user().is_manager_of(branch_id)


def _require_academic(branch_id: int) -> None:
    if not _academic(branch_id):
        raise Forbidden("Only a Branch Manager of this branch can do this")


# ---------------------------------------------------------------- batches

def get_batch(batch_id: int) -> Batch:
    batch = db.session.get(Batch, batch_id)
    if batch is None or not current_user().can_access_branch(batch.branch_id):
        raise NotFound("Batch not found")
    return batch


def list_batches(filters: dict, page: int, per_page: int):
    return paginate(admissions_repo.batches_stmt(filters, current_user().branch_ids()), page, per_page)


def batch_workspace(batch_id: int) -> dict:
    batch = get_batch(batch_id)
    awaiting = db.session.execute(admissions_repo.queue_stmt({"branch_id": batch.branch_id},
                                                             current_user().branch_ids())).scalars()
    course_ids = {batch.course_id}
    return {"batch": batch, "allocations": admissions_repo.batch_allocations(batch_id),
            "awaiting": [row for row in awaiting if row.admission.course_id in course_ids
                         or _is_component(row.admission.course_id, batch.course_id)]}


def _is_component(combo_id: int, course_id: int) -> bool:
    return db.session.get(ComboCourse, (combo_id, course_id)) is not None


def _check_batch_refs(data: dict, branch_id: int) -> None:
    if data.get("trainer_user_id") and data["trainer_user_id"] not in users_repo.user_ids_with_any_role(
            ("TRAINER",), branch_id):
        raise ValidationError("Trainer must be an active trainer at the batch's branch",
                              {"trainer_user_id": ["Not a trainer at this branch"]})


def create_batch(data: dict) -> Batch:
    require_crm_academics("Batches")
    _require_academic(data["branch_id"])
    course = db.session.get(Course, data["course_id"])
    if course is None or course.status != "Active":
        raise ValidationError("Unknown or inactive course", {"course_id": ["Not an active course"]})
    _check_batch_refs(data, data["branch_id"])
    batch = Batch(branch_id=data["branch_id"], course_id=data["course_id"], created_by=current_user().user_id,
                  **{f: data[f] for f in BATCH_FIELDS if f in data})
    db.session.add(batch)
    db.session.flush()  # combo courses are refused; code set by trigger
    db.session.refresh(batch)
    return batch


def update_batch(batch_id: int, data: dict) -> Batch:
    require_crm_academics("Batches")
    batch = get_batch(batch_id)
    _require_academic(batch.branch_id)
    if batch.status in ("Completed", "Cancelled"):
        raise BusinessRule(f"Batch {batch.batch_code} is {batch.status}")
    _check_batch_refs(data, batch.branch_id)
    if "capacity" in data and data["capacity"] < batch.occupancy.allocated:
        raise BusinessRule(f"{batch.occupancy.allocated} students are allocated; capacity can't go below that")
    for field, value in data.items():
        setattr(batch, field, value)
    db.session.flush()
    db.session.refresh(batch)
    return batch


# ---------------------------------------------------------------- allocation

def allocation_queue(filters: dict, page: int, per_page: int):
    return paginate(admissions_repo.queue_stmt(filters, current_user().branch_ids()), page, per_page)


def allocation_check(batch_id: int, admission_id: int) -> dict:
    """The same rules as the database, as a pre-check with the blocking reason and who can fix it."""
    batch = get_batch(batch_id)
    admission = admissions_service.get_admission(admission_id)
    service_code = admission.service_branch.branch_code
    batch_code = batch.branch.branch_code

    def blocked(reason: str, owner: str | None = None) -> dict:
        return {"ok": False, "reason": reason, "recovery_owner": owner}

    if admission.enrolment_status in ("Cancelled", "Paused", "Completed"):
        return blocked(f"Enrolment is {admission.enrolment_status}; allocation blocked.")
    if batch.status in ("Completed", "Cancelled"):
        return blocked(f"Batch {batch.batch_code} is {batch.status}.", f"Branch Manager ({batch_code})")
    if batch.branch_id != admission.service_branch_id:
        return blocked(f"Wrong branch: batch is {batch_code}, the student's service branch is {service_code}. "
                       "Cross-branch allocation is never automatic.", f"Branch Manager ({service_code})")
    if batch.course_id != admission.course_id and not _is_component(admission.course_id, batch.course_id):
        return blocked(f"Course mismatch: batch is {batch.course.course_title}, admission is "
                       f"{admission.course.course_title}.")
    if any(a.course_id == batch.course_id for a in admissions_repo.active_allocations(admission_id)):
        return blocked("Already allocated to a batch for this course. Close that allocation to move batch.",
                       f"Branch Manager ({service_code})")
    if batch.occupancy.is_full:
        return blocked(f"Full capacity: {batch.occupancy.allocated}/{batch.capacity}. Choose another batch or request a "
                       "capacity change.", f"Branch Manager ({batch_code})")
    return {"ok": True, "reason": "All checks passed: same service branch, course, seat available.",
            "recovery_owner": None}


def allocate(admission_id: int, batch_id: int) -> BatchAllocation:
    require_crm_academics("Batch allocations")
    admission = admissions_service.get_admission(admission_id)
    _require_academic(admission.service_branch_id)
    batch = get_batch(batch_id)
    allocation = BatchAllocation(admission_id=admission_id, batch_id=batch.batch_id, allocated_by=current_user().user_id)
    db.session.add(allocation)
    db.session.flush()
    db.session.refresh(allocation)
    db.session.expire(admission)
    audit.record("BATCH_ALLOCATED", "admission", admission_id, new={"batch": batch.batch_code},
                 branch_id=admission.service_branch_id)
    whatsapp_events.batch_allocated(allocation)
    return allocation


def get_allocation(allocation_id: int) -> BatchAllocation:
    allocation = db.session.get(BatchAllocation, allocation_id)
    if allocation is None:
        raise NotFound("Allocation not found")
    admissions_service.get_admission(allocation.admission_id)
    return allocation


def close_allocation(allocation_id: int, status: str, reason: str | None) -> BatchAllocation:
    require_crm_academics("Batch allocations")
    allocation = get_allocation(allocation_id)
    if not current_user().is_manager_of(allocation.batch.branch_id):
        raise Forbidden("Only a Branch Manager can close allocations")
    if allocation.status != "Active":
        raise BusinessRule(f"Allocation is already {allocation.status}")
    allocation.status = status
    allocation.ended_at = datetime.now(timezone.utc)
    allocation.end_reason = reason
    db.session.flush()
    return allocation


def set_joining_date(allocation_id: int, joining_date: date) -> BatchAllocation:
    """First confirmed regular class (demos excluded); moves enrolment to In Progress."""
    require_crm_academics("Joining dates")
    allocation = get_allocation(allocation_id)
    user = current_user()
    branch_id = allocation.batch.branch_id
    if not (user.is_manager_of(branch_id) or user.has_role("TRAINER", branch_id=branch_id)):
        raise Forbidden("Only the Branch Manager or a trainer can record joining")
    if allocation.status != "Active":
        raise BusinessRule(f"Allocation is {allocation.status}")
    if allocation.joining_date is not None:
        raise BusinessRule(f"Joining date is already recorded ({allocation.joining_date})")
    if joining_date > date.today():
        raise ValidationError("Joining date can't be in the future", {"joining_date": ["Must not be in the future"]})
    if joining_date < allocation.batch.start_date:
        raise ValidationError("Joining can't be before the batch starts", {"joining_date": ["Before batch start"]})
    allocation.joining_date = joining_date
    db.session.flush()
    db.session.expire(allocation.admission)
    return allocation


def complete(admission_id: int) -> Admission:
    """Authorised academic completion → alumni + support window (stamped by the DB)."""
    require_crm_academics("Course completions")
    admission = admissions_service.get_admission(admission_id)
    if not current_user().is_manager_of(admission.service_branch_id):
        raise Forbidden("Only a Branch Manager can authorise completion")
    if admission.enrolment_status != "In Progress":
        raise BusinessRule(f"Only an enrolment In Progress can be completed (it is {admission.enrolment_status})")
    admissions_service.close_allocations(admission, "Completed", "Course completed")
    admission.enrolment_status = "Completed"
    admission.completion_authorised_by = current_user().user_id
    db.session.flush()
    db.session.refresh(admission)
    audit.record("ADMISSION_COMPLETED", "admission", admission_id, new={"support_until": admission.support_until},
                 branch_id=admission.service_branch_id)
    return admission

