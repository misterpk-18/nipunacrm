"""Admissions, batches, allocations and curriculum queries."""
from sqlalchemy import Select, or_, select

from config.database import db
from models import (
    Admission, AdmissionBalance, AdmissionCurriculum, AdmissionFeeChange, Batch, BatchAllocation,
    BatchAllocationQueue, CurriculumVersion, Person,
)


def admissions_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    stmt = (select(Admission).join(Person, Person.person_id == Admission.person_id)
            .join(AdmissionBalance, AdmissionBalance.admission_id == Admission.admission_id)
            .order_by(Admission.created_at.desc(), Admission.admission_id.desc()))
    if branch_ids is not None:
        stmt = stmt.where(or_(Admission.service_branch_id.in_(branch_ids), Admission.original_branch_id.in_(branch_ids)))
    if filters.get("branch_id"):
        stmt = stmt.where(or_(Admission.service_branch_id == filters["branch_id"],
                              Admission.original_branch_id == filters["branch_id"]))
    for field, column in (("service_branch_id", Admission.service_branch_id),
                          ("original_branch_id", Admission.original_branch_id),
                          ("enrolment_status", Admission.enrolment_status),
                          ("curriculum_status", Admission.curriculum_status),
                          ("handover_status", Admission.handover_status), ("lms_status", Admission.lms_status),
                          ("seat_type", Admission.seat_type), ("person_id", Admission.person_id),
                          ("course_id", Admission.course_id), ("payment_completion", AdmissionBalance.payment_completion)):
        if filters.get(field) is not None:
            stmt = stmt.where(column == filters[field])
    if filters.get("q"):
        pattern = f"%{filters['q']}%"
        stmt = stmt.where(or_(Admission.admission_code.ilike(pattern), Person.full_name.ilike(pattern),
                              Person.phone.ilike(pattern)))
    return stmt


def admission_for_invoice(invoice_id: int) -> Admission | None:
    return db.session.execute(select(Admission).where(Admission.invoice_id == invoice_id)).scalar_one_or_none()


def active_allocations(admission_id: int) -> list[BatchAllocation]:
    stmt = select(BatchAllocation).where(BatchAllocation.admission_id == admission_id, BatchAllocation.status == "Active")
    return list(db.session.execute(stmt).scalars())


def allocations_for(admission_id: int) -> list[BatchAllocation]:
    stmt = select(BatchAllocation).where(BatchAllocation.admission_id == admission_id).order_by(BatchAllocation.allocation_id)
    return list(db.session.execute(stmt).scalars())


def curricula_for(admission_id: int) -> list[AdmissionCurriculum]:
    stmt = select(AdmissionCurriculum).where(AdmissionCurriculum.admission_id == admission_id)
    return list(db.session.execute(stmt).scalars())


def fee_changes_for(admission_id: int) -> list[AdmissionFeeChange]:
    stmt = select(AdmissionFeeChange).where(AdmissionFeeChange.admission_id == admission_id).order_by(
        AdmissionFeeChange.fee_change_id)
    return list(db.session.execute(stmt).scalars())


def batches_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    stmt = select(Batch).order_by(Batch.start_date, Batch.batch_id)
    if branch_ids is not None:
        stmt = stmt.where(Batch.branch_id.in_(branch_ids))
    for field, column in (("branch_id", Batch.branch_id), ("course_id", Batch.course_id), ("status", Batch.status),
                          ("trainer_id", Batch.trainer_user_id)):
        if filters.get(field) is not None:
            stmt = stmt.where(column == filters[field])
    return stmt


def batch_allocations(batch_id: int) -> list[BatchAllocation]:
    stmt = (select(BatchAllocation).where(BatchAllocation.batch_id == batch_id)
            .order_by(BatchAllocation.status, BatchAllocation.allocation_id))
    return list(db.session.execute(stmt).scalars())


def queue_stmt(filters: dict, branch_ids: set[int] | None) -> Select:
    stmt = select(BatchAllocationQueue).order_by(BatchAllocationQueue.allocate_by.asc().nulls_last())
    if branch_ids is not None:
        stmt = stmt.where(BatchAllocationQueue.service_branch_id.in_(branch_ids))
    if filters.get("branch_id"):
        stmt = stmt.where(BatchAllocationQueue.service_branch_id == filters["branch_id"])
    if filters.get("course_id"):
        stmt = stmt.join(Admission, Admission.admission_id == BatchAllocationQueue.admission_id).where(
            Admission.course_id == filters["course_id"])
    return stmt


def curriculum_versions(course_id: int | None) -> list[CurriculumVersion]:
    stmt = select(CurriculumVersion).order_by(CurriculumVersion.course_id, CurriculumVersion.created_at)
    if course_id:
        stmt = stmt.where(CurriculumVersion.course_id == course_id)
    return list(db.session.execute(stmt).scalars())


def published_version(course_id: int) -> CurriculumVersion | None:
    stmt = select(CurriculumVersion).where(CurriculumVersion.course_id == course_id,
                                           CurriculumVersion.status == "Published")
    return db.session.execute(stmt).scalar_one_or_none()
