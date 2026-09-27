"""Students (sidebar #6), Collections (#8), Refunds (#9) and support cases."""
from flask import Blueprint

from controllers import collections as collections_controller
from controllers import students as students_controller
from routes.decorators import fresh_auth, login_required, require_roles
from services.context import ADMIN_ROLES, FINANCE_ROLES, MANAGER_ROLES, STAFF_ROLES

students_bp = Blueprint("students", __name__)
REFUND_ROLES = MANAGER_ROLES + ("ACCOUNTS",)
CERTIFICATE_ROLES = ADMIN_ROLES + ("ACADEMIC_COORDINATOR",)


def route(rule: str, method: str, roles, fresh=False):
    def decorator(view):
        wrapped = fresh_auth(view) if fresh else view
        return getattr(students_bp, method)(rule)(login_required(require_roles(*roles)(wrapped)))
    return decorator


# ---------------------------------------------------------------- students

@route("/students", "get", STAFF_ROLES)
def list_students():
    return students_controller.list_students()


@route("/students/<int:person_id>", "get", STAFF_ROLES)
def get_student(person_id: int):
    return students_controller.get_student(person_id)


@route("/students/<int:person_id>/<any(admissions, finance, academic, documents, timeline, cases, placement, audit):tab>",
       "get", STAFF_ROLES)
def student_tab(person_id: int, tab: str):
    return students_controller.student_tab(person_id, tab)


@route("/persons/<int:person_id>/documents", "post", STAFF_ROLES)
def upload_document(person_id: int):
    return students_controller.upload_document(person_id)


@route("/documents/<int:document_id>/review", "post", STAFF_ROLES)
def review_document(document_id: int):
    return students_controller.review_document(document_id)


@route("/admissions/<int:admission_id>/certificates", "post", CERTIFICATE_ROLES)
def create_certificate(admission_id: int):
    return students_controller.create_certificate(admission_id)


@route("/certificates/<int:certificate_id>", "patch", CERTIFICATE_ROLES)
def update_certificate(certificate_id: int):
    return students_controller.update_certificate(certificate_id)


@route("/certificates/<int:certificate_id>/issue", "post", CERTIFICATE_ROLES)
def issue_certificate(certificate_id: int):
    return students_controller.issue_certificate(certificate_id)


@route("/certificates/<int:certificate_id>/revoke", "post", ADMIN_ROLES, fresh=True)
def revoke_certificate(certificate_id: int):
    return students_controller.revoke_certificate(certificate_id)


@route("/support-cases", "get", STAFF_ROLES)
def list_cases():
    return students_controller.list_cases()


@route("/support-cases", "post", STAFF_ROLES)
def create_case():
    return students_controller.create_case()


@route("/support-cases/<int:case_id>", "get", STAFF_ROLES)
def get_case(case_id: int):
    return students_controller.get_case(case_id)


@route("/support-cases/<int:case_id>", "patch", STAFF_ROLES)
def update_case(case_id: int):
    return students_controller.update_case(case_id)


# ---------------------------------------------------------------- collections

@route("/collections/dues", "get", FINANCE_ROLES)
def list_dues():
    return collections_controller.list_dues()


@route("/collections/ageing", "get", FINANCE_ROLES)
def ageing():
    return collections_controller.ageing()


@route("/admissions/<int:admission_id>/promises", "get", FINANCE_ROLES)
def list_promises(admission_id: int):
    return collections_controller.list_promises(admission_id)


@route("/admissions/<int:admission_id>/promises", "post", FINANCE_ROLES)
def add_promise(admission_id: int):
    return collections_controller.add_promise(admission_id)


@route("/payment-promises/<int:promise_id>/kept", "post", FINANCE_ROLES)
def promise_kept(promise_id: int):
    return collections_controller.resolve_promise(promise_id, "Kept")


@route("/payment-promises/<int:promise_id>/broken", "post", FINANCE_ROLES)
def promise_broken(promise_id: int):
    return collections_controller.resolve_promise(promise_id, "Broken")


@route("/payment-promises/<int:promise_id>/cancel", "post", FINANCE_ROLES)
def promise_cancel(promise_id: int):
    return collections_controller.resolve_promise(promise_id, "Cancelled")


# ---------------------------------------------------------------- refunds

@route("/refund-cases", "get", REFUND_ROLES)
def list_refund_cases():
    return collections_controller.list_refund_cases()


@route("/refund-cases", "post", REFUND_ROLES)
def register_refund_case():
    return collections_controller.register_refund_case()


@route("/refund-cases/<int:case_id>", "get", REFUND_ROLES)
def get_refund_case(case_id: int):
    return collections_controller.get_refund_case(case_id)


@route("/refund-cases/<int:case_id>", "patch", REFUND_ROLES)
def update_refund_case(case_id: int):
    return collections_controller.update_refund_case(case_id)


@route("/refund-cases/<int:case_id>/decide", "post", ADMIN_ROLES, fresh=True)
def decide_refund_case(case_id: int):
    return collections_controller.decide_refund_case(case_id)


@route("/refund-cases/<int:case_id>/payout", "post", ("ACCOUNTS",))
def payout_refund_case(case_id: int):
    return collections_controller.payout_refund_case(case_id)


@route("/refund-cases/<int:case_id>/reconcile", "post", ("ACCOUNTS",))
def reconcile_refund_case(case_id: int):
    return collections_controller.reconcile_refund_case(case_id)


@route("/refund-cases/<int:case_id>/withdraw", "post", MANAGER_ROLES)
def withdraw_refund_case(case_id: int):
    return collections_controller.withdraw_refund_case(case_id)
