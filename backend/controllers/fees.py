"""Fee discussions, versions, accepted plan, special closing requests, and the invoice register."""
from flask import request

from controllers.common import Validator, created, get_page_params, json_body, ok, paginated
from models.enums import DELIVERY_MODES, INVOICE_STATUSES, SCR_STATUSES, SEAT_TYPES
from services import fees as fees_service
from services import invoices as invoices_service


# ---------------------------------------------------------------- discussions

def list_discussions(lead_id: int):
    return ok([d.to_dict() for d in fees_service.list_for_lead(lead_id)])


def start_discussion(lead_id: int):
    v = Validator(json_body())
    v.integer("course_id", nullable=True, min_value=1)
    v.integer("counsellor_id", nullable=True, min_value=1)
    return created(fees_service.start_discussion(lead_id, v.validate()).to_dict())


def get_discussion(discussion_id: int):
    discussion = fees_service.get_discussion(discussion_id)
    offers = fees_service.applicable_offers(discussion)
    return ok({**discussion.to_dict(), "applicable_offers": [o.to_dict() for o in offers]})


def add_version(discussion_id: int):
    v = Validator(json_body())
    v.integer("offer_id", nullable=True, min_value=1)
    v.decimal("extra_concession", min_value=0)
    v.integer("payment_plan_id", min_value=1)
    v.date("valid_until", nullable=True)
    v.string("notes", nullable=True)
    return created(fees_service.add_version(discussion_id, v.validate()).to_dict())


def share(discussion_id: int):
    return ok(fees_service.share(discussion_id).to_dict())


def accept_plan(discussion_id: int):
    v = Validator(json_body())
    v.integer("version_id", required=True, min_value=1)
    v.choice("delivery_mode", DELIVERY_MODES, required=True)
    v.choice("seat_type", SEAT_TYPES, required=True)
    v.date("planned_start_date", nullable=True)
    return ok(fees_service.accept_plan(discussion_id, v.validate()).to_dict())


def approve_version(version_id: int):
    return ok(fees_service.approve_version(version_id).to_dict())


# ---------------------------------------------------------------- special closing

def request_special_closing(version_id: int):
    v = Validator(json_body())
    v.decimal("requested_extra", min_value=0)
    v.string("request_reason", required=True)
    return created(fees_service.request_special_closing(version_id, v.validate()).to_dict())


def list_special_closing():
    v = Validator(request.args.to_dict())
    v.choice("queue", ("can_approve", "higher_approval", "all"), default="all")
    v.choice("status", SCR_STATUSES)
    v.integer("branch_id", min_value=1)
    page, per_page = get_page_params()
    scrs, meta = fees_service.list_scrs(v.validate(), page, per_page)
    return paginated([s.to_dict() for s in scrs], meta)


def get_special_closing(scr_id: int):
    return ok(fees_service.get_scr(scr_id).to_dict())


def approve_special_closing(scr_id: int):
    v = Validator(json_body())
    v.integer("independent_approved_by", nullable=True, min_value=1)
    v.string("decision_reason", nullable=True)
    return ok(fees_service.approve_scr(scr_id, v.validate()).to_dict())


def counteroffer_special_closing(scr_id: int):
    v = Validator(json_body())
    v.decimal("counter_extra", required=True, min_value=0)
    v.string("decision_reason", nullable=True)
    return ok(fees_service.counteroffer_scr(scr_id, v.validate()).to_dict())


def reject_special_closing(scr_id: int):
    v = Validator(json_body())
    v.string("reason", required=True)
    return ok(fees_service.reject_scr(scr_id, v.validate()["reason"]).to_dict())


# ---------------------------------------------------------------- invoices


def issue_invoice(version_id: int):
    v = Validator(json_body())
    v.date("day0_date", nullable=True)
    v.int_list("agreed_due_days", nullable=True, min_value=0)
    v.string("terms", nullable=True)
    return created(invoices_service.issue(version_id, v.validate()).to_dict())


def list_invoices():
    v = Validator(request.args.to_dict())
    v.integer("branch_id", min_value=1)
    v.choice("status", INVOICE_STATUSES)
    v.integer("person_id", min_value=1)
    v.integer("lead_id", min_value=1)
    v.choice("completion", ("Unpaid", "Part Paid", "Paid"))
    v.string("q", max_length=100)
    page, per_page = get_page_params()
    invoices, meta, totals = invoices_service.list_invoices(v.validate(), page, per_page)
    return paginated([i.to_row() for i in invoices], {**meta, "totals": totals})


def get_invoice(invoice_id: int):
    d = invoices_service.detail(invoice_id)
    schedule = [row.to_dict() for row in d["schedule"]] or [
        {"installment_no": i.installment_no, "due_date": i.due_date, "amount_due": i.amount_due} for i in d["installments"]]
    return ok({**d["invoice"].to_dict(), "schedule": schedule, "payments": [p.to_row() for p in d["payments"]],
               "correction_requests": [c.to_dict() for c in d["corrections"]]})


def admission_readiness(invoice_id: int):
    return ok(invoices_service.admission_readiness(invoice_id))


def print_invoice(invoice_id: int):
    return ok(invoices_service.printable(invoice_id))


def cancel_invoice(invoice_id: int):
    v = Validator(json_body())
    v.string("reason", required=True)
    return ok(invoices_service.cancel(invoice_id, v.validate()["reason"]).to_dict())


def set_due_date(invoice_id: int, installment_no: int):
    v = Validator(json_body())
    v.date("due_date", required=True)
    installment = invoices_service.set_due_date(invoice_id, installment_no, v.validate()["due_date"])
    return ok({"installment_no": installment.installment_no, "due_date": installment.due_date,
               "amount_due": installment.amount_due})
