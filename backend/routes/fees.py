"""Fee discussions & special closing (lead detail "Fees / Offers") and the Invoice Register."""
from flask import Blueprint

from controllers import fees as fees_controller
from routes.decorators import fresh_auth, login_required, require_roles
from services.context import FINANCE_ROLES, LEAD_ROLES, MANAGER_ROLES

fees_bp = Blueprint("fees", __name__)


def route(rule: str, method: str, roles=LEAD_ROLES, fresh=False):
    def decorator(view):
        wrapped = fresh_auth(view) if fresh else view
        return getattr(fees_bp, method)(rule)(login_required(require_roles(*roles)(wrapped)))
    return decorator


# ---------------------------------------------------------------- discussions

@route("/leads/<int:lead_id>/fee-discussions", "get")
def list_discussions(lead_id: int):
    return fees_controller.list_discussions(lead_id)


@route("/leads/<int:lead_id>/fee-discussions", "post")
def start_discussion(lead_id: int):
    return fees_controller.start_discussion(lead_id)


@route("/fee-discussions/<int:discussion_id>", "get", FINANCE_ROLES)
def get_discussion(discussion_id: int):
    return fees_controller.get_discussion(discussion_id)


@route("/fee-discussions/<int:discussion_id>/versions", "post")
def add_version(discussion_id: int):
    return fees_controller.add_version(discussion_id)


@route("/fee-discussions/<int:discussion_id>/share", "post")
def share(discussion_id: int):
    return fees_controller.share(discussion_id)


# ---------------------------------------------------------------- delivery plan (per course deal)

PLAN_ROLES = LEAD_ROLES + ("ACADEMIC_COORDINATOR", "ACCOUNTS")


@route("/leads/<int:lead_id>/delivery-plan", "get", PLAN_ROLES)
def get_delivery_plan(lead_id: int):
    return fees_controller.get_delivery_plan(lead_id)


@route("/leads/<int:lead_id>/delivery-plan", "put", LEAD_ROLES + ("ACADEMIC_COORDINATOR",))
def save_delivery_plan(lead_id: int):
    return fees_controller.save_delivery_plan(lead_id)


@route("/leads/<int:lead_id>/delivery-plan/accept", "post", LEAD_ROLES + ("ACADEMIC_COORDINATOR",))
def accept_delivery_plan(lead_id: int):
    return fees_controller.accept_delivery_plan(lead_id)


@route("/leads/<int:lead_id>/delivery-plan/reopen", "post", LEAD_ROLES + ("ACADEMIC_COORDINATOR",))
def reopen_delivery_plan(lead_id: int):
    return fees_controller.reopen_delivery_plan(lead_id)


@route("/fee-discussion-versions/<int:version_id>/approve", "post")
def approve_version(version_id: int):
    return fees_controller.approve_version(version_id)


# ---------------------------------------------------------------- special closing

@route("/fee-discussion-versions/<int:version_id>/special-closing-requests", "post")
def request_special_closing(version_id: int):
    return fees_controller.request_special_closing(version_id)


@route("/special-closing-requests", "get", MANAGER_ROLES)
def list_special_closing():
    return fees_controller.list_special_closing()


@route("/special-closing-requests/<int:scr_id>", "get")
def get_special_closing(scr_id: int):
    return fees_controller.get_special_closing(scr_id)


@route("/special-closing-requests/<int:scr_id>/approve", "post", MANAGER_ROLES, fresh=True)
def approve_special_closing(scr_id: int):
    return fees_controller.approve_special_closing(scr_id)


@route("/special-closing-requests/<int:scr_id>/counteroffer", "post", MANAGER_ROLES)
def counteroffer_special_closing(scr_id: int):
    return fees_controller.counteroffer_special_closing(scr_id)


@route("/special-closing-requests/<int:scr_id>/reject", "post", MANAGER_ROLES)
def reject_special_closing(scr_id: int):
    return fees_controller.reject_special_closing(scr_id)


# ---------------------------------------------------------------- invoices

@route("/invoices", "get", FINANCE_ROLES)
def list_invoices():
    return fees_controller.list_invoices()


@route("/invoices", "post", FINANCE_ROLES)
def create_invoice():
    return fees_controller.create_invoice()


@route("/invoices/options", "get", FINANCE_ROLES)
def invoice_options():
    return fees_controller.invoice_options()


@route("/invoices/<int:invoice_id>", "get", FINANCE_ROLES)
def get_invoice(invoice_id: int):
    return fees_controller.get_invoice(invoice_id)


@route("/invoices/<int:invoice_id>/admission-readiness", "get", FINANCE_ROLES)
def admission_readiness(invoice_id: int):
    return fees_controller.admission_readiness(invoice_id)


@route("/invoices/<int:invoice_id>/print", "get", FINANCE_ROLES)
def print_invoice(invoice_id: int):
    return fees_controller.print_invoice(invoice_id)


@route("/invoices/<int:invoice_id>/cancel", "post", FINANCE_ROLES)
def cancel_invoice(invoice_id: int):
    return fees_controller.cancel_invoice(invoice_id)


@route("/invoices/<int:invoice_id>/installments/<int:installment_no>/due-date", "put", FINANCE_ROLES)
def set_due_date(invoice_id: int, installment_no: int):
    return fees_controller.set_due_date(invoice_id, installment_no)
