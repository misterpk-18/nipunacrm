"""Users and their role scopes."""
from sqlalchemy import Select, func, select
from sqlalchemy.orm import selectinload

from config.database import db
from models import Role, User, UserRoleScope
from repositories.common import text

# A scope that is neither revoked nor expired (SQL twin of _active_scope_condition, for raw queries)
_ACTIVE_SCOPE_SQL = ("user_role_scopes.revoked_at IS NULL "
                     "AND (user_role_scopes.expires_at IS NULL OR user_role_scopes.expires_at > now())")

# Scopes carry their role and branch: load them together instead of one query per scope.
_SCOPE_LOADS = (selectinload(UserRoleScope.role), selectinload(UserRoleScope.branch))


def _active_scope_condition():
    """ORM form of the active-scope test; still used by repositories/fees.py."""
    return (
        UserRoleScope.revoked_at.is_(None)
        & (UserRoleScope.expires_at.is_(None) | (UserRoleScope.expires_at > func.now()))
    )


def get_by_id(user_id: int) -> User | None:
    return db.session.get(User, user_id)


def get_by_email(email: str) -> User | None:
    return db.session.execute(select(User).from_statement(text("SELECT * FROM users WHERE lower(email) = :email")),
                              {"email": email.lower()}).scalar_one_or_none()


def email_taken(email: str, exclude_user_id: int | None = None) -> bool:
    where = ["lower(email) = :email"]
    params: dict = {"email": email.lower()}
    if exclude_user_id:
        where.append("user_id <> :exclude_user_id")
        params["exclude_user_id"] = exclude_user_id
    sql = "SELECT user_id FROM users WHERE " + " AND ".join(where)
    return db.session.execute(text(sql), params).first() is not None


def active_scopes(user_id: int) -> list[UserRoleScope]:
    sql = f"""
        SELECT user_role_scopes.*
        FROM user_role_scopes
        JOIN roles ON roles.role_id = user_role_scopes.role_id
        WHERE user_role_scopes.user_id = :user_id AND {_ACTIVE_SCOPE_SQL} AND roles.is_active
        ORDER BY user_role_scopes.scope_id
    """
    return list(db.session.execute(select(UserRoleScope).from_statement(text(sql)).options(*_SCOPE_LOADS),
                                   {"user_id": user_id}).scalars())


def all_scopes(user_id: int) -> list[UserRoleScope]:
    return list(db.session.execute(select(UserRoleScope).from_statement(text("""
        SELECT * FROM user_role_scopes WHERE user_id = :user_id ORDER BY scope_id
    """)).options(*_SCOPE_LOADS), {"user_id": user_id}).scalars())


def get_scope(user_id: int, scope_id: int) -> UserRoleScope | None:
    return db.session.execute(select(UserRoleScope).from_statement(text("""
        SELECT * FROM user_role_scopes WHERE user_id = :user_id AND scope_id = :scope_id
    """)).options(*_SCOPE_LOADS), {"user_id": user_id, "scope_id": scope_id}).scalar_one_or_none()


def find_unrevoked_scope(user_id: int, role_id: int, branch_id: int | None) -> UserRoleScope | None:
    """The scope holding the (user, role, branch) slot — active or expired, but not revoked."""
    where = ["user_id = :user_id", "role_id = :role_id", "revoked_at IS NULL"]
    params: dict = {"user_id": user_id, "role_id": role_id}
    if branch_id is None:
        where.append("branch_id IS NULL")
    else:
        where.append("branch_id = :branch_id")
        params["branch_id"] = branch_id
    sql = "SELECT * FROM user_role_scopes WHERE " + " AND ".join(where)
    return db.session.execute(select(UserRoleScope).from_statement(text(sql)).options(*_SCOPE_LOADS),
                              params).scalar_one_or_none()


def user_ids_with_role(role_id: int, branch_id: int | None) -> list[int]:
    """Active users holding the role at this branch, or company-wide. branch_id=None: any branch."""
    where = ["users.is_active", "user_role_scopes.role_id = :role_id", _ACTIVE_SCOPE_SQL]
    params: dict = {"role_id": role_id}
    if branch_id is not None:
        where.append("(user_role_scopes.branch_id IS NULL OR user_role_scopes.branch_id = :branch_id)")
        params["branch_id"] = branch_id
    sql = ("SELECT DISTINCT users.user_id FROM users JOIN user_role_scopes ON user_role_scopes.user_id = users.user_id "
           "WHERE " + " AND ".join(where))
    return list(db.session.execute(text(sql), params).scalars())


def admin_user_ids() -> list[int]:
    """Active Founder / CEO and Super Admin users (any branch): they see every notification."""
    sql = f"""
        SELECT DISTINCT users.user_id
        FROM users
        JOIN user_role_scopes ON user_role_scopes.user_id = users.user_id
        JOIN roles ON roles.role_id = user_role_scopes.role_id
        WHERE users.is_active AND roles.role_code = ANY(:role_codes) AND {_ACTIVE_SCOPE_SQL}
    """
    return list(db.session.execute(text(sql), {"role_codes": ["SUPER_ADMIN", "FOUNDER_CEO"]}).scalars())


def user_ids_with_any_role(role_codes: tuple[str, ...], branch_id: int) -> set[int]:
    sql = f"""
        SELECT users.user_id
        FROM users
        JOIN user_role_scopes ON user_role_scopes.user_id = users.user_id
        JOIN roles ON roles.role_id = user_role_scopes.role_id
        WHERE users.is_active AND roles.role_code = ANY(:role_codes) AND {_ACTIVE_SCOPE_SQL}
          AND (user_role_scopes.branch_id IS NULL OR user_role_scopes.branch_id = :branch_id)
    """
    return set(db.session.execute(text(sql), {"role_codes": list(role_codes), "branch_id": branch_id}).scalars())


def list_stmt(role_code: str | None, branch_id: int | None, is_active: bool | None, q: str | None) -> Select:
    """Kept as a Select (paginated with db.paginate, which needs limit/offset): the filter is raw SQL."""
    where = ["TRUE"]
    params: dict = {}
    if is_active is not None:
        where.append("users.is_active = :is_active")
        params["is_active"] = is_active
    if q:
        where.append("(users.full_name ILIKE :pattern OR users.email ILIKE :pattern OR users.phone ILIKE :pattern)")
        params["pattern"] = f"%{q.strip()}%"
    if role_code or branch_id:
        scope = ["user_role_scopes.user_id = users.user_id", _ACTIVE_SCOPE_SQL]
        if role_code:
            scope.append("user_role_scopes.role_id = (SELECT role_id FROM roles WHERE role_code = :role_code)")
            params["role_code"] = role_code
        if branch_id:
            scope.append("user_role_scopes.branch_id = :branch_id")
            params["branch_id"] = branch_id
        where.append("EXISTS (SELECT 1 FROM user_role_scopes WHERE " + " AND ".join(scope) + ")")
    return (select(User).options(selectinload(User.scopes)).where(text(" AND ".join(where)).bindparams(**params))
            .order_by(text("users.full_name, users.user_id")))


def staff_scopes(role_codes: list[str] | None, branch_ids: set[int] | None) -> list[UserRoleScope]:
    """Active scopes of active users, at the given branches (None = all) plus company-wide scopes."""
    where = [_ACTIVE_SCOPE_SQL, "users.is_active IS TRUE"]
    params: dict = {}
    if role_codes:
        where.append("roles.role_code = ANY(:role_codes)")
        params["role_codes"] = list(role_codes)
    if branch_ids is not None:
        where.append("(user_role_scopes.branch_id = ANY(:branch_ids) OR user_role_scopes.branch_id IS NULL)")
        params["branch_ids"] = list(branch_ids)
    sql = ("SELECT user_role_scopes.* FROM user_role_scopes "
           "JOIN users ON users.user_id = user_role_scopes.user_id "
           "JOIN roles ON roles.role_id = user_role_scopes.role_id "
           "WHERE " + " AND ".join(where) + " ORDER BY users.full_name, users.user_id, user_role_scopes.scope_id")
    return list(db.session.execute(
        select(UserRoleScope).from_statement(text(sql)).options(selectinload(UserRoleScope.user), *_SCOPE_LOADS),
        params).scalars())
