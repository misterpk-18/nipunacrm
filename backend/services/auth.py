"""Login, sessions, fresh authentication and password changes."""
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from config.database import db
from models import ActiveSession, Branch, User, UserRoleScope, UserSession
from repositories import sessions as sessions_repo
from repositories import settings as settings_repo
from repositories import users as users_repo
from repositories.common import set_db_user
from services import audit
from services.context import CurrentUser, Scope, client_ip, client_user_agent, current_user, set_current_user
from services.errors import Forbidden, NotFound, TooManyAttempts, Unauthenticated, ValidationError
from services.security import hash_password, hash_token, new_session_token, verify_password

logger = logging.getLogger(__name__)

SESSION_EXPIRED = "Your session has expired. Please log in again."


@dataclass
class LoginResult:
    token: str
    session: UserSession
    current: CurrentUser


# ---------------------------------------------------------------- per-request authentication

def authenticate(token: str) -> CurrentUser:
    """Resolve a bearer token to the current user (called by @login_required on every request)."""
    session = sessions_repo.find_active(hash_token(token))
    if session is None:
        raise Unauthenticated(SESSION_EXPIRED)

    user = users_repo.get_by_id(session.user_id)
    if user is None or not user.is_active:
        raise Unauthenticated(SESSION_EXPIRED)

    current = _to_current_user(user, session.session_id, session.has_fresh_auth, users_repo.active_scopes(user.user_id))
    set_current_user(current)
    set_db_user(user.user_id)
    sessions_repo.touch(session.session_id)
    return current


def _to_current_user(user: User, session_id: str, has_fresh_auth: bool, scopes: list[UserRoleScope]) -> CurrentUser:
    return CurrentUser(
        user_id=user.user_id,
        email=user.email,
        full_name=user.full_name,
        session_id=session_id,
        is_recovery_account=user.is_recovery_account,
        must_change_password=user.must_change_password,
        has_fresh_auth=has_fresh_auth,
        scopes=tuple(
            Scope(s.scope_id, s.role.role_code, s.role.role_name, s.branch_id, s.role.is_company_wide) for s in scopes
        ),
    )


# ---------------------------------------------------------------- login / logout

def login(email: str, password: str) -> LoginResult:
    user = users_repo.get_by_email(email)
    now = datetime.now(timezone.utc)

    if user is not None and user.locked_until is not None and user.locked_until > now:
        raise TooManyAttempts("Too many failed attempts. Try again later.")

    if not verify_password(user.password_hash if user else None, password) or not user.is_active:
        if user is not None and user.is_active:
            _register_failed_attempt(user, now)
        logger.warning("Failed login for %s from %s", email, client_ip())
        raise Unauthenticated("Invalid email or password")

    scopes = users_repo.active_scopes(user.user_id)
    if not scopes:
        raise Forbidden("Your account has no active access. Contact a Super Admin.")

    user.failed_login_attempts = 0
    user.locked_until = None
    user.last_login_at = now

    token = new_session_token()
    session = sessions_repo.create(
        UserSession(
            session_id=hash_token(token),
            user_id=user.user_id,
            ip_address=client_ip(),
            user_agent=client_user_agent(),
            reauthenticated_at=now,  # entering the password counts as fresh auth
        )
    )
    audit.record("LOGIN", "user", user.user_id, actor_user_id=user.user_id)
    return LoginResult(token=token, session=session, current=_to_current_user(user, session.session_id, True, scopes))


def _register_failed_attempt(user: User, now: datetime) -> None:
    max_attempts = settings_repo.get_int("login_max_attempts", 5)
    lock_minutes = settings_repo.get_int("login_lock_minutes", 15)

    user.failed_login_attempts += 1
    if user.failed_login_attempts >= max_attempts:
        user.locked_until = now + timedelta(minutes=lock_minutes)
        user.failed_login_attempts = 0
        logger.warning("Locked %s for %s minutes after %s failed logins", user.email, lock_minutes, max_attempts)
    # Commit now: the 401 response would otherwise roll this back
    db.session.commit()


def logout() -> None:
    user = current_user()
    sessions_repo.revoke(user.session_id, "logout")
    audit.record("LOGOUT", "user", user.user_id)


# ---------------------------------------------------------------- current user

def profile(current: CurrentUser | None = None) -> tuple[User, list[UserRoleScope], list[Branch], str]:
    """User, active scopes, allowed branches and landing route (for /auth/me and the login response)."""
    current = current or current_user()
    user = users_repo.get_by_id(current.user_id)
    scopes = users_repo.active_scopes(current.user_id)
    return user, scopes, allowed_branches(current), home_route(current)


def allowed_branches(user: CurrentUser) -> list[Branch]:
    branch_ids = user.branch_ids()
    stmt = select(Branch).where(Branch.is_active).order_by(Branch.branch_id)
    if branch_ids is not None:
        stmt = stmt.where(Branch.branch_id.in_(branch_ids))
    return list(db.session.execute(stmt).scalars())


def home_route(user: CurrentUser) -> str:
    """Landing screen, as in the prototype: counsellors → workspace, branch managers → their dashboard."""
    if user.is_admin:
        return "/dashboard"
    if user.has_role("BRANCH_MANAGER"):
        return "/branch-manager"
    if user.has_role("SALES", "FRONT_OFFICE"):
        return "/counsellor"
    return "/dashboard"


# ---------------------------------------------------------------- fresh auth / passwords

def reauthenticate(password: str) -> None:
    current = current_user()
    user = users_repo.get_by_id(current.user_id)
    if not verify_password(user.password_hash, password):
        raise ValidationError("Password is incorrect", {"password": ["Incorrect password"]})
    sessions_repo.mark_reauthenticated(current.session_id)


def check_password_policy(password: str) -> None:
    min_length = settings_repo.get_int("password_min_length", 10)
    if len(password) < min_length:
        raise ValidationError("Password is too short", {"new_password": [f"Must be at least {min_length} characters"]})


def change_password(current_password: str, new_password: str) -> None:
    current = current_user()
    user = users_repo.get_by_id(current.user_id)
    if not verify_password(user.password_hash, current_password):
        raise ValidationError("Current password is incorrect", {"current_password": ["Incorrect password"]})
    if new_password == current_password:
        raise ValidationError("Choose a new password", {"new_password": ["Must differ from the current password"]})
    check_password_policy(new_password)

    user.password_hash = hash_password(new_password)
    user.must_change_password = False
    user.password_changed_at = datetime.now(timezone.utc)
    signed_out = sessions_repo.revoke_all_for_user(user.user_id, "password changed", except_session_id=current.session_id)
    sessions_repo.mark_reauthenticated(current.session_id)
    audit.record("PASSWORD_CHANGED", "user", user.user_id, new={"other_sessions_signed_out": signed_out})


# ---------------------------------------------------------------- own sessions

def list_sessions() -> list[ActiveSession]:
    return sessions_repo.list_active_for_user(current_user().user_id)


def revoke_session(session_id: str) -> None:
    current = current_user()
    session = sessions_repo.find_active(session_id)
    if session is None or session.user_id != current.user_id:
        raise NotFound("Session not found")
    sessions_repo.revoke(session_id, "signed out by user")
    audit.record("SESSION_REVOKED", "user", current.user_id, new={"session": session_id[:12]})
