"""Admin → Users & Access. Founder / CEO and Super Admin only."""
from flask import Blueprint

from controllers import users as users_controller
from routes.decorators import fresh_auth, login_required, require_roles
from services.context import ADMIN_ROLES

users_bp = Blueprint("users", __name__, url_prefix="/users")


@users_bp.get("")
@login_required
@require_roles(*ADMIN_ROLES)
def list_users():
    return users_controller.list_users()


@users_bp.post("")
@login_required
@require_roles(*ADMIN_ROLES)
@fresh_auth
def create_user():
    return users_controller.create_user()


@users_bp.get("/<int:user_id>")
@login_required
@require_roles(*ADMIN_ROLES)
def get_user(user_id: int):
    return users_controller.get_user(user_id)


@users_bp.patch("/<int:user_id>")
@login_required
@require_roles(*ADMIN_ROLES)
def update_user(user_id: int):
    return users_controller.update_user(user_id)


@users_bp.post("/<int:user_id>/reset-password")
@login_required
@require_roles(*ADMIN_ROLES)
@fresh_auth
def reset_password(user_id: int):
    return users_controller.reset_password(user_id)


@users_bp.get("/<int:user_id>/scopes")
@login_required
@require_roles(*ADMIN_ROLES)
def list_scopes(user_id: int):
    return users_controller.list_scopes(user_id)


@users_bp.post("/<int:user_id>/scopes")
@login_required
@require_roles(*ADMIN_ROLES)
@fresh_auth
def grant_scope(user_id: int):
    return users_controller.grant_scope(user_id)


@users_bp.delete("/<int:user_id>/scopes/<int:scope_id>")
@login_required
@require_roles(*ADMIN_ROLES)
@fresh_auth
def revoke_scope(user_id: int, scope_id: int):
    return users_controller.revoke_scope(user_id, scope_id)
