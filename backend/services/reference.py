"""Shared dropdown data: roles and the staff directory."""
from sqlalchemy import select

from config.database import db
from models import Role
from repositories import users as users_repo
from services.context import current_user
from services.errors import NotFound


def list_roles() -> list[Role]:
    return list(db.session.execute(select(Role).where(Role.is_active).order_by(Role.role_id)).scalars())


def list_staff(branch_id: int | None, role_codes: list[str] | None) -> list[dict]:
    """Active staff for owner / trainer / task-owner pickers, limited to the caller's branches.

    A branch filter keeps that branch's scopes plus company-wide ones; each user appears once with all
    matching roles.
    """
    user = current_user()
    allowed = user.branch_ids()
    if branch_id is not None:
        if allowed is not None and branch_id not in allowed:
            raise NotFound("Branch not found")
        allowed = {branch_id}
    staff: dict[int, dict] = {}
    for scope in users_repo.staff_scopes(role_codes, allowed):
        entry = staff.setdefault(scope.user_id, {"user_id": scope.user_id, "full_name": scope.user.full_name, "roles": []})
        entry["roles"].append({
            "role_code": scope.role.role_code,
            "role_name": scope.role.role_name,
            "branch_id": scope.branch_id,
            "branch_code": scope.branch.branch_code if scope.branch else None,
        })
    return list(staff.values())
