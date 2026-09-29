"""Invoice Register (db 021): one invoice per learner and issuing branch, one line per course deal.

Create invoice (from a deal): only eligible courses of the same person and branch can be combined — approved fee
version, accepted delivery plan, not yet invoiced, still open. The flexible 1–3 instalment schedule is given with
the invoice and applies to its total. The database numbers the invoice and its lines, snapshots the issuing
branch, fills each line from the approved version, checks the schedule at commit and keeps invoices immutable.
Nothing here creates an admission.
"""
from datetime import date
from decimal import Decimal

from sqlalchemy import select

from config.database import db
from models import (
    Admission, FeeDiscussion, Installment, Invoice, InvoiceBalance, InvoiceLine, Lead, PaymentPlan,
    PaymentPromise,
)
from repositories import invoices as invoices_repo
from repositories.common import paginate
from services import audit
from services import delivery_plans as plans_service
from services import fees as fees_service
from services import leads as leads_service
from services.context import COUNSELLOR_ROLES, current_user
from services.errors import BusinessRule, Forbidden, NotFound, ValidationError

PLAN_BY_COUNT = {1: "FULL", 2: "TWO_INSTALMENTS", 3: "THREE_INSTALMENTS"}


def get_invoice(invoice_id: int) -> Invoice:
    invoice = db.session.get(Invoice, invoice_id)
    if invoice is None or not current_user().can_access_branch(invoice.collecting_branch_id):
        raise NotFound("Invoice not found")
    return invoice


def _can_issue(branch_id: int) -> bool:
    user = current_user()
    return user.is_manager_of(branch_id) or user.has_role(*COUNSELLOR_ROLES, "ACCOUNTS", branch_id=branch_id)


def split_label(amounts: list[Decimal], total: Decimal) -> str:
    """"Full", "50/50", "50/25/25" … from the invoice's own schedule."""
    if len(amounts) <= 1 or not total:
        return "Full"
    return "/".join(str(int((a * 100 / total).quantize(Decimal("1")))) for a in amounts)


# ---------------------------------------------------------------- eligibility

def _current_discussion(lead: Lead) -> FeeDiscussion | None:
    stmt = (select(FeeDiscussion).where(FeeDiscussion.lead_id == lead.lead_id,
                                        FeeDiscussion.milestone.not_in(FeeDiscussion.CLOSED_MILESTONES))
            .order_by(FeeDiscussion.fee_discussion_id.desc()))
    return db.session.execute(stmt).scalars().first()


def course_option(lead: Lead) -> dict:
    """What a course deal needs before it can go on an invoice, and its price (approved, else standard)."""
    discussion = _current_discussion(lead)
    version = discussion.current_version if discussion else None
    approved = version is not None and version.status == "Approved"
    plan = plans_service.plan_for(lead.lead_id)
    invoice = plans_service.live_invoice_for(lead.lead_id)
    reasons = []
    if lead.converted_at is None:
        reasons.append("Not a deal yet")
    if not lead.is_open:
        reasons.append(f"Deal is {lead.stage}")
    if invoice is not None:
        reasons.append(f"Already invoiced on {invoice.invoice_number}")
    if not approved:
        reasons.append("No approved fee version")
    if plan is None or plan.accepted_at is None:
        reasons.append("Delivery plan not accepted")
    return {
        "lead": lead.to_summary(), "course": lead.course.to_summary() if lead.course else None,
        "standard_fee": lead.course.standard_fee if lead.course else None,
        "amount": version.final_payable if approved else (lead.course.standard_fee if lead.course else None),
        "fee_version": {"version_id": version.version_id, "version_no": version.version_no, "status": version.status,
                        "final_payable": version.final_payable} if version else None,
        "fee_discussion_id": discussion.fee_discussion_id if discussion else None,
        "delivery_plan": {"plan_code": plan.plan_code, "status": plan.status} if plan else None,
        "invoice": invoice.to_summary() if invoice else None,
        "eligible": not reasons, "reasons": reasons,
    }


def _person_deals(person_id: int, branch_id: int) -> list[Lead]:
    stmt = (select(Lead).where(Lead.person_id == person_id, Lead.branch_id == branch_id,
                               Lead.converted_at.is_not(None), Lead.stage.not_in(("Lost - closed",)))
            .order_by(Lead.lead_id))
    return list(db.session.execute(stmt).scalars())


def options(lead_id: int) -> dict:
    """Create-invoice dialog for a deal: issuer preview, bill-to and every course deal of the same person at the
    same branch, with what blocks each one."""
    lead = leads_service.get_lead(lead_id)
    branch = lead.branch
    courses = [course_option(deal) for deal in _person_deals(lead.person_id, lead.branch_id)]
    return {
        "issuer": {"legal_name": branch.legal_name, "branch_code": branch.branch_code,
                   "branch_name": branch.branch_name, "address": branch.address, "phone": branch.phone,
                   "email": branch.email, "accent": branch.invoice_accent},
        "bill_to": lead.person.to_summary(), "branch": branch.to_summary(), "lead_id": lead.lead_id,
        "courses": courses, "can_issue": _can_issue(lead.branch_id),
    }


# ---------------------------------------------------------------- create

def _schedule(total: Decimal, given: list[dict] | None) -> list[tuple[date, Decimal]]:
    """1–3 instalments: any dates from today in order, amounts adding up to the invoice total.
    Omitted: the whole total today (Full payment)."""
    if total <= 0:
        return []
    if not given:
        return [(date.today(), total)]
    if not 1 <= len(given) <= 3:
        raise ValidationError("Give 1, 2 or 3 instalments", {"installments": ["1 to 3 instalments"]})
    errors: dict[str, list[str]] = {}
    for n, row in enumerate(given):
        if row["due_date"] < date.today():
            errors[f"installments.{n}.due_date"] = ["Must be today or later"]
        if n and row["due_date"] <= given[n - 1]["due_date"]:
            errors[f"installments.{n}.due_date"] = ["Must be after the previous instalment"]
    added = sum(row["amount"] for row in given)
    if added != total:
        errors["installments"] = [f"Instalments add up to ₹{added} but the invoice total is ₹{total}"]
    if errors:
        raise ValidationError("Check the payment schedule", errors)
    return [(row["due_date"], row["amount"]) for row in given]


def create(data: dict) -> Invoice:
    """Invoice one or more compatible course deals of one person at one branch."""
    leads = [leads_service.get_lead(lead_id) for lead_id in dict.fromkeys(data["lead_ids"])]
    first = leads[0]
    if not _can_issue(first.branch_id):
        raise Forbidden("Only counsellors, accounts or a branch manager can issue invoices")
    blocked = {}
    for lead in leads:
        if lead.person_id != first.person_id:
            blocked[lead.lead_code] = ["Belongs to a different person; one invoice bills one learner"]
        elif lead.branch_id != first.branch_id:
            blocked[lead.lead_code] = ["A deal at another branch; combine only courses of the same branch"]
        else:
            option = course_option(lead)
            if not option["eligible"]:
                blocked[lead.lead_code] = option["reasons"]
    if blocked:
        raise BusinessRule("Some courses can't be invoiced: " + "; ".join(
            f"{code}: {', '.join(reasons)}" for code, reasons in blocked.items()), {"leads": blocked})

    versions = []
    for lead in leads:
        discussion = _current_discussion(lead)
        version = discussion.current_version
        fees_service.check_offer_not_used(discussion, version.offer)
        versions.append(version)
    total = sum((v.final_payable for v in versions), Decimal("0.00"))
    schedule = _schedule(total, data.get("installments"))
    code = PLAN_BY_COUNT[max(len(schedule), 1)]
    plan = db.session.execute(select(PaymentPlan).where(PaymentPlan.plan_code == code)).scalar_one()

    user = current_user()
    invoice = Invoice(person_id=first.person_id, collecting_branch_id=first.branch_id, payment_plan_id=plan.payment_plan_id,
                      day0_date=data.get("day0_date") or date.today(), terms=data.get("terms"), issued_by=user.user_id)
    db.session.add(invoice)
    db.session.flush()  # number + issuer snapshot
    for lead in leads:
        db.session.add(InvoiceLine(invoice_id=invoice.invoice_id, lead_id=lead.lead_id))
        db.session.flush()  # the DB checks eligibility again and fills the line from the approved version
    for n, (due, amount) in enumerate(schedule, 1):
        db.session.add(Installment(invoice_id=invoice.invoice_id, installment_no=n, due_date=due, amount_due=amount))
    db.session.flush()
    db.session.refresh(invoice)
    for lead in leads:
        leads_service.log_activity(lead, "Note", f"Invoice {invoice.invoice_number} issued · ₹{invoice.billed_amount}")
    audit.record("INVOICE_ISSUED", "invoice", invoice.invoice_id,
                 new={"invoice_number": invoice.invoice_number, "billed_amount": invoice.billed_amount,
                      "lead_ids": [lead.lead_id for lead in leads], "installments": len(schedule)},
                 branch_id=invoice.collecting_branch_id)
    return invoice


# ---------------------------------------------------------------- read

def list_invoices(filters: dict, page: int, per_page: int):
    stmt = invoices_repo.invoices_stmt(filters, current_user().branch_ids())
    invoices, meta = paginate(stmt, page, per_page)
    return invoices, meta, invoices_repo.totals(stmt)


def detail(invoice_id: int) -> dict:
    invoice = get_invoice(invoice_id)
    promises = db.session.execute(select(PaymentPromise).where(PaymentPromise.invoice_id == invoice_id)
                                  .order_by(PaymentPromise.promise_id.desc())).scalars()
    return {"invoice": invoice, "schedule": invoices_repo.dues_for(invoice_id) if invoice.status == "Issued" else [],
            "installments": invoice.installments, "payments": invoices_repo.payments_for(invoice_id),
            "corrections": invoices_repo.corrections_for(invoice_id), "promises": list(promises),
            "admissions": invoices_repo.admissions_for(invoice_id)}


def admission_readiness(invoice_id: int) -> dict:
    """Per course line: accepted delivery plan, verified money reaching the admission token, admitted yet."""
    invoice = get_invoice(invoice_id)
    lines = []
    for line in invoice.lines:
        admission = db.session.execute(select(Admission).where(Admission.invoice_line_id == line.invoice_line_id)
                                       ).scalar_one_or_none()
        token = invoices_repo.line_token_status(line.invoice_line_id)
        plan = plans_service.plan_for(line.lead_id)
        checks = [
            {"check": "invoice_issued", "ok": invoice.status == "Issued", "detail": f"Invoice is {invoice.status}"},
            {"check": "accepted_plan", "ok": plan is not None and plan.accepted_at is not None,
             "detail": f"Delivery plan {plan.plan_code} accepted" if plan and plan.accepted_at
             else "Accept the delivery plan for this course"},
            {"check": "verified_payment", "ok": token["payment_id"] is not None or token["token"] == 0,
             "detail": f"₹{token['verified_total']} verified on this course — admission token of ₹{token['token']} reached"
             if token["payment_id"] else
             f"Verified payments on this course must reach ₹{token['token']} (₹{token['verified_total']} so far)",
             "token": token["token"], "verified_total": token["verified_total"]},
            {"check": "not_yet_admitted", "ok": admission is None,
             "detail": f"Admitted as {admission.admission_code}" if admission else "No admission yet"},
        ]
        lines.append({"invoice_line_id": line.invoice_line_id, "line_code": line.line_code,
                      "course": line.course.to_summary(), "lead": line.lead.to_summary(),
                      "ready": all(c["ok"] for c in checks), "checks": checks,
                      "missing": [c["check"] for c in checks if not c["ok"]],
                      "admission": admission.to_summary() if admission else None})
    return {"invoice_id": invoice_id, "invoice_number": invoice.invoice_number, "lines": lines,
            "ready": any(line["ready"] for line in lines)}


def printable(invoice_id: int) -> dict:
    """The branch invoice document: issuer snapshot, bill-to, course lines, terms, totals, verified paid, balance,
    instalment cards and verified receipts. Pending claims are never shown as receipts."""
    invoice = get_invoice(invoice_id)
    balance = invoice.balance
    dues = {d.installment_no: d for d in invoices_repo.dues_for(invoice_id)} if invoice.status == "Issued" else {}
    receipts = [p for p in invoices_repo.payments_for(invoice_id) if p.verification_status == "Verified"]
    amounts = [i.amount_due for i in invoice.installments]
    person = invoice.person
    return {
        "document": "Course invoice" if invoice.status == "Issued" else f"Course invoice ({invoice.status})",
        "invoice_number": invoice.invoice_number, "issued_on": invoice.issued_on, "status": invoice.status,
        "payment_status": balance.invoice_state,
        "issuer": invoice.issuer,
        "bill_to": {**person.to_summary(), "email": person.email},
        "lines": [{"line_no": line.line_no, "line_code": line.line_code, "course": line.course.to_summary(),
                   "lead_code": line.lead.lead_code, "standard_fee": line.standard_fee,
                   "billed_amount": line.billed_amount} for line in invoice.lines],
        "terms": invoice.terms,
        "plan": {"plan_name": invoice.payment_plan.plan_name, "split": split_label(amounts, invoice.billed_amount)},
        "totals": {"standard_fee": invoice.standard_fee, "billed_amount": invoice.billed_amount,
                   "discount": invoice.standard_fee - invoice.billed_amount,
                   "verified_paid": balance.verified_paid, "pending_verification": balance.pending_verification,
                   "waived": balance.waived, "balance_due": balance.outstanding},
        "installments": [{"installment_no": i.installment_no, "due_date": i.due_date, "amount_due": i.amount_due,
                          "due_position": dues[i.installment_no].due_position if i.installment_no in dues else None,
                          "balance": dues[i.installment_no].balance if i.installment_no in dues else None}
                         for i in invoice.installments],
        "receipts": [{"receipt_number": p.receipt_number, "transaction_number": p.transaction_number,
                      "payment_date": p.payment_date, "verified_at": p.verified_at, "amount": p.amount,
                      "entry_type": p.entry_type, "mode": p.mode.label if p.mode else None} for p in receipts],
    }


# ---------------------------------------------------------------- change

def cancel(invoice_id: int, reason: str) -> Invoice:
    """Only an invoice with no payments; its courses can then be invoiced again (the DB resets their milestone)."""
    invoice = get_invoice(invoice_id)
    user = current_user()
    if not (user.is_admin or user.has_role("ACCOUNTS", branch_id=invoice.collecting_branch_id)
            or user.is_manager_of(invoice.collecting_branch_id)):
        raise Forbidden("Only Accounts, a branch manager or an admin can cancel invoices")
    invoice.status = "Cancelled"  # the DB refuses if there are payments
    invoice.cancel_reason = reason
    db.session.flush()
    db.session.expire(invoice, ["balance"])
    audit.record("INVOICE_CANCELLED", "invoice", invoice_id, reason=reason, branch_id=invoice.collecting_branch_id)
    return invoice


def set_due_date(invoice_id: int, installment_no: int, due_date: date) -> Installment:
    invoice = get_invoice(invoice_id)
    if not _can_issue(invoice.collecting_branch_id):
        raise Forbidden("Only counsellors, accounts or a branch manager can change due dates")
    if invoice.status != "Issued":
        raise BusinessRule(f"Invoice is {invoice.status}")
    installment = next((i for i in invoice.installments if i.installment_no == installment_no), None)
    if installment is None:
        raise NotFound("Instalment not found")
    neighbours = {i.installment_no: i.due_date for i in invoice.installments}
    if (installment_no - 1 in neighbours and due_date <= neighbours[installment_no - 1]) or (
            installment_no + 1 in neighbours and due_date >= neighbours[installment_no + 1]):
        raise ValidationError("Keep the instalments in order", {"due_date": ["Between the previous and next instalment"]})
    old = installment.due_date
    installment.due_date = due_date
    db.session.flush()
    audit.record("INSTALLMENT_DUE_DATE_CHANGED", "invoice", invoice_id,
                 old={"installment_no": installment_no, "due_date": old}, new={"due_date": due_date},
                 branch_id=invoice.collecting_branch_id)
    return installment


def balance_of(invoice_id: int) -> InvoiceBalance:
    return db.session.get(InvoiceBalance, invoice_id, populate_existing=True)

