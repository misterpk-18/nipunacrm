"""Route decorators: @login_required, @require_roles(...), @fresh_auth, and @lms_service_key for calls from the LMS.

Order on a route:  @login_required  →  @require_roles(...)  →  @fresh_auth  →  view
"""
import hmac
import logging
from functools import wraps

from flask import current_app, request

from services import audit
from services import auth as auth_service
from services.context import current_user
from services.errors import Forbidden, FreshAuthRequired, PasswordChangeRequired, Unauthenticated

logger = logging.getLogger(__name__)

# Endpoints a user with a pending forced password change may still call
PASSWORD_CHANGE_ALLOWED = {"auth.me", "auth.logout", "auth.change_password"}


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        scheme, _, token = request.headers.get("Authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise Unauthenticated("Login required")

        user = auth_service.authenticate(token.strip())
        if user.must_change_password and request.endpoint not in PASSWORD_CHANGE_ALLOWED:
            raise PasswordChangeRequired("Change your temporary password to continue")
        if user.is_recovery_account:
            _audit_recovery_access()
        return view(*args, **kwargs)

    return wrapper


def _audit_recovery_access() -> None:
    """Emergency / recovery accounts: every request they make is audited (and logged, even if it fails)."""
    logger.warning("Recovery account request: %s %s", request.method, request.path)
    audit.record("RECOVERY_ACCESS", "endpoint", request.endpoint or "unknown",
                 new={"method": request.method, "path": request.path})


def require_roles(*role_codes: str):
    """Allow if the user holds any of these roles at any branch; branch-level checks happen in services."""

    def decorator(view):
        @wraps(view)
        def wrapper(*args, **kwargs):
            user = current_user()
            if user is None or not user.has_role(*role_codes):
                raise Forbidden("You don't have access to this action")
            return view(*args, **kwargs)

        return wrapper

    return decorator


def fresh_auth(view):
    """Sensitive actions: the user must have entered their password recently (login or /auth/reauthenticate)."""

    @wraps(view)
    def wrapper(*args, **kwargs):
        user = current_user()
        if user is None or not user.has_fresh_auth:
            raise FreshAuthRequired("Confirm your password to continue")
        return view(*args, **kwargs)

    return wrapper


def lms_service_key(view):
    """A call from the Nipuna LMS: header X-Service-Key equal to LMS_SERVICE_KEY (the key both systems share)."""
    @wraps(view)
    def wrapper(*args, **kwargs):
        expected = current_app.config.get("LMS_SERVICE_KEY") or ""
        supplied = request.headers.get("X-Service-Key") or ""
        if not expected or not hmac.compare_digest(supplied.encode(), expected.encode()):
            raise Unauthenticated("Invalid service key")
        return view(*args, **kwargs)

    return wrapper
