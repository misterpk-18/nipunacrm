"""Payments ledger, recording, verification, allocation, receipts and correction requests."""
import json
from decimal import Decimal

from flask import request

from controllers.common import Validator, created, get_page_params, json_body, ok, paginated
from models.enums import CORRECTION_REQUEST_STATUSES, PAYMENT_ENTRY_TYPES, PAYMENT_VERIFICATIONS
from services import payments as payments_service
from services import storage
from services.errors import ValidationError


def list_payments():
    v = Validator(request.args.to_dict())
    v.integer("branch_id", min_value=1)
    v.choice("status", PAYMENT_VERIFICATIONS)
    v.choice("entry_type", PAYMENT_ENTRY_TYPES)
    v.integer("invoice_id", min_value=1)
    v.integer("person_id", min_value=1)
    v.integer("admission_id", min_value=1)
    v.integer("payment_mode_id", min_value=1)
    v.date("from")
    v.date("to")
    v.string("q", max_length=100)
    page, per_page = get_page_params()
    payments, meta, totals = payments_service.list_payments(v.validate(), page, per_page)
    return paginated([p.to_row() for p in payments], {**meta, "totals": totals})


def _tender_rules(v: Validator) -> None:
    v.decimal("amount", required=True, min_value=Decimal("0.01"))
    v.integer("payment_mode_id", required=True, min_value=1)
    v.date("payment_date", nullable=True)
    v.string("reference", nullable=True, max_length=100)
    v.integer("exception_approved_by", nullable=True, min_value=1)


def _allocation_rules(v: Validator) -> None:
    v.integer("invoice_line_id", required=True, min_value=1)
    v.decimal("amount", required=True, min_value=Decimal("0"))


def record_payment():
    """JSON, or multipart/form-data with the same fields (tenders / allocations as JSON strings) plus a `proof` file.

    One tender: amount + payment_mode_id (+ reference, date, approver) at the top level; a split checkout: `tenders`
    (one pending transaction each). `allocations` split the money across the invoice's course lines (omitted: the
    oldest course first)."""
    is_form = request.mimetype == "multipart/form-data"
    body = request.form.to_dict() if is_form else json_body()
    if is_form:
        for key in ("tenders", "allocations"):
            if body.get(key):
                try:
                    body[key] = json.loads(body[key])
                except ValueError:
                    raise ValidationError("Invalid JSON", {key: ["Must be a JSON list"]}) from None
    v = Validator(body)
    v.integer("invoice_id", nullable=True, min_value=1)
    v.integer("person_id", nullable=True, min_value=1)
    v.integer("lead_id", nullable=True, min_value=1)
    v.integer("collecting_branch_id", nullable=True, min_value=1)
    v.list_of("tenders", _tender_rules)
    if not body.get("tenders"):
        _tender_rules(v)
    v.list_of("allocations", _allocation_rules)
    v.string("notes", nullable=True)
    v.boolean("split_excess", default=True)
    data = v.validate()
    upload = request.files.get("proof") if is_form else None
    proof = storage.save_upload(upload, "payment-proofs", field="proof") if upload else None
    payments, advance = payments_service.record(data, proof)
    return created({"payment": payments[0].to_dict() if payments else None,
                    "payments": [p.to_dict() for p in payments],
                    "advance": advance.to_dict() if advance else None})


def get_payment(payment_id: int):
    return ok(payments_service.get_payment(payment_id).to_dict())


def verify_payment(payment_id: int):
    v = Validator(json_body())
    v.boolean("evidence_reviewed", required=True)
    v.boolean("cash_checked", default=False)
    payment, admitted = payments_service.verify(payment_id, v.validate())
    return ok({**payment.to_dict(), "admissions_created": [a.to_summary() for a in admitted]})


def fail_payment(payment_id: int):
    v = Validator(json_body())
    v.string("failure_reason", required=True)
    return ok(payments_service.fail(payment_id, v.validate()["failure_reason"]).to_dict())


def allocate_payment(payment_id: int):
    v = Validator(json_body())
    v.integer("invoice_id", required=True, min_value=1)
    v.list_of("allocations", _allocation_rules)
    data = v.validate()
    payment, admitted = payments_service.allocate(payment_id, data["invoice_id"], data.get("allocations"))
    return ok({**payment.to_dict(), "admissions_created": [a.to_summary() for a in admitted]})


def list_unallocated():
    v = Validator(request.args.to_dict())
    v.integer("person_id", min_value=1)
    page, per_page = get_page_params()
    rows, meta = payments_service.list_unallocated(v.validate().get("person_id"), page, per_page)
    return paginated([r.to_dict() for r in rows], meta)


def payment_receipt(payment_id: int):
    return ok(payments_service.receipt(payment_id))


def request_correction(payment_id: int):
    v = Validator(json_body())
    v.string("reason", required=True)
    return created(payments_service.request_correction(payment_id, v.validate()["reason"]).to_dict())


def list_corrections():
    v = Validator(request.args.to_dict())
    v.choice("status", CORRECTION_REQUEST_STATUSES)
    v.integer("invoice_id", min_value=1)
    page, per_page = get_page_params()
    rows, meta = payments_service.list_corrections(v.validate(), page, per_page)
    return paginated([r.to_dict() for r in rows], meta)


def get_correction(request_id: int):
    return ok(payments_service.get_correction(request_id).to_dict())


def decide_correction(request_id: int, approve: bool):
    v = Validator(json_body())
    v.string("decision_note", required=not approve, nullable=approve)
    return ok(payments_service.decide_correction(request_id, approve, v.validate().get("decision_note")).to_dict())
