"""Admissions: created per invoiced course (automatically on verification, or from the eligibility review),
complimentary courses, list / detail / update, cancel, service-branch transfers and post-admission fee changes
(admin approves, Accounts applies).

The database enforces the prerequisites (the course's accepted delivery plan, verified money on its invoice line
reaching the ₹1,000 token), copies parties / fee / plan / delivery from the line, links payments wholly on the line,
moves the lead to Admitted and the discussion to Converted, and freezes fee / plan / date afterwards.
"""
from datetime import date, datetime, timezone

from config.database import db
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from models import (
    Admission, AdmissionFeeChange, AdmissionTransfer, Branch, Course, DeliveryPlan, Invoice, InvoiceLine,
)
from repositories import admissions as admissions_repo
from repositories import invoices as invoices_repo
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

def _line_for(data: dict) -> InvoiceLine:
    """The invoiced course: invoice_line_id, or invoice_id for a one-course invoice."""
    if data.get("invoice_line_id"):
        line = db.session.get(InvoiceLine, data["invoice_line_id"])
        if line is None:
            raise NotFound("Invoice line not found")
        invoices_service.get_invoice(line.invoice_id)
        return line
    invoice = invoices_service.get_invoice(data["invoice_id"])
    if len(invoice.lines) != 1:
        raise ValidationError(f"{invoice.invoice_number} has {len(invoice.lines)} courses; choose one",
                              {"invoice_line_id": ["Required for a multi-course invoice"]})
    return invoice.lines[0]


def _insert_admission(line: InvoiceLine, data: dict, created_by: int) -> Admission:
    admission = Admission(
        invoice_id=line.invoice_id, invoice_line_id=line.invoice_line_id, service_branch_id=data.get("service_branch_id"),
        admission_date=data.get("admission_date") or date.today(),
        counsellor_id=line.lead.assigned_to, created_by=created_by, **{f: data.get(f) for f in OWNER_FIELDS},
    )
    db.session.add(admission)
    db.session.flush()  # prerequisites checked; code, parties, fee, plan and delivery filled by the DB
    db.session.refresh(admission)
    audit.record("ADMISSION_CREATED", "admission", admission.admission_id,
                 new={"admission_code": admission.admission_code, "invoice_id": line.invoice_id,
                      "invoice_line_id": line.invoice_line_id, "final_fee": admission.final_fee},
                 branch_id=admission.original_branch_id)
    return admission


def create(data: dict) -> Admission:
    """Manual creation from the eligibility review (normally admissions are created on verification)."""
    line = _line_for(data)
    user = current_user()
    branch_id = line.invoice.collecting_branch_id
    if not (user.is_manager_of(branch_id) or user.has_role(*COUNSELLOR_ROLES, "ACCOUNTS", branch_id=branch_id)):
        raise Forbidden("Only counsellors, accounts or a branch manager can create admissions")
    existing = admissions_repo.admission_for_line(line.invoice_line_id)
    if existing is not None:
        raise Conflict(f"{line.course.course_title} on {line.invoice.invoice_number} is already admitted as "
                       f"{existing.admission_code}", {"admission_id": existing.admission_id})
    if data.get("service_branch_id") and db.session.get(Branch, data["service_branch_id"]) is None:
        raise ValidationError("Unknown branch", {"service_branch_id": ["Not found"]})
    if data.get("admission_date") and data["admission_date"] > date.today():
        raise ValidationError("Admission date can't be in the future", {"admission_date": ["Must not be in the future"]})
    for field in OWNER_FIELDS:
        if data.get(field):
            _check_staff(data[field], branch_id, field)
    admission = _insert_admission(line, data, user.user_id)
    db.session.expire_all()
    return get_admission(admission.admission_id)


def auto_admit(invoice_id: int) -> list[Admission]:
    """After verification: every course line of the invoice whose verified money reached the admission token gets
    its admission — once (unique per line), reusing the person. A line the database refuses (e.g. an offer already
    used) is left for the eligibility review, with a task for the branch manager."""
    invoice = db.session.get(Invoice, invoice_id)
    if invoice is None or invoice.status != "Issued":
        return []
    created = []
    for line in invoice.lines:
        if admissions_repo.admission_for_line(line.invoice_line_id) is not None or not line.lead.is_open:
            continue
        token = invoices_repo.line_token_status(line.invoice_line_id)
        if token["payment_id"] is None and token["token"] > 0:
            continue
        savepoint = db.session.begin_nested()
        try:
            admission = _insert_admission(line, {}, current_user().user_id)
            savepoint.commit()
        except SQLAlchemyError as exc:
            savepoint.rollback()
            message = str(getattr(exc, "orig", exc)).split("\n")[0]
            tasks.create_system_task("GENERAL", f"Admission blocked for {line.course.course_title} on "
                                     f"{invoice.invoice_number}: {message}", invoice.collecting_branch_id,
                                     datetime.now(timezone.utc), team_role_code="BRANCH_MANAGER",
                                     dedupe_key=f"admission-blocked:{line.invoice_line_id}", invoice_id=invoice_id)
            continue
        created.append(admission)
    if created:
        db.session.expire_all()
    return created


def eligibility(filters: dict, page: int, per_page: int):
    """New Admission review: invoiced courses not yet admitted, with what each still needs."""
    lines, meta = paginate(admissions_repo.unadmitted_lines_stmt(filters, current_user().branch_ids()), page, per_page)
    rows = []
    for line in lines:
        token = invoices_repo.line_token_status(line.invoice_line_id)
        plan = db.session.execute(select(DeliveryPlan).where(DeliveryPlan.lead_id == line.lead_id)).scalar_one_or_none()
        plan_ok = plan is not None and plan.accepted_at is not None
        token_ok = token["payment_id"] is not None or token["token"] == 0
        rows.append({
            **line.to_dict(), "invoice": line.invoice.to_summary(), "person": line.invoice.person.to_summary(),
            "branch": line.invoice.collecting_branch.to_summary(),
            "delivery_plan": plan.to_dict() if plan else None, "token": token["token"],
            "verified_total": token["verified_total"], "eligible": plan_ok and token_ok and line.lead.is_open,
            "waiting_for": [w for w, ok in (("accepted delivery plan", plan_ok),
                                            (f"₹{token['token']:.2f} verified", token_ok),
                                            ("an open deal", line.lead.is_open)) if not ok],
        })
    return rows, meta


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
