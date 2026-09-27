"""Admissions: create from an invoice, complimentary courses, list / detail / update, cancel, service-branch
transfers and post-admission fee changes (admin approves, Accounts applies).

The database enforces both prerequisites (accepted plan on the invoice's version, a Verified qualifying payment
on the invoice), copies parties / fee / plan from the invoice, links the invoice's payments, moves the lead to
Admitted and the discussion to Converted, and freezes fee / plan / date afterwards.
"""
from datetime import date, datetime, timezone

from config.database import db
from models import Admission, AdmissionFeeChange, AdmissionTransfer, Branch, Course, FeeDiscussion
from repositories import admissions as admissions_repo
from repositories import users as users_repo
from repositories.common import paginate
from services import audit, tasks
from services import invoices as invoices_service
from services.context import ADMIN_ROLES, COUNSELLOR_ROLES, current_user
from services.errors import BusinessRule, Conflict, Forbidden, NotFound, ValidationError

OWNER_FIELDS = ("record_owner_id", "finance_owner_id", "academic_owner_id")


def get_admission(admission_id: int) -> Admission:
    admission = db.session.get(Admission, admission_id)
    user = current_user()
    if admission is None or not (user.can_access_branch(admission.service_branch_id)
                                 or user.can_access_branch(admission.original_branch_id)):
        raise NotFound("Admission not found")
    return admission


def _check_staff(user_id: int, branch_id: int, field: str) -> None:
    staff = users_repo.user_ids_with_any_role(
        ADMIN_ROLES + COUNSELLOR_ROLES + ("BRANCH_MANAGER", "ACCOUNTS", "ACADEMIC_COORDINATOR"), branch_id)
    if user_id not in staff:
        raise ValidationError("Must be active staff at the branch", {field: ["Not staff at this branch"]})


# ---------------------------------------------------------------- create

def create(data: dict) -> Admission:
    invoice = invoices_service.get_invoice(data["invoice_id"])
    user = current_user()
    branch_id = invoice.collecting_branch_id
    if not (user.is_manager_of(branch_id) or user.has_role(*COUNSELLOR_ROLES, branch_id=branch_id)):
        raise Forbidden("Only counsellors or a branch manager can create admissions")
    existing = admissions_repo.admission_for_invoice(invoice.invoice_id)
    if existing is not None:
        raise Conflict(f"Invoice {invoice.invoice_number} is already admitted as {existing.admission_code}",
                       {"admission_id": existing.admission_id})
    if data.get("service_branch_id") and db.session.get(Branch, data["service_branch_id"]) is None:
        raise ValidationError("Unknown branch", {"service_branch_id": ["Not found"]})
    if data.get("admission_date") and data["admission_date"] > date.today():
        raise ValidationError("Admission date can't be in the future", {"admission_date": ["Must not be in the future"]})
    for field in OWNER_FIELDS:
        if data.get(field):
            _check_staff(data[field], branch_id, field)

    discussion = db.session.get(FeeDiscussion, invoice.fee_discussion_id)
    admission = Admission(
        invoice_id=invoice.invoice_id, service_branch_id=data.get("service_branch_id"),
        admission_date=data.get("admission_date") or date.today(),
        counsellor_id=discussion.counsellor_id or invoice.lead.assigned_to, created_by=user.user_id,
        **{f: data.get(f) for f in OWNER_FIELDS},
    )
    db.session.add(admission)
    db.session.flush()  # prerequisites checked; code, parties, fee and plan filled by the DB
    db.session.refresh(admission)
    db.session.expire_all()
    audit.record("ADMISSION_CREATED", "admission", admission.admission_id,
                 new={"admission_code": admission.admission_code, "invoice_id": invoice.invoice_id,
                      "final_fee": admission.final_fee}, branch_id=admission.original_branch_id)
    return get_admission(admission.admission_id)


def add_complimentary(admission_id: int, data: dict) -> Admission:
    """Complimentary course from an active offer (fee threshold and verified payment checked by the DB)."""
    parent = get_admission(admission_id)
    user = current_user()
    if not (user.is_manager_of(parent.original_branch_id)
            or user.has_role(*COUNSELLOR_ROLES, branch_id=parent.original_branch_id)):
        raise Forbidden("Only counsellors or a branch manager can add complimentary courses")
    if parent.complimentary_of_admission_id is not None:
        raise BusinessRule("A complimentary admission can't grant another")
    if db.session.get(Course, data["course_id"]) is None:
        raise ValidationError("Unknown course", {"course_id": ["Not found"]})
    admission = Admission(
        complimentary_of_admission_id=parent.admission_id, offer_id=data["offer_id"], course_id=data["course_id"],
        final_fee=0, original_branch_id=parent.original_branch_id, service_branch_id=parent.service_branch_id,
        delivery_mode=parent.delivery_mode, admission_date=date.today(), counsellor_id=parent.counsellor_id,
        created_by=user.user_id,
    )
    db.session.add(admission)
    db.session.flush()
    db.session.refresh(admission)
    audit.record("COMPLIMENTARY_ADMISSION_CREATED", "admission", admission.admission_id,
                 new={"parent": parent.admission_code, "offer_id": data["offer_id"], "course_id": data["course_id"]},
                 branch_id=admission.original_branch_id)
    return admission


# ---------------------------------------------------------------- read / update

def list_admissions(filters: dict, page: int, per_page: int):
    return paginate(admissions_repo.admissions_stmt(filters, current_user().branch_ids()), page, per_page)


def update(admission_id: int, data: dict) -> Admission:
    admission = get_admission(admission_id)
    user = current_user()
    branch_id = admission.service_branch_id
    if not (user.is_manager_of(branch_id)
            or user.has_role(*COUNSELLOR_ROLES, "ACCOUNTS", "ACADEMIC_COORDINATOR", branch_id=branch_id)):
        raise Forbidden("You can't update this admission")
    for field in OWNER_FIELDS:
        if data.get(field):
            _check_staff(data[field], branch_id, field)
    old = {field: getattr(admission, field) for field in data}
    for field, value in data.items():
        setattr(admission, field, value)
    if data.get("lms_status") in ("Invited", "Active"):
        admission.lms_last_synced_at = datetime.now(timezone.utc)
    db.session.flush()
    audit.record("ADMISSION_UPDATED", "admission", admission_id, old=old, new=data, branch_id=branch_id)
    return admission


def _managed(admission_id: int) -> Admission:
    admission = get_admission(admission_id)
    if not current_user().is_manager_of(admission.service_branch_id):
        raise Forbidden("Only a branch manager of the service branch can do this")
    return admission


def close_allocations(admission: Admission, status: str, reason: str) -> None:
    now = datetime.now(timezone.utc)
    for allocation in admissions_repo.active_allocations(admission.admission_id):
        allocation.status, allocation.ended_at, allocation.end_reason = status, now, reason


def cancel(admission_id: int, reason: str) -> Admission:
    """Operational cancellation (a refund is a separate case)."""
    admission = _managed(admission_id)
    if admission.enrolment_status in ("Cancelled", "Completed"):
        raise BusinessRule(f"Admission is {admission.enrolment_status}")
    close_allocations(admission, "Withdrawn", f"Admission cancelled: {reason}")
    admission.enrolment_status = "Cancelled"
    admission.cancelled_by = current_user().user_id
    admission.cancelled_at = datetime.now(timezone.utc)
    admission.cancellation_reason = reason
    db.session.flush()
    audit.record("ADMISSION_CANCELLED", "admission", admission_id, reason=reason, branch_id=admission.service_branch_id)
    db.session.expire(admission, ["balance"])
    return admission


def transfer(admission_id: int, data: dict) -> AdmissionTransfer:
    admission = _managed(admission_id)
    if not admission.is_active:
        raise BusinessRule(f"Admission is {admission.enrolment_status}")
    if db.session.get(Branch, data["to_branch_id"]) is None:
        raise ValidationError("Unknown branch", {"to_branch_id": ["Not found"]})
    if data["to_branch_id"] == admission.service_branch_id:
        raise ValidationError("The student is already served there", {"to_branch_id": ["Same as current branch"]})
    user = current_user()
    close_allocations(admission, "Moved", "Service branch transfer")
    record = AdmissionTransfer(admission_id=admission_id, to_branch_id=data["to_branch_id"], reason=data["reason"],
                               effective_date=data.get("effective_date") or date.today(),
                               requested_by=data.get("requested_by") or user.user_id, approved_by=user.user_id)
    db.session.add(record)
    db.session.flush()  # moves admissions.service_branch_id
    db.session.refresh(record)
    db.session.expire(admission)
    audit.record("ADMISSION_TRANSFERRED", "admission", admission_id,
                 old={"service_branch_id": record.from_branch_id}, new={"service_branch_id": record.to_branch_id},
                 reason=data["reason"], branch_id=record.from_branch_id)
    return record


# ---------------------------------------------------------------- fee changes

def get_fee_change(fee_change_id: int) -> AdmissionFeeChange:
    change = db.session.get(AdmissionFeeChange, fee_change_id)
    if change is None:
        raise NotFound("Fee change not found")
    get_admission(change.admission_id)
    return change


def request_fee_change(admission_id: int, data: dict) -> AdmissionFeeChange:
    admission = get_admission(admission_id)
    user = current_user()
    if not (user.is_manager_of(admission.service_branch_id)
            or user.has_role(*COUNSELLOR_ROLES, branch_id=admission.original_branch_id)):
        raise Forbidden("Only counsellors or a branch manager can request fee changes")
    if admission.complimentary_of_admission_id is not None:
        raise BusinessRule("Complimentary admissions have no fee")
    if data["new_fee"] == admission.final_fee:
        raise ValidationError("The new fee is the same as the current one", {"new_fee": ["No change"]})
    change = AdmissionFeeChange(admission_id=admission_id, new_fee=data["new_fee"], reason=data["reason"],
                                requested_by=user.user_id)
    db.session.add(change)
    db.session.flush()  # one open change per admission (unique index)
    db.session.refresh(change)
    tasks.create_system_task("APPROVAL", f"Approve fee change for {admission.admission_code}: ₹{change.old_fee} → "
                             f"₹{change.new_fee}", admission.service_branch_id, datetime.now(timezone.utc),
                             team_role_code="FOUNDER_CEO", dedupe_key=f"fee-change:{change.fee_change_id}",
                             admission_id=admission_id)
    audit.record("FEE_CHANGE_REQUESTED", "admission", admission_id,
                 new={"old_fee": change.old_fee, "new_fee": change.new_fee}, reason=data["reason"],
                 branch_id=admission.service_branch_id)
    return change


def decide_fee_change(fee_change_id: int, approve: bool, reason: str | None) -> AdmissionFeeChange:
    change = get_fee_change(fee_change_id)
    user = current_user()
    if change.status != "Pending":
        raise BusinessRule(f"Fee change is {change.status}")
    if change.requested_by == user.user_id:
        raise Forbidden("You can't approve your own fee change")
    change.status = "Approved" if approve else "Rejected"
    change.approved_by = user.user_id  # recorded for rejections too
    change.rejection_reason = None if approve else reason
    db.session.flush()
    db.session.refresh(change)  # approved_at is stamped by the DB
    tasks.complete_system_task(f"fee-change:{fee_change_id}")
    if approve:
        tasks.create_system_task("GENERAL", f"Apply approved fee change for {change.admission.admission_code}",
                                 change.admission.service_branch_id, datetime.now(timezone.utc),
                                 team_role_code="ACCOUNTS", dedupe_key=f"fee-change-apply:{fee_change_id}",
                                 admission_id=change.admission_id)
    audit.record("FEE_CHANGE_APPROVED" if approve else "FEE_CHANGE_REJECTED", "admission", change.admission_id,
                 new={"fee_change_id": fee_change_id, "new_fee": change.new_fee}, reason=reason,
                 branch_id=change.admission.service_branch_id)
    return change


def apply_fee_change(fee_change_id: int) -> AdmissionFeeChange:
    """Accounts applies it: admission fee, invoice amount and instalments are revised by the DB."""
    change = get_fee_change(fee_change_id)
    if not current_user().has_role("ACCOUNTS", branch_id=change.admission.service_branch_id):
        raise Forbidden("Only Accounts at the service branch can apply fee changes")
    change.status = "Applied"
    change.accounts_corrected_by = current_user().user_id
    db.session.flush()
    tasks.complete_system_task(f"fee-change-apply:{fee_change_id}")
    db.session.refresh(change)
    db.session.expire(change.admission)
    audit.record("FEE_CHANGE_APPLIED", "admission", change.admission_id,
                 old={"final_fee": change.old_fee}, new={"final_fee": change.new_fee},
                 branch_id=change.admission.service_branch_id)
    return change
