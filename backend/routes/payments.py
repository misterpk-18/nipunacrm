"""Payments (sidebar #7) and payment correction requests."""
from flask import Blueprint

from controllers import payments as payments_controller
from routes.decorators import fresh_auth, login_required, require_roles
from services.context import ADMIN_ROLES, FINANCE_ROLES

payments_bp = Blueprint("payments", __name__)
ACCOUNTS_ROLES = ADMIN_ROLES + ("ACCOUNTS",)


@payments_bp.get("/payments")
@login_required
@require_roles(*FINANCE_ROLES)
def list_payments():
    return payments_controller.list_payments()


@payments_bp.post("/payments")
@login_required
@require_roles(*FINANCE_ROLES)
def record_payment():
    return payments_controller.record_payment()


@payments_bp.get("/payments/unallocated")
@login_required
@require_roles(*ACCOUNTS_ROLES, "BRANCH_MANAGER")
def list_unallocated():
    return payments_controller.list_unallocated()


@payments_bp.get("/payments/<int:payment_id>")
@login_required
@require_roles(*FINANCE_ROLES)
def get_payment(payment_id: int):
    return payments_controller.get_payment(payment_id)


@payments_bp.get("/payments/<int:payment_id>/receipt")
@login_required
@require_roles(*FINANCE_ROLES)
def payment_receipt(payment_id: int):
    return payments_controller.payment_receipt(payment_id)


@payments_bp.post("/payments/<int:payment_id>/verify")
@login_required
@require_roles(*ACCOUNTS_ROLES)
@fresh_auth
def verify_payment(payment_id: int):
    return payments_controller.verify_payment(payment_id)


@payments_bp.post("/payments/<int:payment_id>/fail")
@login_required
@require_roles(*ACCOUNTS_ROLES)
@fresh_auth
def fail_payment(payment_id: int):
    return payments_controller.fail_payment(payment_id)


@payments_bp.post("/payments/<int:payment_id>/allocate")
@login_required
@require_roles(*ACCOUNTS_ROLES)
def allocate_payment(payment_id: int):
    return payments_controller.allocate_payment(payment_id)


@payments_bp.post("/payments/<int:payment_id>/correction-requests")
@login_required
@require_roles(*ACCOUNTS_ROLES)
def request_correction(payment_id: int):
    return payments_controller.request_correction(payment_id)


@payments_bp.get("/correction-requests")
@login_required
@require_roles(*ACCOUNTS_ROLES)
def list_corrections():
    return payments_controller.list_corrections()


@payments_bp.get("/correction-requests/<int:request_id>")
@login_required
@require_roles(*ACCOUNTS_ROLES)
def get_correction(request_id: int):
    return payments_controller.get_correction(request_id)


@payments_bp.post("/correction-requests/<int:request_id>/approve")
@login_required
@require_roles(*ADMIN_ROLES)
@fresh_auth
def approve_correction(request_id: int):
    return payments_controller.decide_correction(request_id, True)


@payments_bp.post("/correction-requests/<int:request_id>/reject")
@login_required
@require_roles(*ADMIN_ROLES)
@fresh_auth
def reject_correction(request_id: int):
    return payments_controller.decide_correction(request_id, False)
