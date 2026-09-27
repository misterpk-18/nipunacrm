"""Lookups, branches, shifts, holidays, concession limits, settings."""
from flask import Blueprint

from controllers import masters as masters_controller
from routes.decorators import fresh_auth, login_required, require_roles
from services.context import ADMIN_ROLES

masters_bp = Blueprint("masters", __name__)


# ---------------------------------------------------------------- lookups

@masters_bp.get("/lookups")
@login_required
def all_lookups():
    return masters_controller.all_lookups()


@masters_bp.get("/lookups/<lookup_type>")
@login_required
@require_roles(*ADMIN_ROLES)
def list_lookup(lookup_type: str):
    return masters_controller.list_lookup(lookup_type)


@masters_bp.post("/lookups/<lookup_type>")
@login_required
@require_roles(*ADMIN_ROLES)
def create_lookup(lookup_type: str):
    return masters_controller.create_lookup(lookup_type)


@masters_bp.patch("/lookups/<lookup_type>/<int:row_id>")
@login_required
@require_roles(*ADMIN_ROLES)
def update_lookup(lookup_type: str, row_id: int):
    return masters_controller.update_lookup(lookup_type, row_id)


# ---------------------------------------------------------------- branches

@masters_bp.get("/branches")
@login_required
def list_branches():
    return masters_controller.list_branches()


@masters_bp.get("/branches/<int:branch_id>")
@login_required
def get_branch(branch_id: int):
    return masters_controller.get_branch(branch_id)


@masters_bp.patch("/branches/<int:branch_id>")
@login_required
@require_roles(*ADMIN_ROLES)
def update_branch(branch_id: int):
    return masters_controller.update_branch(branch_id)


@masters_bp.get("/branches/<int:branch_id>/shifts")
@login_required
def list_shifts(branch_id: int):
    return masters_controller.list_shifts(branch_id)


@masters_bp.put("/branches/<int:branch_id>/shifts")
@login_required
@require_roles(*ADMIN_ROLES)
def replace_shifts(branch_id: int):
    return masters_controller.replace_shifts(branch_id)


@masters_bp.get("/holidays")
@login_required
def list_holidays():
    return masters_controller.list_holidays()


@masters_bp.post("/holidays")
@login_required
@require_roles(*ADMIN_ROLES)
def create_holiday():
    return masters_controller.create_holiday()


@masters_bp.delete("/holidays/<int:holiday_id>")
@login_required
@require_roles(*ADMIN_ROLES)
def delete_holiday(holiday_id: int):
    return masters_controller.delete_holiday(holiday_id)


# ---------------------------------------------------------------- concession limits / settings

@masters_bp.get("/concession-limits")
@login_required
@require_roles(*ADMIN_ROLES)
def list_concession_limits():
    return masters_controller.list_concession_limits()


@masters_bp.put("/concession-limits")
@login_required
@require_roles(*ADMIN_ROLES)
@fresh_auth
def replace_concession_limits():
    return masters_controller.replace_concession_limits()


@masters_bp.get("/settings")
@login_required
@require_roles(*ADMIN_ROLES)
def list_settings():
    return masters_controller.list_settings()


@masters_bp.patch("/settings")
@login_required
@require_roles(*ADMIN_ROLES)
@fresh_auth
def update_settings():
    return masters_controller.update_settings()
