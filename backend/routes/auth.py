from flask import Blueprint

from controllers import auth as auth_controller
from routes.decorators import login_required

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")


@auth_bp.post("/login")
def login():
    return auth_controller.login()


@auth_bp.post("/logout")
@login_required
def logout():
    return auth_controller.logout()


@auth_bp.get("/me")
@login_required
def me():
    return auth_controller.me()


@auth_bp.post("/reauthenticate")
@login_required
def reauthenticate():
    return auth_controller.reauthenticate()


@auth_bp.post("/change-password")
@login_required
def change_password():
    return auth_controller.change_password()


@auth_bp.get("/sessions")
@login_required
def list_sessions():
    return auth_controller.list_sessions()


@auth_bp.delete("/sessions/<session_id>")
@login_required
def revoke_session(session_id: str):
    return auth_controller.revoke_session(session_id)
