"""Admissions, transfers, fee changes; batches, allocations, curriculum and completion."""
from flask import request

from controllers.common import Validator, created, get_page_params, json_body, ok, paginated, require_changes
from models.enums import (
    BATCH_STATUSES, CURRICULUM_STATUSES, DELIVERY_MODES, ENROLMENT_STATUSES, HANDOVER_STATUSES, LMS_STATUSES,
    SEAT_TYPES,
)
from repositories import admissions as admissions_repo
from services import academics as academics_service
from services import admissions as admissions_service


def _admission_detail(admission) -> dict:
    return {
        **admission.to_dict(),
        "allocations": [a.to_dict() for a in admissions_repo.allocations_for(admission.admission_id)],
        "curricula": [c.to_dict() for c in admissions_repo.curricula_for(admission.admission_id)],
        "fee_changes": [c.to_dict() for c in admissions_repo.fee_changes_for(admission.admission_id)],
    }


# ---------------------------------------------------------------- admissions

def create_admission():
    v = Validator(json_body())
    v.integer("invoice_id", required=True, min_value=1)
    v.integer("service_branch_id", nullable=True, min_value=1)
    v.date("admission_date", nullable=True)
    for field in admissions_service.OWNER_FIELDS:
        v.integer(field, nullable=True, min_value=1)
    return created(_admission_detail(admissions_service.create(v.validate())))


def add_complimentary(admission_id: int):
    v = Validator(json_body())
    v.integer("offer_id", required=True, min_value=1)
    v.integer("course_id", required=True, min_value=1)
    return created(admissions_service.add_complimentary(admission_id, v.validate()).to_dict())


def list_admissions():
    v = Validator(request.args.to_dict())
    for field in ("branch_id", "service_branch_id", "original_branch_id", "person_id", "course_id"):
        v.integer(field, min_value=1)
    v.choice("enrolment_status", ENROLMENT_STATUSES)
    v.choice("curriculum_status", CURRICULUM_STATUSES)
    v.choice("handover_status", HANDOVER_STATUSES)
    v.choice("lms_status", LMS_STATUSES)
    v.choice("seat_type", SEAT_TYPES)
    v.choice("payment_completion", ("Unpaid", "Part Paid", "Paid"))
    v.string("q", max_length=100)
    page, per_page = get_page_params()
    admissions, meta = admissions_service.list_admissions(v.validate(), page, per_page)
    return paginated([a.to_row() for a in admissions], meta)


def get_admission(admission_id: int):
    return ok(_admission_detail(admissions_service.get_admission(admission_id)))


def update_admission(admission_id: int):
    v = Validator(json_body())
    v.choice("handover_status", HANDOVER_STATUSES)
    v.choice("lms_status", LMS_STATUSES)
    v.choice("delivery_mode", DELIVERY_MODES)
    v.date("planned_start_date", nullable=True)
    for field in admissions_service.OWNER_FIELDS:
        v.integer(field, nullable=True, min_value=1)
    return ok(_admission_detail(admissions_service.update(admission_id, require_changes(v.validate()))))


def cancel_admission(admission_id: int):
    v = Validator(json_body())
    v.string("reason", required=True)
    return ok(admissions_service.cancel(admission_id, v.validate()["reason"]).to_dict())


def transfer_admission(admission_id: int):
    v = Validator(json_body())
    v.integer("to_branch_id", required=True, min_value=1)
    v.string("reason", required=True)
    v.date("effective_date", nullable=True)
    v.integer("requested_by", nullable=True, min_value=1)
    return created(admissions_service.transfer(admission_id, v.validate()).to_dict())


def request_fee_change(admission_id: int):
    v = Validator(json_body())
    v.decimal("new_fee", required=True, min_value=0)
    v.string("reason", required=True)
    return created(admissions_service.request_fee_change(admission_id, v.validate()).to_dict())


def decide_fee_change(fee_change_id: int, approve: bool):
    v = Validator(json_body())
    v.string("reason", required=not approve, nullable=approve)
    return ok(admissions_service.decide_fee_change(fee_change_id, approve, v.validate().get("reason")).to_dict())


def apply_fee_change(fee_change_id: int):
    return ok(admissions_service.apply_fee_change(fee_change_id).to_dict())


# ---------------------------------------------------------------- batches

def _batch_rules(v: Validator, creating: bool) -> None:
    v.string("batch_name", required=creating, max_length=150)
    if creating:
        v.integer("course_id", required=True, min_value=1)
        v.integer("branch_id", required=True, min_value=1)
    v.integer("curriculum_version_id", nullable=True, min_value=1)
    v.choice("delivery_mode", DELIVERY_MODES)
    v.integer("trainer_user_id", nullable=True, min_value=1)
    v.string("schedule_days", nullable=True, max_length=50)
    v.time("start_time")
    v.time("end_time")
    v.date("start_date", required=creating)
    v.date("end_date", nullable=True)
    v.integer("capacity", required=creating, min_value=1)
    v.integer("min_students", nullable=True, min_value=1)
    v.string("location", nullable=True, max_length=255)
    v.choice("status", BATCH_STATUSES)
    v.string("lms_course_id", nullable=True, max_length=100)


def list_batches():
    v = Validator(request.args.to_dict())
    for field in ("branch_id", "course_id", "trainer_id"):
        v.integer(field, min_value=1)
    v.choice("status", BATCH_STATUSES)
    page, per_page = get_page_params()
    batches, meta = academics_service.list_batches(v.validate(), page, per_page)
    return paginated([b.to_dict() for b in batches], meta)


def create_batch():
    v = Validator(json_body())
    _batch_rules(v, creating=True)
    return created(academics_service.create_batch(v.validate()).to_dict())


def get_batch(batch_id: int):
    w = academics_service.batch_workspace(batch_id)
    return ok({**w["batch"].to_dict(), "allocations": [a.to_dict() for a in w["allocations"]],
               "awaiting_allocation": [row.to_dict() for row in w["awaiting"]]})


def update_batch(batch_id: int):
    v = Validator(json_body())
    _batch_rules(v, creating=False)
    return ok(academics_service.update_batch(batch_id, require_changes(v.validate())).to_dict())


def allocation_queue():
    v = Validator(request.args.to_dict())
    v.integer("branch_id", min_value=1)
    v.integer("course_id", min_value=1)
    page, per_page = get_page_params()
    rows, meta = academics_service.allocation_queue(v.validate(), page, per_page)
    return paginated([r.to_dict() for r in rows], meta)


def allocation_check(batch_id: int):
    v = Validator(request.args.to_dict())
    v.integer("admission_id", required=True, min_value=1)
    return ok(academics_service.allocation_check(batch_id, v.validate()["admission_id"]))


def allocate(admission_id: int):
    v = Validator(json_body())
    v.integer("batch_id", required=True, min_value=1)
    return created(academics_service.allocate(admission_id, v.validate()["batch_id"]).to_dict())


def close_allocation(allocation_id: int):
    v = Validator(json_body())
    v.choice("status", ("Moved", "Withdrawn", "Completed"), required=True)
    v.string("reason", nullable=True)
    data = v.validate()
    return ok(academics_service.close_allocation(allocation_id, data["status"], data.get("reason")).to_dict())


def set_joining_date(allocation_id: int):
    v = Validator(json_body())
    v.date("joining_date", required=True)
    return ok(academics_service.set_joining_date(allocation_id, v.validate()["joining_date"]).to_dict())


# ---------------------------------------------------------------- curriculum / completion

def list_curriculum_versions():
    v = Validator(request.args.to_dict())
    v.integer("course_id", min_value=1)
    return ok([c.to_dict() for c in academics_service.list_curriculum_versions(v.validate().get("course_id"))])


def create_curriculum_version():
    v = Validator(json_body())
    v.integer("course_id", required=True, min_value=1)
    v.string("version_label", required=True, max_length=30)
    v.string("notes", nullable=True)
    v.boolean("publish", default=False)
    return created(academics_service.create_curriculum_version(v.validate()).to_dict())


def publish_curriculum_version(version_id: int):
    return ok(academics_service.publish_curriculum_version(version_id).to_dict())


def map_curriculum(admission_id: int):
    v = Validator(json_body())
    v.integer("curriculum_version_id", required=True, min_value=1)
    admission = academics_service.map_curriculum(admission_id, v.validate()["curriculum_version_id"])
    return ok(_admission_detail(admission))


def complete_admission(admission_id: int):
    return ok(academics_service.complete(admission_id).to_dict())
