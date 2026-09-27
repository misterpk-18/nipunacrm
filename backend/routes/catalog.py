"""Course Master, payment plans, Offer Master."""
from flask import Blueprint

from controllers import catalog as catalog_controller
from routes.decorators import fresh_auth, login_required, require_roles
from services.context import ADMIN_ROLES

catalog_bp = Blueprint("catalog", __name__)


# ---------------------------------------------------------------- courses

@catalog_bp.get("/courses")
@login_required
def list_courses():
    return catalog_controller.list_courses()


@catalog_bp.get("/courses/<int:course_id>")
@login_required
def get_course(course_id: int):
    return catalog_controller.get_course(course_id)


@catalog_bp.post("/courses")
@login_required
@require_roles(*ADMIN_ROLES)
def create_course():
    return catalog_controller.create_course()


@catalog_bp.patch("/courses/<int:course_id>")
@login_required
@require_roles(*ADMIN_ROLES)
def update_course(course_id: int):
    return catalog_controller.update_course(course_id)


@catalog_bp.put("/courses/<int:course_id>/branches")
@login_required
@require_roles(*ADMIN_ROLES)
def set_course_branches(course_id: int):
    return catalog_controller.set_course_branches(course_id)


@catalog_bp.put("/courses/<int:course_id>/components")
@login_required
@require_roles(*ADMIN_ROLES)
def set_combo_components(course_id: int):
    return catalog_controller.set_combo_components(course_id)


# ---------------------------------------------------------------- payment plans

@catalog_bp.get("/payment-plans")
@login_required
def list_payment_plans():
    return catalog_controller.list_payment_plans()


@catalog_bp.get("/payment-plans/<int:plan_id>")
@login_required
def get_payment_plan(plan_id: int):
    return catalog_controller.get_payment_plan(plan_id)


@catalog_bp.post("/payment-plans")
@login_required
@require_roles(*ADMIN_ROLES)
def create_payment_plan():
    return catalog_controller.create_payment_plan()


@catalog_bp.patch("/payment-plans/<int:plan_id>")
@login_required
@require_roles(*ADMIN_ROLES)
def update_payment_plan(plan_id: int):
    return catalog_controller.update_payment_plan(plan_id)


# ---------------------------------------------------------------- offers

@catalog_bp.get("/offers")
@login_required
@require_roles(*ADMIN_ROLES, "BRANCH_MANAGER")
def list_offers():
    return catalog_controller.list_offers()


@catalog_bp.get("/offers/<int:offer_id>")
@login_required
@require_roles(*ADMIN_ROLES, "BRANCH_MANAGER")
def get_offer(offer_id: int):
    return catalog_controller.get_offer(offer_id)


@catalog_bp.post("/offers")
@login_required
@require_roles(*ADMIN_ROLES)
def create_offer():
    return catalog_controller.create_offer()


@catalog_bp.patch("/offers/<int:offer_id>")
@login_required
@require_roles(*ADMIN_ROLES)
def update_offer(offer_id: int):
    return catalog_controller.update_offer(offer_id)


@catalog_bp.post("/offers/<int:offer_id>/new-version")
@login_required
@require_roles(*ADMIN_ROLES)
def new_offer_version(offer_id: int):
    return catalog_controller.new_offer_version(offer_id)


@catalog_bp.post("/offers/<int:offer_id>/activate")
@login_required
@require_roles(*ADMIN_ROLES)
@fresh_auth
def activate_offer(offer_id: int):
    return catalog_controller.activate_offer(offer_id)


@catalog_bp.post("/offers/<int:offer_id>/deactivate")
@login_required
@require_roles(*ADMIN_ROLES)
@fresh_auth
def deactivate_offer(offer_id: int):
    return catalog_controller.deactivate_offer(offer_id)


@catalog_bp.put("/offers/<int:offer_id>/scope")
@login_required
@require_roles(*ADMIN_ROLES)
def set_offer_scope(offer_id: int):
    return catalog_controller.set_offer_scope(offer_id)


@catalog_bp.put("/offers/<int:offer_id>/complimentary-courses")
@login_required
@require_roles(*ADMIN_ROLES)
def set_offer_complimentary(offer_id: int):
    return catalog_controller.set_offer_complimentary(offer_id)
