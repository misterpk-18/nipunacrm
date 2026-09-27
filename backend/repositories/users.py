"""Users and their role scopes."""
from sqlalchemy import Select, exists, func, or_, select
from sqlalchemy.orm import selectinload

from config.database import db
from models import Role, User, UserRoleScope


def _active_scope_condition():
    return (
        UserRoleScope.revoked_at.is_(None)
        & (UserRoleScope.expires_at.is_(None) | (UserRoleScope.expires_at > func.now()))
    )


def get_by_id(user_id: int) -> User | None:
    return db.session.get(User, user_id)


def get_by_email(email: str) -> User | None:
    return db.session.execute(select(User).where(func.lower(User.email) == email.lower())).scalar_one_or_none()


def email_taken(email: str, exclude_user_id: int | None = None) -> bool:
    stmt = select(User.user_id).where(func.lower(User.email) == email.lower())
    if exclude_user_id:
        stmt = stmt.where(User.user_id != exclude_user_id)
    return db.session.execute(stmt).first() is not None


def active_scopes(user_id: int) -> list[UserRoleScope]:
    stmt = (
        select(UserRoleScope)
        .join(Role)
        .where(UserRoleScope.user_id == user_id, _active_scope_condition(), Role.is_active)
        .order_by(UserRoleScope.scope_id)
    )
    return list(db.session.execute(stmt).scalars())


def all_scopes(user_id: int) -> list[UserRoleScope]:
    stmt = select(UserRoleScope).where(UserRoleScope.user_id == user_id).order_by(UserRoleScope.scope_id)
    return list(db.session.execute(stmt).scalars())


def get_scope(user_id: int, scope_id: int) -> UserRoleScope | None:
    return db.session.execute(
        select(UserRoleScope).where(UserRoleScope.user_id == user_id, UserRoleScope.scope_id == scope_id)
    ).scalar_one_or_none()


def find_unrevoked_scope(user_id: int, role_id: int, branch_id: int | None) -> UserRoleScope | None:
    """The scope holding the (user, role, branch) slot — active or expired, but not revoked."""
    stmt = select(UserRoleScope).where(
        UserRoleScope.user_id == user_id,
        UserRoleScope.role_id == role_id,
        UserRoleScope.branch_id.is_(None) if branch_id is None else UserRoleScope.branch_id == branch_id,
        UserRoleScope.revoked_at.is_(None),
    )
    return db.session.execute(stmt).scalar_one_or_none()


def user_ids_with_role(role_id: int, branch_id: int | None) -> list[int]:
    """Active users holding the role at this branch, or company-wide. branch_id=None: any branch."""
    stmt = (
        select(func.distinct(User.user_id))
        .join(UserRoleScope, UserRoleScope.user_id == User.user_id)
        .where(User.is_active, UserRoleScope.role_id == role_id, _active_scope_condition())
    )
    if branch_id is not None:
        stmt = stmt.where(UserRoleScope.branch_id.is_(None) | (UserRoleScope.branch_id == branch_id))
    return list(db.session.execute(stmt).scalars())


def user_ids_with_any_role(role_codes: tuple[str, ...], branch_id: int) -> set[int]:
    stmt = (
        select(User.user_id)
        .join(UserRoleScope, UserRoleScope.user_id == User.user_id)
        .join(Role, Role.role_id == UserRoleScope.role_id)
        .where(User.is_active, Role.role_code.in_(role_codes), _active_scope_condition(),
               UserRoleScope.branch_id.is_(None) | (UserRoleScope.branch_id == branch_id))
    )
    return set(db.session.execute(stmt).scalars())


def list_stmt(role_code: str | None, branch_id: int | None, is_active: bool | None, q: str | None) -> Select:
    stmt = select(User).options(selectinload(User.scopes)).order_by(User.full_name, User.user_id)

    if is_active is not None:
        stmt = stmt.where(User.is_active == is_active)
    if q:
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(or_(User.full_name.ilike(pattern), User.email.ilike(pattern), User.phone.ilike(pattern)))
    if role_code or branch_id:
        scope_filter = (UserRoleScope.user_id == User.user_id) & _active_scope_condition()
        if role_code:
            scope_filter &= UserRoleScope.role_id == select(Role.role_id).where(Role.role_code == role_code).scalar_subquery()
        if branch_id:
            scope_filter &= UserRoleScope.branch_id == branch_id
        stmt = stmt.where(exists().where(scope_filter))
    return stmt


def staff_scopes(role_codes: list[str] | None, branch_ids: set[int] | None) -> list[UserRoleScope]:
    """Active scopes of active users, at the given branches (None = all) plus company-wide scopes."""
    stmt = (
        select(UserRoleScope)
        .join(User, User.user_id == UserRoleScope.user_id)
        .join(Role, Role.role_id == UserRoleScope.role_id)
        .options(selectinload(UserRoleScope.user))
        .where(_active_scope_condition(), User.is_active.is_(True))
        .order_by(User.full_name, User.user_id, UserRoleScope.scope_id)
    )
    if role_codes:
        stmt = stmt.where(Role.role_code.in_(role_codes))
    if branch_ids is not None:
        stmt = stmt.where(or_(UserRoleScope.branch_id.in_(branch_ids), UserRoleScope.branch_id.is_(None)))
    return list(db.session.execute(stmt).scalars())
