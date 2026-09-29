"""Refund cases: registration (always allowed) → assessment → decision (admins) → payout → reconciliation.

The database sets the 7-working-day decision and 18-working-day payout targets, restricts decisions to
Founder / CEO or Super Admin, caps refunds at verified payments, forbids the decider executing the payout,
and requires reconciliation before Completed.
"""
from datetime import datetime, timezone

from sqlalchemy import select

from config.database import db
from models import Admission, Payment, PaymentMode, RefundCase, RefundCaseReceipt
from repositories.common import paginate
from services import audit, tasks
from services import admissions as admissions_service
from services.context import current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError


def _stmt(filters: dict, branch_ids: set[int] | None):
    stmt = select(RefundCase).join(Admission, Admission.admission_id == RefundCase.admission_id).order_by(
        RefundCase.requested_at.desc())
    if branch_ids is not None:
        stmt = stmt.where(Admission.service_branch_id.in_(branch_ids))
    for field, column in (("status", RefundCase.status), ("refund_decision", RefundCase.refund_decision),
                          ("payout_status", RefundCase.payout_status), ("admission_id", RefundCase.admission_id),
                          ("branch_id", Admission.service_branch_id)):
        if filters.get(field) is not None:
            stmt = stmt.where(column == filters[field])
    return stmt


def list_cases(filters: dict, page: int, per_page: int):
    return paginate(_stmt(filters, current_user().branch_ids()), page, per_page)


def get_case(case_id: int) -> RefundCase:
    case = db.session.get(RefundCase, case_id)
    if case is None or not current_user().can_access_branch(case.admission.service_branch_id):
        raise NotFound("Refund case not found")
    return case


def _set_receipts(case: RefundCase, payment_ids: list[int]) -> None:
    for payment_id in payment_ids:
        payment = db.session.get(Payment, payment_id)
        line_id = case.admission.invoice_line_id
        on_line = payment is not None and line_id is not None and any(
            a.invoice_line_id == line_id for a in payment.allocations)
        if payment is None or not (payment.admission_id == case.admission_id or on_line):
            raise ValidationError("Receipts must belong to this admission", {"payment_ids": [f"{payment_id} not found"]})
    case.receipts = [RefundCaseReceipt(payment_id=pid) for pid in payment_ids]


def register(data: dict) -> RefundCase:
    admission = admissions_service.get_admission(data["admission_id"])
    user = current_user()
    if not (user.is_manager_of(admission.service_branch_id) or user.has_role("ACCOUNTS", branch_id=admission.service_branch_id)):
        raise Forbidden("Only a branch manager, Accounts or an admin can register refund cases")
    case = RefundCase(admission_id=admission.admission_id, request_reason=data["request_reason"],
                      request_timing=data.get("request_timing"),
                      evidence_status=data.get("evidence_status", "Evidence Pending"), created_by=user.user_id)
    db.session.add(case)
    db.session.flush()
    _set_receipts(case, data.get("payment_ids", []))
    db.session.flush()
    db.session.refresh(case)  # code and decision due time from triggers
    tasks.create_system_task("REFUND_CASE", f"Decide refund case {case.case_code} · {admission.person.full_name}",
                             admission.service_branch_id, case.decision_due_at, team_role_code="FOUNDER_CEO",
                             dedupe_key=f"refund-decide:{case.refund_case_id}", refund_case_id=case.refund_case_id)
    audit.record("REFUND_CASE_REGISTERED", "admission", admission.admission_id,
                 new={"case_code": case.case_code}, reason=data["request_reason"], branch_id=admission.service_branch_id)
    return case


def update(case_id: int, data: dict) -> RefundCase:
    case = get_case(case_id)
    if case.status in RefundCase.CLOSED_STATUSES:
        raise BusinessRule(f"Refund case is {case.status}")
    payment_ids = data.pop("payment_ids", None)
    for field, value in data.items():
        setattr(case, field, value)
    if payment_ids is not None:
        _set_receipts(case, payment_ids)
    if case.status == "Registered" and (case.assessment_date or case.assessment_notes):
        case.status = "Under Assessment"
    db.session.flush()
    return case


def decide(case_id: int, data: dict) -> RefundCase:
    case = get_case(case_id)
    if case.refund_decision != "Pending" or case.status in RefundCase.CLOSED_STATUSES:
        raise BusinessRule(f"Refund case is already {case.refund_decision if case.refund_decision != 'Pending' else case.status}")
    decision = data["decision"]
    if decision == "Refund Approved" and not data.get("amount"):
        raise ValidationError("Give the approved refund amount", {"amount": ["Required"]})
    if decision == "Waiver Approved" and not data.get("amount"):
        raise ValidationError("Give the approved waiver amount", {"amount": ["Required"]})
    if decision == "Rejected" and not data.get("reason"):
        raise ValidationError("A rejection needs a reason", {"reason": ["Required"]})
    case.refund_decision = decision
    case.decided_by = current_user().user_id
    case.decided_at = datetime.now(timezone.utc)
    case.decision_reason = data.get("reason")
    if decision == "Refund Approved":
        case.approved_refund_amount = data["amount"]
        case.payout_status = "Approved"
    elif decision == "Waiver Approved":
        case.approved_waiver_amount = data["amount"]
    case.status = "Decided"
    db.session.flush()  # role, refund cap and payout target checked / set by the DB
    db.session.refresh(case)
    tasks.complete_system_task(f"refund-decide:{case_id}")
    if decision == "Refund Approved":
        tasks.create_system_task("REFUND_CASE", f"Pay out refund {case.case_code} · ₹{case.approved_refund_amount}",
                                 case.admission.service_branch_id, case.payout_due_at, team_role_code="ACCOUNTS",
                                 dedupe_key=f"refund-payout:{case_id}", refund_case_id=case_id)
    audit.record("REFUND_DECIDED", "admission", case.admission_id,
                 new={"case_code": case.case_code, "decision": decision, "amount": data.get("amount")},
                 reason=data.get("reason"), branch_id=case.admission.service_branch_id)
    db.session.expire(case.admission, ["balance"])
    return case


def _accounts(case: RefundCase) -> None:
    if not current_user().has_role("ACCOUNTS", branch_id=case.admission.service_branch_id):
        raise Forbidden("Only Accounts at the service branch can handle payouts")


def payout(case_id: int, data: dict) -> RefundCase:
    """Processing (amount, mode, reference) → Completed (needs reconciliation first) or Failed (needs a reason)."""
    case = get_case(case_id)
    _accounts(case)
    status = data["status"]
    if case.refund_decision != "Refund Approved":
        raise BusinessRule("There is no approved refund to pay out")
    if case.payout_status in ("Completed",):
        raise BusinessRule("The payout is already completed")
    now = datetime.now(timezone.utc)
    if status == "Processing":
        if data.get("payout_mode_id") and db.session.get(PaymentMode, data["payout_mode_id"]) is None:
            raise ValidationError("Unknown payment mode", {"payout_mode_id": ["Not found"]})
        case.payout_status = "Processing"
        case.payout_amount = data.get("payout_amount") or case.approved_refund_amount
        case.payout_mode_id = data.get("payout_mode_id")
        case.payout_reference = data.get("payout_reference")
        case.payout_executed_by = current_user().user_id
    elif status == "Completed":
        if case.payout_status != "Processing":
            raise BusinessRule("Start the payout (Processing) before completing it")
        if case.reconciled_at is None:
            raise BusinessRule("Reconcile the payout before marking it Completed")
        case.payout_status = "Completed"
        case.payout_completed_at = data.get("completed_at") or now
        case.status = "Completed"
    else:
        if not data.get("failure_reason"):
            raise ValidationError("A failed payout needs a reason", {"failure_reason": ["Required"]})
        case.payout_status = "Failed"
        case.payout_failure_reason = data["failure_reason"]
    db.session.flush()  # within approved amount; executor ≠ decider
    if case.status == "Completed":
        tasks.complete_system_task(f"refund-payout:{case_id}")
    audit.record("REFUND_PAYOUT", "admission", case.admission_id,
                 new={"case_code": case.case_code, "payout_status": case.payout_status, "amount": case.payout_amount},
                 branch_id=case.admission.service_branch_id)
    db.session.expire(case.admission, ["balance"])
    return case


def reconcile(case_id: int) -> RefundCase:
    case = get_case(case_id)
    _accounts(case)
    if case.payout_status != "Processing" or not case.payout_reference:
        raise BusinessRule("Only a payout in Processing with a reference can be reconciled")
    case.reconciled_by = current_user().user_id
    case.reconciled_at = datetime.now(timezone.utc)
    db.session.flush()
    return case


def withdraw(case_id: int, reason: str | None) -> RefundCase:
    case = get_case(case_id)
    if not current_user().is_manager_of(case.admission.service_branch_id):
        raise Forbidden("Only a branch manager can withdraw a refund case")
    if case.status in RefundCase.CLOSED_STATUSES or case.payout_status in ("Processing", "Completed"):
        raise BusinessRule(f"Refund case can't be withdrawn now ({case.status} / payout {case.payout_status})")
    case.status = "Withdrawn"
    db.session.flush()
    for key in (f"refund-decide:{case_id}", f"refund-payout:{case_id}"):
        tasks.complete_system_task(key)
    audit.record("REFUND_WITHDRAWN", "admission", case.admission_id, new={"case_code": case.case_code}, reason=reason,
                 branch_id=case.admission.service_branch_id)
    return case
