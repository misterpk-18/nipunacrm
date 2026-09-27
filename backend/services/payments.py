"""Payments: record (against an invoice or as an advance), verify / fail, allocate advances, corrections, receipts.

The ledger is immutable. The database numbers receipts, requires references / cheque approvers, caps invoice
allocations, applies verification only once, and appends a reversal when a correction request is approved.
"""
from datetime import date, datetime, timezone
from decimal import Decimal

from config.database import db
from models import Lead, Payment, PaymentCorrectionRequest, PaymentMode, RefundCase
from models.enums import PROTECTED_STAGES
from repositories import payments as payments_repo
from repositories import users as users_repo
from repositories.common import paginate
from services import audit, notifications, sla, tasks
from services import invoices as invoices_service
from services import persons as persons_service
from services.context import ADMIN_ROLES, COUNSELLOR_ROLES, current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError

VERIFICATION_DUE_STAFFED_MINUTES = 30  # PAYMENT_PENDING_VERIFICATION escalates after 30 minutes


def get_payment(payment_id: int) -> Payment:
    payment = db.session.get(Payment, payment_id)
    if payment is None or not current_user().can_access_branch(payment.collecting_branch_id):
        raise NotFound("Payment not found")
    return payment


def _can_collect(branch_id: int) -> bool:
    user = current_user()
    return user.is_manager_of(branch_id) or user.has_role(*COUNSELLOR_ROLES, "ACCOUNTS", branch_id=branch_id)


def _is_accounts(branch_id: int) -> bool:
    user = current_user()
    return user.has_role(*ADMIN_ROLES) or user.has_role("ACCOUNTS", branch_id=branch_id)


# ---------------------------------------------------------------- read

def list_payments(filters: dict, page: int, per_page: int):
    stmt = payments_repo.payments_stmt(filters, current_user().branch_ids())
    payments, meta = paginate(stmt, page, per_page)
    return payments, meta, payments_repo.totals(stmt)


def list_unallocated(person_id: int | None, page: int, per_page: int):
    return paginate(payments_repo.unallocated_stmt(current_user().branch_ids(), person_id), page, per_page)


# ---------------------------------------------------------------- record

def _remaining_on_invoice(invoice) -> Decimal:
    waived = sum((r.approved_waiver_amount or 0) for r in db.session.query(RefundCase).filter(
        RefundCase.admission_id == invoice.balance.admission_id, RefundCase.refund_decision == "Waiver Approved"))
    return invoice.billed_amount - Decimal(waived) - payments_repo.invoice_taken(invoice.invoice_id)


def record(data: dict, proof: dict | None = None) -> tuple[Payment, Payment | None]:
    """Record money received. Anything beyond the invoice's outstanding goes in as a separate unallocated advance
    (split_excess, the default), otherwise the request is refused. Returns (payment, advance or None)."""
    user = current_user()
    invoice = invoices_service.get_invoice(data["invoice_id"]) if data.get("invoice_id") else None
    lead = None
    if invoice is not None:
        branch_id, person_id, lead_id = invoice.collecting_branch_id, invoice.person_id, invoice.lead_id
        if invoice.status != "Issued":
            raise BusinessRule(f"Invoice {invoice.invoice_number} is {invoice.status}")
    else:
        lead_id = data.get("lead_id")
        if lead_id:
            lead = db.session.get(Lead, lead_id)
            if lead is None or not user.can_access_branch(lead.branch_id):
                raise ValidationError("Unknown lead", {"lead_id": ["Not found"]})
        person_id = data.get("person_id") or (lead.person_id if lead else None)
        if person_id is None:
            raise ValidationError("An advance needs the person (or lead) it belongs to", {"person_id": ["Required"]})
        persons_service.get_person(person_id)
        branch_id = data.get("collecting_branch_id") or (lead.branch_id if lead else None)
        if branch_id is None:
            raise ValidationError("Choose the collecting branch", {"collecting_branch_id": ["Required"]})
    if not _can_collect(branch_id):
        raise Forbidden("You can't record payments at this branch")

    mode = db.session.get(PaymentMode, data["payment_mode_id"])
    if mode is None or not mode.is_active:
        raise ValidationError("Unknown or inactive payment mode", {"payment_mode_id": ["Not an active mode"]})
    if data.get("payment_date") and data["payment_date"] > date.today():
        raise ValidationError("Payment date can't be in the future", {"payment_date": ["Must not be in the future"]})
    approver = data.get("exception_approved_by")
    if approver is not None:
        if approver == user.user_id:
            raise ValidationError("An exception needs an independent approver", {"exception_approved_by": ["Not yourself"]})
        if approver not in users_repo.user_ids_with_any_role(ADMIN_ROLES + ("BRANCH_MANAGER",), branch_id):
            raise ValidationError("The approver must be a branch manager or admin",
                                  {"exception_approved_by": ["Not an approver at this branch"]})

    amount, excess = data["amount"], Decimal("0.00")
    if invoice is not None:
        remaining = max(_remaining_on_invoice(invoice), Decimal("0.00"))
        if amount > remaining:
            if not data.get("split_excess", True):
                raise BusinessRule(f"Payment of {amount} exceeds the outstanding {remaining} on {invoice.invoice_number}",
                                   {"outstanding": str(remaining)})
            if remaining == 0:
                invoice, excess = None, Decimal("0.00")  # nothing left to allocate: all of it is an advance
            else:
                amount, excess = remaining, amount - remaining

    common = dict(payment_mode_id=mode.payment_mode_id, payment_date=data.get("payment_date") or date.today(),
                  reference=data.get("reference"), collected_by=user.user_id, collecting_branch_id=branch_id,
                  person_id=person_id, lead_id=lead_id, exception_approved_by=approver, notes=data.get("notes"),
                  proof_file_path=proof["file_path"] if proof else None, created_by=user.user_id)
    payment = _insert(Payment(amount=amount, invoice_id=invoice.invoice_id if invoice else None, **common))
    advance = None
    if excess > 0:
        advance = _insert(Payment(amount=excess, invoice_id=None,
                                  **{**common, "notes": f"Excess over invoice, from {payment.receipt_number}"}))

    lead = lead or (db.session.get(Lead, lead_id) if lead_id else None)
    if payment.invoice_id and lead is not None and lead.stage not in PROTECTED_STAGES:
        lead.stage = "Payment Pending Verification"
    db.session.flush()
    return payment, advance


def _insert(payment: Payment) -> Payment:
    db.session.add(payment)
    db.session.flush()  # receipt number, reference / approver rules, invoice cap
    db.session.refresh(payment)
    title = f"Verify payment {payment.receipt_number} · {payment.person.full_name} · ₹{payment.amount}"
    notifications.notify("PAYMENT_PENDING_VERIFICATION", event_key=f"payment.recorded:{payment.receipt_number}",
                         entity_type="payment", entity_id=payment.payment_id, branch_id=payment.collecting_branch_id,
                         title=title)
    tasks.create_system_task(
        "PAYMENT_VERIFICATION", title, payment.collecting_branch_id,
        sla.staffed_deadline(payment.collecting_branch_id, datetime.now(timezone.utc), VERIFICATION_DUE_STAFFED_MINUTES),
        team_role_code="ACCOUNTS", dedupe_key=f"payment-verify:{payment.payment_id}", payment_id=payment.payment_id,
    )
    audit.record("PAYMENT_RECORDED", "payment", payment.payment_id,
                 new={"receipt_number": payment.receipt_number, "amount": payment.amount, "invoice_id": payment.invoice_id},
                 branch_id=payment.collecting_branch_id)
    return payment


# ---------------------------------------------------------------- verification

def _pending_receipt(payment_id: int) -> Payment:
    payment = get_payment(payment_id)
    if not _is_accounts(payment.collecting_branch_id):
        raise Forbidden("Only Accounts or an admin can verify payments")
    if payment.entry_type != "Payment" or payment.amount <= 0:
        raise BusinessRule("Verification applies only to positive payment receipts; corrections need approval")
    if payment.verification_status != "Pending Verification":
        raise BusinessRule(f"{payment.receipt_number} is already {payment.verification_status}")
    return payment


def _close_verification(payment: Payment) -> None:
    tasks.complete_system_task(f"payment-verify:{payment.payment_id}")
    notifications.complete_for("payment", payment.payment_id)


def verify(payment_id: int) -> Payment:
    payment = _pending_receipt(payment_id)
    payment.verification_status = "Verified"
    payment.verified_by = current_user().user_id
    db.session.flush()  # verified_at stamped; first verified payment updates the admission
    _close_verification(payment)
    audit.record("PAYMENT_VERIFIED", "payment", payment_id, new={"amount": payment.amount},
                 branch_id=payment.collecting_branch_id)
    db.session.refresh(payment)
    return payment


def fail(payment_id: int, reason: str) -> Payment:
    payment = _pending_receipt(payment_id)
    payment.verification_status = "Failed"
    payment.verified_by = current_user().user_id
    payment.failure_reason = reason
    db.session.flush()
    _close_verification(payment)
    audit.record("PAYMENT_FAILED", "payment", payment_id, reason=reason, branch_id=payment.collecting_branch_id)
    db.session.refresh(payment)
    return payment


def allocate(payment_id: int, invoice_id: int) -> Payment:
    """An unallocated advance → an invoice (once)."""
    payment = get_payment(payment_id)
    if not _is_accounts(payment.collecting_branch_id):
        raise Forbidden("Only Accounts or an admin can allocate advances")
    if payment.entry_type != "Payment" or payment.invoice_id is not None:
        raise BusinessRule(f"{payment.receipt_number} is not an unallocated advance")
    invoice = invoices_service.get_invoice(invoice_id)
    payment.invoice_id = invoice.invoice_id  # the DB checks person, invoice status and the cap
    db.session.flush()
    db.session.refresh(payment)
    audit.record("PAYMENT_ALLOCATED", "payment", payment_id, new={"invoice_id": invoice_id},
                 branch_id=payment.collecting_branch_id)
    return payment


def receipt(payment_id: int) -> dict:
    payment = get_payment(payment_id)
    verified = payment.verification_status == "Verified"
    branch = payment.collecting_branch
    return {
        "document": "Payment receipt" if verified else "Acknowledgement of proof only — not a receipt until verified",
        "receipt_number": payment.receipt_number, "entry_type": payment.entry_type,
        "payment_date": payment.payment_date, "amount": payment.amount,
        "mode": payment.mode.label if payment.mode else None, "reference": payment.reference,
        "received_from": payment.person.to_summary(),
        "invoice_number": payment.invoice.invoice_number if payment.invoice_id else None,
        "branch": {"name": branch.branch_name, "address": branch.address, "phone": branch.phone},
        "verification_status": payment.verification_status, "verified_at": payment.verified_at,
    }


# ---------------------------------------------------------------- corrections

def get_correction(request_id: int) -> PaymentCorrectionRequest:
    request = db.session.get(PaymentCorrectionRequest, request_id)
    if request is None or not current_user().can_access_branch(request.payment.collecting_branch_id):
        raise NotFound("Correction request not found")
    return request


def request_correction(payment_id: int, reason: str) -> PaymentCorrectionRequest:
    """Ledger unchanged; a distinct Founder / CEO or Super Admin must approve (the DB checks the receipt)."""
    payment = get_payment(payment_id)
    if not _is_accounts(payment.collecting_branch_id):
        raise Forbidden("Only Accounts or an admin can request corrections")
    request = PaymentCorrectionRequest(payment_id=payment.payment_id, reason=reason, requested_by=current_user().user_id)
    db.session.add(request)
    db.session.flush()
    db.session.refresh(request)
    tasks.create_system_task(
        "APPROVAL", f"Approve correction {request.request_code} for {payment.receipt_number}", payment.collecting_branch_id,
        datetime.now(timezone.utc), team_role_code="FOUNDER_CEO", dedupe_key=f"correction:{request.correction_request_id}",
        correction_request_id=request.correction_request_id,
    )
    audit.record("CORRECTION_REQUESTED", "payment", payment_id, reason=reason,
                 new={"request_code": request.request_code}, branch_id=payment.collecting_branch_id)
    return request


def list_corrections(filters: dict, page: int, per_page: int):
    return paginate(payments_repo.corrections_stmt(filters, current_user().branch_ids()), page, per_page)


def decide_correction(request_id: int, approve: bool, note: str | None) -> PaymentCorrectionRequest:
    request = get_correction(request_id)
    user = current_user()
    if request.status != "Pending Approval":
        raise BusinessRule(f"{request.request_code} is {request.status}")
    if request.requested_by == user.user_id:
        raise Forbidden("A distinct approver must decide; self-approval is not allowed")
    request.status = "Approved" if approve else "Rejected"
    request.decided_by = user.user_id
    request.decision_note = note
    db.session.flush()  # approval appends the linked reversal
    tasks.complete_system_task(f"correction:{request.correction_request_id}")
    db.session.refresh(request)
    audit.record("CORRECTION_APPROVED" if approve else "CORRECTION_REJECTED", "payment", request.payment_id,
                 new={"request_code": request.request_code,
                      "reversal": request.reversal.receipt_number if request.reversal else None},
                 reason=note, branch_id=request.payment.collecting_branch_id)
    return request
