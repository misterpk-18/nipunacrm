"""User management and role scopes (Admin → Users & Access)."""
from datetime import datetime, timezone

from sqlalchemy import func, select

from config.database import db
from models import Branch, Role, User, UserRoleScope
from repositories import sessions as sessions_repo
from repositories import users as users_repo
from repositories.common import paginate
from services import audit
from services.auth import check_password_policy
from services.context import ADMIN_ROLES, current_user
from services.errors import BusinessRule, Conflict, Forbidden, NotFound, ValidationError
from services.security import generate_temporary_password, hash_password

PROFILE_FIELDS = ("full_name", "email", "phone", "is_active")


def _snapshot(user: User) -> dict:
    return {field: getattr(user, field) for field in PROFILE_FIELDS}


def _guard_not_self(user_id: int, message: str) -> None:
    if user_id == current_user().user_id:
        raise Forbidden(message)


# ---------------------------------------------------------------- users

def list_users(filters: dict, page: int, per_page: int):
    stmt = users_repo.list_stmt(filters.get("role"), filters.get("branch_id"), filters.get("is_active"), filters.get("q"))
    return paginate(stmt, page, per_page)


def get_user(user_id: int) -> User:
    user = users_repo.get_by_id(user_id)
    if user is None:
        raise NotFound("User not found")
    return user


def create_user(data: dict) -> tuple[User, str]:
    actor = current_user()
    if users_repo.email_taken(data["email"]):
        raise Conflict("A user with this email already exists", {"email": ["Already in use"]})
    if data["is_recovery_account"] and not actor.has_role("FOUNDER_CEO"):
        raise Forbidden("Only the Founder / CEO can create a recovery account")

    temporary_password = generate_temporary_password()
    user = User(
        full_name=data["full_name"],
        email=data["email"],
        phone=data.get("phone"),
        person_id=data.get("person_id"),
        is_recovery_account=data["is_recovery_account"],
        password_hash=hash_password(temporary_password),
        must_change_password=True,
    )
    db.session.add(user)
    db.session.flush()

    for scope in data["scopes"]:
        _grant(user.user_id, scope, granted_by=actor.user_id)

    audit.record("USER_CREATED", "user", user.user_id, new={**_snapshot(user), "scopes": _scope_summary(data["scopes"])})
    return user, temporary_password


def update_user(user_id: int, data: dict) -> User:
    user = get_user(user_id)
    old = _snapshot(user)

    if "email" in data and users_repo.email_taken(data["email"], exclude_user_id=user_id):
        raise Conflict("A user with this email already exists", {"email": ["Already in use"]})

    if data.get("is_active") is False and user.is_active:
        # Admins can't deactivate themselves, so the acting admin always remains
        _guard_not_self(user_id, "You can't deactivate your own account")
        sessions_repo.revoke_all_for_user(user_id, "account deactivated")

    for field, value in data.items():
        setattr(user, field, value)

    audit.record("USER_UPDATED", "user", user_id, old=old, new=_snapshot(user))
    return user


def reset_password(user_id: int) -> tuple[User, str]:
    _guard_not_self(user_id, "Use change password for your own account")
    user = get_user(user_id)

    temporary_password = generate_temporary_password()
    user.password_hash = hash_password(temporary_password)
    user.must_change_password = True
    user.failed_login_attempts = 0
    user.locked_until = None
    sessions_repo.revoke_all_for_user(user_id, "password reset by admin")

    audit.record("PASSWORD_RESET", "user", user_id)
    return user, temporary_password


# ---------------------------------------------------------------- role scopes

def list_scopes(user_id: int) -> list[UserRoleScope]:
    get_user(user_id)
    return users_repo.all_scopes(user_id)


def grant_scope(user_id: int, data: dict) -> UserRoleScope:
    _guard_not_self(user_id, "You can't change your own access")
    get_user(user_id)
    scope = _grant(user_id, data, granted_by=current_user().user_id)
    audit.record("SCOPE_GRANTED", "user", user_id, new=_scope_summary([data])[0])
    return scope


def revoke_scope(user_id: int, scope_id: int) -> UserRoleScope:
    _guard_not_self(user_id, "You can't change your own access")
    scope = users_repo.get_scope(user_id, scope_id)
    if scope is None:
        raise NotFound("Scope not found")
    if scope.revoked_at is not None:
        raise BusinessRule("This access is already revoked")

    scope.revoked_at = func.now()
    scope.revoked_by = current_user().user_id
    db.session.flush()
    db.session.refresh(scope)
    audit.record("SCOPE_REVOKED", "user", user_id, old=_scope_summary_from_model(scope))
    return scope


def _grant(user_id: int, data: dict, granted_by: int | None) -> UserRoleScope:
    role = db.session.execute(select(Role).where(Role.role_code == data["role_code"], Role.is_active)).scalar_one_or_none()
    if role is None:
        raise ValidationError("Unknown role", {"role_code": [f"'{data['role_code']}' is not an active role"]})

    actor = current_user()
    if role.role_code == "FOUNDER_CEO" and actor is not None and not actor.has_role("FOUNDER_CEO"):
        raise Forbidden("Only a Founder / CEO can grant Founder / CEO access")

    branch_id = data.get("branch_id")
    if branch_id is not None and db.session.get(Branch, branch_id) is None:
        raise ValidationError("Unknown branch", {"branch_id": ["Branch not found"]})

    expires_at = data.get("expires_at")
    if expires_at is not None and expires_at <= datetime.now(timezone.utc):
        raise ValidationError("Expiry must be in the future", {"expires_at": ["Must be in the future"]})

    existing = users_repo.find_unrevoked_scope(user_id, role.role_id, branch_id)
    if existing is not None:
        if existing.status(datetime.now(timezone.utc)) == "active":
            raise Conflict("The user already has this role for this branch")
        existing.revoked_at = func.now()  # expired: close it so the new grant can take its place
        existing.revoked_by = granted_by
        db.session.flush()

    scope = UserRoleScope(user_id=user_id, role_id=role.role_id, branch_id=branch_id, granted_by=granted_by, expires_at=expires_at)
    db.session.add(scope)
    db.session.flush()  # the DB checks company-wide roles have no branch and branch roles have one
    return scope


def _scope_summary(scopes: list[dict]) -> list[dict]:
    return [
        {"role_code": s["role_code"], "branch_id": s.get("branch_id"),
         "expires_at": s["expires_at"].isoformat() if s.get("expires_at") else None}
        for s in scopes
    ]


def _scope_summary_from_model(scope: UserRoleScope) -> dict:
    return {"scope_id": scope.scope_id, "role_code": scope.role.role_code, "branch_id": scope.branch_id}


# ---------------------------------------------------------------- first admin (CLI)

def create_initial_admin(email: str, full_name: str, role_code: str, password: str) -> User:
    """Used by `flask create-admin` when there are no users yet. The caller commits."""
    if role_code not in ADMIN_ROLES:
        raise ValidationError("Role must be FOUNDER_CEO or SUPER_ADMIN")
    if users_repo.email_taken(email):
        raise Conflict("A user with this email already exists")
    check_password_policy(password)

    user = User(full_name=full_name, email=email, password_hash=hash_password(password))
    db.session.add(user)
    db.session.flush()
    _grant(user.user_id, {"role_code": role_code, "branch_id": None}, granted_by=None)
    audit.record("USER_CREATED", "user", user.user_id, new={"email": email, "role_code": role_code, "via": "cli"}, actor_user_id=None)
    return user
