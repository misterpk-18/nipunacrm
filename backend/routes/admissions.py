"""Admissions & academics (sidebar #5): admissions, transfers, fee changes, batches, allocation, curriculum."""
from flask import Blueprint

from controllers import admissions as admissions_controller
from routes.decorators import fresh_auth, login_required, require_roles
from services.context import ACADEMIC_ROLES, ADMIN_ROLES, LEAD_ROLES, STAFF_ROLES

admissions_bp = Blueprint("admissions", __name__)
ADMISSION_READERS = STAFF_ROLES


def route(rule: str, method: str, roles, fresh=False):
    def decorator(view):
        wrapped = fresh_auth(view) if fresh else view
        return getattr(admissions_bp, method)(rule)(login_required(require_roles(*roles)(wrapped)))
    return decorator


# ---------------------------------------------------------------- admissions

@route("/admissions", "post", LEAD_ROLES)
def create_admission():
    return admissions_controller.create_admission()


@route("/admissions", "get", ADMISSION_READERS)
def list_admissions():
    return admissions_controller.list_admissions()


@route("/admissions/<int:admission_id>", "get", ADMISSION_READERS)
def get_admission(admission_id: int):
    return admissions_controller.get_admission(admission_id)


@route("/admissions/<int:admission_id>", "patch", ADMISSION_READERS)
def update_admission(admission_id: int):
    return admissions_controller.update_admission(admission_id)


@route("/admissions/<int:admission_id>/complimentary", "post", LEAD_ROLES)
def add_complimentary(admission_id: int):
    return admissions_controller.add_complimentary(admission_id)


@route("/admissions/<int:admission_id>/cancel", "post", ADMIN_ROLES + ("BRANCH_MANAGER",))
def cancel_admission(admission_id: int):
    return admissions_controller.cancel_admission(admission_id)


@route("/admissions/<int:admission_id>/transfers", "post", ADMIN_ROLES + ("BRANCH_MANAGER",))
def transfer_admission(admission_id: int):
    return admissions_controller.transfer_admission(admission_id)


@route("/admissions/<int:admission_id>/fee-changes", "post", LEAD_ROLES)
def request_fee_change(admission_id: int):
    return admissions_controller.request_fee_change(admission_id)


@route("/admission-fee-changes/<int:fee_change_id>/approve", "post", ADMIN_ROLES, fresh=True)
def approve_fee_change(fee_change_id: int):
    return admissions_controller.decide_fee_change(fee_change_id, True)


@route("/admission-fee-changes/<int:fee_change_id>/reject", "post", ADMIN_ROLES, fresh=True)
def reject_fee_change(fee_change_id: int):
    return admissions_controller.decide_fee_change(fee_change_id, False)


@route("/admission-fee-changes/<int:fee_change_id>/apply", "post", ("ACCOUNTS",), fresh=True)
def apply_fee_change(fee_change_id: int):
    return admissions_controller.apply_fee_change(fee_change_id)


# ---------------------------------------------------------------- batches & allocation

@route("/batches", "get", ACADEMIC_ROLES + ("TRAINER",))
def list_batches():
    return admissions_controller.list_batches()


@route("/batches", "post", ACADEMIC_ROLES)
def create_batch():
    return admissions_controller.create_batch()


@route("/batches/<int:batch_id>", "get", ACADEMIC_ROLES + ("TRAINER",))
def get_batch(batch_id: int):
    return admissions_controller.get_batch(batch_id)


@route("/batches/<int:batch_id>", "patch", ACADEMIC_ROLES)
def update_batch(batch_id: int):
    return admissions_controller.update_batch(batch_id)


@route("/batch-allocation-queue", "get", ACADEMIC_ROLES)
def allocation_queue():
    return admissions_controller.allocation_queue()


@route("/batches/<int:batch_id>/allocation-check", "get", ACADEMIC_ROLES)
def allocation_check(batch_id: int):
    return admissions_controller.allocation_check(batch_id)


@route("/admissions/<int:admission_id>/allocations", "post", ACADEMIC_ROLES)
def allocate(admission_id: int):
    return admissions_controller.allocate(admission_id)


@route("/batch-allocations/<int:allocation_id>/close", "post", ACADEMIC_ROLES)
def close_allocation(allocation_id: int):
    return admissions_controller.close_allocation(allocation_id)


@route("/batch-allocations/<int:allocation_id>/joining-date", "post", ACADEMIC_ROLES + ("TRAINER",))
def set_joining_date(allocation_id: int):
    return admissions_controller.set_joining_date(allocation_id)


# ---------------------------------------------------------------- curriculum / completion

@route("/curriculum-versions", "get", ACADEMIC_ROLES + ("TRAINER",))
def list_curriculum_versions():
    return admissions_controller.list_curriculum_versions()


@route("/curriculum-versions", "post", ADMIN_ROLES + ("ACADEMIC_COORDINATOR",))
def create_curriculum_version():
    return admissions_controller.create_curriculum_version()


@route("/curriculum-versions/<int:version_id>/publish", "post", ADMIN_ROLES + ("ACADEMIC_COORDINATOR",))
def publish_curriculum_version(version_id: int):
    return admissions_controller.publish_curriculum_version(version_id)


@route("/admissions/<int:admission_id>/curricula", "post", ADMIN_ROLES + ("ACADEMIC_COORDINATOR",))
def map_curriculum(admission_id: int):
    return admissions_controller.map_curriculum(admission_id)


@route("/admissions/<int:admission_id>/complete", "post", ADMIN_ROLES + ("ACADEMIC_COORDINATOR",))
def complete_admission(admission_id: int):
    return admissions_controller.complete_admission(admission_id)
