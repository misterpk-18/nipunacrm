"""Batches, allocation (with a pre-check that names the recovery owner), joining dates, curriculum versions,
curriculum mapping and authorised completion.

The database blocks allocations to another service branch, an unmapped / different curriculum, a full batch,
combo batches, cancelled / paused / completed enrolments, and a second active allocation per course; it moves
enrolment to Scheduled / In Progress, and stamps completion and the support window.
"""
from datetime import date, datetime, timezone

from config.database import db
from models import (
    Admission, AdmissionCurriculum, Batch, BatchAllocation, ComboCourse, Course, CurriculumVersion,
)
from repositories import admissions as admissions_repo
from repositories import users as users_repo
from repositories.common import paginate
from services import audit
from services import admissions as admissions_service
from services.lms_pull import require_crm_academics
from services.context import current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError

BATCH_FIELDS = ("batch_name", "curriculum_version_id", "delivery_mode", "trainer_user_id", "schedule_days",
                "start_time", "end_time", "start_date", "end_date", "capacity", "min_students", "location", "status",
                "lms_course_id")


def _academic(branch_id: int) -> bool:
    user = current_user()
    return user.is_manager_of(branch_id) or user.has_role("ACADEMIC_COORDINATOR", branch_id=branch_id)


def _require_academic(branch_id: int) -> None:
    if not _academic(branch_id):
        raise Forbidden("Only an Academic Coordinator or Branch Manager of this branch can do this")


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


def _check_batch_refs(data: dict, branch_id: int, course_id: int) -> None:
    if data.get("trainer_user_id") and data["trainer_user_id"] not in users_repo.user_ids_with_any_role(
            ("TRAINER",), branch_id):
        raise ValidationError("Trainer must be an active trainer at the batch's branch",
                              {"trainer_user_id": ["Not a trainer at this branch"]})
    if data.get("curriculum_version_id"):
        version = db.session.get(CurriculumVersion, data["curriculum_version_id"])
        if version is None or version.course_id != course_id or version.status != "Published":
            raise ValidationError("Use a published curriculum version of the batch's course",
                                  {"curriculum_version_id": ["Not a published version of this course"]})


def create_batch(data: dict) -> Batch:
    require_crm_academics("Batches")
    _require_academic(data["branch_id"])
    course = db.session.get(Course, data["course_id"])
    if course is None or course.status != "Active":
        raise ValidationError("Unknown or inactive course", {"course_id": ["Not an active course"]})
    _check_batch_refs(data, data["branch_id"], data["course_id"])
    if "curriculum_version_id" not in data:
        published = admissions_repo.published_version(course.course_id)
        data["curriculum_version_id"] = published.curriculum_version_id if published else None
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
    _check_batch_refs(data, batch.branch_id, batch.course_id)
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
        return blocked(f"Batch {batch.batch_code} is {batch.status}.", f"Academic Coordinator ({batch_code})")
    if batch.branch_id != admission.service_branch_id:
        return blocked(f"Wrong branch: batch is {batch_code}, the student's service branch is {service_code}. "
                       "Cross-branch allocation is never automatic.", f"Branch Manager ({service_code})")
    if batch.course_id != admission.course_id and not _is_component(admission.course_id, batch.course_id):
        return blocked(f"Course mismatch: batch is {batch.course.course_title}, admission is "
                       f"{admission.course.course_title}.")
    if any(a.course_id == batch.course_id for a in admissions_repo.active_allocations(admission_id)):
        return blocked("Already allocated to a batch for this course. Close that allocation to move batch.",
                       f"Academic Coordinator ({service_code})")
    if admission.curriculum_status != "Mapped":
        return blocked("Curriculum Mapping Pending — map a published curriculum version for this enrolment.",
                       f"Academic Coordinator ({service_code}) · academic recovery owner")
    if batch.curriculum_version_id and batch.curriculum_version_id not in {
            m.curriculum_version_id for m in admissions_repo.curricula_for(admission_id)}:
        return blocked("The batch follows a different curriculum version than the one mapped to this enrolment.",
                       f"Academic Coordinator ({service_code})")
    if batch.occupancy.is_full:
        return blocked(f"Full capacity: {batch.occupancy.allocated}/{batch.capacity}. Choose another batch or request a "
                       "capacity change.", f"Academic Coordinator ({batch_code})")
    return {"ok": True, "reason": "All checks passed: same service branch, course, curriculum mapped, seat available.",
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
    if not (current_user().is_admin or current_user().has_role("ACADEMIC_COORDINATOR",
                                                               branch_id=allocation.batch.branch_id)):
        raise Forbidden("Only an Academic Coordinator can close allocations")
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
    if not (user.is_admin or user.has_role("ACADEMIC_COORDINATOR", "TRAINER", branch_id=branch_id)):
        raise Forbidden("Only the Academic Coordinator or a trainer can record joining")
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


# ---------------------------------------------------------------- curriculum

def list_curriculum_versions(course_id: int | None) -> list[CurriculumVersion]:
    return admissions_repo.curriculum_versions(course_id)


def create_curriculum_version(data: dict) -> CurriculumVersion:
    require_crm_academics("Curriculum versions")
    if db.session.get(Course, data["course_id"]) is None:
        raise ValidationError("Unknown course", {"course_id": ["Not found"]})
    version = CurriculumVersion(course_id=data["course_id"], version_label=data["version_label"], notes=data.get("notes"))
    db.session.add(version)
    db.session.flush()
    if data.get("publish"):
        publish_curriculum_version(version.curriculum_version_id)
    return version


def publish_curriculum_version(version_id: int) -> CurriculumVersion:
    """Publishing retires the course's previously published version."""
    require_crm_academics("Curriculum versions")
    version = db.session.get(CurriculumVersion, version_id)
    if version is None:
        raise NotFound("Curriculum version not found")
    if version.status != "Draft":
        raise BusinessRule(f"Version {version.version_label} is {version.status}")
    previous = admissions_repo.published_version(version.course_id)
    if previous is not None:
        previous.status = "Retired"
        db.session.flush()
    version.status = "Published"
    version.published_by = current_user().user_id
    version.published_at = datetime.now(timezone.utc)
    db.session.flush()
    audit.record("CURRICULUM_PUBLISHED", "curriculum_version", version_id, new={"version_label": version.version_label})
    return version


def map_curriculum(admission_id: int, curriculum_version_id: int) -> Admission:
    """Map a published curriculum version to the enrolment, then mark curriculum Mapped."""
    require_crm_academics("Curriculum mappings")
    admission = admissions_service.get_admission(admission_id)
    if not (current_user().is_admin or current_user().has_role("ACADEMIC_COORDINATOR",
                                                               branch_id=admission.service_branch_id)):
        raise Forbidden("Only an Academic Coordinator can map curricula")
    version = db.session.get(CurriculumVersion, curriculum_version_id)
    if version is None or version.status != "Published":
        raise ValidationError("Map a published curriculum version", {"curriculum_version_id": ["Not published"]})
    exists = db.session.get(AdmissionCurriculum, (admission_id, curriculum_version_id))
    if exists is None:
        db.session.add(AdmissionCurriculum(admission_id=admission_id, curriculum_version_id=curriculum_version_id,
                                           mapped_by=current_user().user_id))
        db.session.flush()  # the DB checks the version's course belongs to the admission
    admission.curriculum_status = "Mapped"
    db.session.flush()
    return admission


def complete(admission_id: int) -> Admission:
    """Authorised academic completion → alumni + support window (stamped by the DB)."""
    require_crm_academics("Course completions")
    admission = admissions_service.get_admission(admission_id)
    if not (current_user().is_admin or current_user().has_role("ACADEMIC_COORDINATOR",
                                                               branch_id=admission.service_branch_id)):
        raise Forbidden("Only an Academic Coordinator can authorise completion")
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

