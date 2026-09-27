"""Invoice Register: issue from an Approved fee version, schedule, readiness for admission, print, cancel.

The database fills parties / amount / plan / terms from the version, numbers the invoice per collecting branch
and FY, builds the instalment schedule, supersedes an unpaid previous invoice and keeps invoices immutable.
"""
from datetime import date

from config.database import db
from models import Admission, FeeDiscussion, Installment, Invoice, InvoiceBalance
from repositories import invoices as invoices_repo
from repositories.common import paginate
from services import audit
from services import fees as fees_service
from services.context import COUNSELLOR_ROLES, current_user
from services.errors import BusinessRule, Forbidden, NotFound


def get_invoice(invoice_id: int) -> Invoice:
    invoice = db.session.get(Invoice, invoice_id)
    if invoice is None or not current_user().can_access_branch(invoice.collecting_branch_id):
        raise NotFound("Invoice not found")
    return invoice


def _can_issue(branch_id: int) -> bool:
    user = current_user()
    return user.is_manager_of(branch_id) or user.has_role(*COUNSELLOR_ROLES, "ACCOUNTS", branch_id=branch_id)


def issue(version_id: int, data: dict) -> Invoice:
    version = fees_service.get_version(version_id)
    discussion = version.discussion
    if not _can_issue(discussion.branch_id):
        raise Forbidden("Only counsellors, accounts or a branch manager can issue invoices")
    if version.status != "Approved":
        raise BusinessRule(f"Invoices are issued only from an Approved fee version (version {version.version_no} is "
                           f"{version.status})")
    fees_service.check_offer_not_used(discussion, version.offer)
    invoice = Invoice(fee_version_id=version.version_id, day0_date=data.get("day0_date") or date.today(),
                      agreed_due_days=data.get("agreed_due_days"), terms=data.get("terms"),
                      issued_by=current_user().user_id)
    db.session.add(invoice)
    db.session.flush()  # the DB checks the plan windows and supersedes / refuses the previous invoice
    db.session.refresh(invoice)
    db.session.expire(discussion)
    audit.record("INVOICE_ISSUED", "invoice", invoice.invoice_id,
                 new={"invoice_number": invoice.invoice_number, "billed_amount": invoice.billed_amount,
                      "version_id": version.version_id}, branch_id=invoice.collecting_branch_id)
    return invoice


def list_invoices(filters: dict, page: int, per_page: int):
    stmt = invoices_repo.invoices_stmt(filters, current_user().branch_ids())
    invoices, meta = paginate(stmt, page, per_page)
    return invoices, meta, invoices_repo.totals(stmt)


def detail(invoice_id: int) -> dict:
    invoice = get_invoice(invoice_id)
    return {"invoice": invoice, "schedule": invoices_repo.dues_for(invoice_id) if invoice.status == "Issued" else [],
            "installments": invoice.installments, "payments": invoices_repo.payments_for(invoice_id),
            "corrections": invoices_repo.corrections_for(invoice_id)}


def admission_readiness(invoice_id: int) -> dict:
    """Both admission prerequisites and what's missing (drives the Create Admission button)."""
    invoice = get_invoice(invoice_id)
    discussion = db.session.get(FeeDiscussion, invoice.fee_discussion_id)
    admission = db.session.query(Admission).filter(Admission.invoice_id == invoice_id).first()
    first_payment = invoices_repo.first_qualifying_payment(invoice_id)
    plan_ok = discussion.plan_accepted_at is not None and discussion.accepted_version_id == invoice.fee_version_id
    checks = [
        {"check": "invoice_issued", "ok": invoice.status == "Issued",
         "detail": f"Invoice is {invoice.status}"},
        {"check": "accepted_plan", "ok": plan_ok,
         "detail": "Accepted confirmed delivery plan on this invoice's fee version" if plan_ok
         else "Record the accepted delivery plan for this version"},
        {"check": "verified_payment", "ok": first_payment is not None,
         "detail": f"First qualifying payment {first_payment.receipt_number} verified" if first_payment
         else "A payment on this invoice must be Verified by Accounts"},
        {"check": "not_yet_admitted", "ok": admission is None,
         "detail": f"Already admitted as {admission.admission_code}" if admission else "No admission yet"},
    ]
    return {"invoice_id": invoice_id, "ready": all(c["ok"] for c in checks), "checks": checks,
            "missing": [c["check"] for c in checks if not c["ok"]],
            "admission_id": admission.admission_id if admission else None}


def printable(invoice_id: int) -> dict:
    invoice = get_invoice(invoice_id)
    branch = invoice.collecting_branch
    return {
        "document": "Tax invoice" if invoice.status == "Issued" else f"Invoice ({invoice.status})",
        "invoice_number": invoice.invoice_number, "issued_on": invoice.issued_on,
        "branch": {"name": branch.branch_name, "address": branch.address, "phone": branch.phone, "email": branch.email},
        "bill_to": invoice.person.to_summary(), "course": invoice.course.to_summary(),
        "standard_fee": invoice.standard_fee, "billed_amount": invoice.billed_amount, "terms": invoice.terms,
        "plan": invoice.payment_plan.plan_name,
        "schedule": [{"installment_no": i.installment_no, "due_date": i.due_date, "amount_due": i.amount_due}
                     for i in invoice.installments],
        "balance": {"verified_paid": invoice.balance.verified_paid, "outstanding": invoice.balance.outstanding},
    }


def cancel(invoice_id: int, reason: str) -> Invoice:
    invoice = get_invoice(invoice_id)
    user = current_user()
    if not (user.is_admin or user.has_role("ACCOUNTS", branch_id=invoice.collecting_branch_id)):
        raise Forbidden("Only Accounts or an admin can cancel invoices")
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
    old = installment.due_date
    installment.due_date = due_date  # the DB keeps it inside the plan window
    db.session.flush()
    audit.record("INSTALLMENT_DUE_DATE_CHANGED", "invoice", invoice_id,
                 old={"installment_no": installment_no, "due_date": old}, new={"due_date": due_date},
                 branch_id=invoice.collecting_branch_id)
    return installment


def balance_of(invoice_id: int) -> InvoiceBalance:
    return db.session.get(InvoiceBalance, invoice_id, populate_existing=True)


