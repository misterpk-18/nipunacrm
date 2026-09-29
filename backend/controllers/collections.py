"""Collections dues / ageing / promises, and refund cases."""
from flask import request

from controllers.common import Validator, created, get_page_params, json_body, ok, paginated, require_changes
from models.enums import PAYOUT_STATUSES, REFUND_CASE_STATUSES, REFUND_DECISIONS, REFUND_EVIDENCE_STATUSES
from repositories.collections import AGE_BANDS
from services import collections as collections_service
from services import refunds as refunds_service


def _dues_filters() -> dict:
    v = Validator(request.args.to_dict())
    v.choice("position", ("Overdue", "Due Today", "Upcoming"))
    v.choice("age_band", AGE_BANDS)
    v.string("plan_code", max_length=30)
    v.integer("branch_id", min_value=1)
    v.integer("person_id", min_value=1)
    v.boolean("contact_hold")
    return v.validate()


def list_dues():
    filters = _dues_filters()
    page, per_page = get_page_params()
    plans, meta = collections_service.dues(filters, page, per_page)
    return paginated(plans, meta)


def payment_gaps():
    v = Validator(request.args.to_dict())
    v.integer("branch_id", min_value=1)
    page, per_page = get_page_params()
    rows, meta = collections_service.payment_gaps(v.validate(), page, per_page)
    return paginated([row.to_dict() for row in rows], meta)


def ageing():
    filters = _dues_filters()
    filters.pop("position", None)
    return ok(collections_service.ageing(filters))


def list_promises(admission_id: int):
    return ok([p.to_dict() for p in collections_service.list_promises_for_admission(admission_id)])


def list_invoice_promises(invoice_id: int):
    return ok([p.to_dict() for p in collections_service.list_promises(invoice_id)])


def _promise_body() -> dict:
    v = Validator(json_body())
    v.decimal("promised_amount", required=True, min_value=1)
    v.date("promised_date", required=True)
    v.string("notes", nullable=True)
    return v.validate()


def add_invoice_promise(invoice_id: int):
    return created(collections_service.add_promise(invoice_id, _promise_body()).to_dict())


def add_promise(admission_id: int):
    return created(collections_service.add_promise_for_admission(admission_id, _promise_body()).to_dict())


def resolve_promise(promise_id: int, status: str):
    return ok(collections_service.resolve_promise(promise_id, status).to_dict())


# ---------------------------------------------------------------- refunds

def list_refund_cases():
    v = Validator(request.args.to_dict())
    v.choice("status", REFUND_CASE_STATUSES)
    v.choice("refund_decision", REFUND_DECISIONS)
    v.choice("payout_status", PAYOUT_STATUSES)
    v.integer("admission_id", min_value=1)
    v.integer("branch_id", min_value=1)
    page, per_page = get_page_params()
    cases, meta = refunds_service.list_cases(v.validate(), page, per_page)
    return paginated([c.to_row() for c in cases], meta)


def register_refund_case():
    v = Validator(json_body())
    v.integer("admission_id", required=True, min_value=1)
    v.string("request_reason", required=True)
    v.string("request_timing", nullable=True, max_length=100)
    v.choice("evidence_status", REFUND_EVIDENCE_STATUSES)
    v.id_list("payment_ids")
    return created(refunds_service.register(v.validate()).to_dict())


def get_refund_case(case_id: int):
    return ok(refunds_service.get_case(case_id).to_dict())


def update_refund_case(case_id: int):
    v = Validator(json_body())
    v.date("assessment_date", nullable=True)
    v.string("assessment_notes", nullable=True)
    v.choice("evidence_status", REFUND_EVIDENCE_STATUSES)
    v.string("request_timing", nullable=True, max_length=100)
    v.id_list("payment_ids")
    return ok(refunds_service.update(case_id, require_changes(v.validate())).to_dict())


def decide_refund_case(case_id: int):
    v = Validator(json_body())
    v.choice("decision", ("Refund Approved", "Waiver Approved", "Rejected"), required=True)
    v.decimal("amount", nullable=True, min_value=1)
    v.string("reason", nullable=True)
    return ok(refunds_service.decide(case_id, v.validate()).to_dict())


def payout_refund_case(case_id: int):
    v = Validator(json_body())
    v.choice("status", ("Processing", "Completed", "Failed"), required=True)
    v.decimal("payout_amount", nullable=True, min_value=1)
    v.integer("payout_mode_id", nullable=True, min_value=1)
    v.string("payout_reference", nullable=True, max_length=100)
    v.string("failure_reason", nullable=True)
    return ok(refunds_service.payout(case_id, v.validate()).to_dict())


def reconcile_refund_case(case_id: int):
    return ok(refunds_service.reconcile(case_id).to_dict())


def withdraw_refund_case(case_id: int):
    v = Validator(json_body())
    v.string("reason", nullable=True)
    return ok(refunds_service.withdraw(case_id, v.validate().get("reason")).to_dict())
