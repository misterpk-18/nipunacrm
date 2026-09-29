"""Payments: record claims (split across an invoice's courses, one transaction per tender, or an advance), verify / fail,
allocate advances, corrections, receipts.

The ledger is immutable. The database numbers transactions (TXN-GNT-00001) and — only at verification — receipts
(GNT-R-2627-00001), requires references / cheque approvers, caps each course line, checks every payment is fully
allocated, applies verification only once, and appends a reversal (with negated allocations) when a correction is
approved.
"""
from datetime import date, datetime, timezone
from decimal import Decimal

from config.database import db
from models import (
    InvoiceLine, InvoiceLineBalance, Lead, Payment, PaymentAllocation, PaymentCorrectionRequest, PaymentMode,
)
from models.enums import PROTECTED_STAGES
from repositories import payments as payments_repo
from repositories import users as users_repo
from repositories.common import paginate
from services import admissions as admissions_service
from services import audit, notifications, payment_alerts, sla, tasks
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

def _open_lines(invoice) -> list[tuple[InvoiceLine, Decimal]]:
    """Course lines with what can still be allocated to each (pending counts, waivers reduce the cap)."""
    rows = []
    for line in invoice.lines:
        balance = db.session.get(InvoiceLineBalance, line.invoice_line_id, populate_existing=True)
        rows.append((line, max(balance.open_to_allocate, Decimal("0.00"))))
    return rows


def _allocations(invoice, total: Decimal, given: list[dict] | None, split_excess: bool
                 ) -> tuple[list[tuple[InvoiceLine, Decimal]], Decimal]:
    """Given allocations (checked against each line), or the total spread oldest course line first.
    Returns ([(line, amount)], excess for an unallocated advance)."""
    open_lines = _open_lines(invoice)
    if given:
        by_id = {line.invoice_line_id: (line, left) for line, left in open_lines}
        result, errors = [], {}
        for n, row in enumerate(given):
            if row["invoice_line_id"] not in by_id:
                errors[f"allocations.{n}.invoice_line_id"] = ["Not a course on this invoice"]
                continue
            line, left = by_id[row["invoice_line_id"]]
            if row["amount"] > left:
                errors[f"allocations.{n}.amount"] = [f"Only ₹{left} is left on {line.course.course_title}"]
            if row["amount"] > 0:
                result.append((line, row["amount"]))
        added = sum((amount for _, amount in result), Decimal("0.00"))
        if not errors and added != total:
            errors["allocations"] = [f"Allocations add up to ₹{added} but the payment is ₹{total}"]
        if errors:
            raise ValidationError("Check the allocation to courses", errors)
        return result, Decimal("0.00")
    result, remaining = [], total
    for line, left in open_lines:
        take = min(left, remaining)
        if take > 0:
            result.append((line, take))
            remaining -= take
    if remaining > 0 and not split_excess:
        raise BusinessRule(f"Payment of {total} exceeds the outstanding {total - remaining} on {invoice.invoice_number}",
                           {"outstanding": str(total - remaining)})
    return result, remaining


def _split_by_tender(allocations: list[tuple[InvoiceLine, Decimal]], tenders: list[dict]
                     ) -> list[list[tuple[InvoiceLine, Decimal]]]:
    """Each tender takes the next course amounts in order, so every tender is fully allocated."""
    queue = [[line, amount] for line, amount in allocations]
    split = []
    for tender in tenders:
        need, parts = tender["amount"], []
        while need > 0 and queue:
            take = min(need, queue[0][1])
            parts.append((queue[0][0], take))
            queue[0][1] -= take
            need -= take
            if queue[0][1] == 0:
                queue.pop(0)
        split.append(parts)
    return split


def _check_tender(tender: dict, branch_id: int, n: int) -> PaymentMode:
    user = current_user()
    mode = db.session.get(PaymentMode, tender["payment_mode_id"])
    if mode is None or not mode.is_active:
        raise ValidationError("Unknown or inactive payment mode", {f"tenders.{n}.payment_mode_id": ["Not an active mode"]})
    if tender.get("payment_date") and tender["payment_date"] > date.today():
        raise ValidationError("Payment date can't be in the future", {f"tenders.{n}.payment_date": ["Must not be in the future"]})
    approver = tender.get("exception_approved_by")
    if approver is not None:
        if approver == user.user_id:
            raise ValidationError("An exception needs an independent approver",
                                  {f"tenders.{n}.exception_approved_by": ["Not yourself"]})
        if approver not in users_repo.user_ids_with_any_role(ADMIN_ROLES + ("BRANCH_MANAGER",), branch_id):
            raise ValidationError("The approver must be a branch manager or admin",
                                  {f"tenders.{n}.exception_approved_by": ["Not an approver at this branch"]})
    return mode


def record(data: dict, proof: dict | None = None) -> tuple[list[Payment], Payment | None]:
    """Record money received as payment claims (Pending Verification — no receipt yet).

    Against an invoice: the money is split across its course lines (given, or oldest line first); a split checkout
    creates one transaction per tender. Anything beyond the invoice goes in as a separate unallocated advance
    (split_excess, the default), otherwise the request is refused. Without an invoice it is an advance.
    Returns (payments, advance or None)."""
    user = current_user()
    invoice = invoices_service.get_invoice(data["invoice_id"]) if data.get("invoice_id") else None
    lead = None
    if invoice is not None:
        branch_id, person_id = invoice.collecting_branch_id, invoice.person_id
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

    tenders = data.get("tenders") or [{
        field: data.get(field) for field in ("amount", "payment_mode_id", "reference", "payment_date",
                                             "exception_approved_by")}]
    if any(t.get("amount") is None or t.get("payment_mode_id") is None for t in tenders):
        raise ValidationError("Each tender needs an amount and a payment mode",
                              {"tenders": ["amount and payment_mode_id are required"]})
    modes = [_check_tender(tender, branch_id, n) for n, tender in enumerate(tenders)]
    total = sum((t["amount"] for t in tenders), Decimal("0.00"))

    common = dict(collected_by=user.user_id, collecting_branch_id=branch_id, person_id=person_id,
                  notes=data.get("notes"), proof_file_path=proof["file_path"] if proof else None,
                  created_by=user.user_id)

    def tender_fields(tender, mode):
        return dict(payment_mode_id=mode.payment_mode_id, payment_date=tender.get("payment_date") or date.today(),
                    reference=tender.get("reference"), exception_approved_by=tender.get("exception_approved_by"))

    payments, advance = [], None
    if invoice is None:
        payments = [_insert(Payment(amount=t["amount"], invoice_id=None, lead_id=data.get("lead_id"),
                                    **tender_fields(t, m), **common), []) for t, m in zip(tenders, modes)]
        return payments, None

    allocations, excess = _allocations(invoice, total, data.get("allocations"), data.get("split_excess", True))
    allocated = total - excess
    if allocated > 0:
        # tenders are applied in order; the last one may be partly an advance
        applied, cut_tenders = allocated, []
        for tender in tenders:
            take = min(tender["amount"], applied)
            if take > 0:
                cut_tenders.append({**tender, "amount": take})
            applied -= take
        for (tender, parts), mode in zip(zip(cut_tenders, _split_by_tender(allocations, cut_tenders)), modes):
            lead_ids = {line.lead_id for line, _ in parts}
            payments.append(_insert(Payment(amount=tender["amount"], invoice_id=invoice.invoice_id,
                                            lead_id=next(iter(lead_ids)) if len(lead_ids) == 1 else None,
                                            **tender_fields(tender, mode), **common), parts))
    if excess > 0:
        tender, mode = tenders[-1], modes[-1]
        advance = _insert(Payment(amount=excess, invoice_id=None, **tender_fields(tender, mode),
                                  **{**common, "notes": f"Excess over invoice {invoice.invoice_number}"}), [])

    for line in {line.invoice_line_id: line for line, _ in allocations}.values():
        if line.lead.stage not in PROTECTED_STAGES and line.lead.converted_at is not None:
            line.lead.stage = "Payment Pending Verification"  # the card follows
    db.session.flush()
    return payments, advance


def _insert(payment: Payment, parts: list[tuple[InvoiceLine, Decimal]]) -> Payment:
    db.session.add(payment)
    db.session.flush()  # transaction number, reference / approver rules
    for line, amount in parts:
        db.session.add(PaymentAllocation(payment_id=payment.payment_id, invoice_line_id=line.invoice_line_id,
                                         amount=amount))
    db.session.flush()  # each course line's cap
    db.session.refresh(payment)
    title = f"Verify payment {payment.transaction_number} · {payment.person.full_name} · ₹{payment.amount}"
    notifications.notify("PAYMENT_PENDING_VERIFICATION", event_key=f"payment.recorded:{payment.transaction_number}",
                         entity_type="payment", entity_id=payment.payment_id, branch_id=payment.collecting_branch_id,
                         title=title)
    tasks.create_system_task(
        "PAYMENT_VERIFICATION", title, payment.collecting_branch_id,
        sla.staffed_deadline(payment.collecting_branch_id, datetime.now(timezone.utc), VERIFICATION_DUE_STAFFED_MINUTES),
        team_role_code="ACCOUNTS", dedupe_key=f"payment-verify:{payment.payment_id}", payment_id=payment.payment_id,
    )
    audit.record("PAYMENT_RECORDED", "payment", payment.payment_id,
                 new={"transaction_number": payment.transaction_number, "amount": payment.amount,
                      "invoice_id": payment.invoice_id,
                      "allocations": {line.line_code: amount for line, amount in parts}},
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
        raise BusinessRule(f"{payment.transaction_number} is already {payment.verification_status}")
    return payment


def _close_verification(payment: Payment) -> None:
    tasks.complete_system_task(f"payment-verify:{payment.payment_id}")
    notifications.complete_for("payment", payment.payment_id)


def verify(payment_id: int, data: dict) -> tuple[Payment, list]:
    """Evidence reviewed (and, for cash, the independent cash check) → Verified: the receipt number is issued now.
    Every course line that reaches the admission token gets its admission. Returns (payment, admissions created)."""
    payment = _pending_receipt(payment_id)
    if not data.get("evidence_reviewed"):
        raise ValidationError("Confirm the payment evidence was reviewed", {"evidence_reviewed": ["Must be ticked"]})
    if payment.mode and payment.mode.code == "CASH" and not data.get("cash_checked"):
        raise ValidationError("A cash payment needs the independent cash check", {"cash_checked": ["Must be ticked"]})
    payment.evidence_reviewed = True
    payment.cash_checked = bool(data.get("cash_checked"))
    payment.verification_status = "Verified"
    payment.verified_by = current_user().user_id
    db.session.flush()  # verified_at stamped, receipt number issued
    _close_verification(payment)
    admitted = admissions_service.auto_admit(payment.invoice_id) if payment.invoice_id else []
    payment_alerts.check_gap(payment.invoice_id, payment.payment_id)
    db.session.refresh(payment)
    audit.record("PAYMENT_VERIFIED", "payment", payment_id,
                 new={"amount": payment.amount, "receipt_number": payment.receipt_number,
                      "admissions": [a.admission_code for a in admitted]}, branch_id=payment.collecting_branch_id)
    return payment, admitted


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


def allocate(payment_id: int, invoice_id: int, allocations: list[dict] | None = None) -> tuple[Payment, list]:
    """An unallocated advance → an invoice's course lines (once). Verified money may complete admissions."""
    payment = get_payment(payment_id)
    if not _is_accounts(payment.collecting_branch_id):
        raise Forbidden("Only Accounts or an admin can allocate advances")
    if payment.entry_type != "Payment" or payment.invoice_id is not None:
        raise BusinessRule(f"{payment.transaction_number} is not an unallocated advance")
    invoice = invoices_service.get_invoice(invoice_id)
    parts, excess = _allocations(invoice, payment.amount, allocations, split_excess=False)
    payment.invoice_id = invoice.invoice_id  # the DB checks person, branch and invoice status
    db.session.flush()
    for line, amount in parts:
        db.session.add(PaymentAllocation(payment_id=payment.payment_id, invoice_line_id=line.invoice_line_id,
                                         amount=amount))
    db.session.flush()
    db.session.refresh(payment)
    admitted = admissions_service.auto_admit(invoice.invoice_id) if payment.verification_status == "Verified" else []
    audit.record("PAYMENT_ALLOCATED", "payment", payment_id, new={"invoice_id": invoice_id},
                 branch_id=payment.collecting_branch_id)
    return payment, admitted


def receipt(payment_id: int) -> dict:
    """Printable receipt — or, while pending, a payment claim that carries no receipt number."""
    payment = get_payment(payment_id)
    verified = payment.verification_status == "Verified"
    invoice = payment.invoice
    branch = payment.collecting_branch
    issuer = invoice.issuer if invoice else {
        "legal_name": branch.legal_name, "branch_code": branch.branch_code, "branch_name": branch.branch_name,
        "address": branch.address, "phone": branch.phone, "email": branch.email, "accent": branch.invoice_accent}
    titles = {"Receipt": "Payment receipt", "Reversal": "Reversal receipt", "Payment claim": "Payment claim",
              "Failed claim": "Payment claim (failed verification)"}
    return {
        "document": titles[payment.document_kind], "is_receipt": verified,
        "note": None if verified else "Not a receipt — this payment is not counted until Accounts verifies it",
        "transaction_number": payment.transaction_number,
        "receipt_number": payment.receipt_number if verified else None, "entry_type": payment.entry_type,
        "payment_date": payment.payment_date, "amount": payment.amount,
        "mode": payment.mode.label if payment.mode else None, "reference": payment.reference,
        "received_from": payment.person.to_summary(),
        "invoice_number": invoice.invoice_number if invoice else None,
        "allocations": [a.to_dict() for a in payment.allocations],
        "issuer": issuer, "verification_status": payment.verification_status, "verified_at": payment.verified_at,
        "failure_reason": payment.failure_reason,
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
