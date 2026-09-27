"""Collections: coordinated dues per invoice, ageing, promises to pay (kept / broken / cancelled)."""
from datetime import date, datetime, timezone

from config.database import db
from models import Invoice, PaymentPromise
from repositories import collections as collections_repo
from services import audit
from services import admissions as admissions_service
from services.context import COUNSELLOR_ROLES, current_user
from services.errors import BusinessRule, Conflict, Forbidden, NotFound, ValidationError


def dues(filters: dict, page: int, per_page: int):
    branch_ids = current_user().branch_ids()
    invoice_ids, total = collections_repo.due_invoice_ids(filters, branch_ids, page, per_page)
    rows = collections_repo.dues_for_invoices(invoice_ids, filters, branch_ids)
    plans = []
    for invoice_id in invoice_ids:
        items = [r for r in rows if r.invoice_id == invoice_id]
        invoice = db.session.get(Invoice, invoice_id)
        overdue = [r.days_overdue for r in items if r.days_overdue]
        plans.append({
            "invoice": invoice.to_summary(), "person": invoice.person.to_summary(),
            "admission_id": items[0].admission_id, "collecting_branch_id": invoice.collecting_branch_id,
            "plan": invoice.payment_plan.plan_name, "balance": sum(r.balance for r in items),
            "next_due_date": min(r.due_date for r in items), "max_days_overdue": max(overdue) if overdue else None,
            "contact_hold": any(r.contact_hold for r in items), "installments": [r.to_dict() for r in items],
        })
    meta = {"page": page, "per_page": per_page, "total": total, "pages": (total + per_page - 1) // per_page}
    return plans, meta


def ageing(filters: dict) -> dict:
    return collections_repo.ageing(filters, current_user().branch_ids())


def _collector(branch_id: int) -> bool:
    user = current_user()
    return user.is_manager_of(branch_id) or user.has_role(*COUNSELLOR_ROLES, "ACCOUNTS", branch_id=branch_id)


def list_promises(admission_id: int) -> list[PaymentPromise]:
    admissions_service.get_admission(admission_id)
    return collections_repo.promises_for(admission_id)


def add_promise(admission_id: int, data: dict) -> PaymentPromise:
    admission = admissions_service.get_admission(admission_id)
    if not _collector(admission.service_branch_id):
        raise Forbidden("You can't record promises for this admission")
    if data["promised_date"] < date.today():
        raise ValidationError("A promise is for today or later", {"promised_date": ["Must be today or later"]})
    if data["promised_amount"] > admission.balance.outstanding:
        raise ValidationError("More than the outstanding balance",
                              {"promised_amount": [f"Outstanding is {admission.balance.outstanding}"]})
    if any(p.status == "Pending" for p in collections_repo.promises_for(admission_id)):
        raise Conflict("There is already a pending promise; mark it kept, broken or cancelled first")
    promise = PaymentPromise(admission_id=admission_id, promised_amount=data["promised_amount"],
                             promised_date=data["promised_date"], notes=data.get("notes"),
                             recorded_by=current_user().user_id)
    db.session.add(promise)
    db.session.flush()
    return promise


def resolve_promise(promise_id: int, status: str) -> PaymentPromise:
    promise = db.session.get(PaymentPromise, promise_id)
    if promise is None:
        raise NotFound("Promise not found")
    admission = admissions_service.get_admission(promise.admission_id)
    if not _collector(admission.service_branch_id):
        raise Forbidden("You can't update this promise")
    if promise.status != "Pending":
        raise BusinessRule(f"Promise is already {promise.status}")
    promise.status = status
    promise.resolved_at = datetime.now(timezone.utc)
    db.session.flush()
    if status == "Broken":
        audit.record("PROMISE_BROKEN", "admission", promise.admission_id,
                     new={"promise_id": promise_id, "amount": promise.promised_amount},
                     branch_id=admission.service_branch_id)
    return promise
